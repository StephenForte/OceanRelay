const RESULT_MESSAGES = {
  connected: "Connected to Rate Ninja.",
  disconnected: "Disconnected from Rate Ninja.",
  partner_oauth_disabled: "Rate Ninja returned partner_oauth_disabled. Partner login is still turned off there.",
  only_contract_owner: "Only a contract-owner Rate Ninja account can approve. Customer accounts are denied.",
  access_denied: "Rate Ninja denied the connection request.",
  invalid_state: "The connection attempt expired or did not match this browser session.",
  config_incomplete: "OceanRelay is missing configuration, so the connection was not started.",
  token_exchange_failed: "Rate Ninja did not issue tokens for this connection attempt.",
  identity_unavailable: "Rate Ninja did not return a usable identity, so the connection was not saved.",
  revoke_failed: "Rate Ninja did not accept the disconnect yet. The connection is still stored.",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

module.exports = { RESULT_MESSAGES, escapeHtml };

const { renderLayout } = require("./views/layout");

function bannerKind(result) {
  if (result === "connected") return "success";
  if (result === "disconnected") return "info";
  return "error";
}

function resultBanner(result) {
  const message = RESULT_MESSAGES[result] || "";
  if (!message) return "";
  return `<p class="banner banner-${bannerKind(result)}">${escapeHtml(message)}</p>`;
}

function landing({ configView, csrf, result }) {
  const notice = configView.ok
    ? ""
    : `<p class="banner banner-error" id="signin-unavailable">Sign-in is not available right now</p>`;
  const disabled = configView.ok ? "" : " disabled";
  return `<p class="status">Disconnected</p>
    ${resultBanner(result)}
    <section class="card hero">
      <h1>Code-share capacity for contract-owner forwarders</h1>
      <p class="lead">OceanRelay is code-share carrier-backed capacity between contract-owner forwarders.</p>
      ${notice}
      <form method="post" action="/connect">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <button type="submit" class="btn"${disabled}>Sign in with Rate Ninja</button>
      </form>
    </section>
    <h2>How it works</h2>
    <ol class="steps">
      <li>
        <h3>Publish a code-share offer</h3>
        <p>List capacity you can share under your contract.</p>
      </li>
      <li>
        <h3>Another forwarder requests a quantity</h3>
        <p>They ask for a number of containers on that offer.</p>
      </li>
      <li>
        <h3>Record the agreement</h3>
        <p>The agreement is not a carrier booking.</p>
      </li>
    </ol>
    <p class="note">Only a contract-owner Rate Ninja account can approve. Customer accounts are denied. Scopes: profile:read, rates:read, sailings:read.</p>`;
}

function dashboard({ connection, csrf, result, operator, counts }) {
  const profile = connection.profile || {};
  const tally = counts || { published: 0, waiting: 0, accepted: 0 };
  const viewer = {
    signedIn: true,
    companyName: typeof profile.companyName === "string" ? profile.companyName : "",
    name: typeof profile.name === "string" ? profile.name : "",
    sub: typeof profile.sub === "string" ? profile.sub : "",
    csrf,
    operator: Boolean(operator),
  };
  const userId = `<p>Your Rate Ninja user id: ${escapeHtml(profile.sub)}</p>`;
  const body = `${resultBanner(result)}
    <p class="status">Connected</p>
    <h1>${escapeHtml(profile.companyName || "Unknown")}</h1>
    <p>${escapeHtml(profile.name || "Unknown")}</p>
    ${userId}
    <dl>
      <dt>Account type</dt><dd>${escapeHtml(profile.companyType || "Unknown")}</dd>
      <dt>Scopes</dt><dd>${escapeHtml((connection.scopes || []).join(" "))}</dd>
    </dl>
    <div class="stats">
      <a class="stat" href="/offers"><span class="stat-count">${escapeHtml(tally.published)}</span> Your published offers</a>
      <a class="stat" href="/requests"><span class="stat-count">${escapeHtml(tally.waiting)}</span> Requests waiting for you</a>
      <a class="stat" href="/requests"><span class="stat-count">${escapeHtml(tally.accepted)}</span> Your accepted agreements</a>
    </div>
    <p class="actions">
      <a class="btn" href="/market">Browse the marketplace</a>
      <a class="btn btn-secondary" href="/offers/new">Create an offer</a>
    </p>`;
  return renderLayout({
    title: "OceanRelay",
    active: "",
    viewer,
    body,
  });
}

function renderPage({ configView, connection, csrf, result, operator = false, counts = null }) {
  const connected = Boolean(connection);
  if (connected) return dashboard({ connection, csrf, result, operator, counts });
  return renderLayout({
    title: "OceanRelay",
    active: "",
    viewer: null,
    body: landing({ configView, csrf, result }),
  });
}

module.exports.renderPage = renderPage;
