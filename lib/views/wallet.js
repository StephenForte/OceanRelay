"use strict";

const { escapeHtml } = require("../page");
const { renderLayout, navFor, pill } = require("./layout");

const EXPLORER = "https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/tx/";
const CHAIN_STATES = new Set(["disabled", "checking", "ready", "degraded", "misconfigured"]);
const STATE_LABELS = Object.freeze({
  submitting: "Submitting",
  pending: "Pending",
  confirmed: "Confirmed",
  reverted: "Reverted",
  refused: "Refused",
  expired: "Expired",
});

function page(body, viewer, script) {
  return renderLayout({
    title: "Wallet",
    nav: navFor("wallet", viewer),
    body,
    script: script || "",
  });
}

function banner(notice) {
  if (!notice || !notice.text) return "";
  const kind = notice.kind === "success" || notice.kind === "info" ? notice.kind : "error";
  return `<p class="banner banner-${kind}" id="wallet-banner">${escapeHtml(notice.text)}</p>`;
}

function txLink(hash) {
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return "";
  const href = `${EXPLORER}${hash}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(hash)}</a>`;
}

function dateCell(value) {
  return typeof value === "string" ? escapeHtml(value) : "";
}

function stateCell(state) {
  const label = STATE_LABELS[state] || "Unknown";
  return pill(label, STATE_LABELS[state] ? state : "neutral");
}

function walletRows(wallets) {
  const rows = Array.isArray(wallets) ? wallets.slice().reverse() : [];
  if (!rows.length) return `<p class="empty" id="wallet-empty">No wallets yet.</p>`;
  const body = rows.map((entry) => {
    const wallet = entry && typeof entry.wallet === "string" ? entry.wallet : "";
    return `<tr>
      <td><code>${escapeHtml(wallet)}</code></td>
      <td>${stateCell(entry && entry.state)}</td>
      <td>${dateCell(entry && entry.createdAt)}</td>
      <td>${txLink(entry && entry.txHash)}</td>
    </tr>`;
  }).join("");
  return `<div class="table-wrap"><table id="wallet-list">
    <thead><tr><th>Wallet</th><th>State</th><th>Date</th><th>Transaction</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function chainLine(chain) {
  if (!chain || chain.ready) return "";
  const state = CHAIN_STATES.has(chain.state) ? chain.state : "unavailable";
  return `<p class="note" id="chain-state">Chain state: ${escapeHtml(state)}.</p>`;
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

function actionForm(model) {
  const csrf = escapeHtml(model.csrf || "");
  if (model.action === "prepare") {
    return `<form id="wallet-prepare" method="post" action="/wallet/prepare">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <button type="submit">Prepare</button>
    </form>
    <p class="note">Prepare creates this company's key. It does not send a transaction.</p>`;
  }
  if (model.action === "check") {
    return `<form id="wallet-check" method="post" action="/wallet/check">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <button type="submit">Check pending</button>
    </form>
    <p class="note">A binding is already in progress. Check asks the chain. It does not start another one.</p>`;
  }
  if (model.action === "sign") {
    const domain = JSON.stringify(model.domain || {});
    const chain = chainAttribute(model.domain);
    return `<form id="wallet-bind" method="post" action="/wallet/bind" data-domain="${escapeHtml(domain)}" data-chain="${escapeHtml(chain)}" data-company-key="${escapeHtml(model.companyKey || "")}" data-deadline="${escapeHtml(model.deadline || "")}">
      <input type="hidden" name="csrf_token" value="${csrf}">
      <input type="hidden" name="deadline" value="${escapeHtml(model.deadline || "")}">
      <input type="hidden" name="wallet" value="">
      <input type="hidden" name="signature" value="">
      <button type="button" id="wallet-sign">Connect and sign</button>
    </form>
    <p class="note" id="wallet-note">A browser wallet is required. You do not need ETH. The wallet will ask to switch to ForteL2 Sepolia, or to add it.</p>`;
  }
  if (model.atCap) {
    return `<p class="note" id="wallet-cap">A company can bind at most 5 wallets.</p>`;
  }
  return "";
}

function renderWallet(model) {
  const input = model || {};
  const key = typeof input.companyKey === "string" && input.companyKey
    ? `<p class="note">Company key <code id="company-key">${escapeHtml(input.companyKey)}</code></p>`
    : "";
  const body = `<h1>Wallet</h1>
    ${banner(input.banner)}
    ${chainLine(input.chain)}
    <section class="card">
      <h2>Company wallets</h2>
      ${key}
      ${walletRows(input.wallets)}
      ${actionForm(input)}
    </section>`;
  return page(body, input.viewer, input.script || "");
}

module.exports = { renderWallet };
