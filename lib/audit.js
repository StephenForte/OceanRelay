const crypto = require("node:crypto");
const { keccak_256 } = require("@noble/hashes/sha3.js");

// C-12. Every allowed audit event, actor role, detail key and reason code
// is listed in this file. Domain methods may pass a wider object; only the
// fields named here are stored. Anything else is dropped.

const EVENTS = Object.freeze([
  "auth.connected",
  "auth.refused",
  "auth.disconnected",
  "auth.dropped",
  "offer.created",
  "offer.edited",
  "offer.state",
  "offer.capacity_status",
  "request.created",
  "request.countered",
  "request.accepted",
  "request.declined",
  "request.withdrawn",
  "fulfilment.status",
  "cancellation.proposed",
  "cancellation.withdrawn",
  "cancellation.agreed",
  "cancellation.refused",
  "wallet.bound",
  "offer.chain_recorded",
  "request.chain_recorded",
]);

const EVENT_SET = new Set(EVENTS);

const ROLES = new Set(["seller", "buyer", "operator", "user"]);

// Detail keys, in the order they are written. A reviewer can read this
// list without opening a second file.
const DETAIL_KEYS = Object.freeze(["counter", "from", "quantity", "reason", "to", "version"]);

const REASONS = new Set([
  "access_denied",
  "config_incomplete",
  "identity_unavailable",
  "identity_unusable",
  "invalid_state",
  "only_contract_owner",
  "partner_oauth_disabled",
  "refresh_failed",
  "token_exchange_failed",
]);

const CODE = /^[a-z_]+$/;

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function code(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 40 && CODE.test(value)
    ? value
    : null;
}

function idString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && !/\s/.test(value)
    ? value
    : null;
}

function cleanActor(actor) {
  if (!actor || typeof actor !== "object") return null;
  const sub = idString(actor.sub);
  const companyId = idString(actor.companyId);
  if (!sub || !companyId || !ROLES.has(actor.role)) return null;
  return { sub, companyId, role: actor.role };
}

function eip55Address(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const lower = body.toLowerCase();
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out === value ? out : null;
}

function cleanSubject(subject) {
  const out = {};
  if (!subject || typeof subject !== "object") return out;
  const offerId = idString(subject.offerId);
  const requestId = idString(subject.requestId);
  const version = positiveInt(subject.version);
  const wallet = eip55Address(subject.wallet);
  if (offerId) out.offerId = offerId;
  if (requestId) out.requestId = requestId;
  if (version) out.version = version;
  if (wallet) out.wallet = wallet;
  return out;
}

function cleanDetail(detail) {
  const source = detail && typeof detail === "object" ? detail : {};
  const out = {};
  for (const key of DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (key === "counter" || key === "quantity" || key === "version") {
      const number = positiveInt(value);
      if (number) out[key] = number;
    } else if (key === "reason") {
      if (REASONS.has(value)) out.reason = value;
    } else {
      const text = code(value);
      if (text) out[key] = text;
    }
  }
  return out;
}

function auditEntry({ event, actor, subject, detail, at, id }) {
  if (!EVENT_SET.has(event)) throw new Error(`unknown audit event ${String(event)}`);
  const when = typeof at === "string" && at.length > 0 ? at : new Date().toISOString();
  return {
    id: typeof id === "string" && id.length > 0 ? id : crypto.randomUUID(),
    at: when,
    event,
    actor: cleanActor(actor),
    subject: cleanSubject(subject),
    detail: event === "wallet.bound" ? {} : cleanDetail(detail),
  };
}

module.exports = {
  EVENTS,
  DETAIL_KEYS,
  REASONS,
  auditEntry,
};
