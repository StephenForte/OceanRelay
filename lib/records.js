const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canChangeCapacityStatus, priceBuyer, buyerView } = require("./offer-domain");

const SCHEMA_VERSION = 2;
const BAK_SUFFIX = ".pre-m2.bak";

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
  return { schemaVersion: SCHEMA_VERSION, offers: {}, audit: [] };
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
  return { ...parsed, schemaVersion: SCHEMA_VERSION, offers };
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
  return parsed;
}

function copyBak(filePath) {
  const bakPath = `${filePath}${BAK_SUFFIX}`;
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
      const parsed = readRecords(filePath);
      if (parsed.schemaVersion === 1) {
        copyBak(filePath);
        data = migrateV1(parsed);
        persistSnapshot(data);
      } else {
        data = parsed;
      }
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

  function findOwned(draft, companyId, id) {
    const offer = draft.offers[id];
    if (!offer || offer.companyId !== companyId) return null;
    return offer;
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
        applyVersionWrite(offer, actorSub, (version) => {
          version.terms = terms;
          version.overriddenFields = overriddenFields.slice();
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
        offer.statusHistory.push({
          from,
          to,
          actor: actorSub,
          at: nowIso(),
          version: written.n,
        });
        return { ok: true, offer: structuredClone(offer) };
      });
    },
    setOfferState(companyId, id, to, actorSub, today) {
      return api.transact((draft) => {
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
        offer.stateHistory.push({
          from,
          to,
          actor: actorSub,
          at: nowIso(),
        });
        return { ok: true, offer: structuredClone(offer) };
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
  };
  return api;
}

module.exports = {
  openRecords,
  SCHEMA_VERSION,
  effectiveState,
  currentVersion,
  BAK_SUFFIX,
};
