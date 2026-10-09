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
const { CSP } = require("../lib/routes/chain-offers");
const { href: scriptHref } = require("../lib/wallet-script");
const { renderNotFound } = require("../lib/views/offers");
const { expiresAtOf } = require("../lib/commitment");

const KEYS = {
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  registrar: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  wallet: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  other: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  unbound: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};

const SESSION_SECRET = "test-session-secret-value";
const HASH = `0x${"44".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;
const COPY = "The chain shows this version was recorded on ForteL2 Sepolia. It does not show that the carrier has the space.";
const scriptSource = fs.readFileSync(require.resolve("../lib/assets/wallet.js"), "utf8");

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function terms(extra = {}) {
  return {
    source: "manual",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 10,
    unit: "container",
    sailingStart: "2026-12-20",
    sailingEnd: "2026-12-27",
    cutoffDate: "2026-12-18",
    validityDeadline: "2099-12-31",
    currency: "USD",
    baseMinor: 2000,
    markup: { type: "absolute", minor: 500 },
    buyerMinor: 2500,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function mockChain(real, clock) {
  const chain = {
    calls: { submit: 0, receipt: 0, call: 0 },
    submitted: [],
    hold: null,
    next: { state: "confirmed", hash: HASH },
    offerOnChain: [ZERO, 0, 0, 0, 0, ZERO],
    receiptState: { state: "confirmed" },
    mode: "ready",
    status() {
      const state = chain.mode;
      return {
        state,
        reason: state === "ready" ? null : state,
        chainId: real.status().chainId,
        address: real.status().address,
        relayer: openKey(KEYS.relayer).address,
        registrar: openKey(KEYS.registrar).address,
        relayerBalanceWei: "10000000000000000",
        lowBalance: false,
      };
    },
    typed: real.typed,
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
      if (fn !== "getOffer") throw new Error(`unexpected call ${fn}`);
      return chain.offerOnChain;
    },
    clock,
  };
  return chain;
}

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-offers-"));
  const recordsPath = path.join(dir, "records.json");
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
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
      address: "0x000000000000000000000000000000000000c015",
      genesisHash: `0x${"11".repeat(32)}`,
      runtimeCodeHash: `0x${"22".repeat(32)}`,
    },
  });
  const chain = mockChain(real, clock);
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
  const server = createServer({
    config,
    store,
    records,
    chain,
    now: () => clock.now,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      base,
      records,
      recordsPath,
      chain,
      real,
      clock,
      kings: { cookie: sessionCookie("sid-kings", "csrf-kings"), csrf: "csrf-kings", companyId: "kings" },
      other: { cookie: sessionCookie("sid-other", "csrf-other"), csrf: "csrf-other", companyId: "other-co" },
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
  };
}

async function post(base, cookie, target, fields) {
  const response = await fetch(new URL(target, base), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
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

function bindWallet(records, companyId, wallet, state) {
  records.ensureCompanyKey(companyId);
  records.transact((data) => {
    data.companies[companyId].wallets.push({
      wallet,
      boundBy: "user-owner",
      state,
      deadline: 1893456000,
      txHash: state === "confirmed" ? HASH : null,
      error: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
  });
}

function draft(records, companyId = "kings", sub = "user-owner", spec = terms()) {
  return records.createOffer(
    { companyId, sub, companyName: companyId },
    { source: "manual", terms: spec, snapshot: { secret: true }, sourceRecordId: null, overriddenFields: [] }
  );
}

function deadlineIn(ctx, seconds) {
  return String(Math.floor(ctx.clock.now / 1000) + seconds);
}

function messageFor(ctx, offer, kind, deadline, version = 1) {
  const chain = ctx.records.chainOfferFor(offer.id);
  const stored = ctx.records.getCompanyOffer(offer.companyId, offer.id);
  const current = stored.versions.find((item) => item.n === version);
  const commitment = ctx.records.commitmentFor(offer.id, version);
  const expiresAt = expiresAtOf(current.terms.validityDeadline);
  if (kind === "publish") {
    return { type: "Publish", message: { offerId: chain.offerKey, commitment, expiresAt, deadline: Number(deadline) } };
  }
  if (kind === "version") {
    return {
      type: "Version",
      message: { offerId: chain.offerKey, version, commitment, expiresAt, deadline: Number(deadline) },
    };
  }
  const confirmed = chain.confirmed;
  const to = stored.state === "paused" ? "paused" : "published";
  return {
    type: "OfferState",
    message: {
      offerId: chain.offerKey,
      state: to === "paused" ? 2 : 1,
      seq: confirmed.stateSeq,
      deadline: Number(deadline),
    },
  };
}

function signFields(ctx, who, privateKey, offer, kind, deadline, version, extra = {}) {
  const built = messageFor(ctx, offer, kind, deadline, version);
  return {
    csrf_token: who.csrf,
    kind,
    deadline,
    signature: openKey(privateKey).signDigest(ctx.real.typed.digest(built.type, built.message)),
    commitment: `0x${"ab".repeat(32)}`,
    version: "99",
    seq: "7",
    offerKey: `0x${"cd".repeat(32)}`,
    ...extra,
  };
}

async function prepare(ctx, offer, who = ctx.kings) {
  const response = await post(ctx.base, who.cookie, `/chain/offers/${offer.id}/prepare`, { csrf_token: who.csrf });
  assert.equal(response.status, 303, response.location);
  return response;
}

describe("chain offer reads", () => {
  it("does not write or call the chain, and 404s like the offer routes", async () => {
    await withApp(async (ctx) => {
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      const page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      assert.equal(page.status, 200);
      assert.equal(page.csp, CSP);
      assert.equal(page.html.includes(scriptHref), true);
      assert.equal(page.html.includes("<script"), true);
      const offerPage = await get(ctx.base, ctx.kings.cookie, `/offers/${offer.id}`);
      assert.equal(offerPage.html.includes("Publish on chain"), false);
      assert.equal(offerPage.html.includes("not confirmed yet"), true);
      assert.equal(offerPage.html.includes("<script"), false);
      assert.equal(offerPage.csp, null);

      const before = fs.readFileSync(ctx.recordsPath);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(ctx.recordsPath, stamp, stamp);
      ctx.chain.calls.call = 0;
      ctx.chain.calls.receipt = 0;
      ctx.chain.calls.submit = 0;
      const again = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      const seller = await get(ctx.base, ctx.kings.cookie, `/offers/${offer.id}`);
      assert.equal(again.status, 200);
      assert.equal(seller.status, 200);
      assert.equal(fs.readFileSync(ctx.recordsPath).equals(before), true);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
      assert.equal(ctx.chain.calls.call, 0);
      assert.equal(ctx.chain.calls.receipt, 0);
      assert.equal(ctx.chain.calls.submit, 0);

      const missing = await get(ctx.base, ctx.other.cookie, `/chain/offers/${offer.id}`);
      const offerMissing = await get(ctx.base, ctx.other.cookie, `/offers/${offer.id}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.html, offerMissing.html);
      assert.equal(missing.html, renderNotFound());
      assert.equal(missing.csp, null);
    });
  });

  it("shows Publish on chain only for a draft with a confirmed wallet", async () => {
    await withApp(async (ctx) => {
      const offer = draft(ctx.records);
      const hidden = await get(ctx.base, ctx.kings.cookie, `/offers/${offer.id}`);
      assert.equal(hidden.html.includes("Publish on chain"), false);
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const shown = await get(ctx.base, ctx.kings.cookie, `/offers/${offer.id}`);
      assert.match(shown.html, /id="chain-publish"/);
      assert.equal(shown.html.includes("Publish on chain"), true);
      assert.equal(shown.html.includes("<script"), false);
    });
  });
});

