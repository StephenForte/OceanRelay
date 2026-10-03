const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { encryptString } = require("../lib/crypto-box");
const { createPkce } = require("../lib/pkce");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX_ROWS = 1000;
const PENDING_AAD = "oceanrelay-pkce-verifier";
const REFRESH_AAD = "oceanrelay-refresh-token";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-store-"));
}

function writeStore(file, document) {
  fs.writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pendingRow(state, verifier, createdAt) {
  return {
    state,
    verifierCiphertext: encryptString(ENCRYPTION_KEY, verifier, PENDING_AAD),
    createdAt,
  };
}

function connectionRow(refreshToken, name, now) {
  return {
    refreshCiphertext: encryptString(ENCRYPTION_KEY, refreshToken, REFRESH_AAD),
    scopes: ["profile:read", "rates:read", "sailings:read"],
    profile: {
      sub: "user-owner",
      name,
      companyId: "kings",
      companyName: "Kings",
      companyType: "Contract Owner",
      active: true,
    },
    connectedAt: now,
    updatedAt: now,
  };
}

function cookieHeader(response) {
  const raw = response.headers.getSetCookie?.() || [];
  return raw.map((value) => value.split(";")[0]).join("; ");
}

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function appConfig(issuer) {
  return loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: issuer,
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
  });
}

