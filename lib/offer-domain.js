"use strict";

const crypto = require("node:crypto");

// D-5. Exponent is the number of minor-unit digits (USD 2 → cents, JPY 0 → yen).
const CURRENCIES = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  HKD: 2,
  SGD: 2,
  JPY: 0,
  KRW: 0,
});

const CAPACITY_STATUSES = Object.freeze([
  "seller_asserted",
  "carrier_pending",
  "carrier_confirmed",
]);

// One copy of the words every screen must show. carrier_pending reuses the
// seller-claim sentence: no separate pending sentence was specified, and a
// pending note is not a recorded carrier confirmation.
const SELLER_CLAIM_CAVEAT =
  "Quantity is the seller's claim. OceanRelay has not confirmed the space.";
const CARRIER_CONFIRMED_CAVEAT =
  "A carrier confirmation was recorded. The carrier can still roll, change, or cancel.";
const CAPACITY_CAVEATS = Object.freeze({
  seller_asserted: SELLER_CLAIM_CAVEAT,
  carrier_pending: SELLER_CLAIM_CAVEAT,
  carrier_confirmed: CARRIER_CONFIRMED_CAVEAT,
});

const SOURCES = Object.freeze(["rn_rate", "manual"]);
const EQUIPMENT = Object.freeze(["20D", "40D", "40HC"]);
const UNITS = Object.freeze(["container"]);
const EQUIPMENT_COLUMNS = Object.freeze({
  "20D": "rate20D",
  "40D": "rate40D",
  "40HC": "rate40HC",
});

// Chosen limits, after trim. Listed in the T3 handoff.
const LIMITS = Object.freeze({
  origin: 80,
  destination: 80,
  codeShareName: 80,
  operatingCarrier: 120,
  serviceTerms: 4000,
});

const SEEDED_FIELD_NAMES = Object.freeze([
  "origin",
  "destination",
  "carrier",
  "effectiveDate",
  "expirationDate",
  "baseAmount",
]);

// seller_asserted → carrier_pending → carrier_confirmed,
// seller_asserted → carrier_confirmed, and either later status back to
// seller_asserted. confirmed → pending is not a listed move.
const STATUS_EDGES = new Set([
  "seller_asserted>carrier_pending",
  "carrier_pending>carrier_confirmed",
  "seller_asserted>carrier_confirmed",
  "carrier_pending>seller_asserted",
  "carrier_confirmed>seller_asserted",
]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function isSafeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

// D-8. The signature is (from, to) on purpose. Rate Ninja fields are not
// parameters, and nothing in this module maps a rate DTO onto a status.
function canChangeCapacityStatus(from, to) {
  return STATUS_EDGES.has(`${from}>${to}`);
}

function readRequiredString(input, key, limit, label, errors) {
  const raw = input[key];
  if (typeof raw !== "string") {
    errors[key] = `Enter ${label}.`;
    return null;
  }
  const value = raw.trim();
  if (!value) {
    errors[key] = `Enter ${label}.`;
    return null;
  }
  if (value.length > limit) {
    errors[key] = `${label[0].toUpperCase()}${label.slice(1)} must be ${limit} characters or fewer.`;
    return null;
  }
  return value;
}

function readEnum(input, key, allowed, label, errors) {
  const raw = input[key];
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (!allowed.includes(value)) {
    errors[key] = label;
    return null;
  }
  return value;
}

function readDateField(input, key, label, errors, required) {
  if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] == null) {
    if (required) errors[key] = `Enter ${label}.`;
    return undefined;
  }
  const raw = input[key];
  if (typeof raw !== "string") {
    errors[key] = `${label[0].toUpperCase()}${label.slice(1)} must be a real date in YYYY-MM-DD form.`;
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    if (required) errors[key] = `Enter ${label}.`;
    return undefined;
  }
  if (!isCalendarDate(value)) {
    errors[key] = `${label[0].toUpperCase()}${label.slice(1)} must be a real date in YYYY-MM-DD form.`;
    return undefined;
  }
  return value;
}

