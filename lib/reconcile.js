"use strict";

const crypto = require("node:crypto");
const { commitmentForVersion, commitmentFromTermsHash } = require("./commitment");
const { sameAddress, sameHex } = require("./chain/hex");

const ZERO = "0x" + "00".repeat(32);
const FAILED = new Set(["expired", "refused", "reverted"]);
const OPEN = new Set(["submitting", "pending", "confirmed"]);
const CHAIN_STATUS = Object.freeze({
  carrier_pending: 3,
  carrier_confirmed: 4,
  rejected: 5,
  rolled: 6,
  completed: 7,
  cancelled: 8,
});
const OFFER_CHAIN_STATE = Object.freeze({
  1: "published",
  2: "paused",
  4: "expired",
});
const REQUEST_CHAIN_STATUS = Object.freeze({
  1: "requested",
  2: "accepted",
  3: "carrier_pending",
  4: "carrier_confirmed",
  5: "rejected",
  6: "rolled",
  7: "completed",
  8: "cancelled",
});

function compareRecords(snapshot, events, views) {
  const list = Array.isArray(events) ? events : [];
  const read = views && typeof views === "object" ? views : {};
  const findings = [];
  for (const item of walletFindings(snapshot, list, read.wallets || {})) findings.push(item);
  for (const item of offerFindings(snapshot, list, read.offers || {})) findings.push(item);
  for (const item of requestFindings(snapshot, list, read.requests || {})) findings.push(item);
  for (const item of unknownFindings(snapshot, list)) findings.push(item);
  return findings;
}

function walletFindings(snapshot, events, wallets) {
  const findings = [];
  for (const [companyId, company] of Object.entries(companiesOf(snapshot))) {
    if (!company || !Array.isArray(company.wallets)) continue;
    for (const entry of company.wallets) {
      if (!entry || typeof entry.wallet !== "string") continue;
      const key = entry.wallet.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(wallets, key)) continue;
      const chainKey = wallets[key];
      const bound = !isZero(chainKey);
      const own = bound && sameHex(chainKey, company.companyKey);
      const revoked = events.findLast((event) => {
        return event && event.name === "WalletRevoked" && sameAddress(event.args && event.args.wallet, entry.wallet);
      });
      const boundEvent = events.findLast((event) => {
        return event && event.name === "WalletBound"
          && sameAddress(event.args && event.args.wallet, entry.wallet)
          && sameHex(event.args && event.args.companyKey, company.companyKey);
      });
      const subject = { companyId, wallet: entry.wallet };
      if (FAILED.has(entry.state) && own) {
        findings.push(makeFinding({
          kind: "mismatch",
          reason: "wallet_bound",
          subject,
          records: entry.state,
          chain: "bound",
          txHash: txOf(boundEvent),
          adoptable: true,
        }));
      } else if (entry.state === "confirmed" && (!bound || revoked)) {
        findings.push(makeFinding({
          kind: "mismatch",
          reason: "wallet_revoked",
          subject,
          records: "confirmed",
          chain: "revoked",
          txHash: txOf(revoked),
          adoptable: true,
        }));
      } else if (bound && !own && (entry.state === "confirmed" || FAILED.has(entry.state))) {
        findings.push(makeFinding({
          kind: "mismatch",
          reason: "wallet_other_company",
          subject,
          records: entry.state,
          chain: "bound to another company",
          txHash: txOf(boundEvent) || txOf(events.findLast((event) => {
            return event && event.name === "WalletBound" && sameAddress(event.args && event.args.wallet, entry.wallet);
          })),
          adoptable: false,
        }));
      }
    }
  }
  return findings;
}

function offerFindings(snapshot, events, offers) {
  const findings = [];
  for (const offer of Object.values(offersOf(snapshot))) {
    if (!offer || !offer.chain || typeof offer.chain.offerKey !== "string") continue;
    const key = offer.chain.offerKey.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(offers, key)) continue;
    const view = asOffer(offers[key]);
    const companyKey = companyKeyFor(snapshot, offer.companyId);
    const actions = Array.isArray(offer.chain.actions) ? offer.chain.actions : [];
    const failed = actions.filter((action) => action && FAILED.has(action.status));
    const landed = failed.filter((action) => offerLanded(offer, action, companyKey, view));
    if (landed.length > 0) {
      for (const action of landed) {
        findings.push(offerFinding(events, offer, action, view, "offer_landed", true));
      }
    } else if (chainOfferExists(view) && !confirmedOfferMatches(offer, companyKey, view)) {
      const miss = failed.map((action) => offerNearMiss(offer, action, companyKey, view)).find(Boolean);
      const action = failed[0];
      findings.push(offerFinding(events, offer, action, view, miss || "offer_unexplained", false));
    }
    if (landed.length === 0) {
      for (const item of offerLag(offer, view)) findings.push(item);
    }
  }
  return findings;
}

