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
const { renderLayout, navFor, pill } = require("./layout");

function page(title, main, viewer) {
  return renderLayout({ title, nav: navFor("market", viewer), body: main });
}

function notFoundPage(main) {
  return renderLayout({ title: "Offer not found", nav: navFor("market", null, true), body: main });
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
    <div class="search-bar">
      <div>
        <label for="origin">Origin</label>
        <input id="origin" name="origin" value="${escapeHtml(value.origin || "")}">
      </div>
      <div>
        <label for="destination">Destination</label>
        <input id="destination" name="destination" value="${escapeHtml(value.destination || "")}">
      </div>
      <button type="submit">Search</button>
    </div>
    <div class="market-layout">
      <details class="filters" open>
        <summary>Filters</summary>
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
      </details>
      <div class="market-results">
        ${error ? `<p class="error" id="market-error">${escapeHtml(error)}</p>` : ""}
        <!--results-->
      </div>
    </div>
  </form>`;
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
  const yours = entry.yours ? `<p class="yours">${pill("Your offer", "neutral")}</p>` : "";
  const takenLine = taken ? `<p>${pill("Fully taken", "closed")}</p>` : "";
  const unit = view.quantity && view.quantity.unit;
  const claim = view.quantity && view.quantity.label ? view.quantity.label : "Seller's claim";
  return `<li${taken ? ` class="taken"` : ""}>
    <p class="lane">${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</p>
    <p class="share"><a href="/market/${escapeHtml(entry.id)}">${escapeHtml(view.codeShareLine || "Offer")}</a></p>
    ${yours}
    <p>${pill(view.equipment || "", "neutral")}</p>
    <p>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</p>
    <p class="price">${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</p>
    <p>${escapeHtml(quantityLine(available, listed, unit, claim))}</p>
    ${takenLine}
    <p>${pill(capacityLabel(view.capacityStatus), view.capacityStatus)}</p>
  </li>`;
}

function renderMarket({ results, query, error, publishedCount, viewer = null }) {
  let body;
  const count = Array.isArray(results) ? results.length : 0;
  if (!publishedCount) {
    body = `<p class="empty" id="market-empty">No published offers yet.</p>`;
  } else if (!results.length) {
    body = `<p class="empty" id="market-none">No offers match these filters. <a href="/market">Clear filters</a></p>`;
  } else {
    const noun = count === 1 ? "offer" : "offers";
    body = `<p id="market-count">${escapeHtml(count)} ${noun}</p><ul id="market-list">${results.map(resultItem).join("")}</ul>`;
  }
  const form = filterForm(query, error).replace("<!--results-->", () => body);
  return page("Marketplace", `
    <h1>Marketplace</h1>
    ${form}
  `, viewer);
}

function renderDetail({ view, version, yours, available, csrf = "", banner = "", offerId = "", viewer = null }) {
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
  const yoursText = yours ? `<p class="yours">${pill("Your offer", "neutral")}</p>` : "";
  const form = csrf && !yours && onHand > 0
    ? `<form id="request-form" method="post" action="/market/${escapeHtml(offerId)}/requests">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="version" value="${escapeHtml(version)}">
        <label for="quantity">Quantity</label>
        <input id="quantity" name="quantity" inputmode="numeric" autocomplete="off">
        <button type="submit">Request</button>
      </form>`
    : "";
  const meter = listed > 0
    ? `<meter min="0" max="${listed}" value="${onHand}">${escapeHtml(String(onHand))} of ${escapeHtml(String(listed))}</meter>`
    : "";
  return page("Offer", `
    <h1>${escapeHtml(buyer.codeShareLine || "Offer")}</h1>
    ${yoursText}
    ${banner ? `<p class="banner banner-error" id="request-banner">${escapeHtml(banner)}</p>` : ""}
    <div class="offer-detail">
      <section class="card">
        <h2>Buyer terms</h2>
        <p id="market-version">Version ${escapeHtml(version)}</p>
        ${provided}
        <dl>
          <dt>Lane</dt><dd>${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</dd>
          <dt>Equipment</dt><dd>${escapeHtml(buyer.equipment)}</dd>
          <dt>Listed quantity</dt><dd>${escapeHtml(formatQuantity(quantity.value, quantity.unit))} — ${escapeHtml(quantity.label)}</dd>
          <dt>Sailing</dt><dd>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</dd>
          <dt>Cutoff</dt><dd>${escapeHtml(formatCutoff(dates.cutoffDate))}</dd>
          <dt>Validity deadline</dt><dd>${escapeHtml(dates.validityDeadline)}</dd>
          <dt>Buyer price</dt><dd class="price">${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</dd>
          <dt>Service terms</dt><dd>${escapeHtml(buyer.serviceTerms)}</dd>
          <dt>Capacity</dt><dd>${escapeHtml(capacityLabel(buyer.capacityStatus))}</dd>
        </dl>
        <p>${escapeHtml(quantity.caveat)}</p>
        ${extraCaveat}
        <p>${escapeHtml(BOOKING_COPY)}</p>
      </section>
      <aside class="card">
        <h2>Request</h2>
        <p id="available-quantity">${escapeHtml(String(onHand))} of ${escapeHtml(String(listed))} containers available in OceanRelay</p>
        ${meter}
        <p>${escapeHtml(QUANTITY_LIMIT_COPY)}</p>
        ${form}
      </aside>
    </div>
  `, viewer);
}

function renderNotFound() {
  return notFoundPage(`<h1>Offer not found</h1><p>That offer was not found.</p>`);
}

module.exports = {
  renderMarket,
  renderDetail,
  renderNotFound,
};
