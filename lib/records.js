const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canChangeCapacityStatus, priceBuyer, buyerView, LIMITS } = require("./offer-domain");
const { buyerTermsCanonical, buyerTermsHash } = require("./terms-hash");
const { auditEntry } = require("./audit");
const { expiresAtOf, commitmentForVersion } = require("./commitment");

const SCHEMA_VERSION = 7;
const BAK_SUFFIX = ".pre-m2.bak";
const M3_BAK_SUFFIX = ".pre-m3.bak";
const M4_BAK_SUFFIX = ".pre-m4.bak";
const M5_BAK_SUFFIX = ".pre-m5.bak";
const M6_BAK_SUFFIX = ".pre-m6.bak";
const M7_BAK_SUFFIX = ".pre-m7.bak";
const NOTE_LIMIT = 500;
const WALLET_CAP = 5;
const WALLET_ACTIVE = new Set(["submitting", "pending", "confirmed"]);

// D-20. Carrier status moves only. Cancellation is a separate agreement.
const CARRIER_MOVES = [
  ["accepted", "carrier_pending"],
  ["accepted", "carrier_confirmed"],
  ["carrier_pending", "carrier_confirmed"],
  ["carrier_pending", "rejected"],
  ["carrier_confirmed", "rolled"],
  ["carrier_confirmed", "completed"],
  ["carrier_confirmed", "rejected"],
  ["rolled", "carrier_pending"],
  ["rolled", "carrier_confirmed"],
];
const CARRIER_EDGES = new Set(CARRIER_MOVES.map(([from, to]) => `${from}>${to}`));

// C-7 offer (schema v2), which supersedes C-5. Commercial terms live on a
// version. The first publish freezes that version. After publishedAt is set,
// an edit or a capacity-status change appends a version (D-15).
// Offer: id, companyId, createdBy, createdAt, state, publishedAt, currentVersion,
// versions, statusHistory, stateHistory.
// Version: n, createdAt, createdBy, source, terms, snapshot, sourceRecordId,
// overriddenFields, capacityStatus, frozen.

const STATE_EDGES = new Set([
  "draft>published",
  "published>paused",
  "paused>published",
]);

const TERM_KEYS = [
  "source",
  "origin",
  "destination",
  "equipment",
  "quantity",
  "unit",
  "sailingStart",
  "sailingEnd",
  "cutoffDate",
  "validityDeadline",
  "currency",
  "baseMinor",
  "markup",
  "buyerMinor",
  "codeShareName",
  "operatingCarrier",
  "serviceTerms",
];

function freshData() {
  return { schemaVersion: SCHEMA_VERSION, offers: {}, requests: {}, audit: [], companies: {} };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function isAsyncFunction(fn) {
  return Boolean(fn && fn.constructor && fn.constructor.name === "AsyncFunction");
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

function nowIso() {
  // Event time for history rows. Expiry does not use this clock; callers pass
  // `today` so a test can stand on either side of a deadline.
  return new Date().toISOString();
}

function currentVersion(offer) {
  if (!offer || !Array.isArray(offer.versions)) return null;
  for (const version of offer.versions) {
    if (version && version.n === offer.currentVersion) return version;
  }
  return null;
}

function effectiveState(offer, today) {
  if (!isCalendarDate(today)) throw new TypeError("today must be a YYYY-MM-DD date");
  const stored = offer && typeof offer.state === "string" ? offer.state : "";
  // D-14. Only a published or paused offer can read as expired. A draft keeps
  // its stored state until it is published.
  if (stored !== "published" && stored !== "paused") return stored;
  const version = currentVersion(offer);
  const deadline = version && version.terms && version.terms.validityDeadline;
  if (typeof deadline === "string" && isCalendarDate(deadline) && deadline < today) return "expired";
  return stored;
}

function stampHistoryVersion(entry) {
  if (!isPlainObject(entry)) return entry;
  if (Object.prototype.hasOwnProperty.call(entry, "version")) return entry;
  return { ...entry, version: 1 };
}

function migrateOffer(offer) {
  if (!isPlainObject(offer)) return offer;
  const consumed = new Set([
    "source",
    "terms",
    "snapshot",
    "sourceRecordId",
    "overriddenFields",
    "capacityStatus",
    "statusHistory",
  ]);
  const version = {
    n: 1,
    createdAt: Object.prototype.hasOwnProperty.call(offer, "createdAt") ? offer.createdAt : null,
    createdBy: Object.prototype.hasOwnProperty.call(offer, "createdBy") ? offer.createdBy : null,
    frozen: false,
    source: Object.prototype.hasOwnProperty.call(offer, "source") ? offer.source : null,
    sourceRecordId: Object.prototype.hasOwnProperty.call(offer, "sourceRecordId") ? offer.sourceRecordId : null,
    snapshot: Object.prototype.hasOwnProperty.call(offer, "snapshot") ? offer.snapshot : null,
    terms: Object.prototype.hasOwnProperty.call(offer, "terms") ? offer.terms : null,
    overriddenFields: Array.isArray(offer.overriddenFields) ? offer.overriddenFields : [],
    capacityStatus: Object.prototype.hasOwnProperty.call(offer, "capacityStatus") ? offer.capacityStatus : "seller_asserted",
  };
  const next = {};
  for (const key of Object.keys(offer)) {
    if (!consumed.has(key)) next[key] = offer[key];
  }
  if (!Object.prototype.hasOwnProperty.call(next, "state")) next.state = "draft";
  if (!Object.prototype.hasOwnProperty.call(next, "publishedAt")) next.publishedAt = null;
  next.statusHistory = Array.isArray(offer.statusHistory) ? offer.statusHistory.map(stampHistoryVersion) : [];
  next.stateHistory = [];
  next.currentVersion = 1;
  next.versions = [version];
  return next;
}

function migrateV1(parsed) {
  const offers = {};
  const sourceOffers = isPlainObject(parsed.offers) ? parsed.offers : {};
  for (const id of Object.keys(sourceOffers)) offers[id] = migrateOffer(sourceOffers[id]);
  // Stay at v2. M-3 runs next, in the same open, and writes the .pre-m3.bak
  // from this v2 file.
  return { ...parsed, schemaVersion: 2, offers };
}

function migrateV2(parsed) {
  if (Object.prototype.hasOwnProperty.call(parsed, "requests") && !isPlainObject(parsed.requests)) {
    throw new Error("oceanrelay records requests must be an object");
  }
  const requests = isPlainObject(parsed.requests) ? parsed.requests : {};
  return { ...parsed, schemaVersion: 3, requests };
}

function initialFulfilment() {
  return {
    status: "accepted",
    history: [],
    cancellation: null,
    cancellationEvents: [],
  };
}

function migrateV3(parsed) {
  const source = isPlainObject(parsed.requests) ? parsed.requests : {};
  const requests = {};
  for (const id of Object.keys(source)) {
    const request = source[id];
    if (!isPlainObject(request)) {
      requests[id] = request;
      continue;
    }
    const fulfilment = Object.prototype.hasOwnProperty.call(request, "fulfilment")
      ? request.fulfilment
      : (request.state === "accepted" ? initialFulfilment() : null);
    requests[id] = { ...request, fulfilment };
  }
  return { ...parsed, schemaVersion: 4, requests };
}

function migrateV4(parsed) {
  if (Object.prototype.hasOwnProperty.call(parsed, "companies") && !isPlainObject(parsed.companies)) {
    throw new Error("oceanrelay records companies must be an object");
  }
  const companies = isPlainObject(parsed.companies) ? parsed.companies : {};
  return { ...parsed, schemaVersion: 5, companies };
}

function migrateV5(parsed) {
  return { ...parsed, schemaVersion: 6 };
}

function migrateV6(parsed) {
  return { ...parsed, schemaVersion: 7 };
}

function nextCarrierStatuses(from) {
  const next = [];
  for (const [start, to] of CARRIER_MOVES) {
    if (start === from) next.push(to);
  }
  return next;
}

function boundedText(value) {
  if (value == null) return { ok: true, text: "" };
  if (typeof value !== "string" || value.length > NOTE_LIMIT) return { ok: false };
  return { ok: true, text: value };
}

function readRecords(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("oceanrelay records file is unparsable");
  }
  if (!isPlainObject(parsed)) throw new Error("oceanrelay records file is unparsable");
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1 || parsed.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`oceanrelay records schemaVersion ${String(parsed.schemaVersion)} is not supported`);
  }
  if (parsed.offers === undefined) parsed.offers = {};
  if (parsed.audit === undefined) parsed.audit = [];
  if (!isPlainObject(parsed.offers)) throw new Error("oceanrelay records offers must be an object");
  if (!Array.isArray(parsed.audit)) throw new Error("oceanrelay records audit must be an array");
  if (parsed.schemaVersion >= 3) {
    if (parsed.requests === undefined) parsed.requests = {};
    if (!isPlainObject(parsed.requests)) throw new Error("oceanrelay records requests must be an object");
  }
  if (parsed.schemaVersion >= 5) {
    if (parsed.companies === undefined) parsed.companies = {};
    if (!isPlainObject(parsed.companies)) throw new Error("oceanrelay records companies must be an object");
  }
  return parsed;
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeProduct(quantity, unitBuyerMinor) {
  if (!positiveInt(quantity) || !positiveInt(unitBuyerMinor)) return null;
  const product = BigInt(quantity) * BigInt(unitBuyerMinor);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(product);
}

function companyNameOf(identity) {
  const name = identity && identity.companyName;
  return typeof name === "string" ? name : "";
}

function rememberSellerName(request, identity) {
  if (request.sellerCompanyName == null) request.sellerCompanyName = companyNameOf(identity);
}

function quantityAvailable(draft, offerId) {
  const offer = draft && draft.offers ? draft.offers[offerId] : null;
  const version = currentVersion(offer);
  const listed = version && version.terms && positiveInt(version.terms.quantity) ? version.terms.quantity : 0;
  const requests = draft && isPlainObject(draft.requests) ? draft.requests : {};
  let accepted = 0;
  for (const request of Object.values(requests)) {
    if (!request || request.offerId !== offerId || request.state !== "accepted") continue;
    // D-20. Only a cancelled agreement releases quantity. Rejected and disputed
    // agreements keep counting.
    if (request.fulfilment && request.fulfilment.status === "cancelled") continue;
    const qty = request.acceptance && request.acceptance.quantity;
    if (!positiveInt(qty)) continue;
    if (!Number.isSafeInteger(accepted + qty)) return 0;
    accepted += qty;
  }
  const available = listed - accepted;
  return available > 0 ? available : 0;
}

