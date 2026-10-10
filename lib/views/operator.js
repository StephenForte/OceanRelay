"use strict";

const { escapeHtml } = require("../page");
const { nextCarrierStatuses } = require("../records");
const { formatBuyerPrice, fulfilmentStatusLabel } = require("./format");
const { renderLayout, navFor, pill } = require("./layout");

const AUDIT_LIMIT = 200;

function page(title, main, viewer, current) {
  const overview = current === "overview" ? ` aria-current="page"` : "";
  const audit = current === "audit" ? ` aria-current="page"` : "";
  const chain = current === "chain" ? ` aria-current="page"` : "";
  return renderLayout({
    title,
    nav: navFor("operator", viewer),
    body: `<nav class="subnav" aria-label="Operator">
      <a href="/operator"${overview}>Overview</a>
      <a href="/operator/audit"${audit}>Audit log</a>
      <a href="/operator/chain"${chain}>Chain</a>
    </nav>
    ${main}`,
  });
}

function statePill(state) {
  if (!state) return "";
  return pill(state, state);
}

function offersOf(data) {
  return data && data.offers && typeof data.offers === "object" ? data.offers : {};
}

function requestsOf(data) {
  return data && data.requests && typeof data.requests === "object" ? data.requests : {};
}

function currentVersion(offer) {
  if (!offer || !Array.isArray(offer.versions)) return null;
  for (const version of offer.versions) {
    if (version && version.n === offer.currentVersion) return version;
  }
  return null;
}

