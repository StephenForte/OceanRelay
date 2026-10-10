"use strict";

const { stylesheetHref } = require("./styles");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

const NAV = [
  { id: "market", href: "/market", label: "Marketplace" },
  { id: "offers", href: "/offers", label: "Your offers" },
  { id: "requests", href: "/requests", label: "Requests" },
  { id: "wallet", href: "/wallet", label: "Wallet" },
];

const PILL_FAMILY = {
  draft: "neutral",
  published: "good",
  paused: "wait",
  expired: "closed",
  pending: "wait",
  countered: "attention",
  accepted: "good",
  declined: "bad",
  withdrawn: "closed",
  superseded: "closed",
  seller_asserted: "neutral",
  carrier_pending: "wait",
  carrier_confirmed: "good",
  rejected: "bad",
  rolled: "attention",
  completed: "good",
  cancelled: "closed",
  disputed: "bad",
  submitting: "wait",
  confirmed: "good",
  reverted: "bad",
  refused: "bad",
  revoked: "closed",
};

function pill(text, key) {
  const family = PILL_FAMILY[key] || "neutral";
  return `<span class="pill pill-${family}">${escapeHtml(text)}</span>`;
}

function viewerFor(deps, auth) {
  const identity = auth && auth.identity ? auth.identity : null;
  const sub = identity && typeof identity.sub === "string" ? identity.sub : "";
  const subs = deps && deps.config && deps.config.operatorSubs;
  const operator = Boolean(sub && subs && typeof subs.has === "function" && subs.has(sub));
  return {
    signedIn: Boolean(identity),
    companyName: identity && typeof identity.companyName === "string" ? identity.companyName : "",
    name: identity && typeof identity.name === "string" ? identity.name : "",
    sub,
    csrf: auth && auth.session && typeof auth.session.csrf === "string" ? auth.session.csrf : "",
    operator,
  };
}

function mark() {
  return `<svg class="mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M2 22c3.2 0 3.2-6 6.4-6s3.2 6 6.4 6 3.2-6 6.4-6 3.2 6 6.4 6"/>
    <circle cx="8" cy="10" r="2" fill="currentColor"/>
    <circle cx="24" cy="10" r="2" fill="currentColor"/>
    <path fill="none" stroke="currentColor" stroke-width="2" d="M10 10h12"/>
  </svg>`;
}

function navLinks(nav) {
  const items = NAV.map((item) => {
    const current = item.id === nav.active ? ` aria-current="page"` : "";
    return `<a href="${item.href}"${current}>${item.label}</a>`;
  });
  if (nav.isOperator) {
    const current = nav.active === "operator" ? ` aria-current="page"` : "";
    items.push(`<a href="/operator"${current}>Operator</a>`);
  }
  return items.join("");
}

function account(nav) {
  if (!nav.signedIn || (!nav.companyName && !nav.csrf)) return "";
  return `<div class="account">
    <span class="company">${escapeHtml(nav.companyName)}</span>
    <form method="post" action="/disconnect">
      <input type="hidden" name="csrf_token" value="${escapeHtml(nav.csrf)}">
      <button type="submit">Disconnect</button>
    </form>
  </div>`;
}

// C-13's nav. Not-found pages pass signedIn with an empty company and csrf so
// the header stays the same for every viewer. Existing checks compare those
// bodies across different users.
function navFor(active, viewer, fixed = false) {
  if (fixed || !viewer || !viewer.signedIn) {
    return {
      active: active || "",
      signedIn: Boolean(fixed),
      isOperator: false,
      companyName: "",
      csrf: "",
    };
  }
  return {
    active: active || "",
    signedIn: true,
    isOperator: Boolean(viewer.operator),
    companyName: viewer.companyName || "",
    csrf: viewer.csrf || "",
  };
}

function renderLayout({ title, nav = {}, body = "", flash = "", script = "" }) {
  const current = {
    active: nav.active || "",
    signedIn: Boolean(nav.signedIn),
    isOperator: Boolean(nav.isOperator),
    companyName: typeof nav.companyName === "string" ? nav.companyName : "",
    csrf: typeof nav.csrf === "string" ? nav.csrf : "",
  };
  const navigation = current.signedIn
    ? `<nav class="nav" aria-label="Primary">${navLinks(current)}</nav>`
    : "";
  const flashHtml = flash
    ? `<p class="banner banner-info" role="status">${escapeHtml(flash)}</p>`
    : "";
  const scriptTag = typeof script === "string" && script !== ""
    ? `\n  <script src="${escapeHtml(script)}"></script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${stylesheetHref()}">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/">${mark()}<span>OceanRelay</span></a>
    ${navigation}
    ${account(current)}
  </header>
  <main id="main">
    ${flashHtml}
    ${body}
  </main>
  <footer class="site-footer"><p>OceanRelay</p></footer>${scriptTag}
</body>
</html>`;
}

module.exports = {
  renderLayout,
  navFor,
  viewerFor,
  pill,
};
