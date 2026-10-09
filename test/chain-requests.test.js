"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { createChain } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { checksumAddress } = require("../lib/chain/hex");
const { CSP } = require("../lib/routes/chain-requests");
const { href: scriptHref } = require("../lib/wallet-script");
const { renderNotFound } = require("../lib/views/requests");
const { buyerView } = require("../lib/offer-domain");
const { buyerTermsCanonical } = require("../lib/terms-hash");
const { commitmentFromTermsHash } = require("../lib/commitment");

const KEYS = {
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  registrar: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  seller: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  buyer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  buyer2: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  unbound: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  third: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
};

const SESSION_SECRET = "test-session-secret-value";
const HASH = `0x${"44".repeat(32)}`;
const ZERO = `0x${"00".repeat(32)}`;
const SENTENCE = "Requests on this offer are recorded on ForteL2 Sepolia. Both companies need a bound wallet to accept.";
const TODAY = "2026-10-08";

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

function mockChain(real) {
  const chain = {
    calls: { submit: 0, receipt: 0, call: 0 },
    submitted: [],
    hold: null,
    onSubmit: null,
    next: { state: "confirmed", hash: HASH },
    requestOnChain: [ZERO, ZERO, 0, 0, 0, ZERO],
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
      if (chain.fail) throw new Error("lost");
      if (chain.onSubmit) chain.onSubmit(fn, args);
      if (chain.hold) await chain.hold;
      return chain.next;
    },
    async receipt() {
      chain.calls.receipt += 1;
      return chain.receiptState;
    },
    async call(fn) {
      chain.calls.call += 1;
      if (fn !== "getRequest") throw new Error(`unexpected call ${fn}`);
      return chain.requestOnChain;
    },
  };
  return chain;
}

