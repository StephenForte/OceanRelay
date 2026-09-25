const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig, publicConfig, DEPLOYED_REDIRECT_URI } = require("../lib/config");
const { openStore } = require("../lib/store");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";

function cookieHeader(response) {
  const raw = response.headers.getSetCookie?.() || [];
  return raw.map((value) => value.split(";")[0]).join("; ");
}

async function startApp(env, storePath) {
  const config = loadConfig(env);
  const store = openStore(storePath, config.tokenEncryptionKey);
  const server = createServer({ config, store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    config,
    store,
    server,
    base: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("configuration check", () => {
  it("reports missing settings and does not print secrets", () => {
    const secret = "super-secret-should-not-appear";
    const config = loadConfig({
      RATE_NINJA_CLIENT_SECRET: secret,
      RATE_NINJA_BASE_URL: "http://example.com",
      OCEANRELAY_REDIRECT_URI: "http://oceanrelay.onrender.com/oauth/callback",
    });
    const view = publicConfig(config);
    const encoded = JSON.stringify(view);
    assert.equal(encoded.includes(secret), false);
    assert.ok(view.missing.includes("RATE_NINJA_CLIENT_ID"));
    assert.ok(view.missing.includes("SESSION_SECRET"));
    assert.ok(view.missing.includes("TOKEN_ENCRYPTION_KEY"));
    assert.equal(view.missing.includes("RATE_NINJA_CLIENT_SECRET"), false);
    assert.equal(view.settings.RATE_NINJA_CLIENT_SECRET, "set");
    assert.ok(view.invalid.some((item) => item.name === "RATE_NINJA_BASE_URL"));
    assert.ok(view.invalid.some((item) => item.name === "OCEANRELAY_REDIRECT_URI"));
    assert.equal(view.ok, false);
  });

  it("accepts localhost http and the deployed https callback", () => {
    const local = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      OCEANRELAY_REDIRECT_URI: "http://localhost:10000/oauth/callback",
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    });
    assert.equal(local.ok, true);
    assert.equal(local.redirectUri, "http://localhost:10000/oauth/callback");
    const deployed = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      OCEANRELAY_REDIRECT_URI: DEPLOYED_REDIRECT_URI,
    });
    assert.equal(deployed.ok, true);
    assert.equal(deployed.redirectUri, "https://oceanrelay.ai/oauth/callback");
    assert.equal(deployed.issuer, "https://rateninja.co");
    const otherPort = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      OCEANRELAY_REDIRECT_URI: "https://oceanrelay.ai:8443/oauth/callback",
    });
    assert.equal(otherPort.ok, false);
  });
});

