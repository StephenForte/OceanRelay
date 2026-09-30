"use strict";

const { CURRENCIES } = require("../offer-domain");

const CAPACITY_LABELS = Object.freeze({
  seller_asserted: "Seller-asserted",
  carrier_pending: "Carrier pending",
  carrier_confirmed: "Carrier confirmed",
});

const STATE_LABELS = Object.freeze({
  draft: "Draft",
  published: "Published",
  paused: "Paused",
  expired: "Expired",
});

const REQUEST_STATE_LABELS = Object.freeze({
  pending: "Pending",
  countered: "Countered",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
});

const BOOKING_COPY = "Accepted in OceanRelay means a marketplace agreement. It is not a carrier booking.";
const QUANTITY_LIMIT_COPY = "This quantity limit applies only inside OceanRelay. It does not hold carrier space or stop the seller promising the same space elsewhere.";

function formatBuyerPrice(minor, currency) {
  const exponent = CURRENCIES[currency];
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || exponent == null) return "";
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const frac = exponent === 0 ? "" : digits.slice(-exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = exponent === 0 ? grouped : `${grouped}.${frac}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

function capacityLabel(status) {
  return CAPACITY_LABELS[status] || "";
}

function stateLabel(state) {
  return STATE_LABELS[state] || "";
}

function formatCutoff(value) {
  if (typeof value !== "string" || value.trim() === "") return "Not stated";
  return value;
}

function formatQuantity(value, unit) {
  const name = typeof unit === "string" && unit.trim() ? unit.trim() : "";
  const amount = typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  if (!name) return amount == null ? "" : String(amount);
  const plural = amount === 1 || name.endsWith("s") ? name : `${name}s`;
  return amount == null ? plural : `${amount} ${plural}`;
}

function offerLine(state, version, capacityStatus) {
  return `${stateLabel(state)} · version ${version} · ${capacityLabel(capacityStatus)}`;
}

function requestStateLabel(state) {
  return REQUEST_STATE_LABELS[state] || "";
}

function requestQuantity(request) {
  if (!request || typeof request !== "object") return null;
  if (request.state === "accepted" && request.acceptance && Number.isSafeInteger(request.acceptance.quantity)) {
    return request.acceptance.quantity;
  }
  if (request.state === "countered" && Array.isArray(request.counters) && request.counters.length) {
    const latest = request.counters[request.counters.length - 1];
    if (latest && Number.isSafeInteger(latest.quantity)) return latest.quantity;
  }
  return Number.isSafeInteger(request.quantity) ? request.quantity : null;
}

module.exports = {
  formatBuyerPrice,
  capacityLabel,
  stateLabel,
  formatCutoff,
  formatQuantity,
  offerLine,
  requestStateLabel,
  requestQuantity,
  BOOKING_COPY,
  QUANTITY_LIMIT_COPY,
};
