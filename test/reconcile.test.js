"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openRecords } = require("../lib/records");
const { compareRecords } = require("../lib/reconcile");
const { commitmentFromTermsHash } = require("../lib/commitment");
const { createServer } = require("../server");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { COOKIE_NAME, signSession } = require("../lib/session");

const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const BUYER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const TODAY = "2026-10-09";
const WALLET = "0x00000000000000000000000000000000000000Ab";
const TX = "0x" + "11".repeat(32);

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

function snapshot(records) {
  return records.view((draft) => structuredClone(draft));
}

function byReason(findings, reason) {
  return findings.filter((item) => item.reason === reason);
}

describe("reconciliation comparison", () => {
  it("adopts a wallet bound to the company's own key and a revoked wallet, and refuses another company", () => {
    const records = openRecords(null);
    const sellerKey = records.ensureCompanyKey(SELLER.companyId).companyKey;
    const buyerKey = records.ensureCompanyKey(BUYER.companyId).companyKey;
    records.transact((draft) => {
      draft.companies[SELLER.companyId].wallets.push({
        wallet: WALLET,
        state: "expired",
        txHash: null,
      });
      draft.companies[BUYER.companyId].wallets.push({
        wallet: "0x00000000000000000000000000000000000000Cd",
        state: "confirmed",
        txHash: TX,
      });
      draft.companies[SELLER.companyId].wallets.push({
        wallet: "0x00000000000000000000000000000000000000Ef",
        state: "refused",
        txHash: null,
      });
    });
    const events = [
      { name: "WalletBound", args: { companyKey: sellerKey, wallet: WALLET }, transactionHash: TX, blockNumber: 2, logIndex: 0 },
      { name: "WalletRevoked", args: { wallet: "0x00000000000000000000000000000000000000Cd", companyKey: buyerKey }, transactionHash: TX, blockNumber: 3, logIndex: 0 },
    ];
    const findings = compareRecords(snapshot(records), events, {
      wallets: {
        [WALLET.toLowerCase()]: sellerKey,
        ["0x00000000000000000000000000000000000000cd"]: "0x" + "00".repeat(32),
        ["0x00000000000000000000000000000000000000ef"]: buyerKey,
      },
      offers: {},
      requests: {},
    });
    const bound = byReason(findings, "wallet_bound");
    const revoked = byReason(findings, "wallet_revoked");
    const other = byReason(findings, "wallet_other_company");
    assert.equal(bound.length, 1);
    assert.equal(bound[0].adoptable, true);
    assert.equal(bound[0].kind, "mismatch");
    assert.equal(bound[0].txHash, TX);
    assert.equal(bound[0].subject.companyId, SELLER.companyId);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].adoptable, true);
    assert.equal(revoked[0].records, "confirmed");
    assert.equal(other.length, 1);
    assert.equal(other[0].adoptable, false);
    assert.equal(findings.some((item) => item.kind === "unknown"), false);
  });

  it("adopts an offer action only when the commitment, version, seq and company key match", () => {
    const records = openRecords(null);
    const companyKey = records.ensureCompanyKey(SELLER.companyId).companyKey;
    const created = records.createOffer(SELLER, { source: "manual", terms: terms() });
    records.prepareChainOffer(SELLER.companyId, created.id, SELLER.sub);
    records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
    const offerKey = records.chainOfferFor(created.id).offerKey;
    const commitment = records.commitmentFor(created.id, 1);
    records.transact((draft) => {
      const offer = draft.offers[created.id];
      offer.chain.confirmed = null;
      offer.chain.actions = [{
        id: "publish-1",
        kind: "publish",
        version: 1,
        to: null,
        seq: null,
        status: "expired",
      }];
    });
    const offerView = {
      companyKey,
      version: 1,
      stateSeq: 0,
      state: 1,
      expiresAt: 1,
      commitment,
    };
    const events = [{
      name: "OfferPublished",
      args: { offerId: offerKey, companyKey, version: 1, commitment },
      transactionHash: TX,
      blockNumber: 4,
      logIndex: 1,
    }];
    const healthy = compareRecords(snapshot(records), events, {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: offerView },
      requests: {},
    });
    const landed = byReason(healthy, "offer_landed");
    assert.equal(landed.length, 1);
    assert.equal(landed[0].adoptable, true);
    assert.equal(landed[0].txHash, TX);
    assert.equal(landed[0].subject.offerId, created.id);
    assert.equal(healthy.some((item) => item.kind === "lag"), false);

    const flipped = "0x" + (commitment.slice(2, 3) === "0" ? "1" : "0") + commitment.slice(3);
    const miss = compareRecords(snapshot(records), events, {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: { ...offerView, commitment: flipped } },
      requests: {},
    });
    assert.equal(byReason(miss, "offer_landed").length, 0);
    assert.equal(byReason(miss, "offer_commitment")[0].adoptable, false);

    const wrongCompany = compareRecords(snapshot(records), events, {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: { ...offerView, companyKey: "0x" + "44".repeat(32) } },
      requests: {},
    });
    assert.equal(byReason(wrongCompany, "offer_company")[0].adoptable, false);

    records.transact((draft) => {
      draft.offers[created.id].chain.actions = [{
        id: "state-1",
        kind: "state",
        version: 1,
        to: "paused",
        seq: 0,
        status: "reverted",
      }];
    });
    const wrongSeq = compareRecords(snapshot(records), [], {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: { ...offerView, state: 2, stateSeq: 4 } },
      requests: {},
    });
    assert.equal(byReason(wrongSeq, "offer_seq")[0].adoptable, false);

    records.transact((draft) => {
      const offer = draft.offers[created.id];
      offer.chain.actions = [{
        id: "publish-ok",
        kind: "publish",
        version: 1,
        status: "confirmed",
      }];
      offer.chain.confirmed = { version: 1, state: "published", stateSeq: 0 };
      offer.currentVersion = 2;
      offer.versions.push({ ...offer.versions[0], n: 2 });
    });
    const lag = compareRecords(snapshot(records), [], {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: offerView },
      requests: {},
    });
    assert.equal(byReason(lag, "offer_landed").length, 0);
    assert.equal(byReason(lag, "offer_version_unsigned")[0].kind, "lag");
    assert.equal(byReason(lag, "offer_version_unsigned")[0].adoptable, false);
  });

  it("adopts a request action from the acceptance commitment, and reports lag and unknown keys", () => {
    const records = openRecords(null);
    const sellerKey = records.ensureCompanyKey(SELLER.companyId).companyKey;
    const buyerKey = records.ensureCompanyKey(BUYER.companyId).companyKey;
    const created = records.createOffer(SELLER, { source: "manual", terms: terms() });
    records.prepareChainOffer(SELLER.companyId, created.id, SELLER.sub);
    records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
    const offerKey = records.chainOfferFor(created.id).offerKey;
    const request = records.createRequest(BUYER, created.id, 1, 1, TODAY);
    assert.equal(request.ok, true, request.error);
    const termsHash = "ab".repeat(32);
    const salt = "0x" + "66".repeat(32);
    const requestKey = "0x" + "55".repeat(32);
    const commitment = commitmentFromTermsHash(termsHash, salt);
    records.transact((draft) => {
      const row = draft.requests[request.request.id];
      row.state = "accepted";
      row.acceptance = { termsHash, counter: null, quantity: 1 };
      row.fulfilment = { status: "accepted", history: [] };
      row.chain = {
        requestKey,
        salts: { "0": salt },
        confirmed: { recorded: true, acceptedCounter: null, status: null, statusSeq: 0, cancelled: false },
        actions: [{ id: "accept-1", kind: "acceptance", counter: null, seq: null, status: "expired" }],
      };
    });
    const view = {
      offerId: offerKey,
      buyerCompany: buyerKey,
      version: 1,
      statusSeq: 0,
      status: 2,
      termsCommitment: commitment,
    };
    const events = [{
      name: "AcceptanceRecorded",
      args: { requestId: requestKey, termsCommitment: commitment },
      transactionHash: TX,
      blockNumber: 8,
      logIndex: 0,
    }];
    const landed = compareRecords(snapshot(records), events, {
      wallets: {},
      offers: {},
      requests: { [requestKey]: view },
    });
    assert.equal(byReason(landed, "request_landed")[0].adoptable, true);
    assert.equal(byReason(landed, "request_landed")[0].txHash, TX);

    const flipped = "0x" + (commitment.slice(2, 3) === "a" ? "b" : "a") + commitment.slice(3);
    const miss = compareRecords(snapshot(records), events, {
      wallets: {},
      offers: {},
      requests: { [requestKey]: { ...view, termsCommitment: flipped } },
    });
    assert.equal(byReason(miss, "request_commitment")[0].adoptable, false);

    records.transact((draft) => {
      const row = draft.requests[request.request.id];
      row.chain.actions = [{ id: "status-1", kind: "status", to: "carrier_pending", seq: 0, status: "expired" }];
      row.chain.confirmed = { recorded: true, acceptedCounter: null, status: "accepted", statusSeq: 0, cancelled: false };
      row.acceptance = { termsHash, counter: null, quantity: 1 };
      row.fulfilment.history = [{ from: "accepted", to: "carrier_pending", role: "operator" }];
    });
    const wrongSeq = compareRecords(snapshot(records), [], {
      wallets: {},
      offers: {},
      requests: { [requestKey]: { ...view, status: 3, statusSeq: 2, termsCommitment: "0x" + "00".repeat(32) } },
    });
    assert.equal(byReason(wrongSeq, "request_seq")[0].adoptable, false);

    records.transact((draft) => {
      const row = draft.requests[request.request.id];
      row.chain.actions = [];
      row.chain.confirmed = { recorded: true, acceptedCounter: null, status: "accepted", statusSeq: 0, cancelled: false };
      row.fulfilment.history = [
        { from: "accepted", to: "carrier_pending", role: "seller" },
        { from: "carrier_pending", to: "carrier_confirmed", role: "operator" },
      ];
      row.fulfilment.status = "cancelled";
    });
    const lag = compareRecords(snapshot(records), [], {
      wallets: {},
      offers: {},
      requests: { [requestKey]: view },
    });
    assert.equal(byReason(lag, "request_landed").length, 0);
    assert.equal(byReason(lag, "request_status_unsigned").length >= 1, true);
    assert.equal(byReason(lag, "operator_status")[0].kind, "lag");
    assert.equal(byReason(lag, "operator_status")[0].adoptable, false);

    const unknownKey = "0x" + "77".repeat(32);
    const unknown = compareRecords(snapshot(records), [
      { name: "OfferPublished", args: { offerId: unknownKey, companyKey: sellerKey }, transactionHash: TX, blockNumber: 9, logIndex: 0 },
      { name: "Paused", args: { account: WALLET }, transactionHash: TX, blockNumber: 1, logIndex: 0 },
    ], { wallets: {}, offers: {}, requests: {} });
    const unknownOffer = byReason(unknown, "unknown_offer");
    assert.equal(unknownOffer.length, 1);
    assert.equal(unknownOffer[0].kind, "unknown");
    assert.equal(unknownOffer[0].adoptable, false);
    assert.equal(unknownOffer[0].txHash, TX);
    assert.equal(byReason(unknown, "unknown_company").length, 0);
  });

  it("keeps a finding id stable for the same kind, subject and transaction", () => {
    const records = openRecords(null);
    const companyKey = records.ensureCompanyKey(SELLER.companyId).companyKey;
    records.transact((draft) => {
      draft.companies[SELLER.companyId].wallets.push({ wallet: WALLET, state: "expired" });
    });
    const events = [{
      name: "WalletBound",
      args: { companyKey, wallet: WALLET },
      transactionHash: TX,
      blockNumber: 1,
      logIndex: 0,
    }];
    const views = { wallets: { [WALLET.toLowerCase()]: companyKey }, offers: {}, requests: {} };
    const first = compareRecords(snapshot(records), events, views)[0];
    const second = compareRecords(snapshot(records), events, views)[0];
    assert.equal(first.id, second.id);
    assert.equal(first.kind, "mismatch");
  });
});

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const OPERATOR = { companyId: "ops-co", sub: "user-operator", companyName: "Ops Co" };
const MEMBER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function fakeChain(script) {
  const calls = { events: 0, call: 0, submit: 0, sign: 0 };
  return {
    calls,
    status() {
      return { state: script.state || "ready" };
    },
    async events() {
      calls.events += 1;
      if (script.fail) throw new Error("chain_unavailable");
      return script.events || [];
    },
    async call(fn, args) {
      calls.call += 1;
      if (script.fail) throw new Error("chain_unavailable");
      return script.answer(fn, args);
    },
    submit() {
      calls.submit += 1;
    },
    registrarSign() {
      calls.sign += 1;
    },
  };
}