describe("chain offer signing", () => {
  it("rebuilds the message and refuses a tampered signature before writing", async () => {
    await withApp(async (ctx) => {
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      bindWallet(ctx.records, "kings", wallet, "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      const before = fs.readFileSync(ctx.recordsPath);
      const deadline = deadlineIn(ctx, 600);
      const real = messageFor(ctx, offer, "publish", deadline);
      const tampered = {
        ...real.message,
        commitment: `0x${"11".repeat(32)}`,
      };
      const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, {
        csrf_token: ctx.kings.csrf,
        kind: "publish",
        deadline,
        signature: openKey(KEYS.wallet).signDigest(ctx.real.typed.digest("Publish", tampered)),
        commitment: tampered.commitment,
        version: "3",
        seq: "9",
        offerKey: `0x${"22".repeat(32)}`,
      });
      assert.equal(response.status, 303);
      assert.equal(response.location, `/chain/offers/${offer.id}?result=not_signer`);
      assert.equal(fs.readFileSync(ctx.recordsPath).equals(before), true);
      assert.equal(ctx.chain.calls.submit, 0);
    });
  });

  it("refuses the wrong signers before writing or sending", async () => {
    await withApp(async (ctx) => {
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      const pending = checksumAddress(openKey(KEYS.unbound).address);
      bindWallet(ctx.records, "kings", wallet, "confirmed");
      bindWallet(ctx.records, "kings", pending, "pending");
      bindWallet(ctx.records, "other-co", checksumAddress(openKey(KEYS.other).address), "confirmed");
      const offer = draft(ctx.records);
      const otherOffer = draft(ctx.records, "other-co", "user-other");
      await prepare(ctx, offer);
      await prepare(ctx, otherOffer, ctx.other);
      const deadline = deadlineIn(ctx, 600);
      const before = fs.readFileSync(ctx.recordsPath);

      async function refused(fields, result) {
        const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, fields);
        assert.equal(response.location, `/chain/offers/${offer.id}?result=${result}`);
        assert.equal(fs.readFileSync(ctx.recordsPath).equals(before), true);
        assert.equal(ctx.chain.calls.submit, 0);
      }

      await refused(signFields(ctx, ctx.kings, KEYS.other, offer, "publish", deadline), "not_signer");
      await refused(signFields(ctx, ctx.kings, KEYS.unbound, offer, "publish", deadline), "not_signer");
      await refused(signFields(ctx, ctx.kings, KEYS.registrar, offer, "publish", deadline), "not_signer");
      await refused(signFields(ctx, ctx.kings, KEYS.relayer, offer, "publish", deadline), "not_signer");
      const foreign = messageFor(ctx, otherOffer, "publish", deadline);
      await refused({
        csrf_token: ctx.kings.csrf,
        kind: "publish",
        deadline,
        signature: openKey(KEYS.wallet).signDigest(ctx.real.typed.digest(foreign.type, foreign.message)),
      }, "not_signer");
    });
  });

  it("publishes from a draft, then records the next version and a pause in order", async () => {
    await withApp(async (ctx) => {
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      bindWallet(ctx.records, "kings", wallet, "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      const deadline = deadlineIn(ctx, 600);
      let sawSubmitting = false;
      const original = ctx.chain.submit.bind(ctx.chain);
      ctx.chain.submit = async (fn, args) => {
        if (!sawSubmitting) {
          const stored = JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8"));
          const action = stored.offers[offer.id].chain.actions.at(-1);
          assert.equal(action.status, "submitting");
          assert.equal(ctx.chain.calls.submit, 0);
          sawSubmitting = true;
        }
        return original(fn, args);
      };
      const published = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "publish", deadline));
      assert.equal(published.location, `/chain/offers/${offer.id}?result=recorded`);
      assert.equal(sawSubmitting, true);
      const stored = ctx.records.getCompanyOffer("kings", offer.id);
      assert.equal(stored.state, "published");
      assert.equal(stored.chain.confirmed.version, 1);
      assert.equal(stored.chain.confirmed.state, "published");
      assert.equal(stored.chain.confirmed.stateSeq, 0);
      assert.equal(stored.chain.actions[0].status, "confirmed");
      const sent = ctx.chain.submitted[0];
      assert.equal(sent.fn, "publishOffer");
      assert.equal(sent.args[0], stored.chain.offerKey);
      assert.equal(sent.args[1], ctx.records.commitmentFor(offer.id, 1));
      assert.notEqual(sent.args[1], `0x${"ab".repeat(32)}`);
      const audit = JSON.parse(fs.readFileSync(ctx.recordsPath, "utf8")).audit;
      assert.equal(audit.at(-1).event, "offer.chain_recorded");
      assert.equal(audit.at(-1).detail.to, "published");

      const edited = ctx.records.editOffer("kings", offer.id, { terms: terms({ quantity: 8 }) }, "user-owner", "2026-10-08");
      assert.equal(edited.ok, true);
      const third = ctx.records.editOffer("kings", offer.id, { terms: terms({ quantity: 7 }) }, "user-owner", "2026-10-08");
      assert.equal(third.ok, true);
      assert.equal(ctx.records.getCompanyOffer("kings", offer.id).currentVersion, 3);
      await prepare(ctx, offer);
      const page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      assert.match(page.html, /Version 2/);
      const chain = ctx.records.chainOfferFor(offer.id);
      const later = deadlineIn(ctx, 500);
      const skipped = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, {
        csrf_token: ctx.kings.csrf,
        kind: "version",
        deadline: later,
        signature: openKey(KEYS.wallet).signDigest(ctx.real.typed.digest("Version", {
          offerId: chain.offerKey,
          version: 3,
          commitment: `0x${"55".repeat(32)}`,
          expiresAt: expiresAtOf("2099-12-31"),
          deadline: Number(later),
        })),
        version: "3",
      });
      assert.equal(skipped.location, `/chain/offers/${offer.id}?result=not_signer`);
      assert.equal(ctx.chain.calls.submit, 1);
      const versioned = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "version", later, 2));
      assert.equal(versioned.location, `/chain/offers/${offer.id}?result=recorded`);
      assert.equal(ctx.records.chainOfferFor(offer.id).confirmed.version, 2);
      assert.equal(ctx.chain.submitted.at(-1).fn, "publishVersion");
      assert.equal(ctx.chain.submitted.at(-1).args[1], 2);
      await prepare(ctx, offer);
      const thirdSigned = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "version", deadlineIn(ctx, 450), 3));
      assert.equal(thirdSigned.location, `/chain/offers/${offer.id}?result=recorded`);
      assert.equal(ctx.records.chainOfferFor(offer.id).confirmed.version, 3);

      const paused = await post(ctx.base, ctx.kings.cookie, `/offers/${offer.id}/state`, { csrf_token: ctx.kings.csrf, to: "paused" });
      assert.equal(paused.status, 302);
      await prepare(ctx, offer);
      const state = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "state", deadlineIn(ctx, 400)));
      assert.equal(state.location, `/chain/offers/${offer.id}?result=recorded`);
      assert.equal(ctx.chain.submitted.at(-1).fn, "setOfferState");
      assert.equal(ctx.chain.submitted.at(-1).args[1], 2);
      assert.equal(ctx.chain.submitted.at(-1).args[2], 0);
      const confirmed = ctx.records.chainOfferFor(offer.id).confirmed;
      assert.equal(confirmed.state, "paused");
      assert.equal(confirmed.stateSeq, 1);
    });
  });

  it("writes one submitting row and sends once when two signs race", async () => {
    await withApp(async (ctx) => {
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      bindWallet(ctx.records, "kings", wallet, "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      let release;
      ctx.chain.hold = new Promise((resolve) => {
        release = resolve;
      });
      ctx.chain.next = { state: "pending", hash: HASH };
      const fields = signFields(ctx, ctx.kings, KEYS.wallet, offer, "publish", deadlineIn(ctx, 600));
      const first = post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, fields);
      const second = post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, fields);
      const deadline = Date.now() + 2000;
      while (ctx.chain.calls.submit < 1) {
        if (Date.now() > deadline) throw new Error("submit did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const loser = await Promise.race([first, second]);
      assert.equal(loser.location, `/chain/offers/${offer.id}?result=in_flight`);
      assert.equal(ctx.chain.calls.submit, 1);
      release();
      await Promise.all([first, second]);
      assert.equal(ctx.chain.calls.submit, 1);
      const actions = ctx.records.chainOfferFor(offer.id).actions;
      assert.equal(actions.length, 1);
      assert.equal(actions[0].status, "pending");
    });
  });

  it("retries a refused, reverted, or expired publish and confirms it", async () => {
    await withApp(async (ctx) => {
      const wallet = checksumAddress(openKey(KEYS.wallet).address);
      bindWallet(ctx.records, "kings", wallet, "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      const key = ctx.records.chainOfferFor(offer.id).offerKey;

      ctx.chain.next = { state: "refused", error: { name: "DigestUsed" } };
      const refused = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "publish", deadlineIn(ctx, 600)));
      assert.equal(refused.location, `/chain/offers/${offer.id}?result=refused&code=DigestUsed`);
      assert.equal(ctx.records.getCompanyOffer("kings", offer.id).state, "published");
      let page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      assert.match(page.html, /id="chain-sign"/);

      ctx.chain.next = { state: "confirmed", hash: HASH };
      const again = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "publish", deadlineIn(ctx, 500)));
      assert.equal(again.location, `/chain/offers/${offer.id}?result=recorded`);
      assert.equal(ctx.records.chainOfferFor(offer.id).offerKey, key);
      assert.equal(ctx.records.chainOfferFor(offer.id).confirmed.version, 1);

      const revertedOffer = draft(ctx.records);
      await prepare(ctx, revertedOffer);
      ctx.chain.next = { state: "reverted", hash: HASH };
      await post(ctx.base, ctx.kings.cookie, `/chain/offers/${revertedOffer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, revertedOffer, "publish", deadlineIn(ctx, 500)));
      assert.equal(ctx.records.chainOfferFor(revertedOffer.id).actions.at(-1).status, "reverted");
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const revertedRetry = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${revertedOffer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, revertedOffer, "publish", deadlineIn(ctx, 400)));
      assert.equal(revertedRetry.location, `/chain/offers/${revertedOffer.id}?result=recorded`);

      const expiredOffer = draft(ctx.records);
      await prepare(ctx, expiredOffer);
      ctx.chain.next = { state: "pending", hash: HASH };
      await post(ctx.base, ctx.kings.cookie, `/chain/offers/${expiredOffer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, expiredOffer, "publish", deadlineIn(ctx, 600)));
      ctx.clock.now += 20 * 60 * 1000;
      const checked = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${expiredOffer.id}/check`, { csrf_token: ctx.kings.csrf });
      assert.equal(checked.location, `/chain/offers/${expiredOffer.id}?result=expired`);
      assert.equal(ctx.records.chainOfferFor(expiredOffer.id).actions.at(-1).status, "expired");
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const expiredRetry = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${expiredOffer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, expiredOffer, "publish", deadlineIn(ctx, 600)));
      assert.equal(expiredRetry.location, `/chain/offers/${expiredOffer.id}?result=recorded`);
      assert.equal(ctx.records.chainOfferFor(expiredOffer.id).confirmed.state, "published");
    });
  });

  describe("expire resolution", () => {
    function expireActions(ctx, id) {
      return ctx.records.chainOfferFor(id).actions.filter((action) => action.kind === "expire");
    }

    function inFlight(actions) {
      return actions.filter((action) => action.status === "submitting" || action.status === "pending");
    }

    function sends(ctx) {
      return ctx.chain.submitted.filter((item) => item.fn === "markExpired").length;
    }

    function stampCreated(ctx, id) {
      ctx.records.transact((data) => {
        const action = data.offers[id].chain.actions.find((item) => item.kind === "expire" && (item.status === "pending" || item.status === "submitting"));
        action.createdAt = new Date(ctx.clock.now).toISOString();
      });
    }

    async function published(ctx) {
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, offer, "publish", deadlineIn(ctx, 600)));
      assert.equal(response.location, `/chain/offers/${offer.id}?result=recorded`);
      ctx.clock.now = (expiresAtOf("2099-12-31") + 10) * 1000;
      const companyKey = ctx.records.companyKeyFor("kings");
      ctx.chain.offerOnChain = [companyKey, 1, 0, 1, expiresAtOf("2099-12-31"), ctx.records.commitmentFor(offer.id, 1)];
      return offer;
    }

    async function check(ctx, id) {
      const before = sends(ctx);
      const inflightBefore = inFlight(expireActions(ctx, id)).length;
      const original = ctx.chain.submit.bind(ctx.chain);
      ctx.chain.submit = async (fn, args) => {
        if (fn === "markExpired") {
          const flying = inFlight(expireActions(ctx, id));
          assert.equal(flying.length, 1);
        }
        return original(fn, args);
      };
      const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${id}/check`, { csrf_token: ctx.kings.csrf });
      ctx.chain.submit = original;
      if (sends(ctx) > before) assert.equal(inflightBefore, 0);
      return response;
    }

    it("expires an undelivered markExpired after the buffer, then the next check sends again", async () => {
      await withApp(async (ctx) => {
        const offer = await published(ctx);
        ctx.chain.next = { state: "pending", hash: HASH };
        ctx.chain.receiptState = { state: "pending" };
        const started = await check(ctx, offer.id);
        assert.equal(started.location, `/chain/offers/${offer.id}?result=pending`);
        assert.equal(sends(ctx), 1);
        stampCreated(ctx, offer.id);
        const waiting = await check(ctx, offer.id);
        assert.equal(waiting.location, `/chain/offers/${offer.id}?result=unchanged`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "pending");
        assert.equal(sends(ctx), 1);
        assert.equal(inFlight(expireActions(ctx, offer.id)).length, 1);
        ctx.clock.now += 121 * 1000;
        const aged = await check(ctx, offer.id);
        assert.equal(aged.location, `/chain/offers/${offer.id}?result=expired`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "expired");
        assert.equal(sends(ctx), 1);
        const retried = await check(ctx, offer.id);
        assert.equal(retried.location, `/chain/offers/${offer.id}?result=pending`);
        assert.equal(sends(ctx), 2);
        assert.equal(inFlight(expireActions(ctx, offer.id)).length, 1);
      });
    });

    it("reverts an expire whose receipt reverted, then the next check sends again", async () => {
      await withApp(async (ctx) => {
        const offer = await published(ctx);
        ctx.chain.next = { state: "pending", hash: HASH };
        ctx.chain.receiptState = { state: "reverted" };
        const started = await check(ctx, offer.id);
        assert.equal(started.location, `/chain/offers/${offer.id}?result=pending`);
        stampCreated(ctx, offer.id);
        const reverted = await check(ctx, offer.id);
        assert.equal(reverted.location, `/chain/offers/${offer.id}?result=reverted`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "reverted");
        assert.equal(sends(ctx), 1);
        const retried = await check(ctx, offer.id);
        assert.equal(retried.location, `/chain/offers/${offer.id}?result=pending`);
        assert.equal(sends(ctx), 2);
        assert.equal(inFlight(expireActions(ctx, offer.id)).length, 1);
      });
    });

    it("confirms an expire from its receipt and audits it once", async () => {
      await withApp(async (ctx) => {
        const offer = await published(ctx);
        const before = ctx.records.view((data) => data.audit.filter((entry) => entry.event === "offer.chain_recorded" && entry.subject.offerId === offer.id).length);
        ctx.chain.next = { state: "pending", hash: HASH };
        ctx.chain.receiptState = { state: "confirmed" };
        const started = await check(ctx, offer.id);
        assert.equal(started.location, `/chain/offers/${offer.id}?result=pending`);
        const confirmed = await check(ctx, offer.id);
        assert.equal(confirmed.location, `/chain/offers/${offer.id}?result=recorded`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "confirmed");
        assert.equal(ctx.records.chainOfferFor(offer.id).confirmed.state, "expired");
        const recorded = ctx.records.view((data) => data.audit.filter((entry) => entry.event === "offer.chain_recorded" && entry.subject.offerId === offer.id));
        assert.equal(recorded.length, before + 1);
        assert.equal(sends(ctx), 1);
      });
    });

    it("confirms an expire with no hash when getOffer shows Expired", async () => {
      await withApp(async (ctx) => {
        const offer = await published(ctx);
        const original = ctx.chain.submit.bind(ctx.chain);
        ctx.chain.submit = async (fn, args) => {
          if (fn === "markExpired") {
            ctx.chain.calls.submit += 1;
            ctx.chain.submitted.push({ fn, args });
            throw new Error("lost");
          }
          return original(fn, args);
        };
        const crashed = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/check`, { csrf_token: ctx.kings.csrf });
        assert.equal(crashed.location, `/chain/offers/${offer.id}?result=pending`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "submitting");
        assert.equal(expireActions(ctx, offer.id)[0].txHash, null);
        ctx.chain.submit = original;
        const companyKey = ctx.records.companyKeyFor("kings");
        ctx.chain.offerOnChain = [companyKey, 1, 0, 4, expiresAtOf("2099-12-31"), ctx.records.commitmentFor(offer.id, 1)];
        const sendsBefore = sends(ctx);
        const confirmed = await check(ctx, offer.id);
        assert.equal(confirmed.location, `/chain/offers/${offer.id}?result=recorded`);
        assert.equal(expireActions(ctx, offer.id)[0].status, "confirmed");
        assert.equal(ctx.records.chainOfferFor(offer.id).confirmed.state, "expired");
        assert.equal(sends(ctx), sendsBefore);
      });
    });

    it("sends markExpired when a pause or resume is still unsigned and the offer is due", async () => {
      await withApp(async (ctx) => {
        bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
        const paused = draft(ctx.records);
        const resumed = draft(ctx.records);
        await prepare(ctx, paused);
        await prepare(ctx, resumed);
        ctx.chain.next = { state: "confirmed", hash: HASH };
        const published = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${paused.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, paused, "publish", deadlineIn(ctx, 600)));
        assert.equal(published.location, `/chain/offers/${paused.id}?result=recorded`);
        const publishedToo = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${resumed.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, resumed, "publish", deadlineIn(ctx, 500)));
        assert.equal(publishedToo.location, `/chain/offers/${resumed.id}?result=recorded`);
        const off = await post(ctx.base, ctx.kings.cookie, `/offers/${paused.id}/state`, { csrf_token: ctx.kings.csrf, to: "paused" });
        assert.equal(off.status, 302);
        const offToo = await post(ctx.base, ctx.kings.cookie, `/offers/${resumed.id}/state`, { csrf_token: ctx.kings.csrf, to: "paused" });
        assert.equal(offToo.status, 302);
        await prepare(ctx, resumed);
        const signedPause = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${resumed.id}/sign`, signFields(ctx, ctx.kings, KEYS.wallet, resumed, "state", deadlineIn(ctx, 400)));
        assert.equal(signedPause.location, `/chain/offers/${resumed.id}?result=recorded`);
        const on = await post(ctx.base, ctx.kings.cookie, `/offers/${resumed.id}/state`, { csrf_token: ctx.kings.csrf, to: "published" });
        assert.equal(on.status, 302);
        const stateSends = ctx.chain.submitted.filter((item) => item.fn === "setOfferState").length;
        ctx.clock.now = (expiresAtOf("2099-12-31") + 10) * 1000;
        const companyKey = ctx.records.companyKeyFor("kings");
        ctx.chain.offerOnChain = [companyKey, 1, 0, 1, expiresAtOf("2099-12-31"), ctx.records.commitmentFor(paused.id, 1)];
        ctx.chain.next = { state: "pending", hash: HASH };
        const pausePage = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${paused.id}`);
        assert.match(pausePage.html, /id="chain-check"/);
        assert.equal(pausePage.html.includes("chain-sign"), false);
        const pauseCheck = await check(ctx, paused.id);
        assert.equal(pauseCheck.location, `/chain/offers/${paused.id}?result=pending`);
        assert.equal(ctx.chain.submitted.at(-1).fn, "markExpired");
        ctx.chain.offerOnChain = [companyKey, 1, 1, 2, expiresAtOf("2099-12-31"), ctx.records.commitmentFor(resumed.id, 1)];
        const resumePage = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${resumed.id}`);
        assert.match(resumePage.html, /id="chain-check"/);
        assert.equal(resumePage.html.includes("chain-sign"), false);
        const resumeCheck = await check(ctx, resumed.id);
        assert.equal(resumeCheck.location, `/chain/offers/${resumed.id}?result=pending`);
        assert.equal(ctx.chain.submitted.filter((item) => item.fn === "markExpired").length, 2);
        assert.equal(ctx.chain.submitted.filter((item) => item.fn === "setOfferState").length, stateSends);
      });
    });
  });

  it("sends nothing when version 1 is past expiresAt", async () => {
    await withApp(async (ctx) => {
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const offer = draft(ctx.records, "kings", "user-owner", terms({ validityDeadline: "2026-10-07" }));
      const page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      assert.match(page.html, /This offer cannot be recorded/);
      assert.equal(page.html.includes("chain-sign"), false);
      const before = fs.readFileSync(ctx.recordsPath);
      const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, {
        csrf_token: ctx.kings.csrf,
        kind: "publish",
        deadline: deadlineIn(ctx, 600),
        signature: `0x${"11".repeat(65)}`,
      });
      assert.equal(response.location, `/chain/offers/${offer.id}?result=not_next`);
      assert.equal(fs.readFileSync(ctx.recordsPath).equals(before), true);
      assert.equal(ctx.chain.calls.submit, 0);
    });
  });

  it("lets the page script sign the typed data the server rebuilds", async () => {
    await withApp(async (ctx) => {
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const offer = draft(ctx.records);
      await prepare(ctx, offer);
      const page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
      const signed = await browserSign(page.html, KEYS.wallet);
      const response = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, {
        csrf_token: ctx.kings.csrf,
        kind: "publish",
        deadline: signed.deadline,
        signature: signed.signature,
      });
      assert.equal(response.location, `/chain/offers/${offer.id}?result=recorded`);
    });
  });
});