function companies(data) {
  const names = new Map();
  function add(id, name) {
    if (typeof id !== "string" || id === "") return;
    if (!names.has(id)) names.set(id, new Set());
    if (typeof name === "string" && name.trim()) names.get(id).add(name.trim());
  }
  for (const offer of Object.values(offersOf(data))) {
    if (offer) add(offer.companyId, null);
  }
  for (const request of Object.values(requestsOf(data))) {
    if (!request) continue;
    add(request.sellerCompanyId, request.sellerCompanyName);
    add(request.buyerCompanyId, request.buyerCompanyName);
  }
  return [...names.entries()]
    .map(([id, set]) => ({ id, names: [...set].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function offerRows(data) {
  return Object.values(offersOf(data))
    .filter((offer) => offer && typeof offer.id === "string")
    .map((offer) => {
      const version = currentVersion(offer);
      return {
        id: offer.id,
        companyId: offer.companyId || "",
        source: version && typeof version.source === "string" ? version.source : "",
        state: typeof offer.state === "string" ? offer.state : "",
        currentVersion: offer.currentVersion,
        versionCount: Array.isArray(offer.versions) ? offer.versions.length : 0,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function requestRows(data) {
  return Object.values(requestsOf(data))
    .filter((request) => request && typeof request.id === "string")
    .map((request) => {
      const fulfilment = request.fulfilment;
      const cancellation = fulfilment && fulfilment.cancellation;
      return {
        id: request.id,
        state: typeof request.state === "string" ? request.state : "",
        carrierStatus: fulfilment && typeof fulfilment.status === "string" ? fulfilment.status : "",
        cancellation: cancellation && typeof cancellation.state === "string" ? cancellation.state : "",
        createdAt: request.createdAt || "",
      };
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.id.localeCompare(left.id));
}

function acceptedQuantity(request) {
  if (!request || request.state !== "accepted") return 0;
  if (request.fulfilment && request.fulfilment.status === "cancelled") return 0;
  const quantity = request.acceptance && request.acceptance.quantity;
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

function findInconsistencies(data) {
  const found = [];
  const offers = offersOf(data);
  const requests = Object.values(requestsOf(data)).filter((request) => request && typeof request.id === "string");
  const committed = new Map();
  for (const request of requests) {
    const quantity = acceptedQuantity(request);
    if (!quantity || typeof request.offerId !== "string") continue;
    committed.set(request.offerId, (committed.get(request.offerId) || 0) + quantity);
  }
  for (const [offerId, accepted] of committed) {
    const offer = offers[offerId];
    const version = currentVersion(offer);
    const listed = version && version.terms && Number.isSafeInteger(version.terms.quantity) ? version.terms.quantity : 0;
    if (accepted > listed) {
      found.push({
        kind: "over_committed",
        offerId,
        text: `Offer ${offerId} is over-committed: accepted quantity ${accepted} exceeds listed quantity ${listed}.`,
      });
    }
  }
  for (const request of requests) {
    const fulfilment = request.fulfilment;
    const cancellation = fulfilment && fulfilment.cancellation;
    if (cancellation && cancellation.state === "disputed") {
      found.push({ kind: "open_dispute", requestId: request.id, text: `Request ${request.id} is an open dispute.` });
    }
    if (cancellation && cancellation.state === "proposed") {
      found.push({
        kind: "cancellation_proposed",
        requestId: request.id,
        text: `Request ${request.id} has a cancellation proposal awaiting a response.`,
      });
    }
    if (request.state === "accepted" && (!fulfilment || typeof fulfilment !== "object")) {
      found.push({
        kind: "missing_fulfilment",
        requestId: request.id,
        text: `Request ${request.id} is accepted and has no fulfilment record.`,
      });
    }
    if (request.state !== "accepted" || !request.acceptance) continue;
    const acceptance = request.acceptance;
    if (typeof request.offerId !== "string" || !offers[request.offerId]) {
      found.push({
        kind: "missing_offer",
        requestId: request.id,
        text: `Request ${request.id} names an offer that is not in the records.`,
      });
    }
    const quantity = acceptance.quantity;
    const unit = acceptance.unitBuyerMinor;
    const total = acceptance.totalMinor;
    const product = Number.isSafeInteger(quantity) && Number.isSafeInteger(unit) ? quantity * unit : null;
    if (product == null || product !== total) {
      found.push({
        kind: "acceptance_total",
        requestId: request.id,
        text: `Request ${request.id} acceptance total does not match quantity times unit price.`,
      });
    }
    if (typeof acceptance.termsHash !== "string" || acceptance.termsHash === "") {
      found.push({
        kind: "acceptance_hash",
        requestId: request.id,
        text: `Request ${request.id} acceptance is missing its terms fingerprint.`,
      });
    }
  }
  return found;
}

function renderIndex(data, viewer = null) {
  const companyList = companies(data);
  const offers = offerRows(data);
  const requests = requestRows(data);
  const inconsistencies = findInconsistencies(data);
  const companyBody = companyList.length
    ? `<ul id="operator-companies">${companyList.map((company) => {
      const shown = company.names.length ? company.names.map((name) => escapeHtml(name)).join(", ") : "name not in a request";
      return `<li><code>${escapeHtml(company.id)}</code> — ${shown}</li>`;
    }).join("")}</ul>`
    : `<p id="operator-companies-empty">No companies in the records yet.</p>`;
  const offerBody = offers.length
    ? `<div class="table-wrap"><table id="operator-offers"><thead><tr><th>Offer</th><th>Company</th><th>Source</th><th>State</th><th>Version</th><th>Versions</th></tr></thead><tbody>${
      offers.map((offer) => `<tr>
        <td><code>${escapeHtml(offer.id)}</code></td>
        <td><code>${escapeHtml(offer.companyId)}</code></td>
        <td>${escapeHtml(offer.source)}</td>
        <td>${statePill(offer.state)}</td>
        <td>${escapeHtml(offer.currentVersion)}</td>
        <td>${escapeHtml(offer.versionCount)}</td>
      </tr>`).join("")
    }</tbody></table></div>`
    : `<p id="operator-offers-empty">No offers yet.</p>`;
  const requestBody = requests.length
    ? `<div class="table-wrap"><table id="operator-requests"><thead><tr><th>Request</th><th>State</th><th>Carrier status</th><th>Cancellation</th></tr></thead><tbody>${
      requests.map((request) => `<tr>
        <td><a href="/operator/requests/${escapeHtml(request.id)}"><code>${escapeHtml(request.id)}</code></a></td>
        <td>${statePill(request.state)}</td>
        <td>${request.carrierStatus ? pill(fulfilmentStatusLabel(request.carrierStatus), request.carrierStatus) : ""}</td>
        <td>${escapeHtml(cancellationLabel(request.cancellation))}</td>
      </tr>`).join("")
    }</tbody></table></div>`
    : `<p id="operator-requests-empty">No requests yet.</p>`;
  const issueBody = inconsistencies.length
    ? `<ul id="operator-inconsistencies">${inconsistencies.map((item) => `<li data-kind="${escapeHtml(item.kind)}">${escapeHtml(item.text)}</li>`).join("")}</ul>`
    : `<p id="operator-inconsistencies-empty">No inconsistencies.</p>`;
  return page("Operator", `
    <h1>Operator</h1>
    <p id="operator-chain"><a href="/operator/chain">Reconcile with the chain</a></p>
    <section class="panel" id="companies"><h2>Companies</h2>${companyBody}</section>
    <section class="panel" id="offers"><h2>Offers</h2>${offerBody}</section>
    <section class="panel" id="requests"><h2>Requests</h2>${requestBody}</section>
    <section class="panel" id="inconsistencies"><h2>Inconsistencies</h2>${issueBody}</section>
  `, viewer, "overview");
}

function cancellationLabel(state) {
  if (state === "disputed") return "Open dispute";
  if (state === "proposed") return "Proposal awaiting a response";
  return "";
}

function pinnedVersion(data, request) {
  const offer = offersOf(data)[request.offerId];
  if (!offer || !Array.isArray(offer.versions)) return null;
  for (const version of offer.versions) {
    if (version && version.n === request.version) return version;
  }
  return null;
}

function termsList(version, request) {
  const terms = version && version.terms && typeof version.terms === "object" ? version.terms : null;
  if (!terms) return `<p>The pinned offer version is not in the records.</p>`;
  const currency = typeof terms.currency === "string" ? terms.currency : "";
  return `<dl id="pinned-terms">
    <dt>Pinned version</dt><dd>${escapeHtml(request.version)}</dd>
    <dt>Requested quantity</dt><dd>${escapeHtml(request.quantity)}</dd>
    <dt>Origin</dt><dd>${escapeHtml(terms.origin || "")}</dd>
    <dt>Destination</dt><dd>${escapeHtml(terms.destination || "")}</dd>
    <dt>Equipment</dt><dd>${escapeHtml(terms.equipment || "")}</dd>
    <dt>Service terms</dt><dd>${escapeHtml(terms.serviceTerms || "")}</dd>
    <dt>Buyer price</dt><dd>${escapeHtml(formatBuyerPrice(terms.buyerMinor, currency))}</dd>
  </dl>`;
}

function listOrEmpty(items, empty, renderItem) {
  if (!items.length) return `<p>${escapeHtml(empty)}</p>`;
  return `<ol>${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ol>`;
}

function auditForRequest(data, requestId) {
  const audit = Array.isArray(data.audit) ? data.audit : [];
  return audit.filter((entry) => entry && entry.subject && entry.subject.requestId === requestId);
}

function renderRequest(data, requestId, { csrf = "", error = "", viewer = null } = {}) {
  const request = requestsOf(data)[requestId];
  if (!request) {
    return page("Operator request", `
      <h1>Request</h1>
      ${error ? `<p class="banner banner-error" id="operator-error">${escapeHtml(error)}</p>` : ""}
      <p class="empty" id="operator-request-empty">No request with that id.</p>
    `, viewer, "request");
  }
  const version = pinnedVersion(data, request);
  const counters = Array.isArray(request.counters) ? request.counters : [];
  const history = Array.isArray(request.history) ? request.history : [];
  const fulfilment = request.fulfilment && typeof request.fulfilment === "object" ? request.fulfilment : null;
  const fulfilmentHistory = fulfilment && Array.isArray(fulfilment.history) ? fulfilment.history : [];
  const cancellationEvents = fulfilment && Array.isArray(fulfilment.cancellationEvents) ? fulfilment.cancellationEvents : [];
  const acceptance = request.acceptance;
  const currency = acceptance && typeof acceptance.currency === "string"
    ? acceptance.currency
    : (version && version.terms && version.terms.currency) || "";
  const moves = fulfilment ? nextCarrierStatuses(fulfilment.status) : [];
  const choices = moves.map((status) => {
    return `<label><input type="radio" name="to" value="${escapeHtml(status)}" required> ${escapeHtml(fulfilmentStatusLabel(status))}</label>`;
  }).join("");
  const form = choices
    ? `<form id="operator-status" method="post" action="/operator/requests/${escapeHtml(requestId)}/status">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <fieldset>
          <legend>Record a carrier status</legend>
          ${choices}
        </fieldset>
        <label for="note">Note</label>
        <textarea id="note" name="note" maxlength="500" required></textarea>
        <button type="submit">Record status</button>
      </form>`
    : `<p>No further carrier status can be recorded.</p>`;
  const acceptanceBody = acceptance
    ? `<dl id="acceptance">
        <dt>Accepted at</dt><dd>${escapeHtml(acceptance.at || "")}</dd>
        <dt>Quantity</dt><dd>${escapeHtml(acceptance.quantity)}</dd>
        <dt>Unit price</dt><dd>${escapeHtml(formatBuyerPrice(acceptance.unitBuyerMinor, currency))}</dd>
        <dt>Total</dt><dd>${escapeHtml(formatBuyerPrice(acceptance.totalMinor, currency))}</dd>
        <dt>Terms fingerprint</dt><dd><code>${escapeHtml(acceptance.termsHash || "")}</code></dd>
      </dl>`
    : `<p>Not accepted.</p>`;
  const entries = auditForRequest(data, requestId);
  return page("Operator request", `
    <h1>Request</h1>
    ${error ? `<p class="banner banner-error" id="operator-error">${escapeHtml(error)}</p>` : ""}
    <p><code>${escapeHtml(requestId)}</code></p>
    <section class="panel" id="pinned"><h2>Pinned buyer terms</h2>${termsList(version, request)}</section>
    <section class="panel" id="counters"><h2>Counters</h2>${listOrEmpty(counters, "No counters.", (counter) => escapeHtml(`${counter.n}: quantity ${counter.quantity}, ${formatBuyerPrice(counter.unitBuyerMinor, currency)}, ${counter.serviceTerms || ""}`))}</section>
    <section class="panel" id="state-history"><h2>State history</h2>${listOrEmpty(history, "No state history.", (entry) => escapeHtml(`${entry.from || ""} → ${entry.to || ""} at ${entry.at || ""}`))}</section>
    <section class="panel" id="fulfilment-history"><h2>Fulfilment history</h2>
      <p id="fulfilment-status">${fulfilment ? pill(fulfilmentStatusLabel(fulfilment.status), fulfilment.status) : ""}</p>
      ${listOrEmpty(fulfilmentHistory, "No carrier status has been recorded.", (entry) => escapeHtml(`${entry.role === "operator" ? "OceanRelay operator" : (entry.role || "")} ${entry.from || ""} → ${entry.to || ""} at ${entry.at || ""} ${entry.note || ""}`))}
    </section>
    <section class="panel" id="cancellation-events"><h2>Cancellation events</h2>${listOrEmpty(cancellationEvents, "No cancellation events.", (entry) => escapeHtml(`${entry.event || ""} by ${entry.role || ""} at ${entry.at || ""}`))}</section>
    <section class="panel" id="acceptance-panel"><h2>Acceptance</h2>${acceptanceBody}</section>
    <section class="panel" id="request-audit"><h2>Audit</h2>${entries.length ? auditList(entries) : `<p>No audit entries for this request.</p>`}</section>
    <section class="panel" id="operator-status-panel"><h2>Record a carrier status</h2>${form}</section>
  `, viewer, "request");
}

function auditList(entries) {
  return `<ol id="audit-entries">${entries.map((entry) => `<li>${auditLine(entry)}</li>`).join("")}</ol>`;
}

function auditLine(entry) {
  const actor = entry && entry.actor;
  const actorText = actor ? `${actor.role || ""} ${actor.sub || ""} ${actor.companyId || ""}` : "none";
  const subject = entry && entry.subject ? entry.subject : {};
  const subjectText = `offer ${subject.offerId || ""} request ${subject.requestId || ""} version ${subject.version || ""}`;
  return escapeHtml(`${entry && entry.at ? entry.at : ""} ${entry && entry.event ? entry.event : ""} ${actorText} ${subjectText} ${JSON.stringify(entry && entry.detail ? entry.detail : {})}`);
}

function filteredAudit(data, query) {
  const requestId = query && typeof query.requestId === "string" ? query.requestId.trim() : "";
  const offerId = query && typeof query.offerId === "string" ? query.offerId.trim() : "";
  const audit = Array.isArray(data.audit) ? data.audit : [];
  const matched = audit.filter((entry) => {
    const subject = entry && entry.subject && typeof entry.subject === "object" ? entry.subject : {};
    if (requestId && subject.requestId !== requestId) return false;
    if (offerId && subject.offerId !== offerId) return false;
    return true;
  });
  const newest = matched.slice().reverse();
  return { total: matched.length, entries: newest.slice(0, AUDIT_LIMIT), requestId, offerId };
}

function renderAudit(data, query, viewer = null) {
  const filtered = filteredAudit(data, query);
  const body = filtered.entries.length
    ? auditList(filtered.entries)
    : `<p id="audit-empty">No audit entries.</p>`;
  const clipped = filtered.total > filtered.entries.length
    ? `<p id="audit-limit">Showing the latest ${AUDIT_LIMIT} of ${filtered.total}.</p>`
    : `<p>${escapeHtml(String(filtered.entries.length))} entries.</p>`;
  return page("Audit log", `
    <h1>Audit log</h1>
    <form method="get" action="/operator/audit" id="audit-filter">
      <label for="requestId">Request id</label>
      <input id="requestId" name="requestId" value="${escapeHtml(filtered.requestId)}">
      <label for="offerId">Offer id</label>
      <input id="offerId" name="offerId" value="${escapeHtml(filtered.offerId)}">
      <button type="submit">Filter</button>
    </form>
    ${clipped}
    ${body}
  `, viewer, "audit");
}

function renderFrame(title, main, viewer, current) {
  return page(title, main, viewer, current);
}

module.exports = {
  renderIndex,
  renderRequest,
  renderAudit,
  renderFrame,
  findInconsistencies,
};
