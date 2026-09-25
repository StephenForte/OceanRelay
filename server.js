const http = require("node:http");
const { loadConfig, publicConfig } = require("./lib/config");
const { openStore } = require("./lib/store");
const { createPkce, safeEqual } = require("./lib/pkce");
const { COOKIE_NAME, readSession, parseCookies, newSession, sessionCookie } = require("./lib/session");
const {
  discoverEndpoints,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  revokeToken,
  fetchUserInfo,
} = require("./lib/rate-ninja");
const { renderPage } = require("./lib/page");

const accessTokens = new Map();
const refreshInflight = new Map();

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  }));
  res.end(payload);
}

function sendHtml(res, status, html, cookies = []) {
  res.writeHead(status, securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Set-Cookie": cookies,
  }));
  res.end(html);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, securityHeaders({ Location: location, "Set-Cookie": cookies }));
  res.end();
}

function readBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formBody(text) {
  const params = new URLSearchParams(text || "");
  return Object.fromEntries(params.entries());
}

function secureCookie(req, config) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return forwarded === "https" || config.redirectUri.startsWith("https:");
}

function sessionFromRequest(req, config) {
  if (!config.sessionSecret) return { session: null, fresh: false };
  const cookies = parseCookies(req.headers.cookie);
  const existing = readSession(cookies[COOKIE_NAME], config.sessionSecret);
  if (existing) return { session: existing, fresh: false };
  return { session: newSession(), fresh: true };
}

function cookieFor(req, config, session) {
  if (!config.sessionSecret || !session) return [];
  return [sessionCookie(session, config.sessionSecret, secureCookie(req, config))];
}

function rememberAccessToken(sessionId, token, expiresIn) {
  const lifetime = Number(expiresIn);
  const seconds = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 0;
  accessTokens.set(sessionId, { token, expiresAt: Date.now() + seconds * 1000 });
}

function currentAccessToken(sessionId) {
  const entry = accessTokens.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() + 15000) {
    accessTokens.delete(sessionId);
    return null;
  }
  return entry.token;
}

function forgetAccessToken(sessionId) {
  accessTokens.delete(sessionId);
}

async function refreshStoredToken(sessionId, config, store, fetchImpl, endpoints) {
  const cached = currentAccessToken(sessionId);
  if (cached) return { ok: true, accessToken: cached };
  const stored = store.connectionSecrets(sessionId);
  if (!stored) return { ok: false, error: "disconnected" };
  const presented = stored.refreshToken;
  let refreshed;
  try {
    refreshed = await refreshToken(fetchImpl, endpoints, config, presented);
  } catch {
    return { ok: false, error: "refresh_failed" };
  }
  const latest = store.connectionSecrets(sessionId);
  if (latest && latest.refreshToken !== presented) {
    const winner = currentAccessToken(sessionId);
    if (winner) return { ok: true, accessToken: winner };
    return { ok: false, error: "refresh_failed" };
  }
  if (!refreshed.ok || typeof refreshed.body.refresh_token !== "string" || typeof refreshed.body.access_token !== "string") {
    return {
      ok: false,
      error: refreshed.error || "refresh_failed",
      disconnect: refreshed.error === "invalid_grant",
    };
  }
  store.replaceRefreshToken(sessionId, refreshed.body.refresh_token);
  rememberAccessToken(sessionId, refreshed.body.access_token, refreshed.body.expires_in);
  return { ok: true, accessToken: refreshed.body.access_token };
}

function ensureAccessToken(sessionId, config, store, fetchImpl, endpoints) {
  const cached = currentAccessToken(sessionId);
  if (cached) return Promise.resolve({ ok: true, accessToken: cached });
  const existing = refreshInflight.get(sessionId);
  if (existing) return existing;
  const pending = refreshStoredToken(sessionId, config, store, fetchImpl, endpoints)
    .finally(() => refreshInflight.delete(sessionId));
  refreshInflight.set(sessionId, pending);
  return pending;
}

