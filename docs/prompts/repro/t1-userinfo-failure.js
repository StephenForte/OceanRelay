// Reproduces the T1 defect: a failed /oauth/userinfo still yields a "connected" session
// with an empty identity. Run from the repo root: node docs/prompts/repro/t1-userinfo-failure.js
// Uses only the in-process mock Rate Ninja and a temp directory.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../../../server");
const { loadConfig } = require("../../../lib/config");
const { openStore } = require("../../../lib/store");
const { createMockRateNinja } = require("../../../test/mock-rate-ninja");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-repro-"));
  const mock = createMockRateNinja({ clientId: "c", clientSecret: "s" });
  const rnPort = await mock.listen();
  const rn = `http://127.0.0.1:${rnPort}`;
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: "c", RATE_NINJA_CLIENT_SECRET: "s",
    SESSION_SECRET: "repro-session", TOKEN_ENCRYPTION_KEY: "repro-key",
    RATE_NINJA_BASE_URL: rn, OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
  });
  const store = openStore(path.join(dir, "store.json"), config.tokenEncryptionKey);
  // Rate Ninja answers everything normally except userinfo, which fails.
  const fetchImpl = (url, init) => String(url).endsWith("/oauth/userinfo")
    ? Promise.resolve(new Response(JSON.stringify({ error: "server_error" }), { status: 500 }))
    : fetch(url, init);
  const server = createServer({ config, store, fetchImpl });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.redirectUri = `${base}/oauth/callback`;

  const home = await fetch(base);
  const cookie = home.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const csrf = (await home.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
  const connect = await fetch(`${base}/connect`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf_token: csrf }),
  });
  const auth = new URL(connect.headers.get("location"));
  const decision = await fetch(`${rn}/oauth/decision`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      decision: "approve", state: auth.searchParams.get("state"),
      redirect_uri: auth.searchParams.get("redirect_uri"),
      code_challenge: auth.searchParams.get("code_challenge"),
    }),
  });
  const callback = await fetch(decision.headers.get("location"), { headers: { cookie }, redirect: "manual" });
  console.log("callback redirect:", callback.headers.get("location"));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")).connections;
  console.log("stored profile:", JSON.stringify(Object.values(saved)[0]?.profile));
  console.log("revoke calls at Rate Ninja:", mock.calls.filter((c) => c === "POST /oauth/revoke").length);
  server.close(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
