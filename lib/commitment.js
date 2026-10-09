"use strict";

// D-28. The on-chain commitment for offer version n.
// commitment = keccak256(salt ‖ sha256(canonical))
// canonical is C-10 buyerTermsCanonical over that version's buyer-visible
// fields. This module never reads baseMinor, markup, a snapshot, or an identity.
//
// C-10 rejects counter 0 (it must be a positive integer or null). Null is how
// an acceptance of the listed terms is hashed. D-28's "counter 0" is that
// case: the listed offer, not a counter-proposal.

const crypto = require("node:crypto");
const { keccak_256 } = require("@noble/hashes/sha3.js");
const { buyerView } = require("./offer-domain");
const { buyerTermsCanonical } = require("./terms-hash");

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expiresAtOf(validityDeadline) {
  if (typeof validityDeadline !== "string" || !DATE.test(validityDeadline)) return null;
  const ms = Date.parse(`${validityDeadline}T23:59:59Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function saltBytes(salt) {
  if (typeof salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new TypeError("offer salt must be 32 bytes");
  }
  return Buffer.from(salt.slice(2), "hex");
}

// Buyer-visible fields only. Private term keys are not copied across.
function commitmentFields(offerId, version) {
  const terms = version && isPlainObject(version.terms) ? version.terms : {};
  const view = buyerView({
    codeShareName: terms.codeShareName,
    operatingCarrier: terms.operatingCarrier,
    origin: terms.origin,
    destination: terms.destination,
    equipment: terms.equipment,
    quantity: terms.quantity,
    unit: terms.unit,
    sailingStart: terms.sailingStart,
    sailingEnd: terms.sailingEnd,
    cutoffDate: terms.cutoffDate,
    validityDeadline: terms.validityDeadline,
    currency: terms.currency,
    buyerMinor: terms.buyerMinor,
    serviceTerms: terms.serviceTerms,
    capacityStatus: version ? version.capacityStatus : "",
  });
  const quantity = view.quantity.value;
  const unitBuyerMinor = view.buyerPrice.minor;
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new TypeError("listed quantity is not a safe integer");
  if (!Number.isSafeInteger(unitBuyerMinor) || unitBuyerMinor < 1) throw new TypeError("buyer price is not a safe integer");
  const product = BigInt(quantity) * BigInt(unitBuyerMinor);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("buyer total is too large");
  return {
    offerId,
    version: version.n,
    counter: null,
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
    totalMinor: Number(product),
    serviceTerms: view.serviceTerms,
    capacityStatus: view.capacityStatus,
  };
}

function digestOf(canonical) {
  return crypto.createHash("sha256").update(canonical, "utf8").digest();
}

function commitmentFromDigest(digest, salt) {
  const packed = Buffer.concat([saltBytes(salt), digest]);
  return `0x${Buffer.from(keccak_256(packed)).toString("hex")}`;
}

function offerCommitment(buyerFields, salt) {
  return commitmentFromDigest(digestOf(buyerTermsCanonical(buyerFields)), salt);
}

// D-29. The acceptance commitment is the offer commitment, over C-10's
// termsHash of the terms being accepted. termsHash is that sha256, hex.
function acceptanceCommitment(canonical, salt) {
  const digest = digestOf(canonical);
  return {
    termsHash: digest.toString("hex"),
    commitment: commitmentFromDigest(digest, salt),
  };
}

function commitmentFromTermsHash(termsHash, salt) {
  if (typeof termsHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(termsHash)) {
    throw new TypeError("terms hash must be sha256 hex");
  }
  return commitmentFromDigest(Buffer.from(termsHash, "hex"), salt);
}

function commitmentForVersion(offerId, version, salt) {
  return offerCommitment(commitmentFields(offerId, version), salt);
}

module.exports = {
  expiresAtOf,
  commitmentFields,
  offerCommitment,
  commitmentForVersion,
  acceptanceCommitment,
  commitmentFromTermsHash,
};