describe("chain down and the marketplace", () => {
  it("keeps off-chain edits working and shows the chain line without calling the chain", async () => {
    await withApp(async (ctx) => {
      bindWallet(ctx.records, "kings", checksumAddress(openKey(KEYS.wallet).address), "confirmed");
      const offer = draft(ctx.records);
      ctx.records.setOfferState("kings", offer.id, "published", "user-owner", "2026-10-08");
      for (const mode of ["degraded", "disabled", "misconfigured"]) {
        ctx.chain.mode = mode;
        const edited = ctx.records.editOffer("kings", offer.id, { terms: terms({ quantity: 4 }) }, "user-owner", "2026-10-08");
        assert.equal(edited.ok, true, mode);
        const paused = await post(ctx.base, ctx.kings.cookie, `/offers/${offer.id}/state`, { csrf_token: ctx.kings.csrf, to: "paused" });
        assert.equal(paused.status, 302, mode);
        const resumed = await post(ctx.base, ctx.kings.cookie, `/offers/${offer.id}/state`, { csrf_token: ctx.kings.csrf, to: "published" });
        assert.equal(resumed.status, 302, mode);
        const page = await get(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}`);
        assert.match(page.html, /Recording on chain is unavailable/);
        assert.equal(page.html.includes("<script"), false);
        const sign = await post(ctx.base, ctx.kings.cookie, `/chain/offers/${offer.id}/sign`, {
          csrf_token: ctx.kings.csrf,
          kind: "publish",
          deadline: deadlineIn(ctx, 600),
          signature: "0x",
        });
        assert.equal(sign.location, `/chain/offers/${offer.id}?result=unavailable`);
      }
      assert.equal(ctx.chain.calls.submit, 0);

      ctx.chain.mode = "ready";
      ctx.records.transact((data) => {
        const row = data.offers[offer.id];
        row.chain = {
          offerKey: `0x${"12".repeat(32)}`,
          enabledAt: "2026-10-08T00:00:00.000Z",
          enabledBy: "user-owner",
          salts: { 1: `0x${"34".repeat(32)}` },
          confirmed: { version: 1, state: "published", stateSeq: 0 },
          actions: [{
            id: "act-1",
            kind: "publish",
            version: 1,
            to: "published",
            seq: null,
            signer: checksumAddress(openKey(KEYS.wallet).address),
            deadline: 1893456000,
            status: "confirmed",
            txHash: HASH,
            error: null,
            createdAt: "2026-10-08T00:00:00.000Z",
            updatedAt: "2026-10-08T00:00:00.000Z",
          }],
        };
      });
      const before = fs.readFileSync(ctx.recordsPath);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(ctx.recordsPath, stamp, stamp);
      ctx.chain.calls.call = 0;
      const detail = await get(ctx.base, ctx.other.cookie, `/market/${offer.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.html.includes(COPY), true);
      assert.match(detail.html, new RegExp(`Chain version 1\\.`));
      assert.equal(detail.html.includes(HASH), true);
      assert.equal(detail.html.includes("<script"), false);
      assert.equal(detail.html.includes(ctx.records.chainOfferFor(offer.id).offerKey), false);
      assert.equal(fs.readFileSync(ctx.recordsPath).equals(before), true);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
      assert.equal(ctx.chain.calls.call, 0);
      assert.equal(ctx.chain.calls.submit, 0);
    });
  });
});

function browserSign(html, privateKey) {
  const signer = openKey(privateKey);
  const form = {
    attributes: {
      "data-domain": attr(html, "data-domain"),
      "data-chain": attr(html, "data-chain"),
      "data-typed": attr(html, "data-typed"),
    },
    children: [{ name: "signature", value: "" }, { name: "deadline", value: "" }],
    getAttribute(name) {
      return this.attributes[name];
    },
    querySelector(selector) {
      const found = /name=([A-Za-z]+)/.exec(selector);
      return this.children.find((child) => child.name === found[1]);
    },
    submit() {
      const deadline = this.querySelector("input[name=deadline]");
      if (deadline) this.children[1].value = deadline.value;
    },
  };
  const hidden = /name="deadline" value="([^"]*)"/.exec(html);
  const button = {
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "wallet-bind") return null;
      if (id === "chain-sign") return form;
      if (id === "chain-sign-button") return button;
      if (id === "chain-note") return { textContent: "" };
      return null;
    },
  };
  const ethereum = {
    request({ method, params }) {
      if (method === "eth_requestAccounts") return Promise.resolve([signer.address]);
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return Promise.resolve(null);
      const { digestHex } = require("./eip712-generic");
      return Promise.resolve(signer.signDigest(digestHex(JSON.parse(params[1]))));
    },
  };
  vm.runInNewContext(scriptSource, { window: { ethereum }, document }, { filename: "wallet.js" });
  return button.listeners.click({ preventDefault() {} }).then(() => ({
    signature: form.children[0].value,
    deadline: hidden ? hidden[1] : "",
  }));
}
