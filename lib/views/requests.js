"use strict";

const { escapeHtml } = require("../page");
const { CURRENCIES } = require("../offer-domain");
const {
  formatBuyerPrice,
  capacityLabel,
  formatCutoff,
  formatQuantity,
  requestStateLabel,
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
    nav { display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    label { display: block; margin-top: 0.9rem; font-weight: 700; }
    input, textarea { font: inherit; width: 100%; box-sizing: border-box; margin-top: 0.25rem; }
    textarea { min-height: 6rem; }
    button { font: inherit; background: #0b6e4f; color: white; border: 0; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; margin: 1rem 0.5rem 0 0; }
    .error { color: #8a1c1c; }
    .banner { background: #fff7e6; border-radius: 8px; padding: 0.75rem 1rem; }
    .muted { color: #486581; }
    .panel { border: 1px solid #bcccdc; border-radius: 12px; padding: 1rem; margin: 1rem 0; }
    dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.35rem 1rem; }
    dt { color: #486581; }
    dd { margin: 0; }
    ul, ol { padding-left: 1.2rem; }
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

function copyLines() {
  return `<p>${escapeHtml(BOOKING_COPY)}</p><p>${escapeHtml(QUANTITY_LIMIT_COPY)}</p>`;
}

function requestRow(row) {
  return `<li>
    <a href="/requests/${escapeHtml(row.id)}">${escapeHtml(row.codeShareLine || "Offer")}</a>
    <span>${escapeHtml(row.quantity)}</span>
    <span>${escapeHtml(row.state)}</span>
    <span>version ${escapeHtml(row.version)}</span>
  </li>`;
}

function renderList({ made, received }) {
  const madeItems = made && made.length ? `<ul id="requests-made">${made.map(requestRow).join("")}</ul>` : `<p>No requests yet.</p>`;
  const receivedItems = received && received.length
    ? `<ul id="requests-received">${received.map(requestRow).join("")}</ul>`
    : `<p>No requests yet.</p>`;
  return page("Requests", `
    <h1>Requests</h1>
    ${copyLines()}
    <h2>Requests you made</h2>
    ${madeItems}
    <h2>Requests on your offers</h2>
    ${receivedItems}
  `);
}

function minorToInput(minor, currency) {
  const exponent = CURRENCIES[currency];
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || exponent == null) return "";
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  if (exponent === 0) return digits;
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

function historyLine(entry) {
  const from = entry && entry.from ? requestStateLabel(entry.from) : "Opened";
  const to = requestStateLabel(entry && entry.to);
  const counter = entry && entry.counter ? ` · counter ${entry.counter}` : "";
  const at = entry && entry.at ? entry.at : "";
  return `${from} → ${to}${counter} at ${at}`;
}

function renderDetail({
  request,
  view,
  role,
  effective,
  csrf,
  error = "",
  sellerName = "",
  buyerName = "",
}) {
  const buyer = view || {};
  const lane = buyer.lane || {};
  const dates = buyer.dates || {};
  const price = buyer.buyerPrice || {};
  const quantity = buyer.quantity || {};
  const reveal = request.state === "accepted";
  const superseded = effective === "superseded";
  const counters = Array.isArray(request.counters) ? request.counters : [];
  const latest = counters.length ? counters[counters.length - 1] : null;
  const history = Array.isArray(request.history) ? request.history : [];
  const names = reveal
    ? `<dl id="party-names">
        <dt>Seller</dt><dd id="seller-name">${escapeHtml(sellerName)}</dd>
        <dt>Buyer</dt><dd id="buyer-name">${escapeHtml(buyerName)}</dd>
      </dl>`
    : (role === "seller" ? `<p id="counterparty">A contract owner</p>` : "");
  const counterItems = counters.map((counter) => {
    const money = formatBuyerPrice(counter.unitBuyerMinor, buyer.currency);
    return `<li>Counter ${escapeHtml(counter.n)}: ${escapeHtml(counter.quantity)} at ${escapeHtml(money)}. ${escapeHtml(counter.serviceTerms)}</li>`;
  }).join("");
  const historyItems = history.map((entry) => `<li>${escapeHtml(historyLine(entry))}</li>`).join("");
  const acceptance = request.acceptance && request.state === "accepted" ? request.acceptance : null;
  const accepted = acceptance
    ? `<section class="panel" id="acceptance">
        <h2>Acceptance</h2>
        <dl>
          <dt>Quantity</dt><dd>${escapeHtml(acceptance.quantity)}</dd>
          <dt>Unit price</dt><dd>${escapeHtml(formatBuyerPrice(acceptance.unitBuyerMinor, acceptance.currency))}</dd>
          <dt>Total</dt><dd>${escapeHtml(formatBuyerPrice(acceptance.totalMinor, acceptance.currency))}</dd>
          <dt>Currency</dt><dd>${escapeHtml(acceptance.currency)}</dd>
          <dt>Version</dt><dd>${escapeHtml(acceptance.version)}</dd>
          ${acceptance.counter ? `<dt>Counter</dt><dd>${escapeHtml(acceptance.counter)}</dd>` : ""}
          <dt>Accepted at</dt><dd>${escapeHtml(acceptance.at)}</dd>
          <dt>Terms fingerprint</dt><dd>${escapeHtml(String(acceptance.termsHash || "").slice(0, 12))}</dd>
        </dl>
      </section>`
    : "";
  const seedQuantity = latest ? latest.quantity : request.quantity;
  const seedPrice = latest ? latest.unitBuyerMinor : price.minor;
  const seedTerms = latest ? latest.serviceTerms : buyer.serviceTerms;
  const action = requestAction({ request, role, effective, csrf, seedQuantity, seedPrice, seedTerms, currency: buyer.currency });
  const changed = superseded
    ? `<p class="banner" id="superseded">This offer changed. The request is superseded and cannot be accepted.</p>`
    : "";
  return page("Request", `
    <h1>${escapeHtml(buyer.codeShareLine || "Request")}</h1>
    ${names}
    ${error ? `<p class="banner error" id="request-error">${escapeHtml(error)}</p>` : ""}
    ${changed}
    <p id="request-state">${escapeHtml(requestStateLabel(effective))}</p>
    <p id="pinned-version">Version ${escapeHtml(request.version)}</p>
    ${copyLines()}
    <section class="panel" id="buyer-terms">
      <h2>Buyer terms</h2>
      <p>Seller-provided. Not a carrier endorsement.</p>
      <dl>
        <dt>Lane</dt><dd>${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</dd>
        <dt>Equipment</dt><dd>${escapeHtml(buyer.equipment)}</dd>
        <dt>Quantity</dt><dd>${escapeHtml(formatQuantity(quantity.value, quantity.unit))}</dd>
        <dt>Sailing</dt><dd>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</dd>
        <dt>Cutoff</dt><dd>${escapeHtml(formatCutoff(dates.cutoffDate))}</dd>
        <dt>Validity deadline</dt><dd>${escapeHtml(dates.validityDeadline)}</dd>
        <dt>Buyer price</dt><dd>${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</dd>
        <dt>Service terms</dt><dd>${escapeHtml(buyer.serviceTerms)}</dd>
        <dt>Capacity</dt><dd>${escapeHtml(capacityLabel(buyer.capacityStatus))}</dd>
      </dl>
    </section>
    <h2>Counters</h2>
    ${counterItems ? `<ol id="counters">${counterItems}</ol>` : `<p>No counters yet.</p>`}
    <h2>State history</h2>
    ${historyItems ? `<ol id="state-history">${historyItems}</ol>` : `<p>No state changes yet.</p>`}
    ${accepted}
    ${action}
  `);
}

function requestAction({ request, role, effective, csrf, seedQuantity, seedPrice, seedTerms, currency }) {
  if (!request || request.state === "accepted" || request.state === "declined" || request.state === "withdrawn") return "";
  const id = encodeURIComponent(request.id);
  const token = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`;
  const forms = [];
  const open = effective === "pending" || effective === "countered";
  if (role === "seller" && request.state === "pending" && open) {
    forms.push(`<form method="post" action="/requests/${id}/accept">${token}<button type="submit">Accept</button></form>`);
  }
  if ((role === "seller" && request.state === "pending") || (role === "buyer" && request.state === "countered")) {
    forms.push(`<form method="post" action="/requests/${id}/decline">${token}<button type="submit">Decline</button></form>`);
  }
  if (role === "buyer" && (request.state === "pending" || request.state === "countered")) {
    forms.push(`<form method="post" action="/requests/${id}/withdraw">${token}<button type="submit">Withdraw</button></form>`);
  }
  if (role === "buyer" && request.state === "countered" && open) {
    forms.push(`<form method="post" action="/requests/${id}/accept">${token}<button type="submit">Accept</button></form>`);
  }
  if (role === "seller" && request.state === "pending" && open) {
    forms.push(`<form id="counter-form" method="post" action="/requests/${id}/counter">
      ${token}
      <h2>Counter</h2>
      <label for="quantity">Quantity</label>
      <input id="quantity" name="quantity" value="${escapeHtml(seedQuantity)}" inputmode="numeric" autocomplete="off">
      <label for="unitPrice">Unit price</label>
      <input id="unitPrice" name="unitPrice" value="${escapeHtml(minorToInput(seedPrice, currency))}" inputmode="decimal" autocomplete="off">
      <label for="serviceTerms">Service terms</label>
      <textarea id="serviceTerms" name="serviceTerms">${escapeHtml(seedTerms || "")}</textarea>
      <button type="submit">Counter</button>
    </form>`);
  }
  return forms.join("");
}

function renderNotFound() {
  return page("Request not found", `<h1>Request not found</h1><p>That request was not found.</p>`);
}

module.exports = {
  renderList,
  renderDetail,
  renderNotFound,
};