function readMarkup(input, errors) {
  const markup = input.markup;
  if (!isPlainObject(markup)) {
    errors.markup = "Enter a markup.";
    return null;
  }
  const type = typeof markup.type === "string" ? markup.type.trim() : "";
  if (type === "absolute") {
    if (!isSafeInt(markup.minor) || markup.minor < 0) {
      errors.markup = "Absolute markup must be a whole number of minor units, zero or greater.";
      return null;
    }
    return { type: "absolute", minor: markup.minor };
  }
  if (type === "percent") {
    if (!isSafeInt(markup.bps) || markup.bps < 0) {
      errors.markup = "Percentage markup must be a whole number of basis points, zero or greater.";
      return null;
    }
    return { type: "percent", bps: markup.bps };
  }
  errors.markup = "Markup must be an absolute amount or a percentage.";
  return null;
}

function validateDraft(input) {
  const sourceInput = isPlainObject(input) ? input : {};
  const errors = {};
  const source = readEnum(
    sourceInput,
    "source",
    SOURCES,
    "Source must be a Rate Ninja rate or manual entry.",
    errors,
  );
  const origin = readRequiredString(sourceInput, "origin", LIMITS.origin, "an origin", errors);
  const destination = readRequiredString(
    sourceInput,
    "destination",
    LIMITS.destination,
    "a destination",
    errors,
  );
  const equipment = readEnum(
    sourceInput,
    "equipment",
    EQUIPMENT,
    "Equipment must be 20D, 40D, or 40HC.",
    errors,
  );
  let quantity = null;
  if (!isSafeInt(sourceInput.quantity) || sourceInput.quantity < 1) {
    errors.quantity = "Claimed quantity must be a positive whole number.";
  } else {
    quantity = sourceInput.quantity;
  }
  const unit = readEnum(sourceInput, "unit", UNITS, "Unit must be container.", errors);
  const sailingDate = readDateField(sourceInput, "sailingDate", "sailing date", errors, false);
  const sailingStartInput = readDateField(sourceInput, "sailingStart", "sailing window start", errors, false);
  const sailingEndInput = readDateField(sourceInput, "sailingEnd", "sailing window end", errors, false);
  let sailingStart = null;
  let sailingEnd = null;
  const dateBroken = errors.sailingDate || errors.sailingStart || errors.sailingEnd;
  if (!dateBroken) {
    if (sailingDate && sailingStartInput === undefined && sailingEndInput === undefined) {
      sailingStart = sailingDate;
      sailingEnd = sailingDate;
    } else if (sailingStartInput && sailingEndInput && sailingDate === undefined) {
      sailingStart = sailingStartInput;
      sailingEnd = sailingEndInput;
    } else if (
      sailingDate &&
      sailingStartInput &&
      sailingEndInput &&
      sailingStartInput === sailingDate &&
      sailingEndInput === sailingDate
    ) {
      sailingStart = sailingDate;
      sailingEnd = sailingDate;
    } else if (!sailingDate && !sailingStartInput && !sailingEndInput) {
      errors.sailingStart = "Enter a sailing window start, or a single sailing date.";
      errors.sailingEnd = "Enter a sailing window end, or a single sailing date.";
    } else if (!sailingStartInput || !sailingEndInput) {
      if (!sailingStartInput) errors.sailingStart = "Enter a sailing window start, or a single sailing date.";
      if (!sailingEndInput) errors.sailingEnd = "Enter a sailing window end, or a single sailing date.";
      if (sailingDate) {
        errors.sailingDate = "Single sailing date must match the sailing window start and end.";
      }
    } else {
      errors.sailingDate = "Single sailing date must match the sailing window start and end.";
    }
  }
  if (sailingStart && sailingEnd && sailingEnd < sailingStart) {
    errors.sailingEnd = "Sailing window end must not be before the start.";
    sailingStart = null;
    sailingEnd = null;
  }
  const validityDeadline = readDateField(
    sourceInput,
    "validityDeadline",
    "validity deadline",
    errors,
    true,
  );
  if (validityDeadline && sailingEnd && validityDeadline > sailingEnd) {
    errors.validityDeadline = "Validity deadline must not be after the sailing window end.";
  }
  const cutoffDate = readDateField(sourceInput, "cutoffDate", "cutoff date", errors, false);
  let currency = null;
  const currencyRaw = sourceInput.currency;
  const currencyCode = typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
  if (!Object.prototype.hasOwnProperty.call(CURRENCIES, currencyCode)) {
    errors.currency = "Choose a currency from the list.";
  } else {
    currency = currencyCode;
  }
  let baseMinor = null;
  if (!isSafeInt(sourceInput.baseMinor) || sourceInput.baseMinor < 1) {
    errors.baseMinor = "Base price must be a positive whole number of minor units.";
  } else {
    baseMinor = sourceInput.baseMinor;
  }
  const markup = readMarkup(sourceInput, errors);
  if (baseMinor != null && markup && !errors.markup) {
    try {
      priceBuyer({ baseMinor, markup });
    } catch {
      errors.markup = "Buyer price is too large to store as a whole number of minor units.";
    }
  }
  const codeShareName = readRequiredString(
    sourceInput,
    "codeShareName",
    LIMITS.codeShareName,
    "a code-share name",
    errors,
  );
  const operatingCarrier = readRequiredString(
    sourceInput,
    "operatingCarrier",
    LIMITS.operatingCarrier,
    "an operating carrier",
    errors,
  );
  const serviceTerms = readRequiredString(
    sourceInput,
    "serviceTerms",
    LIMITS.serviceTerms,
    "service terms",
    errors,
  );

  if (Object.keys(errors).length > 0) {
    return { ok: false, value: null, errors };
  }

  // Allowlist. companyId, sub, capacityStatus, buyerMinor, and every other
  // input key are ignored (D-1, D-8).
  const value = {
    source,
    origin,
    destination,
    equipment,
    quantity,
    unit,
    sailingStart,
    sailingEnd,
    validityDeadline,
    currency,
    baseMinor,
    markup,
    codeShareName,
    operatingCarrier,
    serviceTerms,
  };
  if (cutoffDate) value.cutoffDate = cutoffDate;
  return { ok: true, value, errors };
}

