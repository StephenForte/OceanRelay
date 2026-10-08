"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createServer } = require("../server");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { createChain } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { checksumAddress } = require("../lib/chain/hex");
const { CSP } = require("../lib/routes/wallet");
const { text: walletScript, href: scriptHref } = require("../lib/wallet-script");
const { digestHex } = require("./eip712-generic");

// Anvil default accounts. Test only. Never use for real funds.
const KEYS = {
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  registrar: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  wallet: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  other: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};

const SESSION_SECRET = "test-session-secret-value";
const HASH = `0x${"44".repeat(32)}`;
const OTHER_KEY = `0x${"ab".repeat(32)}`;
const ZERO_KEY = `0x${"00".repeat(32)}`;
const scriptSource = fs.readFileSync(require.resolve("../lib/assets/wallet.js"), "utf8");

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function deadlineIn(seconds) {
  return String(Math.floor(Date.now() / 1000) + seconds);
}

function signBinding(real, privateKey, companyKey, wallet, deadline) {
  return openKey(privateKey).signDigest(real.typed.digest("Binding", {
    companyKey,
    wallet,
    deadline: Number(deadline),
  }));
}

function mockChain(real) {
  const chain = {
    calls: { submit: 0, sign: 0, receipt: 0, call: 0 },
    submitted: [],
    signed: [],
    hold: null,
    next: { state: "confirmed", hash: HASH },
    onChain: ZERO_KEY,
    receiptState: { state: "confirmed" },
    status() {
      return {
        state: "ready",
        reason: null,
        chainId: real.status().chainId,
        address: real.status().address,
        relayer: openKey(KEYS.relayer).address,
        registrar: openKey(KEYS.registrar).address,
        relayerBalanceWei: "10000000000000000",
        lowBalance: false,
      };
    },
    typed: real.typed,
    registrarSign(message) {
      chain.calls.sign += 1;
      chain.signed.push(message);
      return `0x${"11".repeat(65)}`;
    },
    async submit(fn, args) {
      chain.calls.submit += 1;
      chain.submitted.push({ fn, args });
      if (chain.hold) await chain.hold;
      return chain.next;
    },
    async receipt() {
      chain.calls.receipt += 1;
      return chain.receiptState;
    },
    async call(fn) {
      chain.calls.call += 1;
      if (fn !== "walletCompany") throw new Error(`unexpected call ${fn}`);
      return chain.onChain;
    },
  };
  return chain;
}

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-wallet-"));
  const recordsPath = path.join(dir, "records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: "capacity-exchange",
    RATE_NINJA_CLIENT_SECRET: "test-client-secret-value",
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_RECORDS_PATH: recordsPath,
    OCEANRELAY_STORE_PATH: path.join(dir, "store.json"),
  });
  const real = createChain({
    deployment: {
      chainId: 852,
      address: "0x000000000000000000000000000000000000c014",
      genesisHash: `0x${"11".repeat(32)}`,
      runtimeCodeHash: `0x${"22".repeat(32)}`,
    },
  });
  const chain = mockChain(real);
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  store.saveConnection("sid-kings", {
    refreshToken: "refresh-kings",
    scopes: ["profile:read", "rates:read", "sailings:read"],
    profile: {
      sub: "user-owner",
      companyId: "kings",
      companyName: "Kings",
      companyType: "Contract Owner",
      active: true,
      name: "Owner",
    },
  });
  store.saveConnection("sid-other", {
    refreshToken: "refresh-other",
    scopes: ["profile:read", "rates:read", "sailings:read"],
    profile: {
      sub: "user-other",
      companyId: "other-co",
      companyName: "Other Co",
      companyType: "Contract Owner",
      active: true,
      name: "Other",
    },
  });
  const server = createServer({ config, store, records, chain });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      base,
      records,
      recordsPath,
      chain,
      real,
      kings: { cookie: sessionCookie("sid-kings", "csrf-kings"), csrf: "csrf-kings" },
      other: { cookie: sessionCookie("sid-other", "csrf-other"), csrf: "csrf-other" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function get(base, cookie, target) {
  const response = await fetch(new URL(target, base), {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
    csp: response.headers.get("content-security-policy"),
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
    nosniff: response.headers.get("x-content-type-options"),
  };
}

async function post(base, cookie, target, fields) {
  const response = await fetch(new URL(target, base), {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
    csp: response.headers.get("content-security-policy"),
  };
}

function attr(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (!match) return "";
  return match[1]
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function prepare(ctx, who = ctx.kings) {
  const response = await post(ctx.base, who.cookie, "/wallet/prepare", { csrf_token: who.csrf });
  assert.equal(response.status, 303);
  return ctx.records.companyKeyFor(who === ctx.other ? "other-co" : "kings");
}

function bindFields(ctx, who, privateKey, wallet, deadline, companyKey) {
  return {
    csrf_token: who.csrf,
    wallet,
    deadline,
    signature: signBinding(ctx.real, privateKey, companyKey, wallet, deadline),
  };
}

describe("wallet page", () => {
  it("reads without writing or calling the chain, and other pages stay script-free", async () => {
    await withApp(async (ctx) => {
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(ctx.recordsPath, stamp, stamp);
      const before = fs.readFileSync(ctx.recordsPath);
      const wallet = await get(ctx.base, ctx.kings.cookie, "/wallet");
      assert.equal(wallet.status, 200);
      assert.equal(wallet.csp, CSP);
      assert.equal(wallet.html.includes("<script"), false);
      assert.match(wallet.html, /Binding is unavailable\.|Prepare/);
      assert.match(wallet.html, /id="wallet-prepare"/);
      assert.equal(wallet.html.includes("Connect and sign"), false);
      assert.deepEqual(fs.readFileSync(ctx.recordsPath), before);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
      assert.equal(ctx.chain.calls.submit, 0);
      assert.equal(ctx.chain.calls.sign, 0);
      assert.equal(ctx.chain.calls.receipt, 0);
      assert.equal(ctx.chain.calls.call, 0);

      const home = await get(ctx.base, "", "/");
      const offers = await get(ctx.base, ctx.kings.cookie, "/offers");
      const market = await get(ctx.base, ctx.kings.cookie, "/market");
      const health = await get(ctx.base, "", "/health");
      for (const page of [home, offers, market]) {
        assert.equal(page.csp, null);
        assert.equal(page.html.includes("<script"), false);
      }
      assert.equal(home.html.includes('href="/wallet"'), false);
      assert.match(offers.html, /href="\/wallet"/);
      assert.match(market.html, /href="\/wallet"/);
      assert.equal(health.csp, null);
      assert.deepEqual(fs.readFileSync(ctx.recordsPath), before);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
    });
  });

  it("serves the script with the stylesheet cache rules and a page script only when signing", async () => {
    await withApp(async (ctx) => {
      const asset = await get(ctx.base, "", "/assets/wallet.js");
      assert.equal(asset.status, 200);
      assert.match(asset.type, /^application\/javascript/);
      assert.match(asset.cache, /immutable/);
      assert.match(asset.cache, /max-age=31536000/);
      assert.equal(asset.nosniff, "nosniff");
      assert.equal(asset.html, walletScript);
      assert.equal(asset.html.includes(KEYS.wallet), false);
      const companyKey = await prepare(ctx);
      const before = fs.readFileSync(ctx.recordsPath);
      const stamp = new Date("2020-06-01T00:00:00.000Z");
      fs.utimesSync(ctx.recordsPath, stamp, stamp);
      const page = await get(ctx.base, ctx.kings.cookie, "/wallet");
      assert.equal(page.csp, CSP);
      assert.match(page.html, /id="wallet-sign"/);
      assert.match(page.html, /A browser wallet is required/);
      assert.equal(page.html.includes(`<script src="${scriptHref}">`), true);
      assert.equal((page.html.match(/<script/g) || []).length, 1);
      assert.match(page.html, new RegExp(`id="company-key">${companyKey}`));
      assert.deepEqual(fs.readFileSync(ctx.recordsPath), before);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
      assert.equal(ctx.chain.calls.call + ctx.chain.calls.receipt + ctx.chain.calls.submit + ctx.chain.calls.sign, 0);
      const off = ctx.chain.status;
      ctx.chain.status = () => ({ ...off(), state: "degraded" });
      const down = await get(ctx.base, ctx.kings.cookie, "/wallet");
      assert.equal(down.html.includes("<script"), false);
      assert.match(down.html, /Binding is unavailable/);
      assert.match(down.html, /Chain state: degraded/);
      assert.equal(down.csp, CSP);
    });
  });

  it("escapes a wallet address and links only a real transaction hash", async () => {
    await withApp(async (ctx) => {
      await prepare(ctx);
      ctx.records.transact((data) => {
        data.companies.kings.wallets.push({
          wallet: "<img src=x onerror=alert(1)>",
          boundBy: "user-owner",
          state: "confirmed",
          deadline: 1,
          txHash: HASH,
          error: null,
          createdAt: "<script>alert(1)</script>",
          updatedAt: "2026-10-08T00:00:00.000Z",
        });
      });
      const page = await get(ctx.base, ctx.kings.cookie, "/wallet");
      assert.equal(page.html.includes("<img src=x"), false);
      assert.equal(page.html.includes("<script>alert"), false);
      assert.match(page.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(page.html, new RegExp(`https://settlementos-explorer-ihgo\\.onrender\\.com/fortel2-sepolia/tx/${HASH}`));
    });
  });
});

describe("wallet refusals", () => {
  it("refuses the relayer, the registrar, a bad signature, a deadline, the cap, and an in-flight bind before anything is sent", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = openKey(KEYS.wallet).address;
      const soon = deadlineIn(600);
      const snapshot = () => fs.readFileSync(ctx.recordsPath);

      async function refused(fields, result) {
        const before = snapshot();
        const signs = ctx.chain.calls.sign;
        const submits = ctx.chain.calls.submit;
        const response = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", fields);
        assert.equal(response.status, 303, result);
        assert.equal(response.location, `/wallet?result=${result}`);
        assert.deepEqual(snapshot(), before);
        assert.equal(ctx.chain.calls.sign, signs);
        assert.equal(ctx.chain.calls.submit, submits);
      }

      await refused(bindFields(ctx, ctx.kings, KEYS.relayer, openKey(KEYS.relayer).address, soon, companyKey), "reserved");
      await refused(bindFields(ctx, ctx.kings, KEYS.registrar, openKey(KEYS.registrar).address, soon, companyKey), "reserved");
      await refused({
        csrf_token: ctx.kings.csrf,
        wallet: "0x0000000000000000000000000000000000000000",
        deadline: soon,
        signature: "0x" + "ab".repeat(65),
      }, "reserved");
      await refused({
        csrf_token: ctx.kings.csrf,
        wallet,
        deadline: soon,
        signature: signBinding(ctx.real, KEYS.other, companyKey, openKey(KEYS.other).address, soon),
      }, "mismatch");
      await refused(bindFields(ctx, ctx.kings, KEYS.wallet, wallet, deadlineIn(20 * 60), companyKey), "deadline");
      await refused(bindFields(ctx, ctx.kings, KEYS.wallet, wallet, deadlineIn(-30), companyKey), "deadline");

      ctx.records.transact((data) => {
        data.companies.kings.wallets = Array.from({ length: 5 }, (_, index) => ({
          wallet: checksumAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`),
          boundBy: "user-owner",
          state: index === 4 ? "pending" : "confirmed",
          deadline: Number(soon),
          txHash: null,
          error: null,
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        }));
      });
      await refused(bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey), "in_flight");
      ctx.records.transact((data) => {
        data.companies.kings.wallets[4].state = "confirmed";
      });
      await refused(bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey), "cap");
      ctx.records.transact((data) => {
        data.companies.kings.wallets = [data.companies.kings.wallets[0]];
        data.companies.kings.wallets[0].wallet = wallet;
        data.companies.kings.wallets[0].state = "confirmed";
      });
      await refused(bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey), "already");

      const down = ctx.chain.status;
      ctx.chain.status = () => ({ ...down(), state: "disabled" });
      const beforeDown = snapshot();
      const prepareDown = await post(ctx.base, ctx.other.cookie, "/wallet/prepare", { csrf_token: ctx.other.csrf });
      const bindDown = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey));
      assert.equal(prepareDown.location, "/wallet?result=unavailable");
      assert.equal(bindDown.location, "/wallet?result=unavailable");
      assert.deepEqual(snapshot(), beforeDown);
      assert.equal(ctx.records.companyKeyFor("other-co"), null);
    });
  });

  it("rejects a missing session and a bad CSRF token without writing", async () => {
    await withApp(async (ctx) => {
      const before = fs.readFileSync(ctx.recordsPath);
      const anonymous = await post(ctx.base, "", "/wallet/bind", { csrf_token: "nope" });
      assert.equal(anonymous.status, 403);
      const csrf = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", { csrf_token: "nope" });
      assert.equal(csrf.status, 403);
      assert.match(csrf.html, /invalid_csrf/);
      const home = await get(ctx.base, "", "/wallet");
      assert.equal(home.status, 302);
      assert.equal(home.location, "/");
      assert.deepEqual(fs.readFileSync(ctx.recordsPath), before);
    });
  });
});

describe("wallet bind results", () => {
  it("refuses the row when the registrar cannot sign, and does not send", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = openKey(KEYS.wallet).address;
      const other = openKey(KEYS.other).address;
      ctx.chain.registrarSign = () => {
        throw new Error("registrar key unavailable");
      };
      const failed = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, deadlineIn(600), companyKey));
      assert.equal(failed.status, 303);
      assert.equal(failed.location, "/wallet?result=unavailable");
      assert.equal(ctx.chain.calls.submit, 0);
      const stuck = ctx.records.walletsFor("kings")[0];
      assert.equal(stuck.state, "refused");
      assert.equal(stuck.txHash, null);
      ctx.chain.registrarSign = () => `0x${"11".repeat(65)}`;
      ctx.chain.next = { state: "pending", hash: HASH };
      const again = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.other, other, deadlineIn(600), companyKey));
      assert.equal(again.location, "/wallet?result=pending");
      assert.equal(ctx.chain.calls.submit, 1);
      assert.equal(ctx.records.walletsFor("kings").at(-1).state, "pending");
    });
  });

  it("writes the submit result when a check expires the row while submit is in flight", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      const soon = deadlineIn(600);
      let release;
      ctx.chain.hold = new Promise((resolve) => {
        release = resolve;
      });
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const pending = post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey));
      const deadline = Date.now() + 2000;
      while (ctx.chain.calls.submit < 1) {
        if (Date.now() > deadline) throw new Error("submit did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ctx.records.applyWalletChecks("kings", [{ wallet, state: "expired", error: null }]);
      release();
      const response = await pending;
      assert.equal(response.location, "/wallet?result=bound");
      const entry = ctx.records.walletsFor("kings")[0];
      assert.equal(entry.state, "confirmed");
      assert.equal(entry.txHash, HASH);
      const stored = JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8"));
      assert.equal(stored.audit.filter((item) => item.event === "wallet.bound").length, 1);
    });
  });

  it("writes submitting before the registrar signs, and only one of two concurrent binds is sent", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = openKey(KEYS.wallet).address;
      const other = openKey(KEYS.other).address;
      const soon = deadlineIn(600);
      let sawSubmitting = false;
      const original = ctx.chain.registrarSign;
      ctx.chain.registrarSign = (message) => {
        const stored = JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8"));
        const entry = stored.companies.kings.wallets.at(-1);
        assert.equal(entry.state, "submitting");
        assert.equal(ctx.chain.calls.submit, 0);
        sawSubmitting = true;
        return original(message);
      };
      let release;
      ctx.chain.hold = new Promise((resolve) => {
        release = resolve;
      });
      ctx.chain.next = { state: "pending", hash: HASH };
      const first = post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey));
      const second = post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.other, other, soon, companyKey));
      const deadline = Date.now() + 2000;
      while (ctx.chain.calls.submit < 1) {
        if (Date.now() > deadline) throw new Error("submit did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const loser = await Promise.race([first, second]);
      assert.equal(ctx.chain.calls.submit, 1);
      assert.equal(loser.status, 303);
      assert.equal(loser.location, "/wallet?result=in_flight");
      release();
      const [left, right] = await Promise.all([first, second]);
      const winner = left.location === "/wallet?result=pending" ? left : right;
      assert.equal(winner.location, "/wallet?result=pending");
      assert.equal(sawSubmitting, true);
      assert.equal(ctx.chain.calls.submit, 1);
      assert.equal(ctx.chain.submitted[0].fn, "bindWallet");
      assert.equal(ctx.chain.submitted[0].args[1], wallet);
      const page = await get(ctx.base, ctx.kings.cookie, winner.location);
      assert.match(page.html, /banner-info/);
      assert.match(page.html, /The binding is pending/);
      assert.equal(page.html.includes("banner-error"), false);
      assert.equal(page.html.includes("The binding was refused"), false);
    });
  });

  it("maps every chain result, including an own-key rebind and another company's wallet", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = openKey(KEYS.wallet).address;
      const soon = deadlineIn(600);

      async function bind(next) {
        ctx.chain.next = next;
        const response = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey));
        const page = await get(ctx.base, ctx.kings.cookie, response.location);
        const entry = ctx.records.walletsFor("kings").at(-1);
        return { response, page, entry, audit: JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8")).audit };
      }

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const confirmed = await bind({ state: "confirmed", hash: HASH });
      assert.equal(confirmed.entry.state, "confirmed");
      assert.equal(confirmed.entry.txHash, HASH);
      assert.equal(confirmed.entry.error, null);
      assert.equal(confirmed.audit.at(-1).event, "wallet.bound");
      assert.equal(confirmed.audit.at(-1).actor.role, "user");
      assert.equal(confirmed.audit.at(-1).subject.wallet, wallet);
      assert.deepEqual(confirmed.audit.at(-1).detail, {});
      assert.match(confirmed.page.html, /The wallet is bound to your company/);
      const signature = bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey).signature;
      assert.equal(fs.readFileSync(ctx.recordsPath, "utf8").includes(signature), false);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const pending = await bind({ state: "pending", hash: HASH });
      assert.equal(pending.entry.state, "pending");
      assert.equal(pending.audit.some((entry) => entry.event === "wallet.bound"), false);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const reverted = await bind({ state: "reverted", hash: HASH });
      assert.equal(reverted.entry.state, "reverted");
      assert.match(reverted.page.html, /banner-error/);
      assert.match(reverted.page.html, /The binding transaction reverted/);
      assert.equal(reverted.audit.some((entry) => entry.event === "wallet.bound"), false);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const own = await bind({
        state: "refused",
        error: { name: "WalletAlreadyBound", args: [wallet, companyKey] },
      });
      assert.equal(own.entry.state, "confirmed");
      assert.equal(own.entry.error, null);
      assert.equal(own.audit.at(-1).event, "wallet.bound");
      assert.match(own.page.html, /The wallet is bound to your company/);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const foreign = await bind({
        state: "refused",
        error: { name: "WalletAlreadyBound", args: [wallet, OTHER_KEY] },
      });
      assert.equal(foreign.entry.state, "refused");
      assert.equal(foreign.entry.error, "WalletAlreadyBound");
      assert.match(foreign.page.html, /This wallet belongs to another company/);
      assert.equal(foreign.page.html.includes(OTHER_KEY), false);
      assert.equal(foreign.page.html.includes("other-co"), false);
      assert.equal(fs.readFileSync(ctx.recordsPath, "utf8").includes(OTHER_KEY), false);
      assert.equal(foreign.audit.some((entry) => entry.event === "wallet.bound"), false);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const named = await bind({ state: "refused", error: { name: "DigestUsed", args: [] } });
      assert.equal(named.entry.state, "refused");
      assert.equal(named.entry.error, "DigestUsed");
      assert.match(named.page.html, /The binding was refused \(DigestUsed\)/);

      ctx.records.transact((data) => {
        data.companies.kings.wallets = [];
        data.audit = data.audit.filter((entry) => entry.event !== "wallet.bound");
      });
      const ugly = await bind({ state: "refused", error: { name: "<script>alert(1)</script>", args: ["secret"] } });
      assert.equal(ugly.entry.error, null);
      assert.equal(ugly.page.html.includes("<script>alert"), false);
      assert.equal(ugly.page.html.includes("secret"), false);
      assert.match(ugly.page.html, /The binding was refused\./);
    });
  });

  it("leaves pending until check, then confirms from a receipt or from walletCompany", async () => {
    await withApp(async (ctx) => {
      const companyKey = await prepare(ctx);
      const wallet = openKey(KEYS.wallet).address;
      const soon = deadlineIn(600);
      ctx.chain.next = { state: "pending", hash: HASH };
      const bound = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", bindFields(ctx, ctx.kings, KEYS.wallet, wallet, soon, companyKey));
      assert.equal(bound.location, "/wallet?result=pending");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "pending");

      ctx.chain.receiptState = { state: "pending" };
      const still = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(still.location, "/wallet?result=unchanged");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "pending");
      const stillPage = await get(ctx.base, ctx.kings.cookie, still.location);
      assert.match(stillPage.html, /The binding is still pending/);
      assert.equal(stillPage.html.includes("banner-error"), false);

      ctx.chain.receiptState = { state: "confirmed" };
      const mined = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(mined.location, "/wallet?result=bound");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "confirmed");
      assert.equal(ctx.chain.calls.call, 0);
      assert.equal(JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8")).audit.at(-1).event, "wallet.bound");

      ctx.records.transact((data) => {
        const entry = data.companies.kings.wallets[0];
        entry.state = "pending";
        entry.txHash = HASH;
        entry.deadline = Math.floor(Date.now() / 1000) - 30;
      });
      ctx.chain.calls.receipt = 0;
      ctx.chain.calls.call = 0;
      ctx.chain.receiptState = { state: "confirmed" };
      const recent = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(recent.location, "/wallet?result=bound");
      assert.equal(ctx.chain.calls.receipt, 1);
      assert.equal(ctx.chain.calls.call, 0);

      ctx.records.transact((data) => {
        const entry = data.companies.kings.wallets[0];
        entry.state = "submitting";
        entry.txHash = null;
        entry.deadline = Math.floor(Date.now() / 1000) + 600;
      });
      ctx.chain.onChain = ZERO_KEY;
      ctx.chain.calls.call = 0;
      const waiting = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(waiting.location, "/wallet?result=unchanged");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "submitting");
      assert.equal(ctx.chain.calls.call, 1);

      ctx.records.transact((data) => {
        data.companies.kings.wallets[0].deadline = Math.floor(Date.now() / 1000) - 30;
      });
      const expired = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(expired.location, "/wallet?result=expired");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "expired");

      ctx.records.transact((data) => {
        const entry = data.companies.kings.wallets[0];
        entry.state = "pending";
        entry.txHash = HASH;
        entry.deadline = Math.floor(Date.now() / 1000) - 300;
      });
      ctx.chain.onChain = companyKey;
      ctx.chain.receiptState = { state: "reverted" };
      ctx.chain.calls.receipt = 0;
      ctx.chain.calls.call = 0;
      const late = await post(ctx.base, ctx.kings.cookie, "/wallet/check", { csrf_token: ctx.kings.csrf });
      assert.equal(late.location, "/wallet?result=bound");
      assert.equal(ctx.records.walletsFor("kings")[0].state, "confirmed");
      assert.equal(ctx.chain.calls.receipt, 0);
      assert.equal(ctx.chain.calls.call, 1);
    });
  });

  it("posts the script signature and reaches submit with that wallet as the signer", async () => {
    await withApp(async (ctx) => {
      await prepare(ctx);
      const page = await get(ctx.base, ctx.kings.cookie, "/wallet");
      const domain = JSON.parse(attr(page.html, "data-domain"));
      const companyKey = attr(page.html, "data-company-key");
      const deadline = attr(page.html, "data-deadline");
      const chain = JSON.parse(attr(page.html, "data-chain"));
      assert.equal(chain.chainId, "0x354");
      assert.equal(chain.chainName, "ForteL2 Sepolia");
      assert.deepEqual(chain.nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
      assert.deepEqual(chain.rpcUrls, ["https://fortel2-sequencer-rpc.onrender.com/"]);
      assert.deepEqual(chain.blockExplorerUrls, ["https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/"]);
      const signer = openKey(KEYS.wallet);
      let captured = null;
      const form = {
        attributes: {
          "data-domain": JSON.stringify(domain),
          "data-company-key": companyKey,
          "data-deadline": deadline,
          "data-chain": JSON.stringify(chain),
        },
        children: [
          { name: "wallet", value: "" },
          { name: "signature", value: "" },
        ],
        getAttribute(name) {
          return this.attributes[name];
        },
        querySelector(selector) {
          const found = /name=([A-Za-z]+)/.exec(selector);
          return this.children.find((child) => child.name === found[1]);
        },
        submit() {
          this.submitted = true;
        },
      };
      const button = {
        listeners: {},
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
      };
      const document = {
        getElementById(id) {
          if (id === "wallet-bind") return form;
          if (id === "wallet-sign") return button;
          if (id === "wallet-note") return { textContent: "" };
          return null;
        },
      };
      const ethereum = {
        request({ method, params }) {
          if (method === "eth_requestAccounts") return Promise.resolve([signer.address]);
          if (method === "wallet_switchEthereumChain") {
            assert.equal(params[0].chainId, "0x354");
            return Promise.resolve(null);
          }
          captured = JSON.parse(params[1]);
          return Promise.resolve(signer.signDigest(digestHex(captured)));
        },
      };
      vm.runInNewContext(scriptSource, { window: { ethereum }, document }, { filename: "wallet.js" });
      await button.listeners.click({ preventDefault() {} });
      const digest = digestHex(captured);
      assert.equal(digest, ctx.real.typed.digest("Binding", {
        companyKey,
        wallet: signer.address,
        deadline: Number(deadline),
      }));
      const response = await post(ctx.base, ctx.kings.cookie, "/wallet/bind", {
        csrf_token: ctx.kings.csrf,
        wallet: form.children[0].value,
        deadline,
        signature: form.children[1].value,
      });
      assert.equal(response.location, "/wallet?result=bound");
      assert.equal(ctx.chain.calls.submit, 1);
      const args = ctx.chain.submitted[0].args;
      assert.equal(args[0], companyKey);
      assert.equal(args[1], signer.address);
      assert.equal(args[2], Number(deadline));
      assert.equal(args[3], form.children[1].value);
      const recovered = ctx.real.typed.recover("Binding", {
        companyKey,
        wallet: signer.address,
        deadline: Number(deadline),
      }, args[3]);
      assert.equal(recovered, signer.address);
      assert.equal(fs.readFileSync(ctx.recordsPath, "utf8").includes(args[3]), false);
      assert.equal(fs.readFileSync(ctx.recordsPath, "utf8").includes(args[4]), false);
    });
  });
});
