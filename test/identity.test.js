const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function testConfig(baseUrl) {
  return loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: baseUrl,
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
  });
}

function fakeRes() {
  return {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

async function withCallbackApp(userinfo, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-identity-"));
  const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userinfo });
  const port = await mock.listen();
  const storePath = path.join(dir, "store.json");
  const config = testConfig(`http://127.0.0.1:${port}`);
  const store = openStore(storePath, config.tokenEncryptionKey);
  const server = createServer({ config, store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.redirectUri = `${base}/oauth/callback`;
  try {
    await run({ base, mock, storePath, store, origin: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function finishConnect({ base, origin }) {
  const home = await fetch(base);
  const cookie = (home.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");
  const csrf = (await home.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
  const connect = await fetch(`${base}/connect`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf_token: csrf }),
  });
  const auth = new URL(connect.headers.get("location"));
  const decision = await fetch(`${origin}/oauth/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      decision: "approve",
      state: auth.searchParams.get("state"),
      redirect_uri: auth.searchParams.get("redirect_uri"),
      code_challenge: auth.searchParams.get("code_challenge"),
    }),
  });
  const callback = await fetch(decision.headers.get("location"), { headers: { cookie }, redirect: "manual" });
  return { cookie, callback };
}

function storedProfile(storePath) {
  const saved = JSON.parse(fs.readFileSync(storePath, "utf8")).connections;
  return Object.values(saved)[0]?.profile;
}

describe("identity refusal", () => {
  it("revokes and stores nothing when userinfo returns 500", async () => {
    await withCallbackApp({ status: 500, body: { error: "server_error" } }, async (app) => {
      const { cookie, callback } = await finishConnect(app);
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), "/?result=identity_unavailable");
      assert.equal(storedProfile(app.storePath), undefined);
      assert.equal(app.mock.calls.filter((call) => call === "POST /oauth/revoke").length, 1);
      const page = await fetch(new URL(callback.headers.get("location"), app.base), { headers: { cookie } });
      const html = await page.text();
      assert.match(html, /did not return a usable identity/);
      assert.match(html, /Disconnected/);
    });
  });

  it("revokes a freight-forwarder profile and redirects to only_contract_owner", async () => {
    await withCallbackApp({ profile: { companyType: "Freight Forwarder/Customer" } }, async (app) => {
      const { cookie, callback } = await finishConnect(app);
      assert.equal(callback.headers.get("location"), "/?result=only_contract_owner");
      assert.equal(storedProfile(app.storePath), undefined);
      assert.equal(app.mock.calls.filter((call) => call === "POST /oauth/revoke").length, 1);
      const page = await fetch(new URL(callback.headers.get("location"), app.base), { headers: { cookie } });
      assert.match(await page.text(), /Customer accounts are denied/);
    });
  });

  it("revokes and stores nothing when companyId is empty", async () => {
    await withCallbackApp({ profile: { companyId: "" } }, async (app) => {
      const { callback } = await finishConnect(app);
      assert.equal(callback.headers.get("location"), "/?result=identity_unavailable");
      assert.equal(storedProfile(app.storePath), undefined);
      assert.equal(app.mock.calls.filter((call) => call === "POST /oauth/revoke").length, 1);
    });
  });

  it("revokes and stores nothing when the profile is inactive", async () => {
    await withCallbackApp({ profile: { active: false } }, async (app) => {
      const { callback } = await finishConnect(app);
      assert.equal(callback.headers.get("location"), "/?result=identity_unavailable");
      assert.equal(storedProfile(app.storePath), undefined);
      assert.equal(app.mock.calls.filter((call) => call === "POST /oauth/revoke").length, 1);
    });
  });
});

describe("requireIdentity", () => {
  function seedServer(profile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-identity-gate-"));
    const file = path.join(dir, "store.json");
    const config = testConfig("http://127.0.0.1:9");
    const store = openStore(file, ENCRYPTION_KEY);
    store.saveConnection("sid-gate", {
      refreshToken: "refresh-old",
      scopes: ["profile:read"],
      profile,
    });
    const server = createServer({
      config,
      store,
      fetchImpl: async () => {
        throw new Error("requireIdentity must not call Rate Ninja");
      },
    });
    return {
      dir,
      file,
      store,
      server,
      cleanup() {
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("treats an empty-profile connection as not connected and deletes it", () => {
    const app = seedServer({
      sub: "",
      name: "",
      companyId: "",
      companyName: "",
      companyType: "",
      active: false,
    });
    try {
      assert.equal(app.store.publicConnection("sid-gate").profile.companyId, "");
      const res = fakeRes();
      const result = app.server.requireIdentity({
        method: "GET",
        headers: { cookie: sessionCookie("sid-gate", "csrf-gate") },
      }, res);
      assert.equal(result, null);
      assert.equal(res.status, 302);
      assert.equal(res.headers.Location, "/");
      assert.equal(app.store.publicConnection("sid-gate"), null);
      const reopened = openStore(app.file, ENCRYPTION_KEY);
      assert.equal(reopened.publicConnection("sid-gate"), null);
    } finally {
      app.cleanup();
    }
  });

  it("answers a POST with no usable connection as 403 not_connected", () => {
    const app = seedServer({
      sub: "user-owner",
      name: "SteveF",
      companyId: "kings",
      companyName: "Kings",
      companyType: "Freight Forwarder/Customer",
      active: true,
    });
    try {
      const res = fakeRes();
      const result = app.server.requireIdentity({
        method: "POST",
        headers: { cookie: sessionCookie("sid-gate", "csrf-gate") },
      }, res);
      assert.equal(result, null);
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { error: "not_connected" });
      assert.equal(app.store.publicConnection("sid-gate"), null);
    } finally {
      app.cleanup();
    }
  });

  it("returns the stored identity and keeps a contract-owner connection", () => {
    const app = seedServer({
      sub: "user-owner",
      name: "SteveF",
      companyId: "kings",
      companyName: "Kings",
      companyType: "Contract Owner",
      active: true,
    });
    try {
      const res = fakeRes();
      const result = app.server.requireIdentity({
        method: "GET",
        headers: { cookie: sessionCookie("sid-gate", "csrf-gate") },
      }, res);
      assert.equal(res.status, null);
      assert.equal(result.session.sid, "sid-gate");
      assert.deepEqual(result.identity, {
        sub: "user-owner",
        companyId: "kings",
        companyName: "Kings",
        name: "SteveF",
      });
      assert.equal(app.store.publicConnection("sid-gate").profile.companyId, "kings");
    } finally {
      app.cleanup();
    }
  });

  it("redirects a GET that has a session and no connection", () => {
    const config = testConfig("http://127.0.0.1:9");
    const store = openStore(null, ENCRYPTION_KEY);
    const server = createServer({ config, store });
    const res = fakeRes();
    const result = server.requireIdentity({
      method: "GET",
      headers: { cookie: sessionCookie("sid-missing", "csrf-missing") },
    }, res);
    assert.equal(result, null);
    assert.equal(res.status, 302);
    assert.equal(res.headers.Location, "/");
  });
});
