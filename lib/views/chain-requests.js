"use strict";

const { escapeHtml } = require("../page");
const { renderLayout, navFor, pill } = require("./layout");

const EXPLORER = "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/";
const CHAIN_STATES = new Set(["disabled", "checking", "ready", "degraded", "misconfigured"]);
const ACTION_STATES = Object.freeze({
  submitting: "Submitting",
  pending: "Pending",
  confirmed: "Confirmed",
  reverted: "Reverted",
  refused: "Refused",
  expired: "Expired",
});
const STATUS_LABELS = Object.freeze({
  accepted: "Accepted",
  carrier_pending: "Carrier pending",
  carrier_confirmed: "Carrier confirmed",
  rejected: "Rejected",
  rolled: "Rolled",
  completed: "Completed",
  cancelled: "Cancelled",
});

function page(body, viewer, script) {
  return renderLayout({
    title: "Record on chain",
    nav: navFor("requests", viewer),
    body,
    script: script || "",
  });
}

function banner(notice) {
  if (!notice || !notice.text) return "";
  const kind = notice.kind === "success" || notice.kind === "info" ? notice.kind : "error";
  return `<p class="banner banner-${kind}" id="chain-banner">${escapeHtml(notice.text)}</p>`;
}

function txLink(hash) {
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return "";
  const href = `${EXPLORER}${hash}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(hash)}</a>`;
}

function stateCell(state) {
  const label = ACTION_STATES[state] || "Unknown";
  return pill(label, ACTION_STATES[state] ? state : "neutral");
}

function kindLabel(action) {
  if (!action) return "";
  if (action.kind === "request") return "Link";
  if (action.kind === "acceptance") return "Acceptance";
  if (action.kind === "cancellation") return "Cancellation";
  if (action.kind === "status") return STATUS_LABELS[action.to] || "Status";
  return "Action";
}

function confirmedBlock(chain) {
  const confirmed = chain && chain.confirmed;
  if (!confirmed || confirmed.recorded !== true) return `<p id="chain-confirmed">Nothing is confirmed on chain yet.</p>`;
  let label = "Linked";
  let key = "confirmed";
  if (confirmed.cancelled) {
    label = "Cancelled";
    key = "cancelled";
  } else if (confirmed.status && STATUS_LABELS[confirmed.status]) {
    label = STATUS_LABELS[confirmed.status];
    key = confirmed.status;
  }
  const actions = chain && Array.isArray(chain.actions) ? chain.actions : [];
  const recorded = actions.filter((action) => action && action.status === "confirmed");
  const link = recorded.length ? txLink(recorded[recorded.length - 1].txHash) : "";
  const tx = link ? ` ${link}` : "";
  const counter = confirmed.status && confirmed.acceptedCounter != null
    ? ` Counter ${escapeHtml(confirmed.acceptedCounter)}.`
    : "";
  return `<p id="chain-confirmed">${pill(label, key)}${counter}${tx}</p>`;
}

function actionRows(chain) {
  const rows = chain && Array.isArray(chain.actions) ? chain.actions.slice().reverse() : [];
  if (!rows.length) return `<p class="empty" id="chain-actions-empty">No chain actions yet.</p>`;
  const body = rows.map((action) => `<tr>
      <td>${escapeHtml(kindLabel(action))}</td>
      <td>${stateCell(action && action.status)}</td>
      <td>${txLink(action && action.txHash)}</td>
      <td>${escapeHtml(action && action.error ? action.error : "")}</td>
    </tr>`).join("");
  return `<div class="table-wrap"><table id="chain-actions">
    <thead><tr><th>Action</th><th>State</th><th>Transaction</th><th>Error</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function chainLine(chain) {
  if (!chain || chain.ready) return "";
  const state = CHAIN_STATES.has(chain.state) ? chain.state : "unavailable";
  return `<p class="note" id="chain-state">Recording on chain is unavailable. Chain state: ${escapeHtml(state)}.</p>`;
}

function chainAttribute(domain) {
  const id = Number(domain && domain.chainId);
  if (!Number.isInteger(id) || id <= 0) return "";
  return JSON.stringify({
    chainId: `0x${id.toString(16)}`,
    chainName: "ForteL2 Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://fortel2-sequencer-rpc.onrender.com/"],
    blockExplorerUrls: ["https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/"],
  });
}

function signLabel(model) {
  if (model.kind === "request") return "Link";
  if (model.kind === "proposal") return "Sign terms";
  if (model.kind === "accept") return model.retry ? "Record acceptance" : "Accept and sign";
  if (model.kind === "status") return "Sign status";
  if (model.kind === "cancellation") return "Sign cancellation";
  return "Sign";
}

function actionForm(model) {
  const csrf = escapeHtml(model.csrf || "");
  const id = escapeHtml(model.requestId || "");
  if (model.step === "prepare") {
    return `<form id="chain-prepare" method="post" action="/chain/requests/${id}/prepare">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <button type="submit">Prepare</button>
    </form>
    <p class="note">Prepare creates this request's chain key and the salt for the current terms. It does not send a transaction.</p>`;
  }
  if (model.step === "check") {
    return `<form id="chain-check" method="post" action="/chain/requests/${id}/check">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <button type="submit">Check</button>
    </form>
    <p class="note">A chain action is already in progress. Check asks the chain. It does not start another one.</p>`;
  }
  if (model.step === "sign" && model.typed && model.domain) {
    const domain = JSON.stringify(model.domain);
    const typed = JSON.stringify(model.typed);
    const chain = chainAttribute(model.domain);
    const kind = escapeHtml(model.kind || "");
    const deadline = escapeHtml(String(model.deadline || ""));
    return `<p id="chain-next">${escapeHtml(signLabel(model))}</p>
    <form id="chain-sign" method="post" action="/chain/requests/${id}/sign" data-domain="${escapeHtml(domain)}" data-chain="${escapeHtml(chain)}" data-typed="${escapeHtml(typed)}">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <input type="hidden" name="kind" value="${kind}">
      <input type="hidden" name="deadline" value="${deadline}">
      <input type="hidden" name="signature" value="">
      <button type="button" id="chain-sign-button">${escapeHtml(signLabel(model))}</button>
    </form>
    <p class="note" id="chain-note">A browser wallet is required. You do not need ETH. The wallet will ask to switch to ForteL2 Sepolia, or to add it.</p>`;
  }
  if (model.step === "wait") {
    return `<p class="note" id="chain-wait">Waiting for the other company.</p>`;
  }
  if (model.step === "blocked") {
    return `<p class="note" id="chain-blocked">${escapeHtml(model.blockedText || "This acceptance cannot be recorded.")}</p>`;
  }
  if (model.step === "need_wallet") {
    return `<p class="note" id="chain-wallet">Bind a confirmed wallet before recording this request.</p>`;
  }
  if (model.step === "off_chain") {
    return `<p class="note" id="chain-off">This request stays off chain.</p>`;
  }
  return "";
}

function renderChainRequest(model) {
  const input = model || {};
  const body = `<h1>Record on chain</h1>
    ${banner(input.banner)}
    ${chainLine(input.chainStatus)}
    <section class="card">
      <h2>Chain record</h2>
      ${confirmedBlock(input.chain)}
      ${actionRows(input.chain)}
      ${actionForm(input)}
    </section>`;
  return page(body, input.viewer, input.script || "");
}

module.exports = { renderChainRequest };