function person(companyId, sub, companyName) {
  return { companyId, sub, companyName };
}

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-requests-"));
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
  const chain = mockChain(real);
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const profiles = [
    ["sid-kings", "csrf-kings", person("kings", "user-owner", "Kings")],
    ["sid-buyer", "csrf-buyer", person("other-co", "user-buyer", "Other Co")],
    ["sid-third", "csrf-third", person("third-co", "user-third", "Third Co")],
  ];
  for (const [sid, csrf, profile] of profiles) {
    store.saveConnection(sid, {
      refreshToken: `refresh-${sid}`,
      scopes: ["profile:read", "rates:read", "sailings:read"],
      profile: { ...profile, companyType: "Contract Owner", active: true, name: profile.companyName },
    });
  }
  const server = createServer({ config, store, records, chain, now: () => clock.now });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const who = (sid, csrf, companyId) => ({ cookie: sessionCookie(sid, csrf), csrf, companyId });
  try {
    await run({
      base,
      records,
      recordsPath,
      chain,
      real,
      clock,
      seller: who("sid-kings", "csrf-kings", "kings"),
      buyer: who("sid-buyer", "csrf-buyer", "other-co"),
      third: who("sid-third", "csrf-third", "third-co"),
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

function inputValue(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match ? match[1] : "";
}

function address(key) {
  return checksumAddress(openKey(key).address);
}

function bindWallet(records, companyId, wallet, state, sub) {
  records.ensureCompanyKey(companyId);
  records.transact((data) => {
    data.companies[companyId].wallets.push({
      wallet,
      boundBy: sub,
      state,
      deadline: 1893456000,
      txHash: state === "confirmed" ? HASH : null,
      error: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
  });
}

function draft(records, companyId, spec) {
  return records.createOffer(
    person(companyId, "user-owner", companyId),
    { source: "manual", terms: spec || terms(), snapshot: { secret: true }, sourceRecordId: null, overriddenFields: [] }
  );
}

function publishOnChain(records, offer, signer) {
  const published = records.setOfferState(offer.companyId, offer.id, "published", "user-owner", TODAY);
  assert.equal(published.ok, true);
  records.transact((data) => {
    data.offers[offer.id].chain = {
      offerKey: `0x${"ab".repeat(32)}`,
      enabledAt: "2026-10-08T00:00:00.000Z",
      enabledBy: "user-owner",
      salts: { "1": `0x${"cd".repeat(32)}` },
      confirmed: { version: offer.currentVersion || 1, state: "published", stateSeq: 0 },
      actions: [{
        id: "publish-1",
        kind: "publish",
        version: 1,
        to: "published",
        seq: null,
        signer,
        deadline: 1893456000,
        status: "confirmed",
        txHash: HASH,
        error: null,
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      }],
    };
  });
  return records.getCompanyOffer(offer.companyId, offer.id);
}

function fileBytes(ctx) {
  return fs.readFileSync(ctx.recordsPath);
}

function independentHash(offer, counter, quantity, unitBuyerMinor, serviceTerms) {
  const version = offer.versions.find((item) => item.n === offer.currentVersion);
  const view = buyerView({ ...version.terms, capacityStatus: version.capacityStatus });
  const canonical = buyerTermsCanonical({
    offerId: offer.id,
    version: version.n,
    counter,
    codeShareLine: view.codeShareLine,
    origin: view.lane.origin,
    destination: view.lane.destination,
    equipment: view.equipment,
    unit: view.quantity.unit,
    quantity,
    sailingStart: view.dates.sailingStart,
    sailingEnd: view.dates.sailingEnd,
    cutoffDate: view.dates.cutoffDate,
    validityDeadline: view.dates.validityDeadline,
    currency: view.currency,
    unitBuyerMinor,
    totalMinor: quantity * unitBuyerMinor,
    serviceTerms,
    capacityStatus: view.capacityStatus,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function prepare(ctx, requestId, who) {
  const response = await post(ctx.base, who.cookie, `/chain/requests/${requestId}/prepare`, { csrf_token: who.csrf });
  assert.equal(response.status, 303, response.location);
  return response;
}

async function signPage(ctx, who, privateKey, requestId, mutate) {
  const page = await get(ctx.base, who.cookie, `/chain/requests/${requestId}`);
  const raw = attr(page.html, "data-typed");
  assert.notEqual(raw, "", page.html.slice(0, 400));
  const typed = JSON.parse(raw);
  if (mutate) mutate(typed);
  const signature = openKey(privateKey).signDigest(ctx.real.typed.digest(typed.primaryType, typed.message));
  const response = await post(ctx.base, who.cookie, `/chain/requests/${requestId}/sign`, {
    csrf_token: who.csrf,
    kind: inputValue(page.html, "kind"),
    deadline: inputValue(page.html, "deadline"),
    signature,
    counter: "99",
    termsCommitment: `0x${"11".repeat(32)}`,
    seq: "7",
    requestKey: `0x${"22".repeat(32)}`,
    status: "9",
  });
  return { page, typed, response };
}

function seedParties(ctx) {
  bindWallet(ctx.records, "kings", address(KEYS.seller), "confirmed", "user-owner");
  bindWallet(ctx.records, "other-co", address(KEYS.buyer), "confirmed", "user-buyer");
}

function onChainOffer(ctx, spec) {
  const offer = draft(ctx.records, "kings", spec);
  return publishOnChain(ctx.records, offer, address(KEYS.seller));
}

async function linkRequest(ctx) {
  seedParties(ctx);
  const offer = onChainOffer(ctx);
  const request = makeRequest(ctx, offer);
  await prepare(ctx, request.id, ctx.buyer);
  const signed = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
  assert.equal(signed.response.location, `/chain/requests/${request.id}?result=recorded`);
  return { offer, request };
}

function makeRequest(ctx, offer, quantity = 2) {
  const created = ctx.records.createRequest(person("other-co", "user-buyer", "Other Co"), offer.id, offer.currentVersion, quantity, TODAY);
  assert.equal(created.ok, true, created.error);
  return created.request;
}

describe("chain request reads", () => {
  it("does not write or call the chain, and 404s like the request routes", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      const page = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}`);
      assert.equal(page.status, 200);
      assert.equal(page.csp, CSP);
      assert.equal(page.html.includes(scriptHref), true);
      assert.equal(page.html.includes("Link"), true);
      const requestPage = await get(ctx.base, ctx.buyer.cookie, `/requests/${request.id}`);
      assert.match(requestPage.html, /id="chain-status"/);
      assert.equal(requestPage.html.includes("<script"), false);
      assert.equal(requestPage.csp, null);
      const market = await get(ctx.base, ctx.buyer.cookie, `/market/${offer.id}`);
      assert.equal(market.html.includes(SENTENCE), true);
      assert.equal(market.html.includes("<script"), false);

      const before = fileBytes(ctx);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(ctx.recordsPath, stamp, stamp);
      ctx.chain.calls.call = 0;
      ctx.chain.calls.receipt = 0;
      ctx.chain.calls.submit = 0;
      const again = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}`);
      const shown = await get(ctx.base, ctx.buyer.cookie, `/requests/${request.id}`);
      const detail = await get(ctx.base, ctx.seller.cookie, `/market/${offer.id}`);
      assert.equal(again.status, 200);
      assert.equal(shown.status, 200);
      assert.equal(detail.status, 200);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(fs.statSync(ctx.recordsPath).mtimeMs, stamp.getTime());
      assert.equal(ctx.chain.calls.call, 0);
      assert.equal(ctx.chain.calls.receipt, 0);
      assert.equal(ctx.chain.calls.submit, 0);
      assert.equal(again.html.includes(ctx.records.chainRequestFor(request.id).salts["0"]), false);

      const missing = await get(ctx.base, ctx.third.cookie, `/chain/requests/${request.id}`);
      const requestMissing = await get(ctx.base, ctx.third.cookie, `/requests/${request.id}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.html, requestMissing.html);
      assert.equal(missing.html, renderNotFound());
      assert.equal(missing.csp, null);
    });
  });
});

describe("linking, acceptance, status and cancellation", () => {
  it("links, accepts listed terms, and matches the off-chain terms hash", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      const order = [];
      ctx.chain.onSubmit = () => {
        const stored = ctx.records.getRequestFor("other-co", request.id);
        const action = stored.chain.actions[stored.chain.actions.length - 1];
        order.push(action.status);
      };
      await prepare(ctx, request.id, ctx.buyer);
      const linked = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(linked.response.location, `/chain/requests/${request.id}?result=recorded`);
      assert.equal(linked.typed.primaryType, "Request");
      const requestKey = ctx.records.chainRequestFor(request.id).requestKey;
      assert.equal(ctx.chain.submitted[0].args[0], requestKey);
      assert.notEqual(requestKey, `0x${"22".repeat(32)}`);
      assert.equal(order[0], "submitting");

      const proposed = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(proposed.response.location, `/chain/requests/${request.id}?result=proposed`);
      assert.equal(ctx.chain.calls.submit, 1);
      const proposal = ctx.records.getRequestFor("other-co", request.id).chain.proposals["0"];
      const listed = independentHash(offer, null, request.quantity, offer.versions[0].terms.buyerMinor, offer.versions[0].terms.serviceTerms);
      assert.equal(proposal.termsHash, listed);

      const accepted = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.equal(accepted.response.location, `/chain/requests/${request.id}?result=recorded`, accepted.response.location);
      assert.equal(ctx.chain.submitted[1].fn, "recordAcceptance");
      assert.equal(ctx.chain.submitted[1].args[1], 0);
      assert.notEqual(ctx.chain.submitted[1].args[2], `0x${"11".repeat(32)}`);
      const stored = ctx.records.getRequestFor("kings", request.id);
      assert.equal(stored.state, "accepted");
      assert.equal(stored.acceptance.termsHash, listed);
      assert.equal(stored.acceptance.termsHash, proposal.termsHash);
      assert.equal(stored.chain.confirmed.status, "accepted");
      assert.equal(stored.chain.confirmed.acceptedCounter, null);
      assert.equal(order[1], "submitting");
      assert.equal(JSON.stringify(ctx.records.chainRequestFor(request.id)).includes(proposal.signature), false);
    });
  });

  it("accepts a counter only after the seller proposes it", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      const early = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(early.response.location, `/chain/requests/${request.id}?result=proposed`);
      const countered = ctx.records.counterRequest(person("kings", "user-owner", "Kings"), request.id, {
        quantity: 3,
        unitBuyerMinor: 4000,
        serviceTerms: "door",
      }, TODAY);
      assert.equal(countered.ok, true);
      const before = fileBytes(ctx);
      const submits = ctx.chain.calls.submit;
      const stale = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.buyer.csrf,
        kind: "accept",
        deadline: "1893456000",
        signature: "0x" + "ab".repeat(65),
      });
      assert.equal(stale.status, 303);
      assert.match(stale.location, /result=/);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(ctx.chain.calls.submit, submits);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "countered");

      await prepare(ctx, request.id, ctx.seller);
      const wrong = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.buyer.csrf,
        kind: "proposal",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "12".repeat(65),
      });
      assert.equal(wrong.location, `/chain/requests/${request.id}?result=not_signer`);
      const proposed = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.equal(proposed.response.location, `/chain/requests/${request.id}?result=proposed`);
      const counterHash = independentHash(ctx.records.getCompanyOffer("kings", offer.id), 1, 3, 4000, "door");
      assert.equal(ctx.records.getRequestFor("kings", request.id).chain.proposals["1"].termsHash, counterHash);
      const accepted = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(accepted.response.location, `/chain/requests/${request.id}?result=recorded`);
      const stored = ctx.records.getRequestFor("other-co", request.id);
      assert.equal(stored.acceptance.counter, 1);
      assert.equal(stored.acceptance.termsHash, counterHash);
      assert.equal(ctx.chain.submitted.at(-1).args[1], 1);
      assert.equal(stored.chain.confirmed.acceptedCounter, 1);
    });
  });

  it("records statuses in order, then a two-signature cancellation ahead of unsigned statuses", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      ctx.records.recordCarrierStatus(person("kings", "user-owner", "Kings"), request.id, "carrier_pending", "hold");
      const first = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(first.typed.message.status, 3);
      assert.equal(first.typed.message.seq, 0);
      assert.equal(first.response.location, `/chain/requests/${request.id}?result=recorded`);
      assert.equal(ctx.chain.submitted.at(-1).args[1], 3);
      assert.equal(ctx.chain.submitted.at(-1).args[2], 0);
      ctx.records.recordCarrierStatus(person("other-co", "user-buyer", "Other Co"), request.id, "carrier_confirmed", "");
      const second = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.equal(second.typed.message.status, 4);
      assert.equal(second.typed.message.seq, 1);
      assert.equal(second.response.location, `/chain/requests/${request.id}?result=recorded`);

      const other = makeRequest(ctx, offer, 1);
      await prepare(ctx, other.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, other.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, other.id);
      await signPage(ctx, ctx.seller, KEYS.seller, other.id);
      ctx.records.recordCarrierStatus(person("kings", "user-owner", "Kings"), other.id, "carrier_pending", "later");
      ctx.records.proposeCancellation(person("kings", "user-owner", "Kings"), other.id, "weather");
      ctx.records.agreeCancellation(person("other-co", "user-buyer", "Other Co"), other.id);
      const page = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${other.id}`);
      assert.equal(inputValue(page.html, "kind"), "cancellation");
      assert.equal(page.html.includes("Sign status"), false);
      const firstCancel = await signPage(ctx, ctx.buyer, KEYS.buyer, other.id);
      assert.equal(firstCancel.response.location, `/chain/requests/${other.id}?result=proposed`);
      assert.equal(ctx.chain.submitted.filter((item) => item.fn === "recordCancellation").length, 0);
      const waiting = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${other.id}`);
      assert.match(waiting.html, /Waiting for the other company/);
      const secondCancel = await signPage(ctx, ctx.seller, KEYS.seller, other.id);
      assert.equal(secondCancel.response.location, `/chain/requests/${other.id}?result=recorded`);
      assert.equal(ctx.chain.submitted.at(-1).fn, "recordCancellation");
      assert.equal(ctx.records.getRequestFor("kings", other.id).chain.confirmed.cancelled, true);
      assert.equal(ctx.records.getRequestFor("kings", other.id).chain.confirmed.statusSeq, 0);
    });
  });
});

describe("refusals before a write or a send", () => {
  async function linked(ctx) {
    seedParties(ctx);
    const offer = onChainOffer(ctx);
    const request = makeRequest(ctx, offer);
    await prepare(ctx, request.id, ctx.buyer);
    const signed = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
    assert.equal(signed.response.location, `/chain/requests/${request.id}?result=recorded`);
    return { offer, request };
  }

  it("refuses the wrong wallets and a tampered message", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      bindWallet(ctx.records, "third-co", address(KEYS.third), "confirmed", "user-third");
      bindWallet(ctx.records, "other-co", address(KEYS.registrar), "pending", "user-buyer");
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      const cases = [
        ["seller request", ctx.seller, KEYS.seller, "request"],
        ["third company", ctx.buyer, KEYS.third, "request"],
        ["pending", ctx.buyer, KEYS.registrar, "request"],
        ["unbound", ctx.buyer, KEYS.unbound, "request"],
        ["relayer", ctx.buyer, KEYS.relayer, "request"],
      ];
      for (const [label, who, key, kind] of cases) {
        const before = fileBytes(ctx);
        const submits = ctx.chain.calls.submit;
        const page = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}`);
        const typed = JSON.parse(attr(page.html, "data-typed"));
        const response = await post(ctx.base, who.cookie, `/chain/requests/${request.id}/sign`, {
          csrf_token: who.csrf,
          kind,
          deadline: inputValue(page.html, "deadline"),
          signature: openKey(key).signDigest(ctx.real.typed.digest(typed.primaryType, typed.message)),
        });
        assert.equal(response.status, 303, label);
        assert.match(response.location, /result=(not_signer|not_next)/, `${label} ${response.location}`);
        assert.equal(fileBytes(ctx).equals(before), true, label);
        assert.equal(ctx.chain.calls.submit, submits, label);
      }
      const before = fileBytes(ctx);
      const tampered = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id, (typed) => {
        typed.message.version = 9;
      });
      assert.match(tampered.response.location, /result=not_signer/);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(ctx.chain.calls.submit, 0);
    });
  });

  it("refuses same-company, wrong proposer, missing, expired and mismatched terms", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      bindWallet(ctx.records, "other-co", address(KEYS.buyer2), "confirmed", "user-buyer");
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      const sellerProposal = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "proposal",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "11".repeat(65),
      });
      assert.match(sellerProposal.location, /result=not_signer/);
      const proposed = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.match(proposed.response.location, /result=proposed/);
      const page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}`);
      const typed = JSON.parse(attr(page.html, "data-typed"));
      const before = fileBytes(ctx);
      const same = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: inputValue(page.html, "deadline"),
        signature: openKey(KEYS.buyer2).signDigest(ctx.real.typed.digest(typed.primaryType, typed.message)),
      });
      assert.match(same.location, /result=not_signer/);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(ctx.chain.calls.submit, 1);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");

      const tampered = await signPage(ctx, ctx.seller, KEYS.seller, request.id, (message) => {
        message.message.counter = 4;
      });
      assert.match(tampered.response.location, /result=not_signer/);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
      assert.equal(ctx.chain.calls.submit, 1);

      ctx.records.transact((data) => {
        data.requests[request.id].chain.proposals["0"].termsHash = "ab".repeat(32);
      });
      const mismatch = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.match(mismatch.response.location, /result=(terms|mismatch)/);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
      assert.equal(ctx.chain.calls.submit, 1);

      ctx.records.transact((data) => {
        delete data.requests[request.id].chain.proposals["0"];
      });
      const missing = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "22".repeat(65),
      });
      assert.match(missing.location, /result=expired_proposal/);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
    });
  });

  it("leaves the request untouched when acceptance is pre-checked", async () => {
    await withApp(async (ctx) => {
      const { offer, request } = await linked(ctx);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      async function refused(mutate, result) {
        const before = fileBytes(ctx);
        const submits = ctx.chain.calls.submit;
        if (mutate) mutate();
        const response = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, {
          csrf_token: ctx.seller.csrf,
          kind: "accept",
          deadline: String(Math.floor(ctx.clock.now / 1000) + 86400 * 10),
          signature: "0x" + "33".repeat(65),
        });
        assert.match(response.location, new RegExp(`result=${result}`), response.location);
        assert.equal(fileBytes(ctx).equals(before), true);
        assert.equal(ctx.chain.calls.submit, submits);
        assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
      }
      ctx.records.transact((data) => {
        data.requests[request.id].chain.proposals["0"].deadline = Math.floor(ctx.clock.now / 1000) - 5;
      });
      await refused(null, "expired_proposal");
      ctx.records.transact((data) => {
        data.requests[request.id].chain.proposals["0"].deadline = Math.floor(ctx.clock.now / 1000) + 86400;
        data.offers[offer.id].chain.confirmed.state = "paused";
      });
      await refused(null, "paused");
      ctx.records.transact((data) => {
        data.offers[offer.id].chain.confirmed.state = "published";
        data.offers[offer.id].chain.confirmed.version = 2;
      });
      await refused(null, "blocked");
      const page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}`);
      assert.match(page.html, /This acceptance cannot be recorded/);
      ctx.records.transact((data) => {
        data.offers[offer.id].chain.confirmed.version = 1;
        data.requests[request.id].chain.confirmed.recorded = false;
      });
      await refused(null, "unlinked");
    });
  });
});

