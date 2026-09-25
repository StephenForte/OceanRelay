const DEPLOYED_REDIRECT_URI = "https://oceanrelay.ai/oauth/callback";
const DEFAULT_ISSUER = "https://rateninja.co";
const SCOPES = ["profile:read", "rates:read", "sailings:read"];

const SECRET_SETTINGS = [
  "RATE_NINJA_CLIENT_ID",
  "RATE_NINJA_CLIENT_SECRET",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function localHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function validateHttpUrl(value, { name, requireCallbackPath }) {
  if (!present(value)) return { missing: true };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { invalid: `${name} is not a URL` };
  }
  if (url.username || url.password || url.hash) {
    return { invalid: `${name} must not include credentials or a fragment` };
  }
  if (url.search) return { invalid: `${name} must not include a query string` };
  if (requireCallbackPath && url.pathname !== "/oauth/callback") {
    return { invalid: `${name} path must be /oauth/callback` };
  }
  if (!requireCallbackPath && url.pathname !== "/" && url.pathname !== "") {
    return { invalid: `${name} must be an origin with no path` };
  }
  const local = localHost(url.hostname);
  if (url.protocol === "http:" && local) {
    return { ok: true, href: url.origin + (requireCallbackPath ? url.pathname : "") };
  }
  if (url.protocol !== "https:") {
    return { invalid: `${name} must be https, or http on localhost` };
  }
  if (requireCallbackPath && url.hostname === "oceanrelay.ai" && url.origin + url.pathname !== DEPLOYED_REDIRECT_URI) {
    return { invalid: `Deployed redirect must be ${DEPLOYED_REDIRECT_URI}` };
  }
  return { ok: true, href: url.origin + (requireCallbackPath ? url.pathname : "") };
}

function loadConfig(env = process.env) {
  const missing = [];
  const invalid = [];
  const clientId = present(env.RATE_NINJA_CLIENT_ID) ? env.RATE_NINJA_CLIENT_ID.trim() : "";
  const clientSecret = present(env.RATE_NINJA_CLIENT_SECRET) ? env.RATE_NINJA_CLIENT_SECRET.trim() : "";
  const sessionSecret = present(env.SESSION_SECRET) ? env.SESSION_SECRET.trim() : "";
  const tokenEncryptionKey = present(env.TOKEN_ENCRYPTION_KEY) ? env.TOKEN_ENCRYPTION_KEY.trim() : "";
  if (!clientId) missing.push("RATE_NINJA_CLIENT_ID");
  if (!clientSecret) missing.push("RATE_NINJA_CLIENT_SECRET");
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (!tokenEncryptionKey) missing.push("TOKEN_ENCRYPTION_KEY");

  const redirect = validateHttpUrl(env.OCEANRELAY_REDIRECT_URI, {
    name: "OCEANRELAY_REDIRECT_URI",
    requireCallbackPath: true,
  });
  if (redirect.missing) missing.push("OCEANRELAY_REDIRECT_URI");
  if (redirect.invalid) invalid.push({ name: "OCEANRELAY_REDIRECT_URI", reason: redirect.invalid });

  const issuerInput = present(env.RATE_NINJA_BASE_URL) ? env.RATE_NINJA_BASE_URL : DEFAULT_ISSUER;
  const issuer = validateHttpUrl(issuerInput, { name: "RATE_NINJA_BASE_URL", requireCallbackPath: false });
  if (issuer.invalid) invalid.push({ name: "RATE_NINJA_BASE_URL", reason: issuer.invalid });

  const storePath = present(env.OCEANRELAY_STORE_PATH)
    ? env.OCEANRELAY_STORE_PATH.trim()
    : "data/oceanrelay-store.json";

  return {
    clientId,
    clientSecret,
    sessionSecret,
    tokenEncryptionKey,
    redirectUri: redirect.href || "",
    issuer: issuer.href || "",
    storePath,
    scopes: SCOPES,
    missing,
    invalid,
    ok: missing.length === 0 && invalid.length === 0,
  };
}

function publicConfig(config) {
  return {
    ok: config.ok,
    missing: config.missing,
    invalid: config.invalid.map((item) => ({ name: item.name, reason: item.reason })),
    settings: {
      RATE_NINJA_BASE_URL: config.issuer || null,
      OCEANRELAY_REDIRECT_URI: config.redirectUri || null,
      OCEANRELAY_STORE_PATH: config.storePath,
      RATE_NINJA_CLIENT_ID: config.clientId ? "set" : "missing",
      RATE_NINJA_CLIENT_SECRET: config.clientSecret ? "set" : "missing",
      SESSION_SECRET: config.sessionSecret ? "set" : "missing",
      TOKEN_ENCRYPTION_KEY: config.tokenEncryptionKey ? "set" : "missing",
    },
  };
}

module.exports = {
  DEPLOYED_REDIRECT_URI,
  DEFAULT_ISSUER,
  SCOPES,
  SECRET_SETTINGS,
  loadConfig,
  publicConfig,
};
