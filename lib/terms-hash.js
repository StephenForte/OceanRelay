"use strict";

// C-10. Hash only the terms the buyer saw (D-13). This module never reads an
// offer, a snapshot, a base price, a markup, or an identity. Callers pass the
// buyer-visible fields. The hash is stored at acceptance and is not recomputed
// on read.

const crypto = require("node:crypto");

const KEYS = Object.freeze([
  "offerId",
  "version",
  "counter",
  "codeShareLine",
  "origin",
  "destination",
  "equipment",
  "unit",
  "quantity",
  "sailingStart",
  "sailingEnd",
  "cutoffDate",
  "validityDeadline",
  "currency",
  "unitBuyerMinor",
  "totalMinor",
  "serviceTerms",
  "capacityStatus",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function stableStringify(value, root) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("buyer terms cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, false)).join(",")}]`;
  if (!isPlainObject(value)) throw new TypeError("buyer terms cannot encode this value");
  const keys = Object.keys(value).sort();
  const ordered = root && Object.prototype.hasOwnProperty.call(value, "v")
    ? ["v", ...keys.filter((key) => key !== "v")]
    : keys;
  return `{${ordered.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], false)}`).join(",")}}`;
}

function textValue(value) {
  if (typeof value !== "string") throw new TypeError("buyer terms field must be a string");
  return value;
}

function intValue(value) {
  if (!isSafeInt(value)) throw new TypeError("buyer terms field must be a safe integer");
  return value;
}

function canonicalValue(key, value) {
  if (key === "counter") {
    if (value == null) return null;
    if (!isSafeInt(value) || value < 1) throw new TypeError("buyer terms counter must be a positive integer or null");
    return value;
  }
  if (key === "cutoffDate") {
    if (value == null) return null;
    return textValue(value);
  }
  if (key === "version" || key === "quantity" || key === "unitBuyerMinor" || key === "totalMinor") {
    return intValue(value);
  }
  return textValue(value);
}

function buyerTermsCanonical(fields) {
  const source = isPlainObject(fields) ? fields : {};
  const terms = { v: 1 };
  for (const key of KEYS) terms[key] = canonicalValue(key, source[key]);
  return stableStringify(terms, true);
}

function buyerTermsHash(canonical) {
  if (typeof canonical !== "string") throw new TypeError("canonical buyer terms must be a string");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

module.exports = {
  buyerTermsCanonical,
  buyerTermsHash,
};
