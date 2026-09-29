"use strict";

const { escapeHtml } = require("../page");
const { CURRENCIES } = require("../offer-domain");

const CURRENCY_CODES = Object.keys(CURRENCIES);

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
    input, select, textarea { font: inherit; width: 100%; box-sizing: border-box; margin-top: 0.25rem; }
    textarea { min-height: 6rem; }
    button { font: inherit; background: #0b6e4f; color: white; border: 0; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; margin-top: 1rem; }
    .error { color: #8a1c1c; margin: 0.25rem 0 0; }
    .banner { background: #fff7e6; border-radius: 8px; padding: 0.75rem 1rem; }
    .tag { font-weight: 400; color: #486581; }
    .panel { border: 1px solid #bcccdc; border-radius: 12px; padding: 1rem; margin: 1rem 0; }
    .muted { color: #486581; }
    dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.35rem 1rem; }
    dt { color: #486581; }
    dd { margin: 0; }
    ul { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <main>
    <nav>
      <a href="/">Home</a>
      <a href="/offers">Your offers</a>
      <a href="/offers/new">New offer</a>
    </nav>
    ${main}
  </main>
</body>
</html>`;
}

function banner(text) {
  if (!text) return "";
  return `<p class="banner">${escapeHtml(text)}</p>`;
}

function errorFor(errors, name) {
  if (!errors || !errors[name]) return "";
  return `<p class="error">${escapeHtml(errors[name])}</p>`;
}

function fieldTag(source, seeded, field, value) {
  if (source !== "rn_rate" || !seeded) return `<span class="tag">typed by seller</span>`;
  const seed = field === "operatingCarrier" ? seeded.carrier : seeded[field];
  const seedText = seed == null ? "" : String(seed).trim();
  const typed = value == null ? "" : String(value).trim();
  if (seedText !== "" && typed === seedText) return `<span class="tag">from Rate Ninja</span>`;
  return `<span class="tag">typed by seller</span>`;
}

function priceText(amount) {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) return "no price";
  return String(amount);
}

function formatMinor(minor, currency) {
  const exponent = CURRENCIES[currency];
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || exponent == null) return "";
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const body = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

function formatMarkup(markup, currency) {
  if (!markup || typeof markup !== "object") return "";
  if (markup.type === "percent") {
    const bps = markup.bps;
    const whole = Math.trunc(bps / 100);
    const frac = String(Math.abs(bps % 100)).padStart(2, "0");
    const percent = frac === "00" ? String(whole) : `${whole}.${frac}`.replace(/0+$/, "");
    return `${percent}% (${bps} basis points)`;
  }
  if (markup.type === "absolute") return `${formatMinor(markup.minor, currency)} absolute`;
  return "";
}

function currentVersion(offer) {
  const versions = offer && Array.isArray(offer.versions) ? offer.versions : [];
  return versions.find((version) => version && version.n === offer.currentVersion) || null;
}

function markupLabel(markup) {
  if (!markup || typeof markup !== "object") return "";
  if (markup.type === "percent") return `${markup.bps} bps`;
  if (markup.type === "absolute") return `${markup.minor} minor`;
  return "";
}

function versionChangeText(version, previous) {
  if (!previous) return "Initial version";
  const labels = [
    ["origin", "origin"],
    ["destination", "destination"],
    ["equipment", "equipment"],
    ["quantity", "quantity"],
    ["unit", "unit"],
    ["sailingStart", "sailing start"],
    ["sailingEnd", "sailing end"],
    ["cutoffDate", "cutoff"],
    ["validityDeadline", "validity deadline"],
    ["currency", "currency"],
    ["baseMinor", "base price"],
    ["codeShareName", "code-share name"],
    ["operatingCarrier", "operating carrier"],
    ["serviceTerms", "service terms"],
  ];
  const terms = version.terms || {};
  const prior = previous.terms || {};
  const parts = [];
  for (const [key, label] of labels) {
    const nextText = terms[key] == null ? "" : String(terms[key]);
    const prevText = prior[key] == null ? "" : String(prior[key]);
    if (nextText !== prevText) parts.push(`${label} ${prevText} → ${nextText}`);
  }
  const nextMarkup = markupLabel(terms.markup);
  const prevMarkup = markupLabel(prior.markup);
  if (nextMarkup !== prevMarkup) parts.push(`markup ${prevMarkup} → ${nextMarkup}`);
  if (version.capacityStatus !== previous.capacityStatus) {
    parts.push(`capacity status ${previous.capacityStatus} → ${version.capacityStatus}`);
  }
  return parts.length ? parts.join("; ") : "No term changes";
}

function renderVersionList(offer) {
  const versions = (offer && Array.isArray(offer.versions) ? offer.versions.slice() : [])
    .filter((version) => version && typeof version === "object")
    .sort((left, right) => left.n - right.n);
  if (!versions.length) return "";
  const items = versions.map((version, index) => {
    const previous = index > 0 ? versions[index - 1] : null;
    const when = version.createdAt || "";
    const who = version.createdBy || "";
    const name = version.terms && version.terms.codeShareName ? version.terms.codeShareName : "";
    return `<li>Version ${escapeHtml(version.n)} · ${escapeHtml(when)} · ${escapeHtml(who)} · ${escapeHtml(versionChangeText(version, previous))} · ${escapeHtml(name)}</li>`;
  }).join("");
  return `<h3>Versions</h3><ol id="version-list">${items}</ol>`;
}

function renderSnapshot(snapshot) {
  if (!snapshot) return `<p>No Rate Ninja snapshot. The seller typed this offer.</p>`;
  const notes = snapshot.dto ? snapshot.dto.notes : "";
  return `<dl>
        <dt>Retrieved</dt><dd>${escapeHtml(snapshot.retrievedAt)}</dd>
        <dt>Snapshot origin</dt><dd>${escapeHtml(snapshot.seeded && snapshot.seeded.origin)}</dd>
        <dt>Snapshot destination</dt><dd>${escapeHtml(snapshot.seeded && snapshot.seeded.destination)}</dd>
        <dt>Snapshot carrier</dt><dd>${escapeHtml(snapshot.seeded && snapshot.seeded.carrier)}</dd>
        <dt>Effective</dt><dd>${escapeHtml(snapshot.seeded && snapshot.seeded.effectiveDate)}</dd>
        <dt>Expires</dt><dd>${escapeHtml(snapshot.seeded && snapshot.seeded.expirationDate)}</dd>
        <dt>Snapshot base amount</dt><dd>${escapeHtml(snapshot.baseAmount)} whole units</dd>
        <dt>Notes</dt><dd>${escapeHtml(notes)}</dd>
      </dl>`;
}

function renderList({ offers }) {
  const items = offers.length
    ? `<ul id="offer-list">${offers.map((offer) => {
      const version = currentVersion(offer);
      const terms = (version && version.terms) || {};
      const label = `${terms.codeShareName || "Offer"} — ${terms.origin || ""} to ${terms.destination || ""}`;
      const state = offer.effectiveState || offer.state || "";
      const number = offer.currentVersion || (version && version.n) || "";
      const capacity = version && version.capacityStatus ? version.capacityStatus : "";
      return `<li><a href="/offers/${escapeHtml(offer.id)}">${escapeHtml(label)}</a> <span class="muted">${escapeHtml(state)} · version ${escapeHtml(number)} · ${escapeHtml(capacity)}</span></li>`;
    }).join("")}</ul>`
    : `<p>No offers yet</p><p><a href="/offers/new">Create an offer</a></p>`;
  return page("Your offers", `<h1>Your offers</h1>${items}`);
}

function renderChooser({
  bannerText = "",
  errorMessage = "",
  rates = [],
  sailings = [],
  retrievedAt = "",
  truncated = false,
  showEmptyRates = false,
}) {
  const rateItems = rates.map((rate) => {
    const id = rate && rate.id != null ? String(rate.id) : "";
    const cells = [
      ["20D", "rate20D"],
      ["40D", "rate40D"],
      ["40HC", "rate40HC"],
    ].map(([equipment, column]) => {
      const amount = rate ? rate[column] : 0;
      const text = priceText(amount);
      if (text === "no price" || !id) return `<span>${escapeHtml(equipment)}: no price</span>`;
      const href = `/offers/new?source=rn_rate&rateId=${encodeURIComponent(id)}&equipment=${equipment}`;
      return `<a href="${escapeHtml(href)}">${escapeHtml(equipment)}: ${escapeHtml(text)}</a>`;
    }).join(" · ");
    return `<li>
      <p>${escapeHtml(rate && rate.originPort)} → ${escapeHtml(rate && rate.destinationPort)}, ${escapeHtml(rate && rate.carrier)}</p>
      <p>${cells}</p>
      <p class="muted">Effective ${escapeHtml(rate && rate.rateEffectiveDate)} · Expires ${escapeHtml(rate && rate.rateExpirationDate)}</p>
    </li>`;
  }).join("");
  const sailingItems = sailings.map((row) => `<li>${escapeHtml(row && row.vessel)} ${escapeHtml(row && row.voyage)}, ${escapeHtml(row && row.carrier)}, ${escapeHtml(row && row.departurePort)}, ${escapeHtml(row && row.departure)} → ${escapeHtml(row && row.arrival)}</li>`).join("");
  const empty = showEmptyRates
    ? `<p>Your Rate Ninja account has no rates. You can still enter an offer by hand.</p>`
    : "";
  const retrieved = retrievedAt
    ? `<p>OceanRelay retrieved this list at ${escapeHtml(retrievedAt)}.</p>`
    : "";
  const truncation = truncated ? `<p>Only the first 1,000 rates are shown.</p>` : "";
  return page("New offer", `
    <h1>New offer</h1>
    ${banner(bannerText)}
    ${banner(errorMessage)}
    ${empty}
    ${retrieved}
    ${truncation}
    ${rateItems ? `<ul>${rateItems}</ul>` : ""}
    <p><a href="/offers/new?source=manual">Enter an offer by hand</a></p>
    <h2>Sailings</h2>
    <p>Schedule only. A sailing is not a quantity of space.</p>
    ${sailingItems ? `<ul>${sailingItems}</ul>` : `<p class="muted">No sailings in this page.</p>`}
  `);
}

function currencyOptions(selected) {
  const blank = `<option value=""${selected ? "" : " selected"}>Choose a currency</option>`;
  const rest = CURRENCY_CODES.map((code) => {
    const on = selected === code ? " selected" : "";
    return `<option value="${escapeHtml(code)}"${on}>${escapeHtml(code)}</option>`;
  }).join("");
  return blank + rest;
}

function renderForm({
  csrf,
  source,
  rateId = "",
  equipment = "",
  baseAmount = null,
  seeded = null,
  values = {},
  errors = {},
  mode = "create",
  offerId = "",
  bannerText = "",
  lockedPrice = null,
  snapshot = null,
}) {
  const value = (name) => values[name] ?? "";
  const fromRate = source === "rn_rate";
  const editing = mode === "edit";
  const baseBlock = fromRate
    ? (editing
      ? `<p>Base price <span class="tag">from Rate Ninja</span>: ${escapeHtml(lockedPrice || "")}. This price cannot be edited.</p>
         <h3>Snapshot</h3>
         ${renderSnapshot(snapshot)}
         ${errorFor(errors, "baseAmount")}`
      : (baseAmount == null
        ? `<p>Base price <span class="tag">from Rate Ninja</span> could not be loaded.</p>${errorFor(errors, "baseAmount")}`
        : `<p>Base price <span class="tag">from Rate Ninja</span>: ${escapeHtml(baseAmount)} whole units. This price cannot be edited.</p>${errorFor(errors, "baseAmount")}`))
    : `<label for="baseAmount">Base price <span class="tag">typed by seller</span></label>
       <input id="baseAmount" name="baseAmount" value="${escapeHtml(value("baseAmount"))}" inputmode="decimal" autocomplete="off">
       ${errorFor(errors, "baseAmount")}`;
  const equipmentBlock = fromRate
    ? `<p>Equipment: ${escapeHtml(equipment)}</p><input type="hidden" name="equipment" value="${escapeHtml(equipment)}">`
    : `<label for="equipment">Equipment</label>
       <select id="equipment" name="equipment">
         <option value="">Choose equipment</option>
         ${["20D", "40D", "40HC"].map((code) => `<option value="${code}"${value("equipment") === code ? " selected" : ""}>${code}</option>`).join("")}
       </select>
       ${errorFor(errors, "equipment")}`;
  const heading = editing ? "Edit offer" : (fromRate ? "Offer from a Rate Ninja rate" : "Manual offer");
  const action = editing ? `/offers/${encodeURIComponent(offerId)}/edit` : "/offers";
  return page(editing ? "Edit offer" : "Offer draft", `
    <h1>${escapeHtml(heading)}</h1>
    ${banner(bannerText)}
    ${errorFor(errors, "source")}
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <input type="hidden" name="source" value="${escapeHtml(source)}">
      ${fromRate && !editing ? `<input type="hidden" name="rateId" value="${escapeHtml(rateId)}">` : ""}
      ${equipmentBlock}
      <label for="origin">Origin ${fieldTag(source, seeded, "origin", value("origin"))}</label>
      <input id="origin" name="origin" value="${escapeHtml(value("origin"))}">
      ${errorFor(errors, "origin")}
      <label for="destination">Destination ${fieldTag(source, seeded, "destination", value("destination"))}</label>
      <input id="destination" name="destination" value="${escapeHtml(value("destination"))}">
      ${errorFor(errors, "destination")}
      <label for="operatingCarrier">Operating carrier ${fieldTag(source, seeded, "operatingCarrier", value("operatingCarrier"))}</label>
      <input id="operatingCarrier" name="operatingCarrier" value="${escapeHtml(value("operatingCarrier"))}">
      ${errorFor(errors, "operatingCarrier")}
      ${baseBlock}
      <label for="quantity">Claimed quantity</label>
      <input id="quantity" name="quantity" value="${escapeHtml(value("quantity"))}" inputmode="numeric" autocomplete="off">
      ${errorFor(errors, "quantity")}
      <label for="unit">Unit</label>
      <select id="unit" name="unit">
        <option value="">Choose a unit</option>
        <option value="container"${value("unit") === "container" ? " selected" : ""}>container</option>
      </select>
      ${errorFor(errors, "unit")}
      <label for="sailingDate">Sailing date</label>
      <input id="sailingDate" name="sailingDate" value="${escapeHtml(value("sailingDate"))}" placeholder="YYYY-MM-DD">
      ${errorFor(errors, "sailingDate")}
      <p class="muted">Or enter a sailing window instead of a single date.</p>
      <label for="sailingStart">Sailing window start</label>
      <input id="sailingStart" name="sailingStart" value="${escapeHtml(value("sailingStart"))}" placeholder="YYYY-MM-DD">
      ${errorFor(errors, "sailingStart")}
      <label for="sailingEnd">Sailing window end</label>
      <input id="sailingEnd" name="sailingEnd" value="${escapeHtml(value("sailingEnd"))}" placeholder="YYYY-MM-DD">
      ${errorFor(errors, "sailingEnd")}
      <label for="cutoffDate">Cutoff (optional)</label>
      <input id="cutoffDate" name="cutoffDate" value="${escapeHtml(value("cutoffDate"))}" placeholder="YYYY-MM-DD">
      ${errorFor(errors, "cutoffDate")}
      <label for="validityDeadline">Validity deadline</label>
      <input id="validityDeadline" name="validityDeadline" value="${escapeHtml(value("validityDeadline"))}" placeholder="YYYY-MM-DD">
      ${errorFor(errors, "validityDeadline")}
      <label for="currency">Currency</label>
      <select id="currency" name="currency">${currencyOptions(value("currency"))}</select>
      ${errorFor(errors, "currency")}
      <label for="markupType">Markup</label>
      <select id="markupType" name="markupType">
        <option value="">Choose a markup</option>
        <option value="absolute"${value("markupType") === "absolute" ? " selected" : ""}>Absolute amount</option>
        <option value="percent"${value("markupType") === "percent" ? " selected" : ""}>Percentage</option>
      </select>
      <label for="markupValue">Markup amount</label>
      <input id="markupValue" name="markupValue" value="${escapeHtml(value("markupValue"))}" inputmode="decimal" autocomplete="off">
      <p class="muted">Absolute markup uses major units, such as 0.29. Percentage uses a percent with up to two decimals, such as 2.5 or 10.</p>
      ${errorFor(errors, "markup")}
      <label for="codeShareName">Code-share name</label>
      <p>Seller-provided. Not a carrier endorsement.</p>
      <input id="codeShareName" name="codeShareName" value="${escapeHtml(value("codeShareName"))}">
      ${errorFor(errors, "codeShareName")}
      <label for="serviceTerms">Service terms</label>
      <textarea id="serviceTerms" name="serviceTerms">${escapeHtml(value("serviceTerms"))}</textarea>
      ${errorFor(errors, "serviceTerms")}
      <button type="submit">${editing ? "Save changes" : "Save draft"}</button>
    </form>
  `);
}

function renderBuyerPanel(view) {
  const price = formatMinor(view.buyerPrice.minor, view.buyerPrice.currency);
  const provided = view.codeShareNameIsSellerProvided
    ? `<p>Seller-provided. Not a carrier endorsement.</p>`
    : "";
  return `<section class="panel" id="buyer-panel">
    <h2>What a buyer will see</h2>
    <p>${escapeHtml(view.codeShareLine)}</p>
    ${provided}
    <dl>
      <dt>Lane</dt><dd>${escapeHtml(view.lane.origin)} → ${escapeHtml(view.lane.destination)}</dd>
      <dt>Equipment</dt><dd>${escapeHtml(view.equipment)}</dd>
      <dt>Quantity</dt><dd>${escapeHtml(view.quantity.value)} ${escapeHtml(view.quantity.unit)} — ${escapeHtml(view.quantity.label)}</dd>
      <dt>Sailing</dt><dd>${escapeHtml(view.dates.sailingStart)} to ${escapeHtml(view.dates.sailingEnd)}</dd>
      <dt>Cutoff</dt><dd>${escapeHtml(view.dates.cutoffDate)}</dd>
      <dt>Validity deadline</dt><dd>${escapeHtml(view.dates.validityDeadline)}</dd>
      <dt>Buyer price</dt><dd>${escapeHtml(price)} (${escapeHtml(view.buyerPrice.minor)} minor units)</dd>
      <dt>Service terms</dt><dd>${escapeHtml(view.serviceTerms)}</dd>
      <dt>Capacity</dt><dd>${escapeHtml(view.capacityStatus)}</dd>
    </dl>
    <p>${escapeHtml(view.quantity.caveat)}</p>
    ${view.capacityCaveat !== view.quantity.caveat ? `<p>${escapeHtml(view.capacityCaveat)}</p>` : ""}
  </section>`;
}

function provenance(version, field) {
  if (!version || version.source !== "rn_rate") return "typed by seller";
  const overridden = Array.isArray(version.overriddenFields) && version.overriddenFields.includes(field);
  return overridden ? "typed by seller" : "from Rate Ninja";
}

function renderPreview({ offer, buyer, warning, csrf, transitions, statusError, effectiveState, stateMoves }) {
  const version = currentVersion(offer) || {};
  const terms = version.terms || {};
  const history = Array.isArray(offer.statusHistory) ? offer.statusHistory : [];
  const historyHtml = history.length
    ? `<ol>${history.map((entry) => `<li>from ${escapeHtml(entry.from)} to ${escapeHtml(entry.to)} by ${escapeHtml(entry.actor)} at ${escapeHtml(entry.at)}</li>`).join("")}</ol>`
    : `<p>No status changes yet.</p>`;
  const stateHistory = Array.isArray(offer.stateHistory) ? offer.stateHistory : [];
  const stateHistoryHtml = stateHistory.length
    ? `<ol id="state-history">${stateHistory.map((entry) => `<li>from ${escapeHtml(entry.from)} to ${escapeHtml(entry.to)} by ${escapeHtml(entry.actor)} at ${escapeHtml(entry.at)}</li>`).join("")}</ol>`
    : `<p>No state changes yet.</p>`;
  const warningHtml = warning && warning.note
    ? `<p class="banner" id="source-warning">${escapeHtml(warning.note)}</p>`
    : (warning && warning.codes && warning.codes.length
      ? `<ul id="source-warnings">${warning.codes.map((code) => `<li data-warning="${escapeHtml(code)}">Warning: ${escapeHtml(code)}. ${escapeHtml(warning.text[code] || "")}</li>`).join("")}</ul>`
      : "");
  const forms = (transitions || []).map((to) => `<form method="post" action="/offers/${escapeHtml(offer.id)}/capacity-status">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <input type="hidden" name="to" value="${escapeHtml(to)}">
      <button type="submit">Record ${escapeHtml(to)}</button>
    </form>`).join("");
  const moveForms = (stateMoves || []).map((move) => `<form method="post" action="/offers/${escapeHtml(offer.id)}/state">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <input type="hidden" name="to" value="${escapeHtml(move.to)}">
      <button type="submit">${escapeHtml(move.label)}</button>
    </form>`).join("");
  const editLink = effectiveState === "expired"
    ? ""
    : `<p><a id="edit-offer" href="/offers/${escapeHtml(offer.id)}/edit">Edit offer</a></p>`;
  const published = offer.publishedAt ? `<dt>Published at</dt><dd>${escapeHtml(offer.publishedAt)}</dd>` : "";
  return page("Offer preview", `
    <h1>Offer preview</h1>
    ${banner(statusError)}
    ${warningHtml}
    ${editLink}
    ${moveForms}
    <section class="panel" id="private-panel">
      <h2>Private, only you see this</h2>
      <dl>
        <dt>State</dt><dd id="offer-state">${escapeHtml(effectiveState || offer.state || "")}</dd>
        <dt>Version</dt><dd id="offer-version">${escapeHtml(version.n)}</dd>
        ${published}
        <dt>Source</dt><dd>${escapeHtml(version.source)}</dd>
        <dt>Source record id</dt><dd>${escapeHtml(version.sourceRecordId)}</dd>
        <dt>Origin</dt><dd>${escapeHtml(terms.origin)} <span class="tag">${escapeHtml(provenance(version, "origin"))}</span></dd>
        <dt>Destination</dt><dd>${escapeHtml(terms.destination)} <span class="tag">${escapeHtml(provenance(version, "destination"))}</span></dd>
        <dt>Operating carrier</dt><dd>${escapeHtml(terms.operatingCarrier)} <span class="tag">${escapeHtml(provenance(version, "operatingCarrier"))}</span></dd>
        <dt>Base price</dt><dd>${escapeHtml(formatMinor(terms.baseMinor, terms.currency))} (${escapeHtml(terms.baseMinor)} minor units)</dd>
        <dt>Markup</dt><dd>${escapeHtml(formatMarkup(terms.markup, terms.currency))}</dd>
        <dt>Buyer price</dt><dd>${escapeHtml(formatMinor(terms.buyerMinor, terms.currency))} (${escapeHtml(terms.buyerMinor)} minor units)</dd>
        <dt>Capacity status</dt><dd>${escapeHtml(version.capacityStatus)}</dd>
      </dl>
      <h3>Snapshot</h3>
      ${renderSnapshot(version.snapshot)}
      <h3>Status history</h3>
      ${historyHtml}
      <h3>State history</h3>
      ${stateHistoryHtml}
      ${renderVersionList(offer)}
      ${forms}
    </section>
    ${renderBuyerPanel(buyer)}
  `);
}

function renderNotFound() {
  return page("Offer not found", `<h1>Offer not found</h1><p>That offer was not found.</p>`);
}

module.exports = {
  renderList,
  renderChooser,
  renderForm,
  renderPreview,
  renderNotFound,
};
