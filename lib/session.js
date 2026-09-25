const crypto = require("node:crypto");
const { safeEqual } = require("./pkce");

const COOKIE_NAME = "oceanrelay_session";
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token, secret) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const index = token.lastIndexOf(".");
  const body = token.slice(0, index);
  const sig = token.slice(index + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.sid !== "string" || typeof payload.csrf !== "string") return null;
    if (!payload.iat || Date.now() - payload.iat > MAX_AGE_SEC * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function newSession() {
  return {
    sid: crypto.randomBytes(16).toString("base64url"),
    csrf: crypto.randomBytes(32).toString("base64url"),
    iat: Date.now(),
  };
}

function sessionCookie(session, secret, secure) {
  const value = encodeURIComponent(signSession(session, secret));
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

module.exports = {
  COOKIE_NAME,
  signSession,
  readSession,
  parseCookies,
  newSession,
  sessionCookie,
};