function createServer({ config, store, fetchImpl = globalThis.fetch }) {
  let endpointsPromise;

  function endpoints() {
    if (!endpointsPromise) endpointsPromise = discoverEndpoints(config.issuer, fetchImpl);
    return endpointsPromise;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/config") {
        sendJson(res, 200, publicConfig(config));
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        await handleHome(req, res, url);
        return;
      }
      if (req.method === "POST" && url.pathname === "/connect") {
        await handleConnect(req, res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        await handleCallback(req, res, url);
        return;
      }
      if (req.method === "POST" && url.pathname === "/disconnect") {
        await handleDisconnect(req, res);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error && error.message === "body_too_large" ? "body_too_large" : "request_failed");
      if (!res.headersSent) sendJson(res, 500, { error: "request_failed" });
    }
  });

  async function handleHome(req, res, url) {
    const { session } = sessionFromRequest(req, config);
    if (session && store.publicConnection(session.sid)) {
      try {
        const ready = await endpoints();
        if (ready) {
          const access = await ensureAccessToken(session.sid, config, store, fetchImpl, ready);
          if (!access.ok && access.disconnect) store.deleteConnection(session.sid);
        }
      } catch {
        console.error("connection_refresh_failed");
      }
    }
    const connection = session ? store.publicConnection(session.sid) : null;
    const html = renderPage({
      configView: publicConfig(config),
      connection,
      csrf: session ? session.csrf : "",
      result: url.searchParams.get("result") || "",
    });
    sendHtml(res, 200, html, cookieFor(req, config, session));
  }

  async function handleConnect(req, res) {
    const { session } = sessionFromRequest(req, config);
    const cookies = cookieFor(req, config, session);
    const form = formBody(await readBody(req));
    if (!config.ok || !session) {
      redirect(res, "/?result=config_incomplete", cookies);
      return;
    }
    if (!safeEqual(form.csrf_token || "", session.csrf)) {
      sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const pkce = createPkce();
    store.savePending(session.sid, { state: pkce.state, verifier: pkce.verifier, createdAt: Date.now() });
    const ready = await endpoints();
    redirect(res, authorizeUrl(ready.authorization, {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: pkce.state,
      challenge: pkce.challenge,
    }), cookies);
  }

  async function handleCallback(req, res, url) {
    const { session } = sessionFromRequest(req, config);
    const cookies = cookieFor(req, config, session);
    if (!config.ok || !session) {
      redirect(res, "/?result=config_incomplete", cookies);
      return;
    }
    const oauthError = url.searchParams.get("error");
    const description = url.searchParams.get("error_description") || "";
    if (oauthError) {
      store.takePending(session.sid, url.searchParams.get("state") || "");
      if (oauthError === "access_denied" && description === "only_contract_owner") {
        redirect(res, "/?result=only_contract_owner", cookies);
        return;
      }
      if (oauthError === "access_denied") {
        redirect(res, "/?result=access_denied", cookies);
        return;
      }
      redirect(res, `/?result=${encodeURIComponent(oauthError === "partner_oauth_disabled" ? oauthError : "token_exchange_failed")}`, cookies);
      return;
    }
    const pending = store.takePending(session.sid, url.searchParams.get("state") || "");
    const code = url.searchParams.get("code") || "";
    if (!pending || !code) {
      redirect(res, "/?result=invalid_state", cookies);
      return;
    }
    const ready = await endpoints();
    const exchanged = await exchangeCode(fetchImpl, ready, config, { code, verifier: pending.verifier });
    if (!exchanged.ok) {
      const result = exchanged.error === "partner_oauth_disabled" ? "partner_oauth_disabled" : "token_exchange_failed";
      redirect(res, `/?result=${result}`, cookies);
      return;
    }
    const profileResult = await fetchUserInfo(fetchImpl, ready, exchanged.body.access_token);
    const profile = profileResult.ok ? profileResult.profile : {
      sub: "",
      name: "",
      companyId: "",
      companyName: "",
      companyType: "",
      active: false,
    };
    const scopes = typeof exchanged.body.scope === "string" && exchanged.body.scope.trim()
      ? exchanged.body.scope.trim().split(/\s+/)
      : config.scopes;
    store.saveConnection(session.sid, {
      refreshToken: exchanged.body.refresh_token,
      scopes,
      profile,
    });
    rememberAccessToken(session.sid, exchanged.body.access_token, exchanged.body.expires_in);
    redirect(res, "/?result=connected", cookies);
  }

  async function handleDisconnect(req, res) {
    const { session } = sessionFromRequest(req, config);
    const cookies = cookieFor(req, config, session);
    const form = formBody(await readBody(req));
    if (!session || !safeEqual(form.csrf_token || "", session.csrf)) {
      sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const stored = store.connectionSecrets(session.sid);
    if (!stored) {
      if (store.publicConnection(session.sid)) store.deleteConnection(session.sid);
      forgetAccessToken(session.sid);
      redirect(res, "/?result=disconnected", cookies);
      return;
    }
    let ready;
    try {
      ready = await endpoints();
    } catch {
      ready = null;
    }
    if (!ready) {
      redirect(res, "/?result=revoke_failed", cookies);
      return;
    }
    const revoked = await revokeToken(fetchImpl, ready, config, stored.refreshToken);
    if (!revoked.ok && revoked.error !== "partner_oauth_disabled") {
      redirect(res, "/?result=revoke_failed", cookies);
      return;
    }
    store.deleteConnection(session.sid);
    forgetAccessToken(session.sid);
    redirect(res, "/?result=disconnected", cookies);
  }
}

function main() {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional. Render provides environment variables directly.
  }
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535");
    process.exit(1);
  }
  const config = loadConfig(process.env);
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const server = createServer({ config, store });
  server.listen(port, "0.0.0.0", () => {
    console.log(`listening on 0.0.0.0:${port}`);
  });
}

if (require.main === module) main();

module.exports = { createServer, loadConfig, openStore, publicConfig };
