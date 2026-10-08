const http = require("node:http");
const { loadConfig, publicConfig } = require("./lib/config");
const { createChain } = require("./lib/chain");
const deployment = require("./deployments/fortel2-sepolia.json");
const { openStore } = require("./lib/store");
const { openRecords } = require("./lib/records");
const { createRouter } = require("./lib/router");
const { createPkce, safeEqual } = require("./lib/pkce");
const { COOKIE_NAME, readSession, parseCookies, newSession, sessionCookie } = require("./lib/session");
const rn = require("./lib/rate-ninja");
const { renderPage } = require("./lib/page");
const systemRoutes = require("./lib/routes/system");
const connectRoutes = require("./lib/routes/connect");
const offerRoutes = require("./lib/routes/offers");
const marketRoutes = require("./lib/routes/market");
const requestRoutes = require("./lib/routes/requests");
const operatorRoutes = require("./lib/routes/operator");

const areas = [systemRoutes, connectRoutes, offerRoutes, marketRoutes, requestRoutes, operatorRoutes];

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

function presentId(value) {
  return typeof value === "string" && value.trim() !== "";
}

function identityRefusal(profile, userinfoFailed) {
  if (userinfoFailed || !profile || typeof profile !== "object") return "identity_unavailable";
  if (!presentId(profile.sub) || !presentId(profile.companyId) || profile.active === false) {
    return "identity_unavailable";
  }
  if (profile.companyType !== "Contract Owner") return "only_contract_owner";
  return null;
}

function identityFromProfile(profile) {
  if (identityRefusal(profile, false)) return null;
  return {
    sub: profile.sub,
    companyId: profile.companyId,
    companyName: typeof profile.companyName === "string" ? profile.companyName : "",
    name: typeof profile.name === "string" ? profile.name : "",
  };
}

async function refreshStoredToken(sessionId, config, store, fetchImpl, endpoints) {
  const cached = currentAccessToken(sessionId);
  if (cached) return { ok: true, accessToken: cached };
  const stored = store.connectionSecrets(sessionId);
  if (!stored) return { ok: false, error: "disconnected" };
  const presented = stored.refreshToken;
  let refreshed;
  try {
    refreshed = await rn.refreshToken(fetchImpl, endpoints, config, presented);
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

function createServer({ config, store, records = null, fetchImpl = globalThis.fetch } = {}) {
  const activeRecords = records || openRecords(null);
  let endpointsPromise;

  function endpoints() {
    if (!endpointsPromise) endpointsPromise = rn.discoverEndpoints(config.issuer, fetchImpl);
    return endpointsPromise;
  }

  function requireIdentity(req, res) {
    const { session } = sessionFromRequest(req, config);
    const cookies = cookieFor(req, config, session);
    const connection = session ? store.publicConnection(session.sid) : null;
    const identity = connection ? identityFromProfile(connection.profile) : null;
    if (!session || !identity) {
      if (session && connection) {
        const secrets = store.connectionSecrets(session.sid);
        const profile = connection.profile;
        store.deleteConnection(session.sid);
        forgetAccessToken(session.sid);
        activeRecords.appendAudit("auth.dropped", profile && typeof profile === "object" ? {
          sub: profile.sub,
          companyId: profile.companyId,
          role: "user",
        } : null, { reason: "identity_unusable" });
        // Synchronous gate (C-1). Revoke starts here and is not awaited.
        // Errors are swallowed so a failed revoke cannot reject the process.
        const token = secrets && secrets.refreshToken;
        if (typeof token === "string" && token.length > 0) {
          endpoints()
            .then((ready) => revokeRefreshToken(ready, token))
            .catch(() => {});
        }
      }
      if (req.method === "GET") redirect(res, "/", cookies);
      else sendJson(res, 403, { error: "not_connected" });
      return null;
    }
    return { session, identity };
  }

  async function revokeRefreshToken(ready, token) {
    try {
      if (!ready || typeof token !== "string" || token.length === 0) return;
      await rn.revokeToken(fetchImpl, ready, config, token);
    } catch {
      // Identity was refused. A revoke failure does not restore the connection.
    }
  }

  const chain = createChain({ config, deployment, fetchImpl });
  chain.start();

  const deps = {
    config,
    store,
    chain,
    records: activeRecords,
    rn,
    render: renderPage,
    requireIdentity,
    publicConfig,
    sendJson,
    sendHtml,
    redirect,
    readBody,
    formBody,
    safeEqual,
    createPkce,
    fetchImpl,
    identityRefusal,
    sessionFromRequest(req) {
      return sessionFromRequest(req, config);
    },
    cookieFor(req, session) {
      return cookieFor(req, config, session);
    },
    endpoints,
    ensureAccessToken(sessionId, ready) {
      return ensureAccessToken(sessionId, config, store, fetchImpl, ready);
    },
    rememberAccessToken,
    forgetAccessToken,
    revokeRefreshToken,
  };

  const router = createRouter();
  for (const area of areas) area.register(router, deps);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      const handled = await router.handle(req, res, url);
      if (!handled) sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error && error.message === "body_too_large" ? "body_too_large" : "request_failed");
      if (!res.headersSent) sendJson(res, 500, { error: "request_failed" });
    }
  });
  server.requireIdentity = requireIdentity;
  return server;
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
  let records;
  try {
    records = openRecords(config.recordsPath);
  } catch (error) {
    console.error(error && error.message ? error.message : "records_unavailable");
    process.exit(1);
  }
  const server = createServer({ config, store, records });
  server.listen(port, "0.0.0.0", () => {
    console.log(`listening on 0.0.0.0:${port}`);
  });
}

if (require.main === module) main();

module.exports = {
  createServer,
  loadConfig,
  openStore,
  publicConfig,
  sendJson,
  sendHtml,
  redirect,
  readBody,
  formBody,
  securityHeaders,
};