// Buyer price = base + markup, percent markup rounded half-up to the minor
// unit (D-5). Arithmetic is integer-only so a .5 boundary near 2^53 cannot
// collapse to a float.
function priceBuyer({ baseMinor, markup }) {
  if (!isSafeInt(baseMinor) || baseMinor < 1) {
    throw new TypeError("baseMinor must be a positive safe integer");
  }
  if (!isPlainObject(markup)) throw new TypeError("markup is required");
  let extra;
  if (markup.type === "absolute") {
    if (!isSafeInt(markup.minor) || markup.minor < 0) {
      throw new TypeError("absolute markup minor must be a non-negative safe integer");
    }
    extra = BigInt(markup.minor);
  } else if (markup.type === "percent") {
    if (!isSafeInt(markup.bps) || markup.bps < 0) {
      throw new TypeError("percent markup bps must be a non-negative safe integer");
    }
    const product = BigInt(baseMinor) * BigInt(markup.bps);
    extra = (product + 5000n) / 10000n;
  } else {
    throw new TypeError("markup type must be absolute or percent");
  }
  const buyer = BigInt(baseMinor) + extra;
  if (buyer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("buyer price exceeds MAX_SAFE_INTEGER");
  }
  return Number(buyer);
}

function cloneData(value) {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(cloneData);
  if (value instanceof Date) return value.toISOString();
  if (!isPlainObject(value)) return null;
  const copy = {};
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    copy[key] = cloneData(value[key]);
  }
  return copy;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function columnAmount(rateDto, equipment) {
  const column = EQUIPMENT_COLUMNS[equipment];
  if (!column) return { error: "unknown_equipment" };
  const amount = rateDto[column];
  // D-6. A missing source value is 0, and 0 is not a price. Anything that is
  // not a positive safe integer is the same refusal.
  if (!isSafeInt(amount) || amount < 1) return { error: "no_price_for_equipment" };
  return { amount };
}

// Success returns the frozen snapshot itself. A zero (or missing) equipment
// column returns { ok: false, error: "no_price_for_equipment" } and no snapshot.
// baseAmount is the Rate Ninja column integer unchanged. Currency on the DTO
// is null, so this function does not scale it into minor units.
function snapshotFromRate(rateDto, equipment, retrievedAt) {
  if (!isPlainObject(rateDto)) return { ok: false, error: "rate_dto_required" };
  if (typeof retrievedAt !== "string" || retrievedAt.trim() === "") {
    return { ok: false, error: "retrieved_at_required" };
  }
  const priced = columnAmount(rateDto, equipment);
  if (priced.error) return { ok: false, error: priced.error };
  const dto = cloneData(rateDto);
  const seeded = {
    origin: dto.originPort ?? null,
    destination: dto.destinationPort ?? null,
    carrier: dto.carrier ?? null,
    effectiveDate: dto.rateEffectiveDate ?? null,
    expirationDate: dto.rateExpirationDate ?? null,
    baseAmount: priced.amount,
  };
  return deepFreeze({
    dto,
    equipment,
    baseAmount: priced.amount,
    retrievedAt,
    seededFields: SEEDED_FIELD_NAMES,
    seeded,
  });
}