function offerFinding(events, offer, action, view, reason, adoptable) {
  const subject = { offerId: offer.id };
  if (offer.companyId) subject.companyId = offer.companyId;
  return makeFinding({
    kind: "mismatch",
    reason,
    subject,
    actionId: action && action.id,
    records: action
      ? `action ${action.kind} ${action.status}`
      : (offer.chain.confirmed ? `confirmed ${offer.chain.confirmed.state} v${offer.chain.confirmed.version}` : "nothing confirmed"),
    chain: offerChainText(view),
    txHash: offerTx(events, offer.chain.offerKey, action),
    adoptable,
  });
}

function offerTx(events, offerKey, action) {
  const names = {
    publish: "OfferPublished",
    version: "VersionPublished",
    state: "OfferStateSet",
    expire: "OfferExpired",
  };
  const name = action && names[action.kind];
  const match = events.findLast((event) => {
    if (!event || !event.args || !sameHex(event.args.offerId, offerKey)) return false;
    return !name || event.name === name;
  });
  return txOf(match);
}

function offerLag(offer, view) {
  const findings = [];
  if (!offer || offer.state === "draft") return findings;
  const actions = offer.chain && Array.isArray(offer.chain.actions) ? offer.chain.actions : [];
  const chainVersion = view && Number.isInteger(view.version) && view.version > 0
    ? view.version
    : (offer.chain.confirmed && offer.chain.confirmed.version) || 0;
  if (Number.isInteger(offer.currentVersion) && offer.currentVersion > chainVersion) {
    const signed = actions.some((action) => {
      return action && (action.kind === "publish" || action.kind === "version")
        && action.version === offer.currentVersion
        && OPEN.has(action.status);
    });
    if (!signed) {
      findings.push(makeFinding({
        kind: "lag",
        reason: "offer_version_unsigned",
        subject: { offerId: offer.id, companyId: offer.companyId },
        records: `version ${offer.currentVersion} not signed`,
        chain: offerChainText(view),
        txHash: null,
        adoptable: false,
      }));
    }
  }
  const chainState = view && OFFER_CHAIN_STATE[view.state];
  if ((offer.state === "published" || offer.state === "paused") && chainState && chainState !== offer.state) {
    const signed = actions.some((action) => {
      return action && action.kind === "state" && action.to === offer.state && OPEN.has(action.status);
    });
    if (!signed) {
      findings.push(makeFinding({
        kind: "lag",
        reason: "offer_state_unsigned",
        subject: { offerId: offer.id, companyId: offer.companyId },
        records: `${offer.state} not signed`,
        chain: offerChainText(view),
        txHash: null,
        adoptable: false,
      }));
    }
  }
  return findings;
}

function requestFindings(snapshot, events, requests) {
  const findings = [];
  const offers = offersOf(snapshot);
  for (const request of Object.values(requestsOf(snapshot))) {
    if (!request || !request.chain || typeof request.chain.requestKey !== "string") continue;
    const key = request.chain.requestKey.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(requests, key)) continue;
    const view = asRequest(requests[key]);
    const offer = offers[request.offerId];
    const buyerKey = companyKeyFor(snapshot, request.buyerCompanyId);
    const actions = Array.isArray(request.chain.actions) ? request.chain.actions : [];
    const failed = actions.filter((action) => action && FAILED.has(action.status));
    const landed = failed.filter((action) => requestLanded(request, offer, buyerKey, action, view));
    if (landed.length > 0) {
      for (const action of landed) {
        findings.push(requestFinding(events, request, action, view, "request_landed", true));
      }
    } else if (chainRequestExists(view) && !confirmedRequestMatches(request, offer, buyerKey, view)) {
      const miss = failed.map((action) => requestNearMiss(request, action, buyerKey, view)).find(Boolean);
      findings.push(requestFinding(events, request, failed[0], view, miss || "request_unexplained", false));
    }
    if (landed.length === 0) {
      for (const item of requestLag(request)) findings.push(item);
    }
  }
  return findings;
}