describe("acceptance retry and the accept gate", () => {
  it("retries a refused acceptance on chain and stops on a stale version", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      ctx.chain.next = { state: "refused", error: { name: "OfferNotPublished" } };
      const failed = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.match(failed.response.location, /result=refused/);
      assert.match(failed.response.location, /code=OfferNotPublished/);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "accepted");
      let page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}`);
      assert.match(page.html, /Record acceptance/);
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const again = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.equal(again.response.location, `/chain/requests/${request.id}?result=recorded`);
      assert.equal(ctx.chain.submitted.at(-1).fn, "recordAcceptance");
      assert.equal(ctx.records.getRequestFor("kings", request.id).chain.confirmed.status, "accepted");

      const second = makeRequest(ctx, offer, 1);
      await prepare(ctx, second.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, second.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, second.id);
      ctx.chain.next = { state: "reverted", hash: HASH };
      await signPage(ctx, ctx.seller, KEYS.seller, second.id);
      ctx.clock.now += 15 * 24 * 60 * 60 * 1000;
      const resign = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${second.id}`);
      assert.equal(inputValue(resign.html, "kind"), "proposal");
      ctx.chain.next = { state: "confirmed", hash: HASH };
      await signPage(ctx, ctx.buyer, KEYS.buyer, second.id);
      const recorded = await signPage(ctx, ctx.seller, KEYS.seller, second.id);
      assert.equal(recorded.response.location, `/chain/requests/${second.id}?result=recorded`);

      const third = makeRequest(ctx, offer, 1);
      await prepare(ctx, third.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, third.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, third.id);
      ctx.chain.next = { state: "pending", hash: HASH };
      await signPage(ctx, ctx.seller, KEYS.seller, third.id);
      ctx.clock.now += 15 * 24 * 60 * 60 * 1000;
      const expired = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${third.id}/check`, { csrf_token: ctx.seller.csrf });
      assert.match(expired.location, /result=expired/);
      ctx.records.transact((data) => {
        data.offers[offer.id].chain.confirmed.version = 9;
      });
      page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${third.id}`);
      assert.match(page.html, /This acceptance cannot be recorded/);
      const submits = ctx.chain.calls.submit;
      const blocked = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${third.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "44".repeat(65),
      });
      assert.match(blocked.location, /result=blocked/);
      assert.equal(ctx.chain.calls.submit, submits);
    });
  });

  it("sends one acceptance when two accepts race, and still enforces quantity", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx, terms({ quantity: 1 }));
      const request = makeRequest(ctx, offer, 1);
      await prepare(ctx, request.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      let release;
      ctx.chain.hold = new Promise((resolve) => {
        release = resolve;
      });
      const page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}`);
      const typed = JSON.parse(attr(page.html, "data-typed"));
      const fields = {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: inputValue(page.html, "deadline"),
        signature: openKey(KEYS.seller).signDigest(ctx.real.typed.digest(typed.primaryType, typed.message)),
      };
      const first = post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, fields);
      const second = post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, fields);
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      const [left, right] = await Promise.all([first, second]);
      const locations = [left.location, right.location].sort();
      assert.equal(locations.filter((item) => item && item.includes("result=recorded")).length, 1);
      assert.equal(ctx.chain.submitted.filter((item) => item.fn === "recordAcceptance").length, 1);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "accepted");

      const rivalOffer = onChainOffer(ctx, terms({ quantity: 1 }));
      const one = makeRequest(ctx, rivalOffer, 1);
      bindWallet(ctx.records, "third-co", address(KEYS.third), "confirmed", "user-third");
      const two = ctx.records.createRequest(person("third-co", "user-third", "Third Co"), rivalOffer.id, 1, 1, TODAY);
      assert.equal(two.ok, true);
      for (const item of [one, two.request]) {
        const who = item.buyerCompanyId === "other-co" ? ctx.buyer : ctx.third;
        const key = item.buyerCompanyId === "other-co" ? KEYS.buyer : KEYS.third;
        await prepare(ctx, item.id, who);
        await signPage(ctx, who, key, item.id);
        await signPage(ctx, who, key, item.id);
      }
      ctx.chain.hold = null;
      const sellerPageA = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${one.id}`);
      const sellerPageB = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${two.request.id}`);
      async function accept(item, html) {
        const message = JSON.parse(attr(html, "data-typed"));
        return post(ctx.base, ctx.seller.cookie, `/chain/requests/${item.id}/sign`, {
          csrf_token: ctx.seller.csrf,
          kind: "accept",
          deadline: inputValue(html, "deadline"),
          signature: openKey(KEYS.seller).signDigest(ctx.real.typed.digest(message.primaryType, message.message)),
        });
      }
      const raced = await Promise.all([
        accept(one, sellerPageA.html),
        accept(two.request, sellerPageB.html),
      ]);
      const states = [one.id, two.request.id].map((id) => ctx.records.getRequestFor("kings", id).state).sort();
      assert.deepEqual(states, ["accepted", "pending"]);
      assert.equal(raced.filter((item) => item.location && item.location.includes("unavailable_qty")).length, 1);
    });
  });

  it("gates accept on an on-chain offer and leaves an off-chain offer alone", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      const before = fileBytes(ctx);
      const gated = await post(ctx.base, ctx.seller.cookie, `/requests/${request.id}/accept`, { csrf_token: ctx.seller.csrf });
      assert.equal(gated.status, 303);
      assert.equal(gated.location, `/chain/requests/${request.id}`);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
      const shown = await get(ctx.base, ctx.seller.cookie, `/requests/${request.id}`);
      assert.equal(shown.html.includes('action="/requests/'), true);
      assert.equal(/action="\/requests\/[^"]+\/accept"/.test(shown.html), false);

      const plain = draft(ctx.records, "kings");
      ctx.records.setOfferState("kings", plain.id, "published", "user-owner", TODAY);
      const off = ctx.records.createRequest(person("other-co", "user-buyer", "Other Co"), plain.id, 1, 1, TODAY);
      const accepted = await post(ctx.base, ctx.seller.cookie, `/requests/${off.request.id}/accept`, { csrf_token: ctx.seller.csrf });
      assert.equal(accepted.status, 302);
      assert.equal(ctx.records.getRequestFor("kings", off.request.id).state, "accepted");

      ctx.chain.mode = "degraded";
      const declined = await post(ctx.base, ctx.seller.cookie, `/requests/${request.id}/decline`, { csrf_token: ctx.seller.csrf });
      assert.equal(declined.status, 302);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "declined");
      const blocked = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.buyer.csrf,
        kind: "request",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "55".repeat(65),
      });
      assert.match(blocked.location, /result=unavailable/);
      assert.equal(ctx.chain.calls.submit, 0);
    });
  });

  it("expires an in-flight action so it cannot stay open", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      ctx.chain.next = { state: "pending", hash: HASH };
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.equal(ctx.records.chainRequestFor(request.id).actions[0].status, "pending");
      ctx.chain.receiptState = { state: "confirmed" };
      const checked = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.buyer.csrf });
      assert.match(checked.location, /result=recorded/);
      assert.equal(ctx.records.chainRequestFor(request.id).confirmed.recorded, true);

      const other = makeRequest(ctx, offer, 1);
      await prepare(ctx, other.id, ctx.buyer);
      ctx.chain.next = { state: "pending", hash: null };
      ctx.chain.receiptState = { state: "pending" };
      await signPage(ctx, ctx.buyer, KEYS.buyer, other.id);
      ctx.clock.now += 20 * 60 * 1000;
      const expired = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${other.id}/check`, { csrf_token: ctx.buyer.csrf });
      assert.match(expired.location, /result=expired/);
      assert.equal(ctx.records.chainRequestFor(other.id).actions[0].status, "expired");
    });
  });

  it("expires a lost acceptance without waiting out its proposal deadline", async () => {
    await withApp(async (ctx) => {
      const { request } = await linkRequest(ctx);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      ctx.chain.fail = true;
      const lost = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.match(lost.response.location, /result=pending/);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "accepted");
      const action = ctx.records.chainRequestFor(request.id).actions.find((entry) => entry.kind === "acceptance");
      assert.equal(action.status, "submitting");
      assert.equal(action.txHash, null);
      assert.ok(action.deadline > Math.floor(ctx.clock.now / 1000) + 24 * 60 * 60);
      ctx.records.transact((data) => {
        const row = data.requests[request.id].chain.actions.find((entry) => entry.kind === "acceptance");
        row.createdAt = new Date(ctx.clock.now).toISOString();
      });
      const early = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.seller.csrf });
      assert.match(early.location, /result=unchanged/);
      ctx.clock.now += 3 * 60 * 1000;
      const expired = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.seller.csrf });
      assert.match(expired.location, /result=expired/);
      assert.equal(ctx.records.chainRequestFor(request.id).actions.find((entry) => entry.kind === "acceptance").status, "expired");
      ctx.chain.fail = false;
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const again = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
      assert.match(again.response.location, /result=recorded/);
      assert.equal(ctx.records.chainRequestFor(request.id).confirmed.status, "accepted");
    });
  });

  it("confirms a lost acceptance once the chain shows it, without a new signature", async () => {
    await withApp(async (ctx) => {
      async function loseAcceptance(request) {
        await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
        ctx.chain.fail = true;
        const lost = await signPage(ctx, ctx.seller, KEYS.seller, request.id);
        assert.match(lost.response.location, /result=pending/);
        ctx.records.transact((data) => {
          const row = data.requests[request.id].chain.actions.find((entry) => entry.kind === "acceptance");
          row.createdAt = new Date(ctx.clock.now).toISOString();
        });
        ctx.clock.now += 3 * 60 * 1000;
        const expired = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.seller.csrf });
        assert.match(expired.location, /result=expired/);
        ctx.chain.fail = false;
        const stored = ctx.records.getRequestFor("kings", request.id);
        const chain = ctx.records.chainRequestFor(request.id);
        ctx.chain.requestOnChain = [ZERO, ZERO, 1, 0, 2, commitmentFromTermsHash(stored.acceptance.termsHash, chain.salts["0"])];
      }

      const { request, offer } = await linkRequest(ctx);
      await loseAcceptance(request);
      const submits = ctx.chain.calls.submit;
      const checked = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.seller.csrf });
      assert.match(checked.location, /result=recorded/);
      assert.equal(ctx.chain.calls.submit, submits);
      assert.equal(ctx.records.chainRequestFor(request.id).confirmed.status, "accepted");
      assert.equal(ctx.records.chainRequestFor(request.id).actions.find((entry) => entry.kind === "acceptance").status, "confirmed");

      const second = makeRequest(ctx, offer, 1);
      await prepare(ctx, second.id, ctx.buyer);
      await signPage(ctx, ctx.buyer, KEYS.buyer, second.id);
      await loseAcceptance(second);
      const beforeRetry = ctx.chain.calls.submit;
      const retried = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${second.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "77".repeat(65),
      });
      assert.match(retried.location, /result=recorded/);
      assert.equal(ctx.chain.calls.submit, beforeRetry);
      assert.equal(ctx.records.chainRequestFor(second.id).confirmed.status, "accepted");
    });
  });

  it("stores the next signature after a retried action is already confirmed", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      await prepare(ctx, request.id, ctx.buyer);
      ctx.chain.fail = true;
      const lost = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.match(lost.response.location, /result=pending/);
      ctx.records.transact((data) => {
        const row = data.requests[request.id].chain.actions.find((entry) => entry.kind === "request");
        row.createdAt = new Date(ctx.clock.now).toISOString();
      });
      ctx.clock.now += 3 * 60 * 1000;
      const expired = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.buyer.csrf });
      assert.match(expired.location, /result=expired/);
      ctx.chain.fail = false;
      ctx.chain.next = { state: "confirmed", hash: HASH };
      const linked = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.match(linked.response.location, /result=recorded/);
      ctx.chain.requestOnChain = [
        ctx.records.chainOfferFor(offer.id).offerKey,
        ctx.records.companyKeyFor("other-co"),
        1,
        0,
        1,
        ZERO,
      ];
      const proposed = await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      assert.match(proposed.response.location, /result=proposed/);
      assert.equal(typeof ctx.records.getRequestFor("kings", request.id).chain.proposals["0"].termsHash, "string");
      const accepted = ctx.records.acceptRequest(person("kings", "user-owner", "Kings"), request.id, TODAY);
      assert.equal(accepted.ok, true, accepted.error);

      ctx.records.transact((data) => {
        const chain = data.requests[request.id].chain;
        const expiredAcceptance = chain.actions.find((entry) => entry.kind === "acceptance");
        if (expiredAcceptance) expiredAcceptance.status = "expired";
        chain.actions.push({
          id: "status-open",
          kind: "status",
          counter: null,
          to: "carrier_pending",
          seq: 0,
          signers: [],
          deadline: Math.floor(ctx.clock.now / 1000) + 600,
          status: "submitting",
          txHash: HASH,
          error: null,
          createdAt: new Date(ctx.clock.now).toISOString(),
          updatedAt: new Date(ctx.clock.now).toISOString(),
        });
        chain.actions.push({
          id: "acceptance-late",
          kind: "acceptance",
          counter: null,
          to: null,
          seq: null,
          signers: [],
          deadline: Math.floor(ctx.clock.now / 1000) + 14 * 24 * 60 * 60,
          status: "expired",
          txHash: null,
          error: null,
          createdAt: new Date(ctx.clock.now).toISOString(),
          updatedAt: new Date(ctx.clock.now).toISOString(),
        });
      });
      const stored = ctx.records.getRequestFor("kings", request.id);
      ctx.chain.receiptState = { state: "pending" };
      ctx.chain.requestOnChain = [ZERO, ZERO, 1, 0, 2, commitmentFromTermsHash(stored.acceptance.termsHash, stored.chain.salts["0"])];
      const healed = await post(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}/check`, { csrf_token: ctx.buyer.csrf });
      assert.match(healed.location, /result=recorded/);
      const after = ctx.records.chainRequestFor(request.id);
      assert.equal(after.actions.find((entry) => entry.id === "acceptance-late").status, "confirmed");
      assert.equal(after.actions.find((entry) => entry.id === "status-open").status, "submitting");
    });
  });

  it("does not ask the seller to record a version the chain has already left", async () => {
    await withApp(async (ctx) => {
      seedParties(ctx);
      const offer = onChainOffer(ctx);
      const request = makeRequest(ctx, offer);
      ctx.records.transact((data) => {
        data.offers[offer.id].chain.confirmed.version = 2;
      });
      const stale = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}`);
      assert.match(stale.html, /This acceptance cannot be recorded/);
      assert.equal(stale.html.includes("records this version"), false);
      ctx.records.transact((data) => {
        data.offers[offer.id].chain.confirmed = { version: null, state: "published", stateSeq: 0 };
      });
      const missing = await get(ctx.base, ctx.buyer.cookie, `/chain/requests/${request.id}`);
      assert.match(missing.html, /records this version on chain/);
    });
  });

  it("does not offer acceptance while the offer is paused off chain", async () => {
    await withApp(async (ctx) => {
      const { request, offer } = await linkRequest(ctx);
      await signPage(ctx, ctx.buyer, KEYS.buyer, request.id);
      ctx.records.setOfferState("kings", offer.id, "paused", "user-owner", TODAY);
      const before = fileBytes(ctx);
      const page = await get(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}`);
      assert.match(page.html, /This offer is not published/);
      assert.equal(page.html.includes("Accept and sign"), false);
      const posted = await post(ctx.base, ctx.seller.cookie, `/chain/requests/${request.id}/sign`, {
        csrf_token: ctx.seller.csrf,
        kind: "accept",
        deadline: String(Math.floor(ctx.clock.now / 1000) + 600),
        signature: "0x" + "66".repeat(65),
      });
      assert.match(posted.location, /result=offer_closed/);
      assert.equal(fileBytes(ctx).equals(before), true);
      assert.equal(ctx.chain.calls.submit, 1);
      assert.equal(ctx.records.getRequestFor("kings", request.id).state, "pending");
    });
  });
});
