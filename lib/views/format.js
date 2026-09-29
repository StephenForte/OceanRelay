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

module.exports = {
  formatBuyerPrice,
  capacityLabel,
  stateLabel,
  formatCutoff,
  formatQuantity,
  offerLine,
};