function requestFinding(events, request, action, view, reason, adoptable) {
  const subject = { requestId: request.id };
  if (request.offerId) subject.offerId = request.offerId;
  return makeFinding({
    kind: "mismatch",
    reason,
    subject,
    actionId: action && action.id,
    records: action
      ? `action ${action.kind} ${action.status}`
      : (request.chain.confirmed ? "confirmed" : "nothing confirmed"),
    chain: requestChainText(view),
    txHash: requestTx(events, request.chain.requestKey, action),
    adoptable,
  });
}

function requestTx(events, requestKey, action) {
  const names = {
    request: "RequestRecorded",
    acceptance: "AcceptanceRecorded",
    status: "StatusRecorded",
    cancellation: "CancellationRecorded",
  };
  const name = action && names[action.kind];
  const match = events.findLast((event) => {
    if (!event || !event.args || !sameHex(event.args.requestId, requestKey)) return false;
    return !name || event.name === name;
  });
  return txOf(match);
}

function requestLag(request) {
  const findings = [];
  const confirmed = request.chain && request.chain.confirmed;
  const seq = confirmed && Number.isInteger(confirmed.statusSeq) ? confirmed.statusSeq : 0;
  const actions = request.chain && Array.isArray(request.chain.actions) ? request.chain.actions : [];
  const history = request.fulfilment && Array.isArray(request.fulfilment.history) ? request.fulfilment.history : [];
  for (let i = seq; i < history.length; i += 1) {
    const entry = history[i];
    const signed = actions.some((action) => {
      return action && action.kind === "status" && action.seq === i && OPEN.has(action.status);
    });
    if (signed) continue;
    const operator = entry && entry.role === "operator";
    findings.push(makeFinding({
      kind: "lag",
      reason: operator ? "operator_status" : "request_status_unsigned",
      subject: { requestId: request.id, offerId: request.offerId },
      actionId: `status:${i}`,
      records: operator ? `operator status ${entry.to}` : `status ${entry && entry.to} not signed`,
      chain: confirmed && confirmed.status ? confirmed.status : "not signed",
      txHash: null,
      adoptable: false,
    }));
  }
  const cancelled = request.fulfilment && request.fulfilment.status === "cancelled";
  if (cancelled && !(confirmed && confirmed.cancelled === true)) {
    const signed = actions.some((action) => action && action.kind === "cancellation" && OPEN.has(action.status));
    if (!signed) {
      findings.push(makeFinding({
        kind: "lag",
        reason: "request_status_unsigned",
        subject: { requestId: request.id, offerId: request.offerId },
        actionId: "cancellation",
        records: "cancellation not signed",
        chain: "not cancelled",
        txHash: null,
        adoptable: false,
      }));
    }
  }
  return findings;
}