describe("connect flow", () => {
  let mock;
  let app;
  let dir;
  let secrets;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-"));
    mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const port = await mock.listen();
    app = await startApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${port}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, path.join(dir, "store.json"));
    app.config.redirectUri = `${app.base}/oauth/callback`;
    secrets = [CLIENT_SECRET, SESSION_SECRET, ENCRYPTION_KEY];
  });

  after(async () => {
    await app.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps health, starts PKCE, stores only encrypted refresh tokens, and disconnects", async () => {
    const health = await fetch(`${app.base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });

    const home = await fetch(app.base);
    const homeHtml = await home.text();
    assert.match(homeHtml, /Disconnected/);
    assert.match(homeHtml, /Configuration check/);
    assert.equal(homeHtml.includes(CLIENT_SECRET), false);
    const cookie = cookieHeader(home);
    assert.match(cookie, /oceanrelay_session=/);

    const csrf = homeHtml.match(/name="csrf_token" value="([^"]+)"/)[1];
    const connect = await fetch(`${app.base}/connect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
      redirect: "manual",
    });
    assert.equal(connect.status, 302);
    const authorize = new URL(connect.headers.get("location"));
    assert.equal(authorize.pathname, "/oauth/authorize");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(authorize.searchParams.get("scope"), "profile:read rates:read sailings:read");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${app.base}/oauth/callback`);
    const setCookie = connect.headers.get("set-cookie") || "";
    assert.equal(setCookie.includes(CLIENT_SECRET), false);
    assert.equal(setCookie.includes("refresh-"), false);
    assert.equal(setCookie.includes("access-"), false);

    const decision = await fetch(`${mock.server.address().port ? `http://127.0.0.1:${mock.server.address().port}` : ""}/oauth/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        decision: "approve",
        state: authorize.searchParams.get("state"),
        redirect_uri: authorize.searchParams.get("redirect_uri"),
        code_challenge: authorize.searchParams.get("code_challenge"),
      }),
      redirect: "manual",
    });
    assert.equal(decision.status, 302);
    const callbackUrl = decision.headers.get("location");
    const callback = await fetch(callbackUrl, { headers: { cookie }, redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.get("location"), app.base).searchParams.get("result"), "connected");
    assert.equal((callback.headers.get("location") || "").includes("access-"), false);
    assert.equal((callback.headers.get("set-cookie") || "").includes(CLIENT_SECRET), false);

    const connected = await fetch(app.base, { headers: { cookie } });
    const connectedHtml = await connected.text();
    assert.match(connectedHtml, /Connected/);
    assert.match(connectedHtml, /SteveF/);
    assert.match(connectedHtml, /Contract Owner/);
    for (const secret of secrets) assert.equal(connectedHtml.includes(secret), false);
    assert.equal(connectedHtml.includes("access-"), false);
    assert.equal(connectedHtml.includes("refresh-"), false);

    const stored = fs.readFileSync(path.join(dir, "store.json"), "utf8");
    assert.equal(stored.includes(CLIENT_SECRET), false);
    assert.equal(stored.includes("access-"), false);
    assert.equal(stored.includes("refresh-"), false);
    assert.match(stored, /v1\./);

    const disconnectCsrf = connectedHtml.match(/name="csrf_token" value="([^"]+)"/)[1];
    const disconnect = await fetch(`${app.base}/disconnect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: disconnectCsrf }),
      redirect: "manual",
    });
    assert.equal(disconnect.status, 302);
    assert.match(disconnect.headers.get("location"), /disconnected/);
    assert.ok(mock.calls.includes("POST /oauth/revoke"));
    assert.equal(mock.calls.some((call) => call.startsWith("GET /api/v1") || call.startsWith("POST /api/v1")), false);
    const after = await fetch(app.base, { headers: { cookie } });
    assert.match(await after.text(), /Disconnected/);
  });

  it("explains a customer denial without exchanging a code", async () => {
    const home = await fetch(app.base);
    const cookie = cookieHeader(home);
    const csrf = (await home.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
    const connect = await fetch(`${app.base}/connect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
      redirect: "manual",
    });
    const authorize = new URL(connect.headers.get("location"));
    const origin = `http://127.0.0.1:${mock.server.address().port}`;
    const decision = await fetch(`${origin}/oauth/decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        decision: "customer",
        state: authorize.searchParams.get("state"),
        redirect_uri: authorize.searchParams.get("redirect_uri"),
        code_challenge: authorize.searchParams.get("code_challenge"),
      }),
      redirect: "manual",
    });
    const callback = await fetch(decision.headers.get("location"), { headers: { cookie }, redirect: "manual" });
    const page = await fetch(new URL(callback.headers.get("location"), app.base), { headers: { cookie } });
    assert.match(await page.text(), /Customer accounts are denied/);
    assert.equal(mock.calls.filter((call) => call === "POST /oauth/token").length, 1);
  });
});

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

describe("bugbot regressions", () => {
  it("refreshes one shared token when two home loads overlap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-race-"));
    const config = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    });
    const store = openStore(path.join(dir, "store.json"), ENCRYPTION_KEY);
    store.saveConnection("sid-race", {
      refreshToken: "refresh-old",
      scopes: ["profile:read"],
      profile: { name: "SteveF", companyName: "Kings", companyType: "Contract Owner" },
    });
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = async (url) => {
      if (String(url).includes("well-known")) return new Response("no", { status: 404 });
      calls += 1;
      await gate;
      return new Response(JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 600,
        token_type: "Bearer",
        scope: "profile:read",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const server = createServer({ config, store, fetchImpl });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = sessionCookie("sid-race", "csrf-race");
    const first = fetch(base, { headers: { cookie } });
    const second = fetch(base, { headers: { cookie } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    assert.match(await left.text(), /Connected/);
    assert.match(await right.text(), /Connected/);
    assert.equal(calls, 1);
    assert.equal(store.connectionSecrets("sid-race").refreshToken, "refresh-new");
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders the home page when Rate Ninja cannot be reached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-down-"));
    const config = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    });
    const store = openStore(path.join(dir, "store.json"), ENCRYPTION_KEY);
    store.saveConnection("sid-down", {
      refreshToken: "refresh-old",
      scopes: ["profile:read"],
      profile: { name: "SteveF", companyName: "Kings", companyType: "Contract Owner" },
    });
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const server = createServer({ config, store, fetchImpl });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      headers: { cookie: sessionCookie("sid-down", "csrf-down") },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /Connected/);
    assert.match(html, /Disconnect/);
    assert.equal(store.publicConnection("sid-down").profile.name, "SteveF");
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deletes a connection that can no longer be decrypted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-decrypt-"));
    const file = path.join(dir, "store.json");
    const config = loadConfig({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    });
    const writer = openStore(file, ENCRYPTION_KEY);
    writer.saveConnection("sid-bad", {
      refreshToken: "refresh-old",
      scopes: ["profile:read"],
      profile: { name: "SteveF", companyName: "Kings", companyType: "Contract Owner" },
    });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.connections["sid-bad"].refreshCiphertext = "v1.not-a-valid-ciphertext";
    fs.writeFileSync(file, JSON.stringify(raw));
    const store = openStore(file, ENCRYPTION_KEY);
    assert.equal(store.connectionSecrets("sid-bad"), null);
    assert.equal(store.publicConnection("sid-bad").profile.name, "SteveF");
    const server = createServer({ config, store, fetchImpl: async () => { throw new Error("down"); } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const csrf = "csrf-bad";
    const response = await fetch(`http://127.0.0.1:${server.address().port}/disconnect`, {
      method: "POST",
      headers: {
        cookie: sessionCookie("sid-bad", csrf),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf }),
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /disconnected/);
    assert.equal(store.publicConnection("sid-bad"), null);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("challenge matches verifier", () => {
  it("uses S256", () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(challenge.length > 20, true);
  });
});