function sameWallet(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function companyBucket(draft, companyId) {
  if (!isPlainObject(draft.companies)) return null;
  const company = draft.companies[companyId];
  return isPlainObject(company) ? company : null;
}

function activeWallets(company) {
  const wallets = company && Array.isArray(company.wallets) ? company.wallets : [];
  return wallets.filter((entry) => entry && WALLET_ACTIVE.has(entry.state));
}

function partyRole(request, companyId) {
  if (!request || typeof companyId !== "string" || companyId === "") return "";
  if (request.buyerCompanyId === companyId) return "buyer";
  if (request.sellerCompanyId === companyId) return "seller";
  return "";
}

function latestCounter(request) {
  const counters = request && Array.isArray(request.counters) ? request.counters : [];
  return counters.length ? counters[counters.length - 1] : null;
}

function isFinalState(state) {
  return state === "accepted" || state === "declined" || state === "withdrawn";
}

function effectiveRequestState(request, offer) {
  if (!request || typeof request !== "object") return "";
  const state = typeof request.state === "string" ? request.state : "";
  if (state !== "pending" && state !== "countered") return state;
  const version = currentVersion(offer);
  if (!version || version.n !== request.version) return "superseded";
  return state;
}

function requireToday(today) {
  if (!isCalendarDate(today)) throw new TypeError("today must be a YYYY-MM-DD date");
}

function requestIssue(offer, today) {
  if (!offer) return "not_found";
  const state = effectiveState(offer, today);
  if (state === "expired") return "expired";
  if (offer.state === "draft") return "draft";
  if (offer.state === "paused") return "paused";
  if (offer.state !== "published") return "not_published";
  const version = currentVersion(offer);
  if (!version || version.frozen !== true) return "not_frozen";
  return "";
}

function buyerTermsFor(offer, version, counter, quantity, unitBuyerMinor, totalMinor, serviceTerms) {
  const terms = version && version.terms && typeof version.terms === "object" ? version.terms : {};
  const view = buyerView({
    ...terms,
    capacityStatus: version ? version.capacityStatus : "",
  });
  return buyerTermsCanonical({
    offerId: offer.id,
    version: version.n,
    counter: counter == null ? null : counter,
    codeShareLine: view.codeShareLine,
    origin: view.lane.origin,
    destination: view.lane.destination,
    equipment: view.equipment,
    unit: view.quantity.unit,
    quantity,
    sailingStart: view.dates.sailingStart,
    sailingEnd: view.dates.sailingEnd,
    cutoffDate: view.dates.cutoffDate,
    validityDeadline: view.dates.validityDeadline,
    currency: view.currency,
    unitBuyerMinor,
    totalMinor,
    serviceTerms: typeof serviceTerms === "string" ? serviceTerms : "",
    capacityStatus: view.capacityStatus,
  });
}

function versionByNumber(offer, n) {
  const versions = offer && Array.isArray(offer.versions) ? offer.versions : [];
  return versions.find((version) => version && version.n === n) || null;
}

function chainActions(offer) {
  return offer && offer.chain && Array.isArray(offer.chain.actions) ? offer.chain.actions : [];
}

function publishConfirmed(offer) {
  return chainActions(offer).some((action) => action && action.kind === "publish" && action.status === "confirmed");
}

function actionInFlight(offer) {
  return chainActions(offer).some((action) => {
    return action && (action.status === "submitting" || action.status === "pending");
  });
}

function versionExpiry(version) {
  const deadline = version && version.terms ? version.terms.validityDeadline : null;
  return expiresAtOf(deadline);
}

// The next chain step, derived from the two records. It does not write.
function nextChainStep(offer, today, nowSec) {
  if (!isCalendarDate(today)) throw new TypeError("today must be a YYYY-MM-DD date");
  if (!Number.isInteger(nowSec)) throw new TypeError("now must be unix seconds");
  if (!offer || !isPlainObject(offer.chain)) return { step: "prepare" };
  if (actionInFlight(offer)) return { step: "check", expire: false };
  if (!publishConfirmed(offer)) {
    const expiresAt = versionExpiry(versionByNumber(offer, 1));
    if (expiresAt == null || expiresAt <= nowSec) return { step: "blocked" };
    return { step: "sign", action: { kind: "publish", version: 1, to: "published", seq: null } };
  }
  const confirmed = offer.chain.confirmed;
  if (!confirmed || !Number.isInteger(confirmed.version)) return { step: "blocked" };
  const current = Number.isInteger(offer.currentVersion) ? offer.currentVersion : 0;
  if (current > confirmed.version) {
    const n = confirmed.version + 1;
    const version = versionByNumber(offer, n);
    const expiresAt = versionExpiry(version);
    if (version && expiresAt != null && expiresAt > nowSec) {
      return { step: "sign", action: { kind: "version", version: n, to: null, seq: null } };
    }
  }
  if (effectiveState(offer, today) === "expired" && (confirmed.state === "published" || confirmed.state === "paused")) {
    const expiresAt = versionExpiry(versionByNumber(offer, confirmed.version));
    if (expiresAt != null && nowSec > expiresAt) return { step: "check", expire: true };
  }
  const stored = offer.state;
  if ((stored === "published" || stored === "paused") && stored !== confirmed.state && confirmed.state !== "expired") {
    const seq = confirmed.stateSeq;
    if (!Number.isInteger(seq) || seq < 0) return { step: "blocked" };
    return { step: "sign", action: { kind: "state", version: null, to: stored, seq } };
  }
  return { step: "none" };
}

function saltVersion(offer) {
  if (!publishConfirmed(offer)) return 1;
  const confirmed = offer.chain && offer.chain.confirmed;
  if (!confirmed || !Number.isInteger(confirmed.version)) return 1;
  const current = Number.isInteger(offer.currentVersion) ? offer.currentVersion : 0;
  if (current > confirmed.version) return confirmed.version + 1;
  return null;
}

function chainAuditTo(entry) {
  if (!entry) return null;
  if (entry.kind === "version") return "version";
  if (entry.to === "published" || entry.to === "paused" || entry.to === "expired") return entry.to;
  return null;
}

function requestActions(request) {
  return request && request.chain && Array.isArray(request.chain.actions) ? request.chain.actions : [];
}

function requestActionInFlight(request) {
  return requestActions(request).some((action) => {
    return action && (action.status === "submitting" || action.status === "pending");
  });
}

function offerActionInFlight(offer) {
  return chainActions(offer).some((action) => {
    return action && (action.status === "submitting" || action.status === "pending");
  });
}

function chainCounterOf(counterN) {
  return counterN == null ? 0 : counterN;
}

function counterKeyOf(counterN) {
  return String(chainCounterOf(counterN));
}

function currentCounterN(request) {
  if (!request) return null;
  if (request.state === "accepted" && request.acceptance) return request.acceptance.counter == null ? null : request.acceptance.counter;
  if (request.state === "countered") {
    const counter = latestCounter(request);
    return counter ? counter.n : null;
  }
  return null;
}

function requestLinked(request) {
  const confirmed = request && request.chain && request.chain.confirmed;
  return Boolean(confirmed && confirmed.recorded === true);
}

function acceptanceRecorded(request) {
  const confirmed = request && request.chain && request.chain.confirmed;
  if (!confirmed) return false;
  return Boolean(confirmed.status) || confirmed.cancelled === true;
}

function confirmedWallet(draft, companyId, address) {
  const company = companyBucket(draft, companyId);
  return activeWallets(company).some((entry) => entry.state === "confirmed" && sameWallet(entry.wallet, address));
}

function proposalOpen(proposal, nowSec) {
  return Boolean(proposal && Number.isInteger(proposal.deadline) && proposal.deadline > nowSec);
}

function offerChainState(offer, version) {
  const confirmed = offer && offer.chain && offer.chain.confirmed;
  if (!confirmed || !Number.isInteger(confirmed.version)) return "missing";
  if (confirmed.version !== version) return "stale";
  if (confirmed.state === "paused") return "paused";
  if (confirmed.state !== "published") return "not_published";
  return "";
}

function chainRequestPublic(chain) {
  if (!isPlainObject(chain)) return null;
  const copy = structuredClone(chain);
  if (isPlainObject(copy.proposals)) {
    for (const key of Object.keys(copy.proposals)) {
      if (isPlainObject(copy.proposals[key])) delete copy.proposals[key].signature;
    }
  }
  if (isPlainObject(copy.cancelProposal)) delete copy.cancelProposal.signature;
  return copy;
}

function requestAuditTo(entry) {
  if (!entry) return null;
  if (entry.kind === "status") return typeof entry.to === "string" ? entry.to : null;
  if (entry.kind === "request" || entry.kind === "acceptance" || entry.kind === "cancellation") return entry.kind;
  return null;
}

function applyRequestConfirmed(request, entry) {
  if (!isPlainObject(request.chain.confirmed)) {
    request.chain.confirmed = {
      recorded: false,
      acceptedCounter: null,
      status: null,
      statusSeq: 0,
      cancelled: false,
    };
  }
  const confirmed = request.chain.confirmed;
  if (entry.kind === "request") {
    confirmed.recorded = true;
  } else if (entry.kind === "acceptance") {
    confirmed.recorded = true;
    confirmed.acceptedCounter = entry.counter == null ? null : entry.counter;
    confirmed.status = "accepted";
    const key = counterKeyOf(entry.counter);
    if (isPlainObject(request.chain.proposals)) delete request.chain.proposals[key];
  } else if (entry.kind === "status") {
    confirmed.status = entry.to;
    confirmed.statusSeq = entry.seq + 1;
  } else if (entry.kind === "cancellation") {
    confirmed.cancelled = true;
    confirmed.status = "cancelled";
    request.chain.cancelProposal = null;
  }
}

function termsHashForRequest(draft, requestId, today) {
  const request = draft.requests && draft.requests[requestId];
  if (!request) return { ok: false, error: "not_found" };
  if (request.state === "accepted" && request.acceptance && typeof request.acceptance.termsHash === "string") {
    return {
      ok: true,
      termsHash: request.acceptance.termsHash,
      counter: request.acceptance.counter == null ? null : request.acceptance.counter,
    };
  }
  const pending = request.state === "pending";
  const identity = pending
    ? { companyId: request.sellerCompanyId, sub: request.sellerCompanyId }
    : { companyId: request.buyerCompanyId, sub: request.buyerSub };
  const plan = acceptancePlan(draft, identity, requestId, today);
  if (!plan.ok) return plan;
  return { ok: true, termsHash: plan.termsHash, counter: plan.counterN };
}

function acceptancePlan(draft, identity, requestId, today) {
  requireToday(today);
  const companyId = identity && identity.companyId;
  const actor = identity && identity.sub;
  const request = draft.requests && draft.requests[requestId];
  if (!request || partyRole(request, companyId) === "") return { ok: false, error: "not_found" };
  const role = partyRole(request, companyId);
  if (isFinalState(request.state)) return { ok: false, error: "final" };
  const sellerAccepts = role === "seller" && request.state === "pending";
  const buyerAccepts = role === "buyer" && request.state === "countered";
  if (!sellerAccepts && !buyerAccepts) return { ok: false, error: "forbidden" };
  const offer = draft.offers[request.offerId];
  const issue = requestIssue(offer, today);
  if (issue === "expired") return { ok: false, error: "expired" };
  if (issue) return { ok: false, error: issue === "not_found" ? "not_found" : "not_published" };
  const version = currentVersion(offer);
  if (!version || version.n !== request.version) return { ok: false, error: "superseded" };
  const counter = sellerAccepts ? null : latestCounter(request);
  if (!sellerAccepts && !counter) return { ok: false, error: "invalid" };
  const quantity = sellerAccepts ? request.quantity : counter.quantity;
  const unitBuyerMinor = sellerAccepts ? version.terms && version.terms.buyerMinor : counter.unitBuyerMinor;
  const serviceTerms = sellerAccepts
    ? (version.terms && typeof version.terms.serviceTerms === "string" ? version.terms.serviceTerms : "")
    : counter.serviceTerms;
  const sellerSub = sellerAccepts ? actor : counter.by;
  if (!positiveInt(quantity) || !positiveInt(unitBuyerMinor)) return { ok: false, error: "invalid" };
  if (quantity > quantityAvailable(draft, offer.id)) return { ok: false, error: "unavailable" };
  const totalMinor = safeProduct(quantity, unitBuyerMinor);
  if (totalMinor == null) return { ok: false, error: "overflow" };
  const counterN = counter ? counter.n : null;
  let canonical;
  try {
    canonical = buyerTermsFor(offer, version, counterN, quantity, unitBuyerMinor, totalMinor, serviceTerms);
  } catch {
    return { ok: false, error: "invalid" };
  }
  return {
    ok: true,
    sellerAccepts,
    counterN,
    quantity,
    unitBuyerMinor,
    totalMinor,
    sellerSub,
    canonical,
    termsHash: buyerTermsHash(canonical),
    currency: version.terms && typeof version.terms.currency === "string" ? version.terms.currency : "",
    versionN: version.n,
  };
}

function linkHold(chainState) {
  if (chainState === "paused") return "paused";
  if (chainState === "stale") return "stale";
  if (chainState === "missing") return "unlinked_offer";
  return "blocked";
}

function nextRequestChainStep(draft, request, offer, companyId, nowSec) {
  if (!Number.isInteger(nowSec)) throw new TypeError("now must be unix seconds");
  const role = partyRole(request, companyId);
  if (!role || !request) return { step: "none" };
  if (!offer || !isPlainObject(offer.chain)) return { step: "off_chain" };
  const chainState = offerChainState(offer, request.version);
  if (!isPlainObject(request.chain) || typeof request.chain.requestKey !== "string") {
    if (chainState) return { step: "blocked", reason: linkHold(chainState) };
    if (role === "buyer") return { step: "prepare", kind: "request" };
    return { step: "wait" };
  }
  if (requestActionInFlight(request)) return { step: "check" };
  if (!requestLinked(request)) {
    if (chainState) return { step: "blocked", reason: linkHold(chainState) };
    if (role === "buyer") return { step: "sign", kind: "request" };
    return { step: "wait" };
  }
  const offChainAccepted = request.state === "accepted";
  if (!acceptanceRecorded(request)) {
    if (!offChainAccepted) {
      const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
      const issue = requestIssue(offer, today);
      if (issue === "paused" || issue === "draft" || issue === "not_published" || issue === "not_frozen") {
        return { step: "blocked", reason: "offer_closed" };
      }
      if (issue === "expired") return { step: "blocked", reason: "blocked" };
      const effective = effectiveRequestState(request, offer);
      if (effective !== "pending" && effective !== "countered") return { step: "none" };
    }
    return acceptanceStep(draft, request, offer, role, nowSec, offChainAccepted);
  }
  if (request.fulfilment && request.fulfilment.status === "cancelled" && request.chain.confirmed.cancelled !== true) {
    return cancellationStep(draft, request, role, nowSec);
  }
  return statusStep(request);
}

function acceptanceStep(draft, request, offer, role, nowSec, offChainAccepted) {
  const counterN = currentCounterN(request);
  const key = counterKeyOf(counterN);
  const proposeRole = counterN == null ? "buyer" : "seller";
  const acceptRole = proposeRole === "buyer" ? "seller" : "buyer";
  const salt = request.chain.salts && request.chain.salts[key];
  const proposal = request.chain.proposals && request.chain.proposals[key];
  const open = proposalOpen(proposal, nowSec);
  const block = acceptanceBlock(offer, request, nowSec);
  if (block === "stale" || block === "blocked") {
    return { step: "blocked", reason: block === "stale" ? "stale" : "blocked" };
  }
  if (block === "paused" || block === "offer_inflight") {
    return { step: "blocked", reason: block };
  }
  if (role === proposeRole) {
    if (open) return { step: "wait" };
    if (typeof salt !== "string") return { step: "prepare", kind: "proposal", counter: chainCounterOf(counterN) };
    return { step: "sign", kind: "proposal", counter: chainCounterOf(counterN), retry: offChainAccepted };
  }
  if (role === acceptRole) {
    if (!open) return { step: "wait" };
    return {
      step: "sign",
      kind: "accept",
      counter: chainCounterOf(counterN),
      retry: offChainAccepted,
      deadline: proposal.deadline,
    };
  }
  return { step: "none" };
}

function acceptanceBlock(offer, request, nowSec) {
  const chainState = offerChainState(offer, request.version);
  if (chainState === "stale") return "stale";
  if (chainState === "paused") return "paused";
  if (chainState) return "blocked";
  if (offerActionInFlight(offer)) return "offer_inflight";
  const expiresAt = versionExpiry(versionByNumber(offer, request.version));
  if (expiresAt == null || expiresAt <= nowSec) return "blocked";
  return "";
}

function cancellationStep(draft, request, role, nowSec) {
  const proposal = request.chain.cancelProposal;
  if (!proposalOpen(proposal, nowSec)) return { step: "sign", kind: "cancellation", leg: "first" };
  const buyerSigned = confirmedWallet(draft, request.buyerCompanyId, proposal.signer);
  const sellerSigned = confirmedWallet(draft, request.sellerCompanyId, proposal.signer);
  if ((role === "buyer" && buyerSigned) || (role === "seller" && sellerSigned)) return { step: "wait" };
  if ((role === "buyer" && sellerSigned) || (role === "seller" && buyerSigned)) {
    return { step: "sign", kind: "cancellation", leg: "second", deadline: proposal.deadline };
  }
  return { step: "sign", kind: "cancellation", leg: "first" };
}

function statusStep(request) {
  const confirmed = request.chain.confirmed;
  if (!confirmed || confirmed.cancelled === true) return { step: "none" };
  const history = request.fulfilment && Array.isArray(request.fulfilment.history) ? request.fulfilment.history : [];
  const seq = Number.isInteger(confirmed.statusSeq) ? confirmed.statusSeq : 0;
  const entry = history[seq];
  if (!entry || typeof entry.to !== "string") return { step: "none" };
  const chainFrom = !confirmed.status || confirmed.status === "accepted" ? "accepted" : confirmed.status;
  if (!CARRIER_EDGES.has(`${chainFrom}>${entry.to}`)) return { step: "none" };
  return { step: "sign", kind: "status", status: entry.to, seq };
}

function applyConfirmed(offer, entry) {
  if (!isPlainObject(offer.chain.confirmed)) {
    offer.chain.confirmed = { version: 0, state: "published", stateSeq: 0 };
  }
  const confirmed = offer.chain.confirmed;
  if (entry.kind === "publish") {
    confirmed.version = 1;
    confirmed.state = "published";
    confirmed.stateSeq = 0;
  } else if (entry.kind === "version") {
    confirmed.version = entry.version;
  } else if (entry.kind === "state") {
    confirmed.state = entry.to;
    confirmed.stateSeq = entry.seq + 1;
  } else if (entry.kind === "expire") {
    confirmed.state = "expired";
  }
}

function copyBak(filePath, suffix) {
  const bakPath = `${filePath}${suffix}`;
  if (fs.existsSync(bakPath)) return;
  const bytes = fs.readFileSync(filePath);
  const tmp = `${bakPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.renameSync(tmp, bakPath);
  fs.chmodSync(bakPath, 0o600);
}

function openRecords(filePath) {
  const memoryOnly = filePath == null || filePath === "";
  let data = freshData();
  let inTransact = false;

  function persistSnapshot(snapshot) {
    if (memoryOnly) return;
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  function commit(draft) {
    if (!memoryOnly) {
      const serialized = JSON.stringify(draft);
      const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
      if (current !== serialized) persistSnapshot(draft);
    }
    data = draft;
  }

  if (!memoryOnly) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) {
      let current = readRecords(filePath);
      if (current.schemaVersion === 1) {
        copyBak(filePath, BAK_SUFFIX);
        current = migrateV1(current);
        persistSnapshot(current);
      }
      if (current.schemaVersion === 2) {
        copyBak(filePath, M3_BAK_SUFFIX);
        current = migrateV2(current);
        persistSnapshot(current);
      }
      if (current.schemaVersion === 3) {
        copyBak(filePath, M4_BAK_SUFFIX);
        current = migrateV3(current);
        persistSnapshot(current);
      }
      if (current.schemaVersion === 4) {
        copyBak(filePath, M5_BAK_SUFFIX);
        current = migrateV4(current);
        persistSnapshot(current);
      }
      if (current.schemaVersion === 5) {
        copyBak(filePath, M6_BAK_SUFFIX);
        current = migrateV5(current);
        persistSnapshot(current);
      }
      if (current.schemaVersion === 6) {
        copyBak(filePath, M7_BAK_SUFFIX);
        current = migrateV6(current);
        persistSnapshot(current);
      }
      data = current;
    } else {
      persistSnapshot(data);
    }
  }

  function runSync(kind, fn) {
    if (typeof fn !== "function") throw new TypeError(`${kind} requires a function`);
    if (isAsyncFunction(fn)) throw new Error(`${kind} callback must be synchronous`);
    if (inTransact) throw new Error(`${kind} cannot be nested`);
    const draft = structuredClone(data);
    let result;
    inTransact = true;
    try {
      result = fn(draft);
    } finally {
      inTransact = false;
    }
    if (isThenable(result)) {
      Promise.resolve(result).then(() => {}, () => {});
      throw new Error(`${kind} callback must be synchronous`);
    }
    return { draft, result };
  }

  function pushAudit(draft, fields) {
    if (!Array.isArray(draft.audit)) draft.audit = [];
    draft.audit.push(auditEntry(fields));
  }

  function findOwned(draft, companyId, id) {
    const offer = draft.offers[id];
    if (!offer || offer.companyId !== companyId) return null;
    return offer;
  }

  function applyOfferState(draft, companyId, id, to, actorSub, today) {
    const offer = findOwned(draft, companyId, id);
    if (!offer) return { ok: false, error: "not_found" };
    if (effectiveState(offer, today) === "expired") return { ok: false, error: "expired" };
    const from = offer.state;
    if (!STATE_EDGES.has(`${from}>${to}`)) return { ok: false, error: "illegal_transition" };
    const current = currentVersion(offer);
    if (!current) return { ok: false, error: "invalid" };
    if (to === "published") {
      const deadline = current.terms && current.terms.validityDeadline;
      if (typeof deadline === "string" && isCalendarDate(deadline) && deadline < today) {
        return { ok: false, error: "deadline_passed" };
      }
      current.frozen = true;
      if (!offer.publishedAt) offer.publishedAt = nowIso();
    }
    offer.state = to;
    if (!Array.isArray(offer.stateHistory)) offer.stateHistory = [];
    const at = nowIso();
    offer.stateHistory.push({ from, to, actor: actorSub, at });
    pushAudit(draft, {
      event: "offer.state",
      actor: { sub: actorSub, companyId, role: "seller" },
      subject: { offerId: offer.id, version: current.n },
      detail: { from, to },
      at,
    });
    return { ok: true, offer };
  }

  function applyVersionWrite(offer, actorSub, mutate) {
    const current = currentVersion(offer);
    if (!current) return null;
    const seen = Boolean(current.frozen)
      || Boolean(offer.publishedAt)
      || offer.state === "published"
      || offer.state === "paused";
    if (!seen) {
      mutate(current, current.n);
      return current;
    }
    const next = structuredClone(current);
    const n = current.n + 1;
    next.n = n;
    next.createdAt = nowIso();
    next.createdBy = actorSub;
    next.frozen = offer.state === "published";
    mutate(next, n);
    offer.versions.push(next);
    offer.currentVersion = n;
    return next;
  }

  function applyAccept(draft, identity, requestId, today) {
    const plan = acceptancePlan(draft, identity, requestId, today);
    if (!plan.ok) return plan;
    const companyId = identity && identity.companyId;
    const actor = identity && identity.sub;
    const request = draft.requests[requestId];
    const offer = draft.offers[request.offerId];
    const at = nowIso();
    const from = request.state;
    if (plan.sellerAccepts) rememberSellerName(request, identity);
    request.state = "accepted";
    request.acceptance = {
      at,
      by: actor,
      offerId: offer.id,
      version: plan.versionN,
      counter: plan.counterN,
      quantity: plan.quantity,
      unitBuyerMinor: plan.unitBuyerMinor,
      currency: plan.currency,
      totalMinor: plan.totalMinor,
      sellerCompanyId: request.sellerCompanyId,
      sellerSub: plan.sellerSub,
      buyerCompanyId: request.buyerCompanyId,
      buyerSub: request.buyerSub,
      termsVersion: 1,
      termsHash: plan.termsHash,
    };
    if (!Array.isArray(request.history)) request.history = [];
    request.history.push({ from, to: "accepted", actor, at, counter: plan.counterN });
    request.fulfilment = initialFulfilment();
    pushAudit(draft, {
      event: "request.accepted",
      actor: { sub: actor, companyId, role: plan.sellerAccepts ? "seller" : "buyer" },
      subject: { offerId: offer.id, requestId: request.id, version: plan.versionN },
      detail: { from, to: "accepted", quantity: plan.quantity, counter: plan.counterN },
      at,
    });
    return { ok: true, request: structuredClone(request) };
  }

  function pushRequestAction(request, entry) {
    if (!Array.isArray(request.chain.actions)) request.chain.actions = [];
    request.chain.actions.push(entry);
    return entry;
  }

  function newRequestAction(fields) {
    const at = nowIso();
    return {
      id: crypto.randomUUID(),
      kind: fields.kind,
      counter: Object.prototype.hasOwnProperty.call(fields, "counter") ? fields.counter : null,
      to: fields.to == null ? null : fields.to,
      seq: Number.isInteger(fields.seq) ? fields.seq : null,
      signers: Array.isArray(fields.signers) ? fields.signers.slice() : [],
      deadline: fields.deadline,
      status: "submitting",
      txHash: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  function loadPartyRequest(draft, companyId, requestId) {
    const request = draft.requests && draft.requests[requestId];
    if (!request || partyRole(request, companyId) === "") return null;
    return request;
  }

  function finishRequestAction(draft, companyId, requestId, actionId, spec, fromCheck) {
    const request = loadPartyRequest(draft, companyId, requestId);
    if (!request || !isPlainObject(request.chain) || !Array.isArray(request.chain.actions)) {
      return { ok: false, error: "not_found" };
    }
    const entry = request.chain.actions.find((item) => item && item.id === actionId);
    if (!entry) return { ok: false, error: "not_found" };
    if (fromCheck && entry.status !== "submitting" && entry.status !== "pending") {
      const hashless = typeof entry.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash);
      const landedLate = spec.state === "confirmed" && entry.status === "expired" && hashless;
      if (!landedLate) return { ok: false, error: "not_found" };
    }
    const at = nowIso();
    const othersInFlight = request.chain.actions.some((item) => {
      return item && item !== entry && (item.status === "submitting" || item.status === "pending");
    });
    if (entry.status !== "submitting" && othersInFlight) {
      const hashless = typeof entry.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash);
      const landedLate = spec.state === "confirmed" && entry.status === "expired" && hashless;
      if (!landedLate) {
        if (entry.status === "confirmed" && spec.txHash && !entry.txHash) {
          entry.txHash = spec.txHash;
          entry.updatedAt = at;
          return { ok: true, entry: structuredClone(entry) };
        }
        return { ok: false, error: "superseded" };
      }
    }
    const already = entry.status === "confirmed";
    if (already && spec.state !== "confirmed") {
      if (spec.txHash && !entry.txHash) entry.txHash = spec.txHash;
      entry.updatedAt = at;
      return { ok: true, entry: structuredClone(entry) };
    }
    entry.status = spec.state;
    entry.updatedAt = at;
    if (Object.prototype.hasOwnProperty.call(spec, "txHash") && (spec.txHash || !entry.txHash)) {
      entry.txHash = spec.txHash;
    }
    if (Object.prototype.hasOwnProperty.call(spec, "error")) entry.error = spec.error;
    if (spec.state === "confirmed" && !already) {
      applyRequestConfirmed(request, entry);
      const role = partyRole(request, companyId) || "buyer";
      pushAudit(draft, {
        event: "request.chain_recorded",
        actor: { sub: spec.actorSub, companyId, role },
        subject: { offerId: request.offerId, requestId: request.id, version: request.version },
        detail: { to: requestAuditTo(entry) },
        at,
      });
    }
    return { ok: true, entry: structuredClone(entry) };
  }

  const api = {
    filePath: memoryOnly ? null : filePath,
    // Synchronous on purpose (D-3). An async callback would await between a
    // check and the persist, so two requests could take the last unit.
    transact(fn) {
      const ran = runSync("transact", fn);
      commit(ran.draft);
      return ran.result;
    },
    // C-6. Read-only. The callback sees a copy and nothing is persisted.
    view(fn) {
      return runSync("view", fn).result;
    },
    effectiveState(offer, today) {
      return effectiveState(offer, today);
    },
    createOffer(identity, fields) {
      const companyId = identity && identity.companyId;
      const createdBy = identity && identity.sub;
      const spec = fields && typeof fields === "object" ? fields : {};
      return api.transact((draft) => {
        const id = crypto.randomUUID();
        const createdAt = nowIso();
        const version = {
          n: 1,
          createdAt,
          createdBy,
          frozen: false,
          source: spec.source,
          sourceRecordId: spec.sourceRecordId == null ? null : spec.sourceRecordId,
          snapshot: spec.snapshot == null ? null : spec.snapshot,
          terms: spec.terms,
          overriddenFields: Array.isArray(spec.overriddenFields) ? spec.overriddenFields.slice() : [],
          capacityStatus: "seller_asserted",
        };
        const offer = {
          id,
          companyId,
          createdBy,
          createdAt,
          state: "draft",
          publishedAt: null,
          currentVersion: 1,
          versions: [version],
          statusHistory: [],
          stateHistory: [],
        };
        draft.offers[id] = offer;
        pushAudit(draft, {
          event: "offer.created",
          actor: { sub: createdBy, companyId, role: "seller" },
          subject: { offerId: id, version: 1 },
          detail: { quantity: spec.terms && spec.terms.quantity },
          at: createdAt,
        });
        return structuredClone(offer);
      });
    },
    listCompanyOffers(companyId) {
      return api.view((draft) => {
        return Object.values(draft.offers)
          .filter((offer) => offer && offer.companyId === companyId)
          .sort((left, right) => {
            const byTime = String(right.createdAt).localeCompare(String(left.createdAt));
            if (byTime !== 0) return byTime;
            return String(right.id).localeCompare(String(left.id));
          })
          .map((offer) => structuredClone(offer));
      });
    },
    getCompanyOffer(companyId, id) {
      return api.view((draft) => {
        const offer = draft.offers[id];
        if (!offer || offer.companyId !== companyId) return null;
        return structuredClone(offer);
      });
    },
    editOffer(companyId, id, fields, actorSub, today) {
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer) return { ok: false, error: "not_found" };
        if (effectiveState(offer, today) === "expired") return { ok: false, error: "expired" };
        const current = currentVersion(offer);
        if (!current) return { ok: false, error: "invalid" };
        const spec = fields && typeof fields === "object" ? fields : {};
        const incoming = spec.terms && typeof spec.terms === "object" ? spec.terms : {};
        const terms = { source: current.source };
        for (const key of TERM_KEYS) {
          if (key === "source") continue;
          if (Object.prototype.hasOwnProperty.call(incoming, key) && incoming[key] !== undefined) {
            terms[key] = structuredClone(incoming[key]);
          }
        }
        if (current.source === "rn_rate" && current.terms) {
          terms.baseMinor = current.terms.baseMinor;
          terms.equipment = current.terms.equipment;
        }
        let buyerMinor;
        try {
          buyerMinor = priceBuyer({ baseMinor: terms.baseMinor, markup: terms.markup });
        } catch {
          return { ok: false, error: "invalid" };
        }
        terms.buyerMinor = buyerMinor;
        const overriddenFields = Array.isArray(spec.overriddenFields) ? spec.overriddenFields.slice() : [];
        const written = applyVersionWrite(offer, actorSub, (version) => {
          version.terms = terms;
          version.overriddenFields = overriddenFields.slice();
        });
        pushAudit(draft, {
          event: "offer.edited",
          actor: { sub: actorSub, companyId, role: "seller" },
          subject: { offerId: offer.id, version: written ? written.n : offer.currentVersion },
          detail: { quantity: terms.quantity },
          at: nowIso(),
        });
        return { ok: true, offer: structuredClone(offer) };
      });
    },
    setCapacityStatus(companyId, id, to, actorSub, today) {
      if (!isCalendarDate(today)) throw new TypeError("today must be a YYYY-MM-DD date");
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer) return { ok: false, error: "not_found" };
        if (effectiveState(offer, today) === "expired") return { ok: false, error: "expired" };
        const current = currentVersion(offer);
        if (!current) return { ok: false, error: "invalid" };
        const from = current.capacityStatus;
        if (!canChangeCapacityStatus(from, to)) return { ok: false, error: "illegal_transition" };
        const written = applyVersionWrite(offer, actorSub, (version) => {
          version.capacityStatus = to;
        });
        if (!Array.isArray(offer.statusHistory)) offer.statusHistory = [];
        const at = nowIso();
        offer.statusHistory.push({
          from,
          to,
          actor: actorSub,
          at,
          version: written.n,
        });
        pushAudit(draft, {
          event: "offer.capacity_status",
          actor: { sub: actorSub, companyId, role: "seller" },
          subject: { offerId: offer.id, version: written.n },
          detail: { from, to },
          at,
        });
        return { ok: true, offer: structuredClone(offer) };
      });
    },
    setOfferState(companyId, id, to, actorSub, today) {
      return api.transact((draft) => {
        const result = applyOfferState(draft, companyId, id, to, actorSub, today);
        if (!result.ok) return result;
        return { ok: true, offer: structuredClone(result.offer) };
      });
    },
    // C-8. One entry per published, frozen, non-expired offer. `view` is the
    // buyer projection only. A C-7 version nests commercial terms under
    // `terms`, and buyerView reads those fields from the top level, so the
    // call spreads the terms and adds the version's capacity status.
    listPublishedOffers(today) {
      if (!isCalendarDate(today)) throw new TypeError("today must be a YYYY-MM-DD date");
      return api.view((draft) => {
        const entries = [];
        const offers = draft && draft.offers ? draft.offers : {};
        for (const offer of Object.values(offers)) {
          if (!offer || offer.state !== "published") continue;
          if (effectiveState(offer, today) === "expired") continue;
          const version = currentVersion(offer);
          if (!version || version.frozen !== true) continue;
          const terms = version.terms && typeof version.terms === "object" ? version.terms : {};
          entries.push({
            id: offer.id,
            version: version.n,
            view: buyerView({
              ...terms,
              capacityStatus: version.capacityStatus,
            }),
            companyId: offer.companyId,
          });
        }
        entries.sort((left, right) => String(left.id).localeCompare(String(right.id)));
        return entries;
      });
    },
    availableQuantity(offer) {
      const id = offer && typeof offer.id === "string" ? offer.id : "";
      if (!id) return 0;
      return api.view((draft) => quantityAvailable(draft, id));
    },
    effectiveRequestState(request, offer) {
      return effectiveRequestState(request, offer);
    },
    createRequest(buyerIdentity, offerId, pinnedVersion, quantity, today) {
      requireToday(today);
      const buyerCompanyId = buyerIdentity && buyerIdentity.companyId;
      const buyerSub = buyerIdentity && buyerIdentity.sub;
      return api.transact((draft) => {
        const offer = draft.offers[offerId];
        if (!offer) return { ok: false, error: "not_found" };
        if (offer.companyId === buyerCompanyId) return { ok: false, error: "own_offer" };
        const issue = requestIssue(offer, today);
        if (issue) return { ok: false, error: issue };
        const version = currentVersion(offer);
        if (!version || version.n !== pinnedVersion) return { ok: false, error: "stale_version" };
        if (!positiveInt(quantity)) return { ok: false, error: "bad_quantity" };
        if (quantity > quantityAvailable(draft, offer.id)) return { ok: false, error: "unavailable" };
        const id = crypto.randomUUID();
        const at = nowIso();
        const request = {
          id,
          offerId: offer.id,
          version: version.n,
          createdAt: at,
          sellerCompanyId: offer.companyId,
          buyerCompanyId,
          buyerSub,
          buyerCompanyName: companyNameOf(buyerIdentity),
          sellerCompanyName: null,
          quantity,
          state: "pending",
          counters: [],
          history: [{ from: null, to: "pending", actor: buyerSub, at, counter: null }],
          acceptance: null,
          fulfilment: null,
        };
        if (!isPlainObject(draft.requests)) draft.requests = {};
        draft.requests[id] = request;
        pushAudit(draft, {
          event: "request.created",
          actor: { sub: buyerSub, companyId: buyerCompanyId, role: "buyer" },
          subject: { offerId: offer.id, requestId: id, version: version.n },
          detail: { quantity },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    counterRequest(sellerIdentity, requestId, proposal, today) {
      requireToday(today);
      const companyId = sellerIdentity && sellerIdentity.companyId;
      const actor = sellerIdentity && sellerIdentity.sub;
      const spec = proposal && typeof proposal === "object" ? proposal : {};
      return api.transact((draft) => {
        const request = draft.requests && draft.requests[requestId];
        if (!request || partyRole(request, companyId) === "") return { ok: false, error: "not_found" };
        if (partyRole(request, companyId) !== "seller") return { ok: false, error: "forbidden" };
        if (isFinalState(request.state)) return { ok: false, error: "final" };
        if (request.state !== "pending") return { ok: false, error: "forbidden" };
        const offer = draft.offers[request.offerId];
        if (!offer) return { ok: false, error: "not_found" };
        if (effectiveState(offer, today) === "expired") return { ok: false, error: "expired" };
        const version = currentVersion(offer);
        if (!version || version.n !== request.version) return { ok: false, error: "superseded" };
        const quantity = positiveInt(spec.quantity);
        const unitBuyerMinor = positiveInt(spec.unitBuyerMinor);
        if (!quantity) return { ok: false, error: "bad_quantity" };
        if (!unitBuyerMinor) return { ok: false, error: "bad_price" };
        if (typeof spec.serviceTerms !== "string" || spec.serviceTerms.length > LIMITS.serviceTerms) {
          return { ok: false, error: "bad_terms" };
        }
        const n = (latestCounter(request) ? latestCounter(request).n : 0) + 1;
        const at = nowIso();
        rememberSellerName(request, sellerIdentity);
        if (!Array.isArray(request.counters)) request.counters = [];
        request.counters.push({
          n,
          quantity,
          unitBuyerMinor,
          serviceTerms: spec.serviceTerms,
          at,
          by: actor,
        });
        const from = request.state;
        request.state = "countered";
        if (!Array.isArray(request.history)) request.history = [];
        request.history.push({ from, to: "countered", actor, at, counter: n });
        pushAudit(draft, {
          event: "request.countered",
          actor: { sub: actor, companyId, role: "seller" },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { counter: n, quantity },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    acceptRequest(identity, requestId, today) {
      requireToday(today);
      // Availability is read and the acceptance is written in this one
      // synchronous transact. Do not check quantity before the call and do
      // not await between the check and the write.
      return api.transact((draft) => applyAccept(draft, identity, requestId, today));
    },
    declineRequest(identity, requestId) {
      const companyId = identity && identity.companyId;
      const actor = identity && identity.sub;
      return api.transact((draft) => {
        const request = draft.requests && draft.requests[requestId];
        if (!request || partyRole(request, companyId) === "") return { ok: false, error: "not_found" };
        const role = partyRole(request, companyId);
        if (isFinalState(request.state)) return { ok: false, error: "final" };
        const sellerDeclines = role === "seller" && (request.state === "pending" || request.state === "countered");
        const buyerDeclines = role === "buyer" && request.state === "countered";
        if (!sellerDeclines && !buyerDeclines) return { ok: false, error: "forbidden" };
        const counter = request.state === "countered" ? latestCounter(request) : null;
        const at = nowIso();
        const from = request.state;
        request.state = "declined";
        if (!Array.isArray(request.history)) request.history = [];
        request.history.push({
          from,
          to: "declined",
          actor,
          at,
          counter: counter ? counter.n : null,
        });
        pushAudit(draft, {
          event: "request.declined",
          actor: { sub: actor, companyId, role: sellerDeclines ? "seller" : "buyer" },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { from, to: "declined", counter: counter ? counter.n : undefined },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    withdrawRequest(buyerIdentity, requestId) {
      const companyId = buyerIdentity && buyerIdentity.companyId;
      const actor = buyerIdentity && buyerIdentity.sub;
      return api.transact((draft) => {
        const request = draft.requests && draft.requests[requestId];
        if (!request || partyRole(request, companyId) === "") return { ok: false, error: "not_found" };
        if (partyRole(request, companyId) !== "buyer") return { ok: false, error: "forbidden" };
        if (isFinalState(request.state)) return { ok: false, error: "final" };
        if (request.state !== "pending" && request.state !== "countered") return { ok: false, error: "forbidden" };
        const counter = request.state === "countered" ? latestCounter(request) : null;
        const at = nowIso();
        const from = request.state;
        request.state = "withdrawn";
        if (!Array.isArray(request.history)) request.history = [];
        request.history.push({
          from,
          to: "withdrawn",
          actor,
          at,
          counter: counter ? counter.n : null,
        });
        pushAudit(draft, {
          event: "request.withdrawn",
          actor: { sub: actor, companyId, role: "buyer" },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { from, to: "withdrawn", counter: counter ? counter.n : undefined },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    recordCarrierStatus(identity, requestId, to, note) {
      const text = boundedText(note);
      return api.transact((draft) => {
        const loaded = partyOnAccepted(draft, identity, requestId);
        if (loaded.error) return loaded;
        if (!text.ok) return { ok: false, error: "bad_note" };
        const { request, role, companyId, sub } = loaded;
        const from = request.fulfilment.status;
        if (from === "cancelled" || from === "completed") return { ok: false, error: "final" };
        if (!CARRIER_EDGES.has(`${from}>${to}`)) return { ok: false, error: "illegal_transition" };
        const at = nowIso();
        if (!Array.isArray(request.fulfilment.history)) request.fulfilment.history = [];
        request.fulfilment.history.push({
          from,
          to,
          actorSub: sub,
          actorCompanyId: companyId,
          role,
          at,
          note: text.text,
        });
        request.fulfilment.status = to;
        pushAudit(draft, {
          event: "fulfilment.status",
          actor: { sub, companyId, role },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { from, to },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    proposeCancellation(identity, requestId, reason) {
      const text = boundedText(reason);
      return api.transact((draft) => {
        const loaded = partyOnAccepted(draft, identity, requestId);
        if (loaded.error) return loaded;
        if (!text.ok) return { ok: false, error: "bad_reason" };
        const { request, role, companyId, sub } = loaded;
        if (!cancellationOpen(request)) return { ok: false, error: "final" };
        const current = request.fulfilment.cancellation;
        if (current && current.state === "proposed") return { ok: false, error: "forbidden" };
        const at = nowIso();
        request.fulfilment.cancellation = {
          state: "proposed",
          proposedByCompanyId: companyId,
          proposedBySub: sub,
          proposedAt: at,
          reason: text.text,
          respondedByCompanyId: null,
          respondedBySub: null,
          respondedAt: null,
        };
        appendCancellation(request, {
          event: "proposed",
          byCompanyId: companyId,
          bySub: sub,
          role,
          at,
          reason: text.text,
        });
        pushAudit(draft, {
          event: "cancellation.proposed",
          actor: { sub, companyId, role },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: {},
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    withdrawCancellation(identity, requestId) {
      return api.transact((draft) => {
        const loaded = partyOnAccepted(draft, identity, requestId);
        if (loaded.error) return loaded;
        const { request, role, companyId, sub } = loaded;
        if (!cancellationOpen(request)) return { ok: false, error: "final" };
        const current = request.fulfilment.cancellation;
        if (!current || current.state !== "proposed") return { ok: false, error: "forbidden" };
        if (current.proposedByCompanyId !== companyId) return { ok: false, error: "forbidden" };
        const at = nowIso();
        request.fulfilment.cancellation = null;
        appendCancellation(request, {
          event: "withdrawn",
          byCompanyId: companyId,
          bySub: sub,
          role,
          at,
          reason: "",
        });
        pushAudit(draft, {
          event: "cancellation.withdrawn",
          actor: { sub, companyId, role },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: {},
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    agreeCancellation(identity, requestId) {
      return api.transact((draft) => {
        const loaded = partyOnAccepted(draft, identity, requestId);
        if (loaded.error) return loaded;
        const { request, role, companyId, sub } = loaded;
        if (!cancellationOpen(request)) return { ok: false, error: "final" };
        const current = request.fulfilment.cancellation;
        if (!current || current.state !== "proposed") return { ok: false, error: "forbidden" };
        if (current.proposedByCompanyId === companyId) return { ok: false, error: "forbidden" };
        const at = nowIso();
        const from = request.fulfilment.status;
        const reason = typeof current.reason === "string" ? current.reason : "";
        if (!Array.isArray(request.fulfilment.history)) request.fulfilment.history = [];
        request.fulfilment.history.push({
          from,
          to: "cancelled",
          actorSub: sub,
          actorCompanyId: companyId,
          role,
          at,
          note: reason,
        });
        request.fulfilment.status = "cancelled";
        request.fulfilment.cancellation = null;
        appendCancellation(request, {
          event: "agreed",
          byCompanyId: companyId,
          bySub: sub,
          role,
          at,
          reason: "",
        });
        pushAudit(draft, {
          event: "cancellation.agreed",
          actor: { sub, companyId, role },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { from, to: "cancelled" },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    refuseCancellation(identity, requestId) {
      return api.transact((draft) => {
        const loaded = partyOnAccepted(draft, identity, requestId);
        if (loaded.error) return loaded;
        const { request, role, companyId, sub } = loaded;
        if (!cancellationOpen(request)) return { ok: false, error: "final" };
        const current = request.fulfilment.cancellation;
        if (!current || current.state !== "proposed") return { ok: false, error: "forbidden" };
        if (current.proposedByCompanyId === companyId) return { ok: false, error: "forbidden" };
        const at = nowIso();
        current.state = "disputed";
        current.respondedByCompanyId = companyId;
        current.respondedBySub = sub;
        current.respondedAt = at;
        appendCancellation(request, {
          event: "refused",
          byCompanyId: companyId,
          bySub: sub,
          role,
          at,
          reason: "",
        });
        pushAudit(draft, {
          event: "cancellation.refused",
          actor: { sub, companyId, role },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: {},
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    // C-12. The operator records a carrier status. D-20's table applies, the
    // role is operator, and an empty note is refused. Acceptance is not touched.
    operatorRecordCarrierStatus(identity, requestId, to, note) {
      const text = boundedText(note);
      const companyId = identity && identity.companyId;
      const sub = identity && identity.sub;
      return api.transact((draft) => {
        if (!text.ok || text.text.trim() === "") return { ok: false, error: "bad_note" };
        const request = draft.requests && draft.requests[requestId];
        if (!request || request.state !== "accepted" || !isPlainObject(request.fulfilment)) {
          return { ok: false, error: "not_found" };
        }
        if (typeof sub !== "string" || sub === "" || typeof companyId !== "string" || companyId === "") {
          return { ok: false, error: "not_found" };
        }
        const from = request.fulfilment.status;
        if (from === "cancelled" || from === "completed") return { ok: false, error: "final" };
        if (!CARRIER_EDGES.has(`${from}>${to}`)) return { ok: false, error: "illegal_transition" };
        const at = nowIso();
        if (!Array.isArray(request.fulfilment.history)) request.fulfilment.history = [];
        request.fulfilment.history.push({
          from,
          to,
          actorSub: sub,
          actorCompanyId: companyId,
          role: "operator",
          at,
          note: text.text,
        });
        request.fulfilment.status = to;
        pushAudit(draft, {
          event: "fulfilment.status",
          actor: { sub, companyId, role: "operator" },
          subject: { offerId: request.offerId, requestId: request.id, version: request.version },
          detail: { from, to },
          at,
        });
        return { ok: true, request: structuredClone(request) };
      });
    },
    companyKeyFor(companyId) {
      return api.view((draft) => {
        const company = companyBucket(draft, companyId);
        return company && typeof company.companyKey === "string" ? company.companyKey : null;
      });
    },
    walletsFor(companyId) {
      return api.view((draft) => {
        const company = companyBucket(draft, companyId);
        return company && Array.isArray(company.wallets) ? structuredClone(company.wallets) : [];
      });
    },
    // The company key is created once, inside this transaction, and never rotated.
    ensureCompanyKey(companyId) {
      if (typeof companyId !== "string" || companyId === "") return { ok: false, error: "not_found" };
      return api.transact((draft) => {
        if (!isPlainObject(draft.companies)) draft.companies = {};
        let company = draft.companies[companyId];
        if (isPlainObject(company) && typeof company.companyKey === "string" && company.companyKey !== "") {
          if (!Array.isArray(company.wallets)) company.wallets = [];
          return {
            ok: true,
            created: false,
            companyKey: company.companyKey,
            createdAt: company.createdAt,
          };
        }
        const createdAt = nowIso();
        const companyKey = `0x${crypto.randomBytes(32).toString("hex")}`;
        if (!isPlainObject(company)) {
          company = { companyKey, createdAt, wallets: [] };
          draft.companies[companyId] = company;
        } else {
          company.companyKey = companyKey;
          if (typeof company.createdAt !== "string") company.createdAt = createdAt;
          if (!Array.isArray(company.wallets)) company.wallets = [];
        }
        return { ok: true, created: true, companyKey, createdAt: company.createdAt };
      });
    },
    // Cap, in-flight and duplicate checks share the write, so two binds cannot both pass.
    beginWalletBind(companyId, fields) {
      const spec = fields && typeof fields === "object" ? fields : {};
      return api.transact((draft) => {
        const company = companyBucket(draft, companyId);
        if (!company || typeof company.companyKey !== "string" || company.companyKey === "") {
          return { ok: false, error: "no_key" };
        }
        if (!Array.isArray(company.wallets)) company.wallets = [];
        const active = activeWallets(company);
        if (active.some((entry) => entry.state === "submitting" || entry.state === "pending")) {
          return { ok: false, error: "in_flight" };
        }
        if (active.length >= WALLET_CAP) return { ok: false, error: "cap" };
        if (active.some((entry) => sameWallet(entry.wallet, spec.wallet))) {
          return { ok: false, error: "already" };
        }
        const at = nowIso();
        company.wallets.push({
          wallet: spec.wallet,
          boundBy: spec.boundBy,
          state: "submitting",
          deadline: spec.deadline,
          txHash: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        });
        return { ok: true, companyKey: company.companyKey };
      });
    },
    finishWalletBind(companyId, wallet, patch) {
      const spec = patch && typeof patch === "object" ? patch : {};
      return api.transact((draft) => {
        const company = companyBucket(draft, companyId);
        if (!company || !Array.isArray(company.wallets)) return { ok: false, error: "not_found" };
        // A check can move the row off `submitting` while submit is still in flight.
        const open = company.wallets.filter((item) => {
          return item && sameWallet(item.wallet, wallet) && (
            item.state === "submitting"
            || item.state === "pending"
            || item.state === "expired"
            || item.state === "confirmed"
            || item.state === "reverted"
          );
        });
        const entry = open.find((item) => item.state === "submitting") || open[open.length - 1];
        if (!entry) return { ok: false, error: "not_found" };
        const at = nowIso();
        const othersInFlight = company.wallets.some((item) => {
          return item && item !== entry && (item.state === "submitting" || item.state === "pending");
        });
        // A newer bind has the single in-flight slot. Do not revive this row.
        if (entry.state !== "submitting" && othersInFlight) {
          if (entry.state === "confirmed" && spec.txHash && !entry.txHash) {
            entry.txHash = spec.txHash;
            entry.updatedAt = at;
            return { ok: true, entry: structuredClone(entry) };
          }
          return { ok: false, error: "superseded" };
        }
        const alreadyConfirmed = entry.state === "confirmed";
        if (alreadyConfirmed && spec.state !== "confirmed") {
          if (spec.txHash && !entry.txHash) entry.txHash = spec.txHash;
          entry.updatedAt = at;
          return { ok: true, entry: structuredClone(entry) };
        }
        entry.state = spec.state;
        entry.updatedAt = at;
        if (Object.prototype.hasOwnProperty.call(spec, "txHash") && (spec.txHash || !entry.txHash)) {
          entry.txHash = spec.txHash;
        }
        if (Object.prototype.hasOwnProperty.call(spec, "error")) entry.error = spec.error;
        if (spec.audit === true && !alreadyConfirmed) {
          pushAudit(draft, {
            event: "wallet.bound",
            actor: { sub: entry.boundBy, companyId, role: "user" },
            subject: { wallet: entry.wallet },
            detail: {},
            at,
          });
        }
        return { ok: true, entry: structuredClone(entry) };
      });
    },
    applyWalletChecks(companyId, updates) {
      const list = Array.isArray(updates) ? updates : [];
      return api.transact((draft) => {
        const company = companyBucket(draft, companyId);
        if (!company || !Array.isArray(company.wallets)) return [];
        const applied = [];
        for (const update of list) {
          if (!update || typeof update !== "object") continue;
          const entry = company.wallets.find((item) => {
            return item && (item.state === "submitting" || item.state === "pending") && sameWallet(item.wallet, update.wallet);
          });
          if (!entry || entry.state === update.state) continue;
          const at = nowIso();
          entry.state = update.state;
          entry.updatedAt = at;
          if (Object.prototype.hasOwnProperty.call(update, "error")) entry.error = update.error;
          if (update.audit === true) {
            pushAudit(draft, {
              event: "wallet.bound",
              actor: { sub: entry.boundBy, companyId, role: "user" },
              subject: { wallet: entry.wallet },
              detail: {},
              at,
            });
          }
          applied.push(structuredClone(entry));
        }
        return applied;
      });
    },
    chainOfferFor(offerId) {
      return api.view((draft) => {
        const offer = draft.offers && draft.offers[offerId];
        return offer && isPlainObject(offer.chain) ? structuredClone(offer.chain) : null;
      });
    },
    commitmentFor(offerId, n) {
      return api.view((draft) => {
        const offer = draft.offers && draft.offers[offerId];
        if (!offer || !isPlainObject(offer.chain)) return null;
        const version = versionByNumber(offer, n);
        const salt = offer.chain.salts && offer.chain.salts[String(n)];
        if (!version || typeof salt !== "string") return null;
        try {
          return commitmentForVersion(offer.id, version, salt);
        } catch {
          return null;
        }
      });
    },
    chainStepFor(companyId, id, today, nowSec) {
      return api.view((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer) return null;
        return nextChainStep(offer, today, nowSec);
      });
    },
    // offerKey and the next version's salt are created here, inside one POST.
    prepareChainOffer(companyId, id, actorSub) {
      if (typeof companyId !== "string" || companyId === "") return { ok: false, error: "not_found" };
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer) return { ok: false, error: "not_found" };
        if (!isPlainObject(offer.chain)) {
          if (offer.state !== "draft") return { ok: false, error: "not_draft" };
          offer.chain = {
            offerKey: `0x${crypto.randomBytes(32).toString("hex")}`,
            enabledAt: nowIso(),
            enabledBy: actorSub,
            salts: {},
            confirmed: null,
            actions: [],
          };
        }
        const n = saltVersion(offer);
        if (n != null) {
          const key = String(n);
          if (typeof offer.chain.salts[key] !== "string") {
            offer.chain.salts[key] = `0x${crypto.randomBytes(32).toString("hex")}`;
          }
        }
        return { ok: true, offerKey: offer.chain.offerKey, chain: structuredClone(offer.chain) };
      });
    },
    // Publish on a draft also publishes off-chain. A refusal writes nothing.
    beginChainAction(companyId, id, spec, today, nowSec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer || !isPlainObject(offer.chain)) return { ok: false, error: "not_prepared" };
        const next = nextChainStep(offer, today, nowSec);
        if (next && next.step === "check" && actionInFlight(offer)) return { ok: false, error: "in_flight" };
        if (!next || next.step !== "sign" || !next.action || next.action.kind !== wanted.kind) {
          return { ok: false, error: "not_next" };
        }
        const action = next.action;
        if (action.kind === "version" && action.version !== wanted.version) {
          return { ok: false, error: "not_next" };
        }
        if (action.kind === "state" && (action.to !== wanted.to || action.seq !== wanted.seq)) {
          return { ok: false, error: "not_next" };
        }
        const saltKey = action.kind === "publish" ? "1" : (action.kind === "version" ? String(action.version) : null);
        if (saltKey && typeof offer.chain.salts[saltKey] !== "string") return { ok: false, error: "no_salt" };
        if (action.kind === "publish" && offer.state === "draft") {
          const published = applyOfferState(draft, companyId, id, "published", wanted.actorSub, today);
          if (!published.ok) return published;
        }
        const at = nowIso();
        const entry = {
          id: crypto.randomUUID(),
          kind: action.kind,
          version: action.version,
          to: action.to,
          seq: action.seq,
          signer: wanted.signer,
          deadline: wanted.deadline,
          status: "submitting",
          txHash: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        };
        if (!Array.isArray(offer.chain.actions)) offer.chain.actions = [];
        offer.chain.actions.push(entry);
        return { ok: true, action: structuredClone(entry) };
      });
    },
    beginChainExpire(companyId, id, today, nowSec) {
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, id);
        if (!offer || !isPlainObject(offer.chain)) return { ok: false, error: "not_prepared" };
        const next = nextChainStep(offer, today, nowSec);
        if (!next || next.step !== "check" || next.expire !== true) return { ok: false, error: "not_due" };
        const at = nowIso();
        const version = offer.chain.confirmed ? offer.chain.confirmed.version : null;
        const entry = {
          id: crypto.randomUUID(),
          kind: "expire",
          version,
          to: "expired",
          seq: null,
          signer: null,
          deadline: null,
          status: "submitting",
          txHash: null,
          error: null,
          createdAt: at,
          updatedAt: at,
        };
        if (!Array.isArray(offer.chain.actions)) offer.chain.actions = [];
        offer.chain.actions.push(entry);
        return { ok: true, action: structuredClone(entry) };
      });
    },
    finishChainAction(companyId, offerId, actionId, patch) {
      const spec = patch && typeof patch === "object" ? patch : {};
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, offerId);
        if (!offer || !isPlainObject(offer.chain) || !Array.isArray(offer.chain.actions)) {
          return { ok: false, error: "not_found" };
        }
        const entry = offer.chain.actions.find((item) => item && item.id === actionId);
        if (!entry) return { ok: false, error: "not_found" };
        const at = nowIso();
        const othersInFlight = offer.chain.actions.some((item) => {
          return item && item !== entry && (item.status === "submitting" || item.status === "pending");
        });
        // A newer action has the single in-flight slot. Do not revive this row.
        if (entry.status !== "submitting" && othersInFlight) {
          if (entry.status === "confirmed" && spec.txHash && !entry.txHash) {
            entry.txHash = spec.txHash;
            entry.updatedAt = at;
            return { ok: true, entry: structuredClone(entry) };
          }
          return { ok: false, error: "superseded" };
        }
        const already = entry.status === "confirmed";
        if (already && spec.state !== "confirmed") {
          if (spec.txHash && !entry.txHash) entry.txHash = spec.txHash;
          entry.updatedAt = at;
          return { ok: true, entry: structuredClone(entry) };
        }
        entry.status = spec.state;
        entry.updatedAt = at;
        if (Object.prototype.hasOwnProperty.call(spec, "txHash") && (spec.txHash || !entry.txHash)) {
          entry.txHash = spec.txHash;
        }
        if (Object.prototype.hasOwnProperty.call(spec, "error")) entry.error = spec.error;
        if (spec.state === "confirmed" && !already) {
          applyConfirmed(offer, entry);
          const version = entry.version || (offer.chain.confirmed && offer.chain.confirmed.version) || null;
          pushAudit(draft, {
            event: "offer.chain_recorded",
            actor: {
              sub: spec.actorSub,
              companyId,
              role: "seller",
            },
            subject: { offerId: offer.id, version },
            detail: { to: chainAuditTo(entry) },
            at,
          });
        }
        return { ok: true, entry: structuredClone(entry) };
      });
    },
    applyChainChecks(companyId, offerId, updates) {
      const list = Array.isArray(updates) ? updates : [];
      return api.transact((draft) => {
        const offer = findOwned(draft, companyId, offerId);
        if (!offer || !isPlainObject(offer.chain) || !Array.isArray(offer.chain.actions)) return [];
        const applied = [];
        for (const update of list) {
          if (!update || typeof update !== "object") continue;
          const entry = offer.chain.actions.find((item) => {
            return item && item.id === update.id && (item.status === "submitting" || item.status === "pending");
          });
          if (!entry || entry.status === update.state) continue;
          const at = nowIso();
          entry.status = update.state;
          entry.updatedAt = at;
          if (Object.prototype.hasOwnProperty.call(update, "error")) entry.error = update.error;
          if (update.txHash && !entry.txHash) entry.txHash = update.txHash;
          if (update.state === "confirmed") {
            applyConfirmed(offer, entry);
            const version = entry.version || (offer.chain.confirmed && offer.chain.confirmed.version) || null;
            pushAudit(draft, {
              event: "offer.chain_recorded",
              actor: { sub: update.actorSub, companyId, role: "seller" },
              subject: { offerId: offer.id, version },
              detail: { to: chainAuditTo(entry) },
              at,
            });
          }
          applied.push(structuredClone(entry));
        }
        return applied;
      });
    },
    // Authentication events are not records changes. Each one is its own transact.
    appendAudit(event, actor, detail) {
      return api.transact((draft) => {
        const entry = auditEntry({ event, actor, subject: {}, detail, at: nowIso() });
        if (!Array.isArray(draft.audit)) draft.audit = [];
        draft.audit.push(entry);
        return structuredClone(entry);
      });
    },
    chainRequestFor(requestId) {
      return api.view((draft) => {
        const request = draft.requests && draft.requests[requestId];
        return chainRequestPublic(request && request.chain);
      });
    },
    requestChainStep(companyId, requestId, nowSec) {
      return api.view((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request) return null;
        const offer = draft.offers[request.offerId] || null;
        return nextRequestChainStep(draft, request, offer, companyId, nowSec);
      });
    },
    acceptanceTermsHash(requestId, today) {
      return api.view((draft) => termsHashForRequest(draft, requestId, today));
    },
    previewAcceptance(identity, requestId, today) {
      return api.view((draft) => {
        const plan = acceptancePlan(draft, identity, requestId, today);
        if (!plan.ok) return plan;
        return {
          ok: true,
          termsHash: plan.termsHash,
          counter: plan.counterN,
          chainCounter: chainCounterOf(plan.counterN),
        };
      });
    },
    prepareChainRequest(companyId, requestId, actorSub) {
      if (typeof companyId !== "string" || companyId === "") return { ok: false, error: "not_found" };
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request) return { ok: false, error: "not_found" };
        const offer = draft.offers[request.offerId];
        if (!offer || !isPlainObject(offer.chain)) return { ok: false, error: "off_chain" };
        if (!isPlainObject(request.chain)) {
          request.chain = {
            requestKey: `0x${crypto.randomBytes(32).toString("hex")}`,
            linkedBy: actorSub,
            createdAt: nowIso(),
            salts: {},
            proposals: {},
            cancelProposal: null,
            confirmed: null,
            actions: [],
          };
        }
        const key = counterKeyOf(currentCounterN(request));
        if (typeof request.chain.salts[key] !== "string") {
          request.chain.salts[key] = `0x${crypto.randomBytes(32).toString("hex")}`;
        }
        return { ok: true, requestKey: request.chain.requestKey, chain: chainRequestPublic(request.chain) };
      });
    },
    beginChainRequest(companyId, requestId, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain)) return { ok: false, error: "not_prepared" };
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (requestLinked(request)) return { ok: false, error: "not_next" };
        if (partyRole(request, companyId) !== "buyer") return { ok: false, error: "not_signer" };
        const entry = newRequestAction({
          kind: "request",
          signers: [wanted.signer],
          deadline: wanted.deadline,
        });
        pushRequestAction(request, entry);
        return { ok: true, action: structuredClone(entry) };
      });
    },
    storeChainProposal(companyId, requestId, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain) || !requestLinked(request)) {
          return { ok: false, error: "not_next" };
        }
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (acceptanceRecorded(request)) return { ok: false, error: "not_next" };
        const counterN = currentCounterN(request);
        const proposeRole = counterN == null ? "buyer" : "seller";
        if (partyRole(request, companyId) !== proposeRole) return { ok: false, error: "not_signer" };
        const key = counterKeyOf(counterN);
        if (typeof request.chain.salts[key] !== "string") return { ok: false, error: "no_salt" };
        if (!isPlainObject(request.chain.proposals)) request.chain.proposals = {};
        request.chain.proposals[key] = {
          signer: wanted.signer,
          deadline: wanted.deadline,
          signature: wanted.signature,
          termsHash: wanted.termsHash,
          at: nowIso(),
        };
        return { ok: true, counter: counterN, termsHash: wanted.termsHash };
      });
    },
    // Off-chain accept and the submitting acceptance row share one transaction.
    beginChainAcceptance(identity, requestId, today, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      const companyId = identity && identity.companyId;
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain)) return { ok: false, error: "not_prepared" };
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (acceptanceRecorded(request)) return { ok: false, error: "not_next" };
        if (!requestLinked(request)) return { ok: false, error: "unlinked" };
        const counterN = currentCounterN(request);
        const proposeRole = counterN == null ? "buyer" : "seller";
        const acceptRole = proposeRole === "buyer" ? "seller" : "buyer";
        if (partyRole(request, companyId) !== acceptRole) return { ok: false, error: "not_signer" };
        const key = counterKeyOf(counterN);
        const proposal = request.chain.proposals && request.chain.proposals[key];
        if (!proposalOpen(proposal, wanted.nowSec)) return { ok: false, error: "expired_proposal" };
        if (request.state === "accepted") {
          if (!request.acceptance || request.acceptance.termsHash !== proposal.termsHash) {
            return { ok: false, error: "terms" };
          }
          if (currentCounterN(request) !== counterN && counterKeyOf(request.acceptance.counter) !== key) {
            return { ok: false, error: "terms" };
          }
        } else {
          const plan = acceptancePlan(draft, identity, requestId, today);
          if (!plan.ok) return plan;
          if (plan.termsHash !== proposal.termsHash || counterKeyOf(plan.counterN) !== key) {
            return { ok: false, error: "terms" };
          }
          const applied = applyAccept(draft, identity, requestId, today);
          if (!applied.ok) return applied;
        }
        const live = draft.requests[requestId];
        const entry = newRequestAction({
          kind: "acceptance",
          counter: live.acceptance.counter == null ? null : live.acceptance.counter,
          signers: [proposal.signer, wanted.signer],
          deadline: proposal.deadline,
        });
        pushRequestAction(live, entry);
        return {
          ok: true,
          action: structuredClone(entry),
          termsHash: live.acceptance.termsHash,
          signature: proposal.signature,
          deadline: proposal.deadline,
          counter: chainCounterOf(live.acceptance.counter),
        };
      });
    },
    beginChainStatus(companyId, requestId, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain)) return { ok: false, error: "not_prepared" };
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (!acceptanceRecorded(request)) return { ok: false, error: "not_next" };
        if (request.fulfilment && request.fulfilment.status === "cancelled" && request.chain.confirmed.cancelled !== true) {
          return { ok: false, error: "not_next" };
        }
        const next = statusStep(request);
        if (!next || next.step !== "sign" || next.kind !== "status") return { ok: false, error: "not_next" };
        if (next.status !== wanted.status || next.seq !== wanted.seq) return { ok: false, error: "not_next" };
        const entry = newRequestAction({
          kind: "status",
          to: next.status,
          seq: next.seq,
          signers: [wanted.signer],
          deadline: wanted.deadline,
        });
        pushRequestAction(request, entry);
        return { ok: true, action: structuredClone(entry) };
      });
    },
    storeChainCancellation(companyId, requestId, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain)) return { ok: false, error: "not_prepared" };
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (!acceptanceRecorded(request)) return { ok: false, error: "not_next" };
        if (!request.fulfilment || request.fulfilment.status !== "cancelled") return { ok: false, error: "not_next" };
        if (request.chain.confirmed && request.chain.confirmed.cancelled === true) return { ok: false, error: "not_next" };
        if (proposalOpen(request.chain.cancelProposal, wanted.nowSec)) return { ok: false, error: "not_next" };
        request.chain.cancelProposal = {
          signer: wanted.signer,
          deadline: wanted.deadline,
          signature: wanted.signature,
          at: nowIso(),
        };
        return { ok: true };
      });
    },
    beginChainCancellation(companyId, requestId, spec) {
      const wanted = spec && typeof spec === "object" ? spec : {};
      return api.transact((draft) => {
        const request = loadPartyRequest(draft, companyId, requestId);
        if (!request || !isPlainObject(request.chain)) return { ok: false, error: "not_prepared" };
        if (requestActionInFlight(request)) return { ok: false, error: "in_flight" };
        if (!request.fulfilment || request.fulfilment.status !== "cancelled") return { ok: false, error: "not_next" };
        if (request.chain.confirmed && request.chain.confirmed.cancelled === true) return { ok: false, error: "not_next" };
        const proposal = request.chain.cancelProposal;
        if (!proposalOpen(proposal, wanted.nowSec)) return { ok: false, error: "expired_proposal" };
        const firstIsBuyer = confirmedWallet(draft, request.buyerCompanyId, proposal.signer);
        const firstIsSeller = confirmedWallet(draft, request.sellerCompanyId, proposal.signer);
        const role = partyRole(request, companyId);
        const second = (role === "buyer" && firstIsSeller) || (role === "seller" && firstIsBuyer);
        if (!second) return { ok: false, error: "not_next" };
        if (sameWallet(proposal.signer, wanted.signer)) return { ok: false, error: "not_signer" };
        const entry = newRequestAction({
          kind: "cancellation",
          signers: [proposal.signer, wanted.signer],
          deadline: proposal.deadline,
        });
        pushRequestAction(request, entry);
        return { ok: true, action: structuredClone(entry), signature: proposal.signature, deadline: proposal.deadline };
      });
    },
    finishChainRequest(companyId, requestId, actionId, patch) {
      const spec = patch && typeof patch === "object" ? patch : {};
      return api.transact((draft) => finishRequestAction(draft, companyId, requestId, actionId, spec, false));
    },
    applyChainRequestChecks(companyId, requestId, updates) {
      const list = Array.isArray(updates) ? updates : [];
      return api.transact((draft) => {
        const applied = [];
        for (const update of list) {
          if (!update || typeof update !== "object") continue;
          const result = finishRequestAction(draft, companyId, requestId, update.id, {
            state: update.state,
            txHash: update.txHash,
            error: update.error,
            actorSub: update.actorSub,
          }, true);
          if (result.ok) applied.push(result.entry);
        }
        return applied;
      });
    },
    listRequestsFor(companyId) {
      return api.view((draft) => {
        const requests = draft && isPlainObject(draft.requests) ? draft.requests : {};
        return Object.values(requests)
          .filter((request) => request && partyRole(request, companyId) !== "")
          .sort((left, right) => {
            const byTime = String(right.createdAt).localeCompare(String(left.createdAt));
            if (byTime !== 0) return byTime;
            return String(right.id).localeCompare(String(left.id));
          })
          .map((request) => structuredClone(request));
      });
    },
    getRequestFor(companyId, requestId) {
      return api.view((draft) => {
        const request = draft.requests && draft.requests[requestId];
        if (!request || partyRole(request, companyId) === "") return null;
        return structuredClone(request);
      });
    },
  };
  return api;
}

function partyOnAccepted(draft, identity, requestId) {
  const companyId = identity && identity.companyId;
  const request = draft.requests && draft.requests[requestId];
  if (!request || partyRole(request, companyId) === "") return { ok: false, error: "not_found" };
  if (request.state !== "accepted" || !isPlainObject(request.fulfilment)) return { ok: false, error: "not_accepted" };
  return {
    request,
    role: partyRole(request, companyId),
    companyId,
    sub: identity && identity.sub,
  };
}

function cancellationOpen(request) {
  const status = request.fulfilment && request.fulfilment.status;
  return status !== "completed" && status !== "cancelled";
}

function appendCancellation(request, event) {
  if (!Array.isArray(request.fulfilment.cancellationEvents)) request.fulfilment.cancellationEvents = [];
  request.fulfilment.cancellationEvents.push(event);
}

module.exports = {
  openRecords,
  SCHEMA_VERSION,
  effectiveState,
  effectiveRequestState,
  currentVersion,
  nextCarrierStatuses,
  BAK_SUFFIX,
  M3_BAK_SUFFIX,
  M4_BAK_SUFFIX,
  M5_BAK_SUFFIX,
  M6_BAK_SUFFIX,
  M7_BAK_SUFFIX,
  nextChainStep,
  nextRequestChainStep,
};
