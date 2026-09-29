"use strict";

// C-8. Pure filter over marketplace entries. Entries are already limited to
// published, frozen, non-expired offers. `companyId` is not read here.
function filterMarket(entries, query, today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError("today must be a YYYY-MM-DD date");
  }
  const source = Array.isArray(entries) ? entries : [];
  const spec = query && typeof query === "object" ? query : {};
  const origin = fold(spec.origin);
  const destination = fold(spec.destination);
  const carrier = fold(spec.carrier);
  const equipment = text(spec.equipment);
  const from = text(spec.from);
  const to = text(spec.to);
  const capacityStatus = text(spec.capacityStatus);
  const currency = text(spec.currency).toUpperCase();
  const hasMax = Object.prototype.hasOwnProperty.call(spec, "maxPrice")
    && spec.maxPrice != null
    && spec.maxPrice !== "";

  const matched = source.filter((entry) => {
    const view = entry && entry.view ? entry.view : {};
    const lane = view.lane || {};
    const dates = view.dates || {};
    if (typeof dates.validityDeadline === "string" && dates.validityDeadline && dates.validityDeadline < today) {
      return false;
    }
    if (origin && !includesFold(lane.origin, origin)) return false;
    if (destination && !includesFold(lane.destination, destination)) return false;
    // buyerView has no separate carrier field (C-4). The operating carrier is
    // the text after "operated by" inside the code-share line.
    if (carrier && !includesFold(view.codeShareLine, carrier)) return false;
    if (equipment && view.equipment !== equipment) return false;
    if (capacityStatus && view.capacityStatus !== capacityStatus) return false;
    if ((from || to) && !sailingOverlaps(dates, from, to)) return false;
    if (hasMax) {
      const price = view.buyerPrice || {};
      if (price.currency !== currency) return false;
      if (typeof price.minor !== "number" || price.minor > spec.maxPrice) return false;
    }
    return true;
  });

  return matched.slice().sort((left, right) => {
    const startLeft = sailingStart(left);
    const startRight = sailingStart(right);
    if (startLeft !== startRight) return startLeft < startRight ? -1 : 1;
    const idLeft = left && left.id ? String(left.id) : "";
    const idRight = right && right.id ? String(right.id) : "";
    if (idLeft !== idRight) return idLeft < idRight ? -1 : 1;
    return 0;
  });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fold(value) {
  return text(value).toLowerCase();
}

function includesFold(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(needle);
}

function sailingStart(entry) {
  const dates = entry && entry.view && entry.view.dates;
  return dates && typeof dates.sailingStart === "string" ? dates.sailingStart : "";
}

function sailingOverlaps(dates, from, to) {
  const start = dates && typeof dates.sailingStart === "string" ? dates.sailingStart : "";
  const end = dates && typeof dates.sailingEnd === "string" ? dates.sailingEnd : "";
  if (!start || !end) return false;
  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

module.exports = { filterMarket };