function dataString(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(dataString).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (!isPlainObject(value)) return "null";
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${dataString(value[key])}`).join(",")}}`;
}

// Spreadsheet normalizeValue does not guarantee YYYY-MM-DD. Accept an ISO
// calendar date (a time suffix is ignored, and it does not shift the date),
// a Date (UTC calendar date), or an Excel serial in the modern freight range.
// Anything else, including slash dates, is unreadable.
function parseRateDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString().slice(0, 10);
    return isCalendarDate(iso) ? iso : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const whole = Math.floor(value);
    if (whole < 20000 || whole > 120000) return null;
    const utc = new Date(Date.UTC(1899, 11, 30) + whole * 86400000);
    const iso = utc.toISOString().slice(0, 10);
    return isCalendarDate(iso) ? iso : null;
  }
  if (typeof value === "string") {
    const match = ISO_DATE_PREFIX.exec(value.trim());
    if (!match || !isCalendarDate(match[1])) return null;
    return match[1];
  }
  return null;
}

function sourceWarnings(snapshot, currentRateDtoOrNull, today) {
  if (typeof today !== "string" || !isCalendarDate(today)) {
    throw new TypeError("today must be a YYYY-MM-DD date");
  }
  if (currentRateDtoOrNull == null) return ["source_missing"];
  const warnings = [];
  const dto = isPlainObject(snapshot) ? snapshot.dto : undefined;
  if (dataString(dto) !== dataString(currentRateDtoOrNull)) warnings.push("source_changed");
  const expiration = isPlainObject(currentRateDtoOrNull) ? currentRateDtoOrNull.rateExpirationDate : undefined;
  const parsed = parseRateDate(expiration);
  if (!parsed) warnings.push("source_date_unreadable");
  else if (parsed < today) warnings.push("source_expired");
  return warnings;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function canonicalMarkup(markup) {
  if (!isPlainObject(markup)) return null;
  if (markup.type === "absolute" && isSafeInt(markup.minor) && markup.minor >= 0) {
    return { type: "absolute", minor: markup.minor };
  }
  if (markup.type === "percent" && isSafeInt(markup.bps) && markup.bps >= 0) {
    return { type: "percent", bps: markup.bps };
  }
  return null;
}

function stableStringify(value, root) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical terms cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, false)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("canonical terms cannot encode this value");
  const keys = Object.keys(value).sort();
  const ordered = root && Object.prototype.hasOwnProperty.call(value, "v")
    ? ["v", ...keys.filter((key) => key !== "v")]
    : keys;
  return `{${ordered.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], false)}`).join(",")}}`;
}

// Commercial terms hashed by Phase 4 acceptances. Version 1 key set, no others.
// Included:
//   v, source, origin, destination, equipment, quantity, unit,
//   sailingStart, sailingEnd, cutoffDate, validityDeadline, currency,
//   baseMinor, markup ({type, minor} or {type, bps} only), buyerMinor,
//   codeShareName, operatingCarrier, serviceTerms, capacityStatus
// Excluded on purpose: companyId, sub, snapshot (including retrievedAt),
// source record id, private notes, and row timestamps (createdAt, updatedAt,
// savedAt, publishedAt). Identities are stored beside the hash. The snapshot
// is evidence, not a term. capacityStatus is the status on this immutable
// version, not a later request milestone.
// buyerMinor uses the stored integer when the object has one; otherwise it is
// derived with priceBuyer so the buyer price is always in the preimage.
// Root key order is "v" first, then remaining keys sorted. Nested objects are
// sorted at every depth.
function canonicalTerms(offerVersion) {
  const offer = isPlainObject(offerVersion) ? offerVersion : {};
  const markup = canonicalMarkup(offer.markup);
  let buyerMinor = null;
  if (Object.prototype.hasOwnProperty.call(offer, "buyerMinor") && isSafeInt(offer.buyerMinor)) {
    buyerMinor = offer.buyerMinor;
  } else if (markup && isSafeInt(offer.baseMinor) && offer.baseMinor > 0) {
    try {
      buyerMinor = priceBuyer({ baseMinor: offer.baseMinor, markup });
    } catch {
      buyerMinor = null;
    }
  }
  const terms = {
    v: 1,
    source: stringOrNull(offer.source),
    origin: stringOrNull(offer.origin),
    destination: stringOrNull(offer.destination),
    equipment: stringOrNull(offer.equipment),
    quantity: isSafeInt(offer.quantity) ? offer.quantity : null,
    unit: stringOrNull(offer.unit),
    sailingStart: stringOrNull(offer.sailingStart),
    sailingEnd: stringOrNull(offer.sailingEnd),
    cutoffDate: stringOrNull(offer.cutoffDate),
    validityDeadline: stringOrNull(offer.validityDeadline),
    currency: stringOrNull(offer.currency),
    baseMinor: isSafeInt(offer.baseMinor) ? offer.baseMinor : null,
    markup,
    buyerMinor,
    codeShareName: stringOrNull(offer.codeShareName),
    operatingCarrier: stringOrNull(offer.operatingCarrier),
    serviceTerms: stringOrNull(offer.serviceTerms),
    capacityStatus: typeof offer.capacityStatus === "string" ? offer.capacityStatus : null,
  };
  return stableStringify(terms, true);
}

function termsHash(canonical) {
  if (typeof canonical !== "string") throw new TypeError("canonical terms must be a string");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function textOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

// Allowlist projection. Fields are copied by name into a new object. The
// offer is never cloned, and private keys are never deleted off a copy.
function buyerView(offer) {
  const source = isPlainObject(offer) ? offer : {};
  const codeShareName = textOrEmpty(source.codeShareName);
  const operatingCarrier = textOrEmpty(source.operatingCarrier);
  const currency = textOrEmpty(source.currency);
  const capacityStatus = typeof source.capacityStatus === "string" ? source.capacityStatus : "";
  let buyerMinor = null;
  if (isSafeInt(source.buyerMinor)) {
    buyerMinor = source.buyerMinor;
  } else if (isSafeInt(source.baseMinor) && canonicalMarkup(source.markup)) {
    buyerMinor = priceBuyer({ baseMinor: source.baseMinor, markup: canonicalMarkup(source.markup) });
  }
  return {
    codeShareLine: `${codeShareName}, operated by ${operatingCarrier}`,
    codeShareNameIsSellerProvided: true,
    lane: {
      origin: textOrEmpty(source.origin),
      destination: textOrEmpty(source.destination),
    },
    equipment: textOrEmpty(source.equipment),
    quantity: {
      value: isSafeInt(source.quantity) ? source.quantity : null,
      unit: textOrEmpty(source.unit),
      label: "Seller's claim",
      caveat: SELLER_CLAIM_CAVEAT,
    },
    dates: {
      sailingStart: textOrEmpty(source.sailingStart),
      sailingEnd: textOrEmpty(source.sailingEnd),
      cutoffDate: typeof source.cutoffDate === "string" ? source.cutoffDate : null,
      validityDeadline: textOrEmpty(source.validityDeadline),
    },
    currency,
    buyerPrice: {
      minor: buyerMinor,
      currency,
    },
    serviceTerms: textOrEmpty(source.serviceTerms),
    capacityStatus,
    capacityCaveat: CAPACITY_CAVEATS[capacityStatus] || SELLER_CLAIM_CAVEAT,
  };
}

module.exports = {
  CURRENCIES,
  CAPACITY_STATUSES,
  SELLER_CLAIM_CAVEAT,
  CARRIER_CONFIRMED_CAVEAT,
  CAPACITY_CAVEATS,
  LIMITS,
  SOURCES,
  EQUIPMENT,
  UNITS,
  canChangeCapacityStatus,
  validateDraft,
  priceBuyer,
  snapshotFromRate,
  sourceWarnings,
  canonicalTerms,
  termsHash,
  buyerView,
};
