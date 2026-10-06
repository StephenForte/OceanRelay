"use strict";

const { escapeHtml } = require("../page");
const { CURRENCIES } = require("../offer-domain");
const {
  formatBuyerPrice,
  capacityLabel,
  formatCutoff,
  formatQuantity,
  requestStateLabel,
  fulfilmentStatusLabel,
  BOOKING_COPY,
  QUANTITY_LIMIT_COPY,
  NOT_CHECKED_COPY,
  DISPUTE_COPY,
} = require("./format");
const { renderLayout, navFor, pill } = require("./layout");

const LABEL_KEY = {
  Pending: "pending",
  Countered: "countered",
  Accepted: "accepted",
  Declined: "declined",
  Withdrawn: "withdrawn",
  Superseded: "superseded",
  "Carrier pending": "carrier_pending",
  "Carrier confirmed": "carrier_confirmed",
  Rejected: "rejected",
  Rolled: "rolled",
  Completed: "completed",
  Cancelled: "cancelled",
  Dispute: "disputed",
};

function page(title, main, viewer) {
  return renderLayout({ title, nav: navFor("requests", viewer), body: main });
}

function notFoundPage(main) {
  return renderLayout({ title: "Request not found", nav: navFor("requests", null, true), body: main });
}

function labelledPill(label) {
  return pill(label, LABEL_KEY[label] || "neutral");
}

function copyLines() {
  return `<p>${escapeHtml(BOOKING_COPY)}</p><p>${escapeHtml(QUANTITY_LIMIT_COPY)}</p>`;
}

