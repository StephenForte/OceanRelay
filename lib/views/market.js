"use strict";

const { escapeHtml } = require("../page");
const { CURRENCIES, CAPACITY_STATUSES } = require("../offer-domain");
const {
  formatBuyerPrice,
  capacityLabel,
  formatCutoff,
  formatQuantity,
  BOOKING_COPY,
  QUANTITY_LIMIT_COPY,
} = require("./format");

function page(title, main) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Georgia, "Iowan Old Style", serif; background: #0e2433; color: #102a43; }
    main { max-width: 46rem; margin: 4vh auto; background: #fff; border-radius: 16px; padding: 2rem; }
    h1 { margin-top: 0; }
    a { color: #0b6e4f; }
    nav { display: flex; gap: 1rem; margin-bottom: 1rem; }
    label { display: block; margin-top: 0.9rem; font-weight: 700; }
    input, select { font: inherit; width: 100%; box-sizing: border-box; margin-top: 0.25rem; }
    button { font: inherit; background: #0b6e4f; color: white; border: 0; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; margin-top: 1rem; }
    .error { color: #8a1c1c; }
    .banner { background: #fff7e6; border-radius: 8px; padding: 0.75rem 1rem; }
    .muted { color: #486581; }
    dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.35rem 1rem; }
    dt { color: #486581; }
    dd { margin: 0; }
    ul { padding-left: 1.2rem; }
    .yours { font-weight: 700; }
    li.taken, li.taken a, li.taken p { color: #6b7280; }
  </style>
</head>
<body>
  <main>
    <nav>
      <a href="/">Home</a>
      <a href="/offers">Your offers</a>
      <a href="/offers/new">New offer</a>
      <a href="/market">Marketplace</a>
      <a href="/requests">Requests</a>
    </nav>
    ${main}
  </main>
</body>
</html>`;
}

function currencyOptions(selected) {
  const blank = `<option value=""${selected ? "" : " selected"}>Any currency</option>`;
  const rest = Object.keys(CURRENCIES).map((code) => {
    const on = selected === code ? " selected" : "";
    return `<option value="${escapeHtml(code)}"${on}>${escapeHtml(code)}</option>`;
  }).join("");
  return blank + rest;
}

function capacityOptions(selected) {
  const blank = `<option value=""${selected ? "" : " selected"}>Any status</option>`;
  const rest = CAPACITY_STATUSES.map((code) => {
    const on = selected === code ? " selected" : "";
    return `<option value="${escapeHtml(code)}"${on}>${escapeHtml(capacityLabel(code))}</option>`;
  }).join("");
  return blank + rest;
}

function equipmentOptions(selected) {
  const blank = `<option value=""${selected ? "" : " selected"}>Any equipment</option>`;
  const rest = ["20D", "40D", "40HC"].map((code) => {
    const on = selected === code ? " selected" : "";
    return `<option value="${code}"${on}>${code}</option>`;
  }).join("");
  return blank + rest;
}

function filterForm(query, error) {
  const value = query || {};
  return `<form method="get" action="/market" id="market-filters">
    <label for="origin">Origin</label>
    <input id="origin" name="origin" value="${escapeHtml(value.origin || "")}">
    <label for="destination">Destination</label>
    <input id="destination" name="destination" value="${escapeHtml(value.destination || "")}">
    <label for="carrier">Carrier</label>
    <input id="carrier" name="carrier" value="${escapeHtml(value.carrier || "")}">
    <label for="equipment">Equipment</label>
    <select id="equipment" name="equipment">${equipmentOptions(value.equipment || "")}</select>
    <label for="from">Sailing from</label>
    <input id="from" name="from" value="${escapeHtml(value.from || "")}" placeholder="YYYY-MM-DD">
    <label for="to">Sailing to</label>
    <input id="to" name="to" value="${escapeHtml(value.to || "")}" placeholder="YYYY-MM-DD">
    <label for="maxPrice">Maximum price</label>
    <input id="maxPrice" name="maxPrice" value="${escapeHtml(value.maxPrice || "")}" inputmode="decimal" autocomplete="off">
    <label for="currency">Currency</label>
    <select id="currency" name="currency">${currencyOptions(value.currency || "")}</select>
    <label for="capacityStatus">Capacity status</label>
    <select id="capacityStatus" name="capacityStatus">${capacityOptions(value.capacityStatus || "")}</select>
    <button type="submit">Search</button>
  </form>
  ${error ? `<p class="error" id="market-error">${escapeHtml(error)}</p>` : ""}`;
}

function quantityLine(available, listed, unit, label) {
  const name = typeof unit === "string" && unit.trim() ? unit.trim() : "container";
  const plural = listed === 1 || name.endsWith("s") ? name : `${name}s`;
  const claim = typeof label === "string" && label.trim() ? label.trim() : "Seller's claim";
  return `${available} of ${listed} ${plural} available in OceanRelay — ${claim}`;
}

function resultItem(entry) {
  const view = entry.view || {};
  const lane = view.lane || {};
  const dates = view.dates || {};
  const price = view.buyerPrice || {};
  const listed = view.quantity && Number.isSafeInteger(view.quantity.value) ? view.quantity.value : 0;
  const available = Number.isSafeInteger(entry.available) ? entry.available : 0;
  const taken = available <= 0;
  const yours = entry.yours ? `<p class="yours">Your offer</p>` : "";
  const takenLine = taken ? `<p>Fully taken</p>` : "";
  const unit = view.quantity && view.quantity.unit;
  const claim = view.quantity && view.quantity.label ? view.quantity.label : "Seller's claim";
  return `<li${taken ? ` class="taken"` : ""}>
    <a href="/market/${escapeHtml(entry.id)}">${escapeHtml(view.codeShareLine || "Offer")}</a>
    ${yours}
    <p>${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</p>
    <p>${escapeHtml(view.equipment)}</p>
    <p>${escapeHtml(quantityLine(available, listed, unit, claim))}</p>
    ${takenLine}
    <p>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</p>
    <p>${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</p>
    <p>${escapeHtml(capacityLabel(view.capacityStatus))}</p>
  </li>`;
}

function renderMarket({ results, query, error, publishedCount }) {
  let body;
  if (!publishedCount) {
    body = `<p id="market-empty">No published offers yet.</p>`;
  } else if (!results.length) {
    body = `<p id="market-none">No offers match these filters. <a href="/market">Clear filters</a></p>`;
  } else {
    body = `<ul id="market-list">${results.map(resultItem).join("")}</ul>`;
  }
  return page("Marketplace", `
    <h1>Marketplace</h1>
    ${filterForm(query, error)}
    ${body}
  `);
}

function renderDetail({ view, version, yours, available, csrf = "", banner = "", offerId = "" }) {
  const buyer = view || {};
  const lane = buyer.lane || {};
  const dates = buyer.dates || {};
  const price = buyer.buyerPrice || {};
  const quantity = buyer.quantity || {};
  const listed = Number.isSafeInteger(quantity.value) ? quantity.value : 0;
  const onHand = Number.isSafeInteger(available) ? available : listed;
  const provided = buyer.codeShareNameIsSellerProvided
    ? `<p>Seller-provided. Not a carrier endorsement.</p>`
    : "";
  const extraCaveat = buyer.capacityCaveat && buyer.capacityCaveat !== quantity.caveat
    ? `<p>${escapeHtml(buyer.capacityCaveat)}</p>`
    : "";
  const yoursText = yours ? `<p class="yours">Your offer</p>` : "";
  const form = csrf && !yours && onHand > 0
    ? `<form id="request-form" method="post" action="/market/${escapeHtml(offerId)}/requests">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="version" value="${escapeHtml(version)}">
        <label for="quantity">Quantity</label>
        <input id="quantity" name="quantity" inputmode="numeric" autocomplete="off">
        <button type="submit">Request</button>
      </form>`
    : "";
  return page("Offer", `
    <h1>${escapeHtml(buyer.codeShareLine || "Offer")}</h1>
    ${yoursText}
    ${banner ? `<p class="banner" id="request-banner">${escapeHtml(banner)}</p>` : ""}
    <p id="market-version">Version ${escapeHtml(version)}</p>
    <p id="available-quantity">${escapeHtml(String(onHand))} of ${escapeHtml(String(listed))} containers available in OceanRelay</p>
    <p>${escapeHtml(QUANTITY_LIMIT_COPY)}</p>
    <p>${escapeHtml(BOOKING_COPY)}</p>
    ${provided}
    <dl>
      <dt>Lane</dt><dd>${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</dd>
      <dt>Equipment</dt><dd>${escapeHtml(buyer.equipment)}</dd>
      <dt>Listed quantity</dt><dd>${escapeHtml(formatQuantity(quantity.value, quantity.unit))} — ${escapeHtml(quantity.label)}</dd>
      <dt>Sailing</dt><dd>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</dd>
      <dt>Cutoff</dt><dd>${escapeHtml(formatCutoff(dates.cutoffDate))}</dd>
      <dt>Validity deadline</dt><dd>${escapeHtml(dates.validityDeadline)}</dd>
      <dt>Buyer price</dt><dd>${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</dd>
      <dt>Service terms</dt><dd>${escapeHtml(buyer.serviceTerms)}</dd>
      <dt>Capacity</dt><dd>${escapeHtml(capacityLabel(buyer.capacityStatus))}</dd>
    </dl>
    <p>${escapeHtml(quantity.caveat)}</p>
    ${extraCaveat}
    ${form}
  `);
}

function renderNotFound() {
  return page("Offer not found", `<h1>Offer not found</h1><p>That offer was not found.</p>`);
}

module.exports = {
  renderMarket,
  renderDetail,
  renderNotFound,
};
