const RESULT_MESSAGES = {
  connected: "Connected to Rate Ninja.",
  disconnected: "Disconnected from Rate Ninja.",
  partner_oauth_disabled: "Rate Ninja returned partner_oauth_disabled. Partner login is still turned off there.",
  only_contract_owner: "Only a contract-owner Rate Ninja account can approve. Customer accounts are denied.",
  access_denied: "Rate Ninja denied the connection request.",
  invalid_state: "The connection attempt expired or did not match this browser session.",
  config_incomplete: "OceanRelay is missing configuration, so the connection was not started.",
  token_exchange_failed: "Rate Ninja did not issue tokens for this connection attempt.",
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

function renderPage({ configView, connection, csrf, result }) {
  const message = RESULT_MESSAGES[result] || "";
  const missing = configView.missing.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("");
  const invalid = configView.invalid
    .map((item) => `<li><code>${escapeHtml(item.name)}</code>: ${escapeHtml(item.reason)}</li>`)
    .join("");
  const settings = Object.entries(configView.settings)
    .map(([name, value]) => `<li><code>${escapeHtml(name)}</code>: ${escapeHtml(value)}</li>`)
    .join("");
  const connected = Boolean(connection);
  const profile = connection?.profile || {};
  const action = connected
    ? `<form method="post" action="/disconnect"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit">Disconnect</button></form>`
    : `<form method="post" action="/connect"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit" ${configView.ok ? "" : "disabled"}>Connect Rate Ninja</button></form>`;
  const status = connected
    ? `<p class="status">Connected</p>
       <dl>
         <dt>Name</dt><dd>${escapeHtml(profile.name || "Unknown")}</dd>
         <dt>Company</dt><dd>${escapeHtml(profile.companyName || "Unknown")}</dd>
         <dt>Account type</dt><dd>${escapeHtml(profile.companyType || "Unknown")}</dd>
         <dt>Scopes</dt><dd>${escapeHtml((connection.scopes || []).join(" "))}</dd>
       </dl>`
    : `<p class="status">Disconnected</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OceanRelay</title>
  <style>
    body { margin: 0; font-family: Georgia, "Iowan Old Style", serif; background: #0e2433; color: #102a43; }
    main { max-width: 40rem; margin: 6vh auto; background: #fff; border-radius: 16px; padding: 2rem; }
    h1 { margin-top: 0; }
    p.lead, p.note { color: #486581; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { font: inherit; background: #0b6e4f; color: white; border: 0; border-radius: 8px; padding: 0.7rem 1rem; cursor: pointer; }
    button[disabled] { background: #9fb3c8; cursor: not-allowed; }
    .status { font-weight: 700; }
    .banner { background: #fff7e6; border-radius: 8px; padding: 0.75rem 1rem; }
    dl { display: grid; grid-template-columns: 9rem 1fr; gap: 0.35rem 1rem; }
    dt { color: #486581; }
    dd { margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>OceanRelay</h1>
    <p class="lead">Connect a contract-owner Rate Ninja account. The Rate Ninja client may still be named Capacity Exchange.</p>
    ${message ? `<p class="banner">${escapeHtml(message)}</p>` : ""}
    <h2>Connection</h2>
    ${status}
    ${action}
    <p class="note">Only a contract-owner Rate Ninja account can approve. Customer accounts are denied. Scopes: profile:read, rates:read, sailings:read.</p>
    <h2>Configuration check</h2>
    <p>${configView.ok ? "Required settings are present." : "Required settings are missing or invalid."}</p>
    ${missing ? `<h3>Missing</h3><ul>${missing}</ul>` : ""}
    ${invalid ? `<h3>Invalid</h3><ul>${invalid}</ul>` : ""}
    <h3>Settings</h3>
    <ul>${settings}</ul>
    <p class="note">Secret values stay on the server. This page reports whether they are set.</p>
  </main>
</body>
</html>`;
}

module.exports = { renderPage, RESULT_MESSAGES };