function unknownFindings(snapshot, events) {
  const companies = knownCompanyKeys(snapshot);
  const offers = knownOfferKeys(snapshot);
  const requests = knownRequestKeys(snapshot);
  const seen = new Set();
  const findings = [];
  function add(kind, key, event) {
    if (!key || isZero(key)) return;
    const id = `${kind}:${String(key).toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    const subject = {};
    findings.push(makeFinding({
      kind: "unknown",
      reason: kind,
      subject,
      actionId: String(key).toLowerCase(),
      records: "no record",
      chain: `${kind.replace("unknown_", "")} ${key}`,
      txHash: txOf(event),
      adoptable: false,
    }));
  }
  for (const event of events) {
    if (!event || !event.args) continue;
    const args = event.args;
    if (args.offerId && !offers.has(String(args.offerId).toLowerCase())) add("unknown_offer", args.offerId, event);
    if (args.requestId && !requests.has(String(args.requestId).toLowerCase())) add("unknown_request", args.requestId, event);
    if (args.companyKey && !companies.has(String(args.companyKey).toLowerCase())) add("unknown_company", args.companyKey, event);
    if (args.buyerCompany && !companies.has(String(args.buyerCompany).toLowerCase())) {
      add("unknown_company", args.buyerCompany, event);
    }
  }
  return findings;
}

function offerLanded(offer, action, companyKey, view) {
  if (!view || !action || !companyKey || !sameHex(view.companyKey, companyKey) || isZero(view.companyKey)) return false;
  const version = action.kind === "publish" ? 1 : action.version
    || (offer.chain.confirmed && offer.chain.confirmed.version);
  const expected = commitmentOf(offer, version);
  if (!expected || !sameHex(view.commitment, expected)) return false;
  if (action.kind === "publish") return view.version === 1 && view.state === 1;
  if (action.kind === "version") return view.version === action.version;
  if (action.kind === "state") {
    const want = action.to === "paused" ? 2 : 1;
    return view.state === want && view.stateSeq === action.seq + 1;
  }
  if (action.kind === "expire") return view.state === 4;
  return false;
}

function offerNearMiss(offer, action, companyKey, view) {
  if (!view || !action) return null;
  if (!sameHex(view.companyKey, companyKey)) return "offer_company";
  const version = action.kind === "publish" ? 1 : action.version
    || (offer.chain.confirmed && offer.chain.confirmed.version);
  const expected = commitmentOf(offer, version);
  if (expected && view.commitment && !sameHex(view.commitment, expected)) return "offer_commitment";
  if (action.kind === "state" && view.stateSeq !== action.seq + 1) return "offer_seq";
  return null;
}

function requestLanded(request, offer, buyerKey, action, view) {
  if (!view || !action) return false;
  const offerKey = offer && offer.chain && offer.chain.offerKey;
  if (action.kind === "request") {
    return sameHex(view.offerId, offerKey)
      && sameHex(view.buyerCompany, buyerKey)
      && view.version === request.version
      && view.status === 1;
  }
  if (action.kind === "acceptance") {
    const expected = acceptanceCommitment(request, action);
    return view.status === 2 && Boolean(expected) && sameHex(view.termsCommitment, expected);
  }
  if (action.kind === "status") {
    return view.status === CHAIN_STATUS[action.to] && view.statusSeq === action.seq + 1;
  }
  if (action.kind === "cancellation") return view.status === 8;
  return false;
}

function requestNearMiss(request, action, buyerKey, view) {
  if (!view || !action) return null;
  if (action.kind === "request" && !sameHex(view.buyerCompany, buyerKey)) return "request_company";
  if (action.kind === "acceptance") {
    const expected = acceptanceCommitment(request, action);
    if (expected && view.termsCommitment && !sameHex(view.termsCommitment, expected)) return "request_commitment";
  }
  if (action.kind === "status" && view.statusSeq !== action.seq + 1) return "request_seq";
  return null;
}

function confirmedOfferMatches(offer, companyKey, view) {
  const confirmed = offer.chain && offer.chain.confirmed;
  if (!confirmed || !view || !sameHex(view.companyKey, companyKey)) return false;
  if (view.version !== confirmed.version) return false;
  const want = confirmed.state === "paused" ? 2 : confirmed.state === "expired" ? 4 : 1;
  if (view.state !== want) return false;
  if (Number.isInteger(confirmed.stateSeq) && view.stateSeq !== confirmed.stateSeq) return false;
  const expected = commitmentOf(offer, confirmed.version);
  return Boolean(expected) && sameHex(view.commitment, expected);
}

function confirmedRequestMatches(request, offer, buyerKey, view) {
  const confirmed = request.chain && request.chain.confirmed;
  if (!confirmed || confirmed.recorded !== true || !view) return false;
  const offerKey = offer && offer.chain && offer.chain.offerKey;
  if (!sameHex(view.offerId, offerKey) || !sameHex(view.buyerCompany, buyerKey)) return false;
  if (view.version !== request.version) return false;
  if (confirmed.cancelled === true) return view.status === 8;
  if (confirmed.status && confirmed.status !== "accepted") {
    return view.status === CHAIN_STATUS[confirmed.status] && view.statusSeq === confirmed.statusSeq;
  }
  if (confirmed.status === "accepted" || confirmed.acceptedCounter != null) {
    const expected = acceptanceCommitment(request, { counter: confirmed.acceptedCounter });
    return view.status === 2 && Boolean(expected) && sameHex(view.termsCommitment, expected);
  }
  return view.status === 1;
}

function acceptanceCommitment(request, action) {
  const saltKey = !action || action.counter == null ? "0" : String(action.counter);
  const salt = request.chain && request.chain.salts && request.chain.salts[saltKey];
  const termsHash = request.acceptance && request.acceptance.termsHash;
  if (typeof salt !== "string" || typeof termsHash !== "string") return null;
  try {
    return commitmentFromTermsHash(termsHash, salt);
  } catch {
    return null;
  }
}

function commitmentOf(offer, version) {
  if (!Number.isInteger(version)) return null;
  const versionRow = versionByNumber(offer, version);
  const salt = offer.chain && offer.chain.salts && offer.chain.salts[String(version)];
  if (!versionRow || typeof salt !== "string") return null;
  try {
    return commitmentForVersion(offer.id, versionRow, salt);
  } catch {
    return null;
  }
}

function versionByNumber(offer, n) {
  if (!offer || !Array.isArray(offer.versions)) return null;
  return offer.versions.find((version) => version && version.n === n) || null;
}

function makeFinding({ kind, reason, subject, actionId, records, chain, txHash, adoptable }) {
  const cleanSubject = {};
  if (subject && subject.companyId) cleanSubject.companyId = subject.companyId;
  if (subject && subject.offerId) cleanSubject.offerId = subject.offerId;
  if (subject && subject.requestId) cleanSubject.requestId = subject.requestId;
  if (subject && subject.wallet) cleanSubject.wallet = subject.wallet;
  const hash = typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash : null;
  return {
    id: findingId(kind, reason, cleanSubject, actionId, hash),
    kind,
    reason,
    subject: cleanSubject,
    actionId: actionId || null,
    records,
    chain,
    txHash: hash,
    adoptable: adoptable === true,
  };
}

function findingId(kind, reason, subject, actionId, txHash) {
  const parts = [
    kind,
    reason,
    subject.companyId || "",
    subject.offerId || "",
    subject.requestId || "",
    (subject.wallet || "").toLowerCase(),
    actionId || "",
    (txHash || "").toLowerCase(),
  ];
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

function offerChainText(view) {
  if (!chainOfferExists(view)) return "no offer";
  const state = OFFER_CHAIN_STATE[view.state] || `state ${view.state}`;
  return `version ${view.version} ${state}`;
}

function requestChainText(view) {
  if (!chainRequestExists(view)) return "no request";
  return REQUEST_CHAIN_STATUS[view.status] || `status ${view.status}`;
}

function chainOfferExists(view) {
  return Boolean(view) && !isZero(view.companyKey) && view.state !== 0;
}

function chainRequestExists(view) {
  return Boolean(view) && !isZero(view.offerId) && view.status !== 0;
}

function asOffer(value) {
  if (Array.isArray(value)) {
    return {
      companyKey: value[0],
      version: num(value[1]),
      stateSeq: num(value[2]),
      state: num(value[3]),
      expiresAt: num(value[4]),
      commitment: value[5],
    };
  }
  if (!value || typeof value !== "object") return null;
  return {
    companyKey: value.companyKey,
    version: num(value.version),
    stateSeq: num(value.stateSeq),
    state: num(value.state),
    expiresAt: num(value.expiresAt),
    commitment: value.commitment,
  };
}

function asRequest(value) {
  if (Array.isArray(value)) {
    return {
      offerId: value[0],
      buyerCompany: value[1],
      version: num(value[2]),
      statusSeq: num(value[3]),
      status: num(value[4]),
      termsCommitment: value[5],
    };
  }
  if (!value || typeof value !== "object") return null;
  return {
    offerId: value.offerId,
    buyerCompany: value.buyerCompany,
    version: num(value.version),
    statusSeq: num(value.statusSeq),
    status: num(value.status),
    termsCommitment: value.termsCommitment,
  };
}

function txOf(event) {
  return event && typeof event.transactionHash === "string" ? event.transactionHash : null;
}

function num(value) {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function isZero(value) {
  return !value || sameHex(value, ZERO);
}

function companiesOf(snapshot) {
  const companies = snapshot && snapshot.companies;
  return companies && typeof companies === "object" ? companies : {};
}

function offersOf(snapshot) {
  const offers = snapshot && snapshot.offers;
  return offers && typeof offers === "object" ? offers : {};
}

function requestsOf(snapshot) {
  const requests = snapshot && snapshot.requests;
  return requests && typeof requests === "object" ? requests : {};
}

function companyKeyFor(snapshot, companyId) {
  const company = companiesOf(snapshot)[companyId];
  return company && typeof company.companyKey === "string" ? company.companyKey : null;
}

function knownCompanyKeys(snapshot) {
  const keys = new Set();
  for (const company of Object.values(companiesOf(snapshot))) {
    if (company && typeof company.companyKey === "string") keys.add(company.companyKey.toLowerCase());
  }
  return keys;
}

function knownOfferKeys(snapshot) {
  const keys = new Set();
  for (const offer of Object.values(offersOf(snapshot))) {
    if (offer && offer.chain && typeof offer.chain.offerKey === "string") keys.add(offer.chain.offerKey.toLowerCase());
  }
  return keys;
}

function knownRequestKeys(snapshot) {
  const keys = new Set();
  for (const request of Object.values(requestsOf(snapshot))) {
    if (request && request.chain && typeof request.chain.requestKey === "string") {
      keys.add(request.chain.requestKey.toLowerCase());
    }
  }
  return keys;
}

module.exports = {
  compareRecords,
  offerLanded,
  requestLanded,
};
