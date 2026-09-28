const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canChangeCapacityStatus } = require("./offer-domain");

const SCHEMA_VERSION = 1;

function freshData() {
  return { schemaVersion: SCHEMA_VERSION, offers: {}, audit: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function readRecords(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("oceanrelay records file is unparsable");
  }
  if (!isPlainObject(parsed)) throw new Error("oceanrelay records file is unparsable");
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`oceanrelay records schemaVersion ${String(parsed.schemaVersion)} is not supported`);
  }
  if (parsed.offers === undefined) parsed.offers = {};
  if (parsed.audit === undefined) parsed.audit = [];
  if (!isPlainObject(parsed.offers)) throw new Error("oceanrelay records offers must be an object");
  if (!Array.isArray(parsed.audit)) throw new Error("oceanrelay records audit must be an array");
  return parsed;
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

  if (!memoryOnly) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) data = readRecords(filePath);
    else persistSnapshot(data);
  }

  const api = {
    filePath: memoryOnly ? null : filePath,
    // Synchronous on purpose (D-3). An async callback would await between a
    // check and the persist, so two requests could take the last unit.
    transact(fn) {
      if (typeof fn !== "function") throw new TypeError("transact requires a function");
      if (fn.constructor && fn.constructor.name === "AsyncFunction") {
        throw new Error("transact callback must be synchronous");
      }
      if (inTransact) throw new Error("transact cannot be nested");
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
        throw new Error("transact callback must be synchronous");
      }
      persistSnapshot(draft);
      data = draft;
      return result;
    },
    createOffer(identity, fields) {
      const companyId = identity && identity.companyId;
      const createdBy = identity && identity.sub;
      const spec = fields && typeof fields === "object" ? fields : {};
      return api.transact((draft) => {
        const id = crypto.randomUUID();
        const offer = {
          id,
          companyId,
          createdBy,
          createdAt: new Date().toISOString(),
          state: "draft",
          source: spec.source,
          terms: spec.terms,
          snapshot: spec.snapshot == null ? null : spec.snapshot,
          sourceRecordId: spec.sourceRecordId == null ? null : spec.sourceRecordId,
          overriddenFields: Array.isArray(spec.overriddenFields) ? spec.overriddenFields.slice() : [],
          capacityStatus: "seller_asserted",
          statusHistory: [],
        };
        draft.offers[id] = offer;
        return structuredClone(offer);
      });
    },
    listCompanyOffers(companyId) {
      return api.transact((draft) => {
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
      return api.transact((draft) => {
        const offer = draft.offers[id];
        if (!offer || offer.companyId !== companyId) return null;
        return structuredClone(offer);
      });
    },
    setCapacityStatus(companyId, id, to, actorSub) {
      return api.transact((draft) => {
        const offer = draft.offers[id];
        if (!offer || offer.companyId !== companyId) return { ok: false, error: "not_found" };
        const from = offer.capacityStatus;
        if (!canChangeCapacityStatus(from, to)) return { ok: false, error: "illegal_transition" };
        offer.capacityStatus = to;
        offer.statusHistory.push({
          from,
          to,
          actor: actorSub,
          at: new Date().toISOString(),
        });
        return { ok: true, offer: structuredClone(offer) };
      });
    },
  };
  return api;
}

module.exports = { openRecords, SCHEMA_VERSION };