function requestTable(id, rows) {
  if (!rows || !rows.length) return `<p class="empty">No requests yet.</p>`;
  const body = rows.map((row) => `<tr>
    <td><a href="/requests/${escapeHtml(row.id)}">${escapeHtml(row.codeShareLine || "Offer")}</a></td>
    <td>${escapeHtml(row.quantity)}</td>
    <td>${labelledPill(row.state)}${row.dispute ? ` ${labelledPill("Dispute")}` : ""}</td>
    <td>${row.fulfilment ? labelledPill(row.fulfilment) : ""}</td>
    <td>version ${escapeHtml(row.version)}</td>
  </tr>`).join("");
  return `<div class="table-wrap"><table id="${id}"><thead><tr><th>Offer</th><th>Quantity</th><th>State</th><th>Carrier status</th><th>Version</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderList({ made, received, viewer = null }) {
  return page("Requests", `
    <h1>Requests</h1>
    ${copyLines()}
    <h2>Requests you made</h2>
    ${requestTable("requests-made", made)}
    <h2>Requests on your offers</h2>
    ${requestTable("requests-received", received)}
  `, viewer);
}

function commitTotal(quantity, unitMinor, currency) {
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitMinor) || quantity < 1 || unitMinor < 1) return "";
  const product = BigInt(quantity) * BigInt(unitMinor);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) return "";
  return formatBuyerPrice(Number(product), currency);
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
  viewer = null,
}) {
  const buyer = view || {};
  const lane = buyer.lane || {};
  const dates = buyer.dates || {};
  const price = buyer.buyerPrice || {};
  const quantity = buyer.quantity || {};
  const reveal = request.state === "accepted";
  const sellerName = reveal && typeof request.sellerCompanyName === "string" ? request.sellerCompanyName : "";
  const buyerName = reveal && typeof request.buyerCompanyName === "string" ? request.buyerCompanyName : "";
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
  const commit = request.state === "countered" && latest
    ? `<section class="panel" id="accept-commit">
        <h2>Accept commits these terms</h2>
        <dl>
          <dt>Quantity</dt><dd id="accept-quantity">${escapeHtml(latest.quantity)}</dd>
          <dt>Unit price</dt><dd id="accept-unit-price">${escapeHtml(formatBuyerPrice(latest.unitBuyerMinor, buyer.currency))}</dd>
          <dt>Total</dt><dd id="accept-total">${escapeHtml(commitTotal(latest.quantity, latest.unitBuyerMinor, buyer.currency))}</dd>
        </dl>
      </section>`
    : "";
  const seedQuantity = latest ? latest.quantity : request.quantity;
  const seedPrice = latest ? latest.unitBuyerMinor : price.minor;
  const seedTerms = latest ? latest.serviceTerms : buyer.serviceTerms;
  const action = requestAction({ request, role, effective, csrf, seedQuantity, seedPrice, seedTerms, currency: buyer.currency });
  const changed = superseded
    ? `<p class="banner banner-error" id="superseded">This offer changed. The request is superseded and cannot be accepted.</p>`
    : "";
  const stateText = requestStateLabel(effective);
  const stateKey = LABEL_KEY[stateText] || "neutral";
  const fulfilment = fulfilmentParts(request, csrf);
  const cancellation = cancellationPanel(request, role, csrf);
  const actions = `${action}${fulfilment.form}${cancellation}`;
  const countersBlock = counterItems ? `<ol id="counters">${counterItems}</ol>` : `<p>No counters yet.</p>`;
  const historyBlock = historyItems ? `<ol id="state-history">${historyItems}</ol>` : `<p>No state changes yet.</p>`;
  return page("Request", `
    <article class="card">
      <h1>${escapeHtml(buyer.codeShareLine || "Request")}</h1>
      <p class="pill pill-${stateFamily(stateKey)}" id="request-state">${escapeHtml(stateText)}</p>
      ${names}
      ${error ? `<p class="banner banner-error" id="request-error">${escapeHtml(error)}</p>` : ""}
      ${changed}
      <p id="pinned-version">Version ${escapeHtml(request.version)}</p>
      <p>Requested quantity <span id="requested-quantity">${escapeHtml(request.quantity)}</span></p>
      ${commit}
      ${accepted}
      ${fulfilment.status}
      ${copyLines()}
      <section class="panel" id="buyer-terms">
        <h2>Buyer terms</h2>
        <p>Seller-provided. Not a carrier endorsement.</p>
        <dl>
          <dt>Lane</dt><dd>${escapeHtml(lane.origin)} → ${escapeHtml(lane.destination)}</dd>
          <dt>Equipment</dt><dd>${escapeHtml(buyer.equipment)}</dd>
          <dt>Listed quantity</dt><dd id="listed-quantity">${escapeHtml(formatQuantity(quantity.value, quantity.unit))}</dd>
          <dt>Sailing</dt><dd>${escapeHtml(dates.sailingStart)} to ${escapeHtml(dates.sailingEnd)}</dd>
          <dt>Cutoff</dt><dd>${escapeHtml(formatCutoff(dates.cutoffDate))}</dd>
          <dt>Validity deadline</dt><dd>${escapeHtml(dates.validityDeadline)}</dd>
          <dt>Buyer price</dt><dd>${escapeHtml(formatBuyerPrice(price.minor, price.currency))}</dd>
          <dt>Service terms</dt><dd>${escapeHtml(buyer.serviceTerms)}</dd>
          <dt>Capacity</dt><dd>${escapeHtml(capacityLabel(buyer.capacityStatus))}</dd>
        </dl>
      </section>
    </article>
    <article class="card">
      <h2>Actions</h2>
      ${actions || `<p class="empty">No actions on this request.</p>`}
    </article>
    <article class="card">
      <h2>Timeline</h2>
      ${timeline(request, buyer)}
      <div hidden>
        <h2>Counters</h2>
        ${countersBlock}
        <h2>State history</h2>
        ${historyBlock}
        ${fulfilment.history}
      </div>
    </article>
  `, viewer);
}

const STATE_FAMILY = {
  pending: "wait",
  countered: "attention",
  accepted: "good",
  declined: "bad",
  withdrawn: "closed",
  superseded: "closed",
  neutral: "neutral",
  carrier_pending: "wait",
  carrier_confirmed: "good",
  rejected: "bad",
  rolled: "attention",
  completed: "good",
  cancelled: "closed",
  disputed: "bad",
};

function stateFamily(key) {
  return STATE_FAMILY[key] || "neutral";
}

function timeline(request, buyer) {
  const events = [];
  const history = Array.isArray(request.history) ? request.history : [];
  history.forEach((entry, index) => {
    events.push({ at: entry && entry.at ? entry.at : "", order: 0, index, text: historyLine(entry) });
  });
  const counters = Array.isArray(request.counters) ? request.counters : [];
  counters.forEach((counter, index) => {
    const money = formatBuyerPrice(counter && counter.unitBuyerMinor, buyer.currency);
    events.push({
      at: counter && counter.at ? counter.at : "",
      order: 1,
      index,
      text: `Counter ${counter && counter.n}: ${counter && counter.quantity} at ${money}. ${counter && counter.serviceTerms ? counter.serviceTerms : ""}`,
    });
  });
  const fulfilment = request.fulfilment && typeof request.fulfilment === "object" ? request.fulfilment : null;
  const carrier = fulfilment && Array.isArray(fulfilment.history) ? fulfilment.history : [];
  carrier.forEach((entry, index) => {
    const role = entry && entry.role === "buyer"
      ? "Buyer"
      : entry && entry.role === "operator"
        ? "OceanRelay operator"
        : "Seller";
    const who = entry && entry.role === "operator" ? "the OceanRelay operator" : partyName(request, entry && entry.role);
    events.push({
      at: entry && entry.at ? entry.at : "",
      order: 2,
      index,
      text: `${role}, ${who}, ${entry && entry.at ? entry.at : ""}, ${entry && entry.note ? entry.note : ""}`,
    });
  });
  const cancellations = fulfilment && Array.isArray(fulfilment.cancellationEvents) ? fulfilment.cancellationEvents : [];
  cancellations.forEach((entry, index) => {
    events.push({
      at: entry && entry.at ? entry.at : "",
      order: 3,
      index,
      text: `${entry && entry.event ? entry.event : ""} by ${entry && entry.role ? entry.role : ""}. ${entry && entry.reason ? entry.reason : ""}`,
    });
  });
  events.sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.order - right.order || left.index - right.index);
  if (!events.length) return `<ol class="timeline" id="request-timeline"></ol><p class="empty">No events yet.</p>`;
  return `<ol class="timeline" id="request-timeline">${events.map((event) => `<li><time datetime="${escapeHtml(event.at)}">${escapeHtml(event.at)}</time> ${escapeHtml(event.text)}</li>`).join("")}</ol>`;
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
  const sellerDeclines = role === "seller" && (request.state === "pending" || request.state === "countered");
  const buyerDeclines = role === "buyer" && request.state === "countered";
  if (sellerDeclines || buyerDeclines) {
    forms.push(`<form method="post" action="/requests/${id}/decline">${token}<button type="submit" class="btn-danger">Decline</button></form>`);
  }
  if (role === "buyer" && (request.state === "pending" || request.state === "countered")) {
    forms.push(`<form method="post" action="/requests/${id}/withdraw">${token}<button type="submit" class="btn-danger">Withdraw</button></form>`);
  }
  if (role === "buyer" && request.state === "countered" && open) {
    forms.push(`<form method="post" action="/requests/${id}/accept">${token}<button type="submit">Accept</button></form>`);
  }
  if (role === "seller" && request.state === "pending" && open) {
    forms.push(`<form id="counter-form" method="post" action="/requests/${id}/counter">
      ${token}
      <h2>Counter</h2>
      <label for="quantity">Counter quantity</label>
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

function partyName(request, role) {
  if (role === "buyer") return request.buyerCompanyName || "the buyer";
  if (role === "seller") return request.sellerCompanyName || "the seller";
  return "a party";
}

function recordedBy(request, entry) {
  if (entry && entry.role === "operator") return "the OceanRelay operator";
  return partyName(request, entry && entry.role);
}

function recordedLine(request) {
  const fulfilment = request.fulfilment;
  if (!fulfilment) return "";
  const status = fulfilment.status;
  if (status !== "carrier_confirmed" && status !== "rolled" && status !== "completed") return "";
  const history = Array.isArray(fulfilment.history) ? fulfilment.history : [];
  let entry = null;
  for (const item of history) {
    if (item && item.to === status) entry = item;
  }
  if (!entry) return "";
  const date = typeof entry.at === "string" ? entry.at.slice(0, 10) : "";
  const label = fulfilmentStatusLabel(status);
  return `${label}, recorded by ${recordedBy(request, entry)} on ${date}. ${NOT_CHECKED_COPY}`;
}

function fulfilmentParts(request, csrf) {
  if (request.state !== "accepted" || !request.fulfilment) return { status: "", history: "", form: "" };
  const fulfilment = request.fulfilment;
  const history = Array.isArray(fulfilment.history) ? fulfilment.history : [];
  const lines = history.map((entry) => {
    const role = entry && entry.role === "buyer"
      ? "Buyer"
      : entry && entry.role === "operator"
        ? "OceanRelay operator"
        : "Seller";
    const who = entry && entry.role === "operator" ? "the OceanRelay operator" : partyName(request, entry && entry.role);
    const text = `${role}, ${who}, ${entry && entry.at ? entry.at : ""}, ${entry && entry.note ? entry.note : ""}`;
    return `<li>${escapeHtml(text)}</li>`;
  }).join("");
  const recorded = recordedLine(request);
  const moves = Array.isArray(request.carrierMoves) ? request.carrierMoves : [];
  const choices = moves.map((status) => {
    const label = fulfilmentStatusLabel(status);
    return `<label><input type="radio" name="to" value="${escapeHtml(status)}"> ${escapeHtml(label)}</label>`;
  }).join("");
  const form = choices
    ? `<form id="status-form" method="post" action="/requests/${encodeURIComponent(request.id)}/status">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <fieldset>
          <legend>Record a carrier status</legend>
          ${choices}
        </fieldset>
        <label for="note">Note</label>
        <textarea id="note" name="note" maxlength="500"></textarea>
        <button type="submit">Record status</button>
      </form>`
    : "";
  const family = stateFamily(fulfilment.status);
  return {
    status: `<p class="pill pill-${family}" id="fulfilment-status">${escapeHtml(fulfilmentStatusLabel(fulfilment.status))}</p>${recorded ? `<p id="carrier-record">${escapeHtml(recorded)}</p>` : ""}`,
    history: lines ? `<ol id="fulfilment-history">${lines}</ol>` : `<p>No carrier status has been recorded.</p>`,
    form,
  };
}

function cancellationPanel(request, role, csrf) {
  if (request.state !== "accepted" || !request.fulfilment) return "";
  const fulfilment = request.fulfilment;
  if (fulfilment.status === "completed") return "";
  if (fulfilment.status === "cancelled") {
    return `<section class="panel" id="cancellation"><h2>Cancellation</h2><p>Cancelled. Both parties agreed.</p></section>`;
  }
  const id = encodeURIComponent(request.id);
  const token = `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">`;
  const cancellation = fulfilment.cancellation;
  const reason = cancellation && typeof cancellation.reason === "string" ? cancellation.reason : "";
  const reasonLine = reason !== "" ? `<p id="cancellation-reason">${escapeHtml(reason)}</p>` : "";
  const propose = `<form id="cancel-propose" method="post" action="/requests/${id}/cancel/propose">
    ${token}
    <label for="reason">Reason</label>
    <textarea id="reason" name="reason" maxlength="500"></textarea>
    <button type="submit">Propose cancellation</button>
  </form>`;
  let body = propose;
  if (cancellation && cancellation.state === "proposed") {
    const mine = cancellation.proposedByCompanyId === (role === "buyer" ? request.buyerCompanyId : request.sellerCompanyId);
    body = mine
      ? `${reasonLine}<form id="cancel-withdraw" method="post" action="/requests/${id}/cancel/withdraw">${token}<button type="submit" class="btn-danger">Withdraw cancellation</button></form>`
      : `${reasonLine}<form id="cancel-agree" method="post" action="/requests/${id}/cancel/agree">${token}<button type="submit">Agree to cancel</button></form><form id="cancel-refuse" method="post" action="/requests/${id}/cancel/refuse">${token}<button type="submit" class="btn-danger">Refuse cancellation</button></form>`;
  } else if (cancellation && cancellation.state === "disputed") {
    body = `<p id="dispute">${escapeHtml(DISPUTE_COPY)}</p>${reasonLine}${propose}`;
  }
  return `<section class="panel" id="cancellation"><h2>Cancellation</h2>${body}</section>`;
}

function renderNotFound() {
  return notFoundPage(`<h1>Request not found</h1><p>That request was not found.</p>`);
}

module.exports = {
  renderList,
  renderDetail,
  renderNotFound,
};