describe("token store pending rows", () => {
  it("drops a pending row older than the TTL on the next save and keeps a fresh row", () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    try {
      const now = Date.now();
      writeStore(file, {
        pending: {
          "sid-old": pendingRow("old-state", "old-verifier", now - PENDING_TTL_MS - 1),
          "sid-fresh": pendingRow("fresh-state", "fresh-verifier", now),
        },
        connections: {},
      });
      const store = openStore(file, ENCRYPTION_KEY);
      store.savePending("sid-new", { state: "new-state", verifier: "new-verifier", createdAt: now });
      const pending = readStore(file).pending;
      assert.equal(pending["sid-old"], undefined);
      assert.equal(pending["sid-fresh"].state, "fresh-state");
      assert.equal(pending["sid-new"].state, "new-state");
      assert.deepEqual(store.takePending("sid-fresh", "fresh-state"), { verifier: "fresh-verifier" });
      assert.deepEqual(store.takePending("sid-new", "new-state"), { verifier: "new-verifier" });
      assert.equal(store.takePending("sid-old", "old-state"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps at most 1000 pending rows and evicts the oldest", () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    try {
      const store = openStore(file, ENCRYPTION_KEY);
      const start = Date.now();
      for (let index = 0; index < PENDING_MAX_ROWS + 5; index += 1) {
        store.savePending(`row-${index}`, {
          state: `state-${index}`,
          verifier: `verifier-${index}`,
          createdAt: start + index,
        });
      }
      const pending = readStore(file).pending;
      assert.equal(Object.keys(pending).length, PENDING_MAX_ROWS);
      for (let index = 0; index < 5; index += 1) {
        assert.equal(pending[`row-${index}`], undefined);
      }
      assert.equal(pending["row-5"].state, "state-5");
      const newest = PENDING_MAX_ROWS + 4;
      assert.deepEqual(store.takePending(`row-${newest}`, `state-${newest}`), { verifier: `verifier-${newest}` });
      assert.equal(readStore(file).pending[`row-${newest}`], undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists takePending only when a row was deleted", () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    try {
      const store = openStore(file, ENCRYPTION_KEY);
      const now = Date.now();
      store.saveConnection("sid-user", {
        refreshToken: "refresh-kept",
        scopes: ["profile:read"],
        profile: {
          sub: "user-owner",
          name: "SteveF",
          companyId: "kings",
          companyName: "Kings",
          companyType: "Contract Owner",
        },
      });
      store.savePending("sid-hit", { state: "state-hit", verifier: "verifier-hit", createdAt: now });
      const before = fs.readFileSync(file);
      const beforeNs = fs.statSync(file, { bigint: true }).mtimeNs;
      assert.equal(store.takePending("sid-missing", "state-hit"), null);
      assert.equal(fs.readFileSync(file).equals(before), true);
      assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, beforeNs);
      assert.equal(store.connectionSecrets("sid-user").refreshToken, "refresh-kept");
      assert.deepEqual(store.takePending("sid-hit", "state-hit"), { verifier: "verifier-hit" });
      assert.equal(readStore(file).pending["sid-hit"], undefined);
      assert.notEqual(fs.statSync(file, { bigint: true }).mtimeNs, beforeNs);
      assert.equal(store.connectionSecrets("sid-user").refreshToken, "refresh-kept");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves live connections byte-identical and decryptable after pruning", () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    try {
      const now = Date.now();
      const pending = {};
      for (let index = 0; index < 5; index += 1) {
        pending[`expired-${index}`] = pendingRow(`expired-${index}`, `verifier-expired-${index}`, now - PENDING_TTL_MS - 60_000);
      }
      const freshCount = PENDING_MAX_ROWS + 2;
      for (let index = 0; index < freshCount; index += 1) {
        pending[`fresh-${index}`] = pendingRow(`fresh-${index}`, `verifier-fresh-${index}`, now - (freshCount - index));
      }
      writeStore(file, {
        pending,
        connections: {
          "sid-alpha": connectionRow("refresh-alpha", "Alpha", now),
          "sid-beta": connectionRow("refresh-beta", "Beta", now),
        },
      });
      const connectionsJson = JSON.stringify(readStore(file).connections);
      const store = openStore(file, ENCRYPTION_KEY);
      store.savePending("sid-new", { state: "state-new", verifier: "verifier-new", createdAt: now });
      const after = readStore(file);
      assert.equal(JSON.stringify(after.connections), connectionsJson);
      assert.deepEqual(Object.keys(after).sort(), ["connections", "pending"]);
      assert.equal(Object.keys(after.pending).length, PENDING_MAX_ROWS);
      for (let index = 0; index < 5; index += 1) {
        assert.equal(after.pending[`expired-${index}`], undefined);
      }
      for (let index = 0; index < 3; index += 1) {
        assert.equal(after.pending[`fresh-${index}`], undefined);
      }
      assert.deepEqual(store.takePending("sid-new", "state-new"), { verifier: "verifier-new" });
      const reopened = openStore(file, ENCRYPTION_KEY);
      assert.equal(reopened.connectionSecrets("sid-alpha").refreshToken, "refresh-alpha");
      assert.equal(reopened.connectionSecrets("sid-beta").refreshToken, "refresh-beta");
      assert.equal(JSON.stringify(readStore(file).connections), connectionsJson);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a store file in the existing format and connects through the mock", async () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    let server;
    try {
      const mockPort = await mock.listen();
      const pkce = createPkce();
      const now = Date.now();
      const sid = "sid-from-main";
      const document = {
        pending: {
          [sid]: pendingRow(pkce.state, pkce.verifier, now),
        },
        connections: {
          "sid-already": connectionRow("refresh-existing", "Already", now),
        },
      };
      assert.deepEqual(Object.keys(document.pending[sid]).sort(), ["createdAt", "state", "verifierCiphertext"]);
      assert.deepEqual(Object.keys(document.connections["sid-already"]).sort(), [
        "connectedAt",
        "profile",
        "refreshCiphertext",
        "scopes",
        "updatedAt",
      ]);
      writeStore(file, document);
      const keptConnection = JSON.stringify(readStore(file).connections["sid-already"]);
      const config = appConfig(`http://127.0.0.1:${mockPort}`);
      const store = openStore(file, ENCRYPTION_KEY);
      assert.equal(store.connectionSecrets("sid-already").refreshToken, "refresh-existing");
      server = createServer({ config, store });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      config.redirectUri = `${base}/oauth/callback`;
      const decision = await fetch(`http://127.0.0.1:${mockPort}/oauth/decision`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          decision: "approve",
          state: pkce.state,
          redirect_uri: config.redirectUri,
          code_challenge: pkce.challenge,
        }),
        redirect: "manual",
      });
      assert.equal(decision.status, 302);
      const callback = await fetch(decision.headers.get("location"), {
        headers: { cookie: sessionCookie(sid, "csrf-main") },
        redirect: "manual",
      });
      assert.equal(callback.status, 302);
      assert.equal(new URL(callback.headers.get("location"), base).searchParams.get("result"), "connected");
      const home = await fetch(base, { headers: { cookie: sessionCookie(sid, "csrf-main") } });
      assert.match(await home.text(), /Connected/);
      const after = readStore(file);
      assert.equal(after.pending[sid], undefined);
      assert.equal(JSON.stringify(after.connections["sid-already"]), keptConnection);
      const reopened = openStore(file, ENCRYPTION_KEY);
      assert.equal(reopened.connectionSecrets("sid-already").refreshToken, "refresh-existing");
      assert.match(reopened.connectionSecrets(sid).refreshToken, /^refresh-/);
      assert.equal(reopened.publicConnection(sid).profile.name, "SteveF");
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds 1100 anonymous connects to 1000 pending rows and under 250000 bytes", async () => {
    const dir = tempDir();
    const file = path.join(dir, "store.json");
    const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    let server;
    try {
      const mockPort = await mock.listen();
      const config = appConfig(`http://127.0.0.1:${mockPort}`);
      const store = openStore(file, ENCRYPTION_KEY);
      server = createServer({ config, store });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      config.redirectUri = `${base}/oauth/callback`;
      for (let index = 0; index < 1100; index += 1) {
        const home = await fetch(base);
        const html = await home.text();
        const csrf = html.match(/name="csrf_token" value="([^"]+)"/);
        assert.ok(csrf);
        const connect = await fetch(`${base}/connect`, {
          method: "POST",
          headers: {
            cookie: cookieHeader(home),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrf_token: csrf[1] }),
          redirect: "manual",
        });
        assert.equal(connect.status, 302);
      }
      const stored = readStore(file);
      const size = fs.statSync(file).size;
      assert.equal(Object.keys(stored.pending).length, PENDING_MAX_ROWS);
      assert.deepEqual(stored.connections, {});
      assert.deepEqual(Object.keys(stored).sort(), ["connections", "pending"]);
      assert.ok(size < 250_000, `token store is ${size} bytes`);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