async function withChain(script, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-reconcile-"));
  const recordsPath = path.join(dir, "records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_OPERATOR_SUBS: OPERATOR.sub,
  });
  const store = openStore(path.join(dir, "store.json"), config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const chain = fakeChain(script);
  const server = createServer({ config, store, records, chain });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  function seed(sid, csrf, profile) {
    store.saveConnection(sid, {
      refreshToken: `refresh-${sid}`,
      scopes: ["profile:read", "rates:read", "sailings:read"],
      profile: { name: profile.companyName, companyType: "Contract Owner", active: true, ...profile },
    });
    return { cookie: sessionCookie(sid, csrf), csrf };
  }
  try {
    await run({
      base,
      records,
      recordsPath,
      chain,
      operator: seed("sid-operator", "csrf-operator", OPERATOR),
      member: seed("sid-member", "csrf-member", MEMBER),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function postForm(base, cookie, target, fields) {
  return fetch(new URL(target, base), {
    method: "POST",
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
}

async function signature(base, target, { cookie, method = "GET" } = {}) {
  const response = await fetch(new URL(target, base), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? new URLSearchParams({ csrf_token: "x" }) : undefined,
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
    referrer: response.headers.get("referrer-policy"),
    nosniff: response.headers.get("x-content-type-options"),
    frame: response.headers.get("x-frame-options"),
    cookie: response.headers.get("set-cookie"),
    body: await response.text(),
  };
}

describe("operator chain report", () => {
  it("renders the report from a read and writes nothing", async () => {
    const companyKey = "0x" + "ab".repeat(32);
    await withChain({
      events: [{
        name: "WalletBound",
        args: { companyKey, wallet: WALLET },
        transactionHash: TX,
        blockNumber: 3,
        logIndex: 0,
      }],
      answer() {
        return companyKey;
      },
    }, async ({ base, records, recordsPath, chain, operator }) => {
      records.ensureCompanyKey(SELLER.companyId);
      records.transact((draft) => {
        draft.companies[SELLER.companyId].companyKey = companyKey;
        draft.companies[SELLER.companyId].wallets = [{ wallet: WALLET, state: "expired", txHash: null }];
      });
      const index = await fetch(`${base}/operator`, { headers: { cookie: operator.cookie } });
      assert.match(await index.text(), /href="\/operator\/chain"/);
      const beforeCalls = chain.calls.events + chain.calls.call;
      const form = await fetch(`${base}/operator/chain`, { headers: { cookie: operator.cookie } });
      const formHtml = await form.text();
      assert.equal(form.status, 200);
      assert.match(formHtml, /id="chain-reconcile"/);
      assert.equal(formHtml.includes("<script"), false);
      assert.equal(chain.calls.events + chain.calls.call, beforeCalls);
      const before = fs.readFileSync(recordsPath);
      const mtime = fs.statSync(recordsPath).mtimeMs;
      const report = await postForm(base, operator.cookie, "/operator/chain/reconcile", {
        csrf_token: operator.csrf,
      });
      const html = await report.text();
      assert.equal(report.status, 200);
      assert.match(html, /data-reason="wallet_bound"/);
      assert.match(html, /data-adoptable="yes"/);
      assert.match(html, new RegExp(TX));
      assert.match(html, />Adopt</);
      assert.equal(chain.calls.submit, 0);
      assert.equal(chain.calls.sign, 0);
      assert.equal(chain.calls.events, 1);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, mtime);
    });
  });

  it("says the chain is unavailable and still writes nothing", async () => {
    await withChain({ fail: true, answer() { return "0x" + "00".repeat(32); } }, async ({ base, recordsPath, operator, chain }) => {
      const before = fs.readFileSync(recordsPath);
      const mtime = fs.statSync(recordsPath).mtimeMs;
      const report = await postForm(base, operator.cookie, "/operator/chain/reconcile", {
        csrf_token: operator.csrf,
      });
      const html = await report.text();
      assert.equal(report.status, 200);
      assert.match(html, /id="chain-unavailable"/);
      assert.equal(html.includes("Adopt"), false);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, mtime);
      assert.equal(chain.calls.submit, 0);
    });
  });

  it("returns the operator 404, byte-identical, to a signed-out user and a non-operator", async () => {
    await withChain({ answer() { return "0x" + "00".repeat(32); } }, async ({ base, member, chain, recordsPath }) => {
      const before = fs.readFileSync(recordsPath);
      const paths = [
        ["/operator/chain", "GET"],
        ["/operator/chain/reconcile", "POST"],
        ["/operator/chain/adopt", "POST"],
      ];
      for (const [target, method] of paths) {
        const signedOut = await signature(base, target, { method });
        const unknownOut = await signature(base, "/no-such-page", { method });
        assert.deepEqual(signedOut, unknownOut, `signed out ${method} ${target}`);
        const signedIn = await signature(base, target, { method, cookie: member.cookie });
        const unknownIn = await signature(base, "/no-such-page", { method, cookie: member.cookie });
        assert.deepEqual(signedIn, unknownIn, `signed in ${method} ${target}`);
      }
      assert.equal(chain.calls.events, 0);
      assert.equal(chain.calls.call, 0);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
    });
  });

  it("adopts one chain fact, refuses a stale id, and never sends or signs", async () => {
    const companyKey = "0x" + "ab".repeat(32);
    let chainKey = companyKey;
    await withChain({
      events: [{
        name: "WalletBound",
        args: { companyKey, wallet: WALLET },
        transactionHash: TX,
        blockNumber: 3,
        logIndex: 0,
      }],
      answer() {
        return chainKey;
      },
    }, async ({ base, records, recordsPath, chain, operator }) => {
      records.ensureCompanyKey(SELLER.companyId);
      records.transact((draft) => {
        draft.companies[SELLER.companyId].companyKey = companyKey;
        draft.companies[SELLER.companyId].wallets = [{
          wallet: WALLET,
          state: "expired",
          txHash: null,
          error: "DeadlineExpired",
        }];
      });
      const report = await postForm(base, operator.cookie, "/operator/chain/reconcile", {
        csrf_token: operator.csrf,
      });
      const html = await report.text();
      const finding = /name="finding" value="([0-9a-f]+)"/.exec(html)[1];
      const before = fs.readFileSync(recordsPath);
      const mtime = fs.statSync(recordsPath).mtimeMs;
      chainKey = "0x" + "00".repeat(32);
      const stale = await postForm(base, operator.cookie, "/operator/chain/adopt", {
        csrf_token: operator.csrf,
        finding,
      });
      assert.equal(stale.status, 303);
      assert.equal(stale.headers.get("location"), "/operator/chain?result=refused");
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, mtime);
      assert.equal(chain.calls.submit, 0);
      assert.equal(chain.calls.sign, 0);
      chainKey = companyKey;
      const adopted = await postForm(base, operator.cookie, "/operator/chain/adopt", {
        csrf_token: operator.csrf,
        finding,
      });
      assert.equal(adopted.status, 303);
      assert.equal(adopted.headers.get("location"), "/operator/chain?result=corrected");
      const wallet = records.walletsFor(SELLER.companyId)[0];
      assert.equal(wallet.state, "confirmed");
      assert.equal(wallet.txHash, TX);
      const audit = records.view((draft) => draft.audit.filter((entry) => entry.event === "chain.corrected"));
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor.role, "operator");
      assert.equal(audit[0].detail.reason, "wallet_bound");
      assert.equal(audit[0].detail.to, "confirmed");
      const again = await postForm(base, operator.cookie, "/operator/chain/adopt", {
        csrf_token: operator.csrf,
        finding,
      });
      assert.equal(again.headers.get("location"), "/operator/chain?result=refused");
      const corrected = records.view((draft) => draft.audit.filter((entry) => entry.event === "chain.corrected"));
      assert.equal(corrected.length, 1);
      assert.equal(chain.calls.submit, 0);
      assert.equal(chain.calls.sign, 0);
    });
  });
});

describe("chain adoption", () => {
  it("corrects an offer and a request without touching marketplace facts, and refuses near misses", () => {
    const records = openRecords(null);
    const companyKey = records.ensureCompanyKey(SELLER.companyId).companyKey;
    const buyerKey = records.ensureCompanyKey(BUYER.companyId).companyKey;
    const created = records.createOffer(SELLER, { source: "manual", terms: terms() });
    records.prepareChainOffer(SELLER.companyId, created.id, SELLER.sub);
    records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
    const offerKey = records.chainOfferFor(created.id).offerKey;
    const commitment = records.commitmentFor(created.id, 1);
    records.transact((draft) => {
      const offer = draft.offers[created.id];
      offer.chain.confirmed = null;
      offer.chain.actions = [{
        id: "publish-1",
        kind: "publish",
        version: 1,
        status: "expired",
      }];
    });
    const offerView = {
      companyKey,
      version: 1,
      stateSeq: 0,
      state: 1,
      expiresAt: 1,
      commitment,
    };
    const events = [{
      name: "OfferPublished",
      args: { offerId: offerKey, companyKey, commitment, version: 1 },
      transactionHash: TX,
      blockNumber: 4,
      logIndex: 0,
    }];
    const views = { wallets: {}, offers: { [offerKey.toLowerCase()]: offerView }, requests: {} };
    const finding = byReason(compareRecords(snapshot(records), events, views), "offer_landed")[0];
    const operator = { sub: "user-operator", companyId: "ops-co" };
    const flipped = "0x" + (commitment.slice(2, 3) === "0" ? "1" : "0") + commitment.slice(3);
    const missed = records.adoptChain(operator, finding.id, {
      events,
      views: { wallets: {}, offers: { [offerKey.toLowerCase()]: { ...offerView, commitment: flipped } }, requests: {} },
    });
    assert.equal(missed.ok, false);
    assert.equal(records.chainOfferFor(created.id).actions[0].status, "expired");
    const wrongCompany = records.adoptChain(operator, finding.id, {
      events,
      views: { wallets: {}, offers: { [offerKey.toLowerCase()]: { ...offerView, companyKey: "0x" + "44".repeat(32) } }, requests: {} },
    });
    assert.equal(wrongCompany.ok, false);
    records.transact((draft) => {
      draft.offers[created.id].chain.actions = [{
        id: "state-1",
        kind: "state",
        version: 1,
        to: "paused",
        seq: 3,
        status: "reverted",
      }];
    });
    const seqFinding = compareRecords(snapshot(records), [], {
      wallets: {},
      offers: { [offerKey.toLowerCase()]: { ...offerView, state: 2, stateSeq: 9 } },
      requests: {},
    }).find((item) => item.reason === "offer_seq");
    assert.equal(seqFinding.adoptable, false);
    assert.equal(records.adoptChain(operator, seqFinding.id, {
      events: [],
      views: { wallets: {}, offers: { [offerKey.toLowerCase()]: { ...offerView, state: 2, stateSeq: 9 } }, requests: {} },
    }).ok, false);
    records.transact((draft) => {
      draft.offers[created.id].chain.actions = [{
        id: "publish-1",
        kind: "publish",
        version: 1,
        status: "expired",
      }];
    });
    const adopted = records.adoptChain(operator, finding.id, { events, views });
    assert.equal(adopted.ok, true);
    const offer = records.getCompanyOffer(SELLER.companyId, created.id);
    assert.equal(offer.state, "published");
    assert.equal(offer.chain.actions[0].status, "confirmed");
    assert.equal(offer.chain.confirmed.version, 1);
    assert.equal(offer.chain.confirmed.state, "published");

    const request = records.createRequest(BUYER, created.id, 1, 1, TODAY);
    const termsHash = "ab".repeat(32);
    const salt = "0x" + "66".repeat(32);
    const requestKey = "0x" + "55".repeat(32);
    const requestCommitment = commitmentFromTermsHash(termsHash, salt);
    records.transact((draft) => {
      const row = draft.requests[request.request.id];
      row.state = "accepted";
      row.acceptance = { termsHash, counter: null, quantity: 1 };
      row.fulfilment = { status: "carrier_pending", history: [] };
      row.chain = {
        requestKey,
        salts: { "0": salt },
        confirmed: { recorded: true, acceptedCounter: null, status: null, statusSeq: 0, cancelled: false },
        actions: [{ id: "accept-1", kind: "acceptance", counter: null, status: "refused" }],
      };
    });
    const requestView = {
      offerId: offerKey,
      buyerCompany: buyerKey,
      version: 1,
      statusSeq: 0,
      status: 2,
      termsCommitment: requestCommitment,
    };
    const requestEvents = [{
      name: "AcceptanceRecorded",
      args: { requestId: requestKey, termsCommitment: requestCommitment },
      transactionHash: TX,
      blockNumber: 6,
      logIndex: 0,
    }];
    const requestViews = { wallets: {}, offers: {}, requests: { [requestKey]: requestView } };
    const requestFinding = byReason(compareRecords(snapshot(records), requestEvents, requestViews), "request_landed")[0];
    const badCommitment = "0x" + (requestCommitment.slice(2, 3) === "a" ? "b" : "a") + requestCommitment.slice(3);
    assert.equal(records.adoptChain(operator, requestFinding.id, {
      events: requestEvents,
      views: { wallets: {}, offers: {}, requests: { [requestKey]: { ...requestView, termsCommitment: badCommitment } } },
    }).ok, false);
    assert.equal(records.adoptChain(operator, requestFinding.id, {
      events: requestEvents,
      views: { wallets: {}, offers: {}, requests: { [requestKey]: { ...requestView, buyerCompany: "0x" + "44".repeat(32) } } },
    }).ok, false);
    const recorded = records.adoptChain(operator, requestFinding.id, {
      events: requestEvents,
      views: requestViews,
    });
    assert.equal(recorded.ok, true);
    const stored = records.view((draft) => draft.requests[request.request.id]);
    assert.equal(stored.state, "accepted");
    assert.equal(stored.fulfilment.status, "carrier_pending");
    assert.equal(stored.chain.actions[0].status, "confirmed");
    assert.equal(stored.chain.confirmed.status, "accepted");
    const audit = records.view((draft) => draft.audit.filter((entry) => entry.event === "chain.corrected"));
    assert.deepEqual(audit.map((entry) => entry.detail.reason), ["offer_landed", "request_landed"]);

    records.transact((draft) => {
      draft.companies[BUYER.companyId].wallets = [{
        wallet: "0x00000000000000000000000000000000000000Cd",
        state: "confirmed",
        txHash: null,
        error: null,
      }];
    });
    const revoked = records.adoptChain(operator, compareRecords(snapshot(records), [{
      name: "WalletRevoked",
      args: { wallet: "0x00000000000000000000000000000000000000Cd", companyKey: buyerKey },
      transactionHash: TX,
      blockNumber: 7,
      logIndex: 0,
    }], {
      wallets: { "0x00000000000000000000000000000000000000cd": "0x" + "00".repeat(32) },
      offers: {},
      requests: {},
    }).find((item) => item.reason === "wallet_revoked").id, {
      events: [{
        name: "WalletRevoked",
        args: { wallet: "0x00000000000000000000000000000000000000Cd", companyKey: buyerKey },
        transactionHash: TX,
        blockNumber: 7,
        logIndex: 0,
      }],
      views: {
        wallets: { "0x00000000000000000000000000000000000000cd": "0x" + "00".repeat(32) },
        offers: {},
        requests: {},
      },
    });
    assert.equal(revoked.ok, true);
    const revokedWallet = records.walletsFor(BUYER.companyId)[0];
    assert.equal(revokedWallet.state, "revoked");
    assert.equal(records.walletsFor(BUYER.companyId).some((entry) => entry.state === "confirmed"), false);
    const rebound = records.beginWalletBind(BUYER.companyId, {
      wallet: "0x00000000000000000000000000000000000000Cd",
      boundBy: BUYER.sub,
      deadline: 1893456000,
    });
    assert.equal(rebound.ok, true);
  });
});
