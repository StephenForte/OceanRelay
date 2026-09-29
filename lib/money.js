"use strict";

// String-based money parsing (D-5). Moved from the offer routes so the
// marketplace max-price field uses the same rules as a draft price.
function parseDecimalToMinor(text, exponent) {
  if (typeof text !== "string") return { ok: false, error: "Enter a price." };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Enter a price." };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: "Enter a price using digits and an optional decimal point." };
  }
  const parts = trimmed.split(".");
  const whole = parts[0];
  const frac = parts[1] || "";
  if (frac.length > exponent) {
    if (exponent === 0) return { ok: false, error: "This currency has no minor units. Enter a whole number." };
    return { ok: false, error: `Use at most ${exponent} decimal places.` };
  }
  const digits = `${whole}${frac}${"0".repeat(exponent - frac.length)}`.replace(/^0+(?=\d)/, "");
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "That amount is too large." };
  return { ok: true, minor };
}

module.exports = { parseDecimalToMinor };
