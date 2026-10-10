"use strict";

const { escapeHtml } = require("../page");
const { renderFrame } = require("./operator");

const EXPLORER = "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/";
const GROUPS = Object.freeze([
  ["mismatch", "Mismatches"],
  ["unknown", "Unknown on chain"],
  ["lag", "Not signed yet"],
]);

function txLink(hash) {
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return "<p>No transaction.</p>";
  const href = `${EXPLORER}${hash}`;
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(hash)}</a></p>`;
}

function subjectLine(subject) {
  const parts = [];
  if (subject.companyId) parts.push(`company ${subject.companyId}`);
  if (subject.offerId) parts.push(`offer ${subject.offerId}`);
  if (subject.requestId) parts.push(`request ${subject.requestId}`);
  if (subject.wallet) parts.push(`wallet ${subject.wallet}`);
  return parts.join(", ") || "chain";
}

function findingBlock(finding, csrf) {
  const adopt = finding.adoptable
    ? `<form method="post" action="/operator/chain/adopt">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="finding" value="${escapeHtml(finding.id)}">
        <button type="submit">Adopt</button>
      </form>`
    : "";
  return `<article class="panel" id="finding-${escapeHtml(finding.id)}" data-reason="${escapeHtml(finding.reason)}" data-adoptable="${finding.adoptable ? "yes" : "no"}">
    <h3>${escapeHtml(finding.reason)}</h3>
    <p>${escapeHtml(subjectLine(finding.subject))}</p>
    <p>Records: ${escapeHtml(finding.records)}</p>
    <p>Chain: ${escapeHtml(finding.chain)}</p>
    ${txLink(finding.txHash)}
    ${adopt}
  </article>`;
}

function group(kind, title, findings, csrf) {
  const rows = findings.filter((item) => item.kind === kind);
  const body = rows.length
    ? rows.map((item) => findingBlock(item, csrf)).join("")
    : `<p>None.</p>`;
  return `<section id="findings-${escapeHtml(kind)}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function renderChain({ csrf, findings, unavailable, result }, viewer) {
  const banner = result === "corrected"
    ? `<p class="banner banner-success" id="chain-result">The records now match that chain item.</p>`
    : result === "refused"
      ? `<p class="banner banner-error" id="chain-result">That finding no longer matches the chain. Nothing was written.</p>`
      : result === "unavailable"
        ? `<p class="banner banner-error" id="chain-result">The chain is unavailable.</p>`
        : "";
  const notice = unavailable ? `<p id="chain-unavailable">The chain is unavailable.</p>` : "";
  const report = Array.isArray(findings)
    ? `${findings.length ? "" : `<p id="chain-clean">No findings.</p>`}
      ${GROUPS.map(([kind, title]) => group(kind, title, findings, csrf)).join("")}`
    : "";
  return renderFrame("Chain", `
    <h1>Chain</h1>
    ${banner}
    <form method="post" action="/operator/chain/reconcile" id="chain-reconcile">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <button type="submit">Reconcile</button>
    </form>
    <p>Reconciling reads the chain and does not change the records.</p>
    ${notice}
    ${report}
  `, viewer, "chain");
}

module.exports = { renderChain };
