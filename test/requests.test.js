const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession, readSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { buyerView } = require("../lib/offer-domain");
const { buyerTermsCanonical, buyerTermsHash } = require("../lib/terms-hash");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const TODAY = "2026-10-01";
const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const BUYER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const THIRD = { companyId: "third-co", sub: "user-third", companyName: "Third Co" };
const MARKUP = "<img src=x onerror=alert(1)>";

const REQUEST_KEYS = [
  "acceptance", "buyerCompanyId", "buyerCompanyName", "buyerSub", "counters", "createdAt", "fulfilment", "history",
  "id", "offerId", "quantity", "sellerCompanyId", "sellerCompanyName", "state", "version",
];
const ACCEPTANCE_KEYS = [
  "at", "buyerCompanyId", "buyerSub", "by", "counter", "currency", "offerId",
  "quantity", "sellerCompanyId", "sellerSub", "termsHash", "termsVersion",
  "totalMinor", "unitBuyerMinor", "version",
];
const COUNTER_KEYS = ["at", "by", "n", "quantity", "serviceTerms", "unitBuyerMinor"];
const HISTORY_KEYS = ["actor", "at", "counter", "from", "to"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-requests-"));
}

function fileText(file) {
  return fs.readFileSync(file, "utf8");
}

function manualTerms(extra = {}) {
  return {
    source: "manual",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 10,
    unit: "container",
    sailingStart: "2026-12-20",
    sailingEnd: "2026-12-20",
    validityDeadline: "2099-12-31",
    currency: "USD",
    baseMinor: 2000,
    markup: { type: "absolute", minor: 0 },
    buyerMinor: 2000,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function withRecords(run) {
  const dir = tempDir();
  const file = path.join(dir, "records.json");
  try {
    run(openRecords(file), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function publish(records, terms = manualTerms(), seller = SELLER, extras = {}) {
  const created = records.createOffer(seller, {
    source: terms.source,
    terms,
    snapshot: extras.snapshot == null ? null : extras.snapshot,
    sourceRecordId: extras.sourceRecordId == null ? null : extras.sourceRecordId,
    overriddenFields: [],
  });
  const published = records.setOfferState(seller.companyId, created.id, "published", seller.sub, TODAY);
  assert.equal(published.ok, true);
  return published.offer;
}

function editName(records, offer, terms, name) {
  const edited = records.editOffer(offer.companyId, offer.id, {
    terms: { ...terms, codeShareName: name },
    overriddenFields: [],
  }, SELLER.sub, TODAY);
  assert.equal(edited.ok, true);
  return edited.offer;
}

function refused(records, file, run) {
  const before = fileText(file);
  const result = run();
  assert.equal(result.ok, false);
  assert.equal(fileText(file), before);
  return result;
}

function canonicalFrom(offer, acceptance, serviceTerms) {
  const version = offer.versions.find((item) => item.n === acceptance.version);
  const view = buyerView({ ...version.terms, capacityStatus: version.capacityStatus });
  return {
    offerId: offer.id,
    version: acceptance.version,
    counter: acceptance.counter,
    codeShareLine: view.codeShareLine,
    origin: view.lane.origin,
    destination: view.lane.destination,
    equipment: view.equipment,
    unit: view.quantity.unit,
    quantity: acceptance.quantity,
    sailingStart: view.dates.sailingStart,
    sailingEnd: view.dates.sailingEnd,
    cutoffDate: view.dates.cutoffDate,
    validityDeadline: view.dates.validityDeadline,
    currency: view.currency,
    unitBuyerMinor: acceptance.unitBuyerMinor,
    totalMinor: acceptance.totalMinor,
    serviceTerms,
    capacityStatus: view.capacityStatus,
  };
}

describe("buyer terms hash", () => {
  it("hashes only buyer-visible terms and ignores key order and private fields", () => {
    withRecords((records) => {
      const terms = manualTerms({
        source: "rn_rate",
        quantity: 4,
        baseMinor: 864201357,
        markup: { type: "absolute", minor: 97531 },
        buyerMinor: 864298888,
        serviceTerms: "Visible terms",
      });
      const seller = { companyId: "CANARY-CO-q7w", sub: "CANARY-SUB-q7w", companyName: "Canary" };
      const offer = publish(records, terms, seller, {
        snapshot: { dto: { notes: "NOTESCANARY-q7w" }, baseAmount: 1 },
        sourceRecordId: "rateSECRETID77",
      });
      const created = records.createRequest(BUYER, offer.id, 1, 4, TODAY);
      assert.equal(created.ok, true);
      const accepted = records.acceptRequest(seller, created.request.id, TODAY);
      assert.equal(accepted.ok, true);
      const acceptance = accepted.request.acceptance;
      const fields = canonicalFrom(offer, acceptance, "Visible terms");
      const canonical = buyerTermsCanonical(fields);
      assert.equal(acceptance.termsHash, buyerTermsHash(canonical));
      assert.equal(canonical.startsWith('{"v":1,'), true);
      for (const secret of ["864201357", "97531", "NOTESCANARY-q7w", "rateSECRETID77", "CANARY-SUB-q7w", "CANARY-CO-q7w", "baseMinor", "markup", "Canary", "Other Co", "buyerCompanyName", "sellerCompanyName"]) {
        assert.equal(canonical.includes(secret), false, secret);
      }
      const reversed = {};
      for (const key of Object.keys(fields).reverse()) reversed[key] = fields[key];
      reversed.baseMinor = 864201357;
      reversed.markup = { type: "absolute", minor: 97531 };
      reversed.snapshot = { dto: { notes: "NOTESCANARY-q7w" } };
      reversed.companyId = "CANARY-CO-q7w";
      reversed.sub = "CANARY-SUB-q7w";
      reversed.sourceRecordId = "rateSECRETID77";
      assert.equal(buyerTermsCanonical(reversed), canonical);
      assert.equal(buyerTermsHash(buyerTermsCanonical(reversed)), acceptance.termsHash);

      const stored = acceptance.termsHash;
      records.transact((data) => {
        data.offers[offer.id].versions[0].terms.baseMinor = 1;
        data.offers[offer.id].versions[0].terms.serviceTerms = "rewritten";
      });
      assert.equal(records.getRequestFor(BUYER.companyId, created.request.id).acceptance.termsHash, stored);
    });
  });
});

describe("request records", () => {
  it("refuses create on the seller's own offer, a draft, a pause, an expiry, a stale version, and a bad quantity", () => {
    withRecords((records, file) => {
      const draft = records.createOffer(SELLER, {
        source: "manual",
        terms: manualTerms(),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      assert.equal(refused(records, file, () => records.createRequest(BUYER, draft.id, 1, 1, TODAY)).error, "draft");
      const published = publish(records, manualTerms());
      assert.equal(refused(records, file, () => records.createRequest(SELLER, published.id, 1, 1, TODAY)).error, "own_offer");
      records.setOfferState(SELLER.companyId, published.id, "paused", SELLER.sub, TODAY);
      assert.equal(refused(records, file, () => records.createRequest(BUYER, published.id, 1, 1, TODAY)).error, "paused");
      records.setOfferState(SELLER.companyId, published.id, "published", SELLER.sub, TODAY);

      const expired = publish(records, manualTerms({ validityDeadline: "2026-10-01" }));
      assert.equal(refused(records, file, () => records.createRequest(BUYER, expired.id, 1, 1, "2026-10-02")).error, "expired");

      const live = publish(records);
      const v2 = editName(records, live, manualTerms(), "Second");
      assert.equal(v2.currentVersion, 2);
      assert.equal(refused(records, file, () => records.createRequest(BUYER, live.id, 1, 1, TODAY)).error, "stale_version");
      for (const quantity of [0, -1, 1.5, 11]) {
        assert.equal(
          refused(records, file, () => records.createRequest(BUYER, live.id, 2, quantity, TODAY)).error,
          quantity === 11 ? "unavailable" : "bad_quantity",
        );
      }
      assert.equal(Object.keys(JSON.parse(fileText(file)).requests).length, 0);
    });
  });

  it("walks each legal transition once and keeps a final state final", () => {
    withRecords((records, file) => {
      const offer = publish(records, manualTerms({ buyerMinor: 2000, baseMinor: 2000 }));
      const pending = records.createRequest(BUYER, offer.id, 1, 4, TODAY);
      assert.equal(pending.ok, true);
      assert.deepEqual(Object.keys(pending.request).sort(), REQUEST_KEYS);
      assert.equal(pending.request.acceptance, null);
      assert.equal(pending.request.buyerCompanyName, BUYER.companyName);
      assert.equal(pending.request.sellerCompanyName, null);
      assert.equal(pending.request.state, "pending");
      assert.deepEqual(Object.keys(pending.request.history[0]).sort(), HISTORY_KEYS);

      const accepted = records.acceptRequest(SELLER, pending.request.id, TODAY);
      assert.equal(accepted.ok, true);
      const acceptance = accepted.request.acceptance;
      assert.deepEqual(Object.keys(acceptance).sort(), ACCEPTANCE_KEYS);
      assert.equal(acceptance.quantity, 4);
      assert.equal(acceptance.unitBuyerMinor, 2000);
      assert.equal(acceptance.totalMinor, 8000);
      assert.equal(acceptance.currency, "USD");
      assert.equal(acceptance.version, 1);
      assert.equal(acceptance.counter, null);
      assert.equal(acceptance.by, SELLER.sub);
      assert.equal(acceptance.sellerSub, SELLER.sub);
      assert.equal(acceptance.buyerSub, BUYER.sub);
      assert.equal(acceptance.sellerCompanyId, SELLER.companyId);
      assert.equal(acceptance.buyerCompanyId, BUYER.companyId);
      assert.equal(accepted.request.sellerCompanyName, SELLER.companyName);
      assert.equal(accepted.request.buyerCompanyName, BUYER.companyName);
      assert.equal(acceptance.offerId, offer.id);
      assert.equal(acceptance.termsVersion, 1);
      assert.equal(acceptance.at, accepted.request.history.at(-1).at);
      assert.equal(records.availableQuantity(offer), 6);
      assert.equal(refused(records, file, () => records.acceptRequest(SELLER, pending.request.id, TODAY)).error, "final");
      assert.equal(refused(records, file, () => records.declineRequest(SELLER, pending.request.id)).error, "final");
      assert.deepEqual(records.getRequestFor(SELLER.companyId, pending.request.id).acceptance, acceptance);

      const declinedOffer = publish(records);
      const toDecline = records.createRequest(BUYER, declinedOffer.id, 1, 1, TODAY).request;
      assert.equal(records.declineRequest(SELLER, toDecline.id).ok, true);
      assert.equal(records.getRequestFor(BUYER.companyId, toDecline.id).state, "declined");
      assert.equal(refused(records, file, () => records.declineRequest(SELLER, toDecline.id)).error, "final");

      const counteredOffer = publish(records);
      const toCounter = records.createRequest(BUYER, counteredOffer.id, 1, 2, TODAY).request;
      const countered = records.counterRequest(SELLER, toCounter.id, {
        quantity: 3,
        unitBuyerMinor: 1500,
        serviceTerms: "Counter service only",
      }, TODAY);
      assert.equal(countered.ok, true);
      assert.equal(countered.request.state, "countered");
      assert.deepEqual(Object.keys(countered.request.counters[0]).sort(), COUNTER_KEYS);
      assert.equal(countered.request.counters[0].n, 1);
      assert.equal(countered.request.sellerCompanyName, SELLER.companyName);
      assert.equal(countered.request.buyerCompanyName, BUYER.companyName);
      const buyerAccepted = records.acceptRequest(BUYER, toCounter.id, TODAY);
      assert.equal(buyerAccepted.ok, true);
      assert.equal(buyerAccepted.request.acceptance.quantity, 3);
      assert.equal(buyerAccepted.request.acceptance.unitBuyerMinor, 1500);
      assert.equal(buyerAccepted.request.acceptance.totalMinor, 4500);
      assert.equal(buyerAccepted.request.acceptance.counter, 1);
      assert.equal(buyerAccepted.request.acceptance.by, BUYER.sub);
      assert.equal(buyerAccepted.request.acceptance.sellerSub, SELLER.sub);
      const counterFields = canonicalFrom(
        records.getCompanyOffer(SELLER.companyId, counteredOffer.id),
        buyerAccepted.request.acceptance,
        "Counter service only",
      );
      assert.equal(buyerAccepted.request.acceptance.termsHash, buyerTermsHash(buyerTermsCanonical(counterFields)));
      const offerTerms = canonicalFrom(
        records.getCompanyOffer(SELLER.companyId, counteredOffer.id),
        buyerAccepted.request.acceptance,
        "CY/CY",
      );
      assert.notEqual(buyerTermsHash(buyerTermsCanonical(offerTerms)), buyerAccepted.request.acceptance.termsHash);

      const buyerDeclines = publish(records);
      const counteredDecline = records.createRequest(BUYER, buyerDeclines.id, 1, 1, TODAY).request;
      records.counterRequest(SELLER, counteredDecline.id, {
        quantity: 1,
        unitBuyerMinor: 100,
        serviceTerms: "No",
      }, TODAY);
      assert.equal(records.declineRequest(BUYER, counteredDecline.id).ok, true);
      assert.equal(records.getRequestFor(SELLER.companyId, counteredDecline.id).state, "declined");
      assert.equal(records.getRequestFor(SELLER.companyId, counteredDecline.id).acceptance, null);

      const withdrawPending = records.createRequest(BUYER, publish(records).id, 1, 1, TODAY).request;
      assert.equal(records.withdrawRequest(BUYER, withdrawPending.id).ok, true);
      assert.equal(records.getRequestFor(BUYER.companyId, withdrawPending.id).state, "withdrawn");

      const withdrawCounter = records.createRequest(BUYER, publish(records).id, 1, 1, TODAY).request;
      records.counterRequest(SELLER, withdrawCounter.id, {
        quantity: 1,
        unitBuyerMinor: 100,
        serviceTerms: "Later",
      }, TODAY);
      assert.equal(records.withdrawRequest(BUYER, withdrawCounter.id).ok, true);
      assert.equal(records.getRequestFor(SELLER.companyId, withdrawCounter.id).state, "withdrawn");

      const named = records.createRequest(BUYER, publish(records).id, 1, 1, TODAY).request;
      records.transact((data) => {
        data.requests[named.id].sellerCompanyName = "Kept Name";
      });
      const kept = records.counterRequest(SELLER, named.id, {
        quantity: 1,
        unitBuyerMinor: 100,
        serviceTerms: "Stay",
      }, TODAY);
      assert.equal(kept.ok, true);
      assert.equal(kept.request.sellerCompanyName, "Kept Name");
    });
  });

  it("refuses the wrong role, a superseded version, and a second acceptance that no longer fits", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const pending = records.createRequest(BUYER, offer.id, 1, 6, TODAY).request;
      assert.equal(refused(records, file, () => records.acceptRequest(BUYER, pending.id, TODAY)).error, "forbidden");
      assert.equal(refused(records, file, () => records.withdrawRequest(SELLER, pending.id)).error, "forbidden");
      assert.equal(refused(records, file, () => records.acceptRequest(THIRD, pending.id, TODAY)).error, "not_found");
      assert.equal(records.getRequestFor(THIRD.companyId, pending.id), null);
      assert.equal(records.getRequestFor("missing", pending.id), null);

      const v2 = editName(records, offer, manualTerms(), "Second");
      const pinned = records.createRequest(BUYER, offer.id, 2, 6, TODAY).request;
      const v3 = editName(records, v2, manualTerms({ codeShareName: "Second" }), "Third");
      assert.equal(v3.currentVersion, 3);
      assert.equal(records.effectiveRequestState(pinned, v3), "superseded");
      assert.equal(refused(records, file, () => records.acceptRequest(SELLER, pinned.id, TODAY)).error, "superseded");
      assert.equal(records.getRequestFor(SELLER.companyId, pinned.id).state, "pending");
      assert.equal(records.getRequestFor(SELLER.companyId, pinned.id).acceptance, null);

      const countered = records.createRequest(BUYER, publish(records).id, 1, 6, TODAY).request;
      records.counterRequest(SELLER, countered.id, { quantity: 6, unitBuyerMinor: 100, serviceTerms: "C" }, TODAY);
      assert.equal(refused(records, file, () => records.acceptRequest(SELLER, countered.id, TODAY)).error, "forbidden");

      const sized = publish(records, manualTerms({ quantity: 10 }));
      const first = records.createRequest(BUYER, sized.id, 1, 6, TODAY).request;
      const second = records.createRequest(BUYER, sized.id, 1, 6, TODAY).request;
      records.counterRequest(SELLER, second.id, { quantity: 6, unitBuyerMinor: 100, serviceTerms: "Six" }, TODAY);
      assert.equal(records.acceptRequest(SELLER, first.id, TODAY).ok, true);
      assert.equal(refused(records, file, () => records.acceptRequest(BUYER, second.id, TODAY)).error, "unavailable");
      assert.equal(records.availableQuantity(records.getCompanyOffer(SELLER.companyId, sized.id)), 4);
      const disk = JSON.parse(fileText(file));
      const taken = Object.values(disk.requests)
        .filter((request) => request.offerId === sized.id && request.state === "accepted")
        .reduce((sum, request) => sum + request.acceptance.quantity, 0);
      assert.equal(taken, 6);

      const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
      const overflowOffer = publish(records);
      const overflow = records.createRequest(BUYER, overflowOffer.id, 1, 2, TODAY).request;
      records.counterRequest(SELLER, overflow.id, { quantity: 2, unitBuyerMinor: huge, serviceTerms: "Big" }, TODAY);
      assert.equal(refused(records, file, () => records.acceptRequest(BUYER, overflow.id, TODAY)).error, "overflow");

      records.transact((data) => {
        data.requests[first.id].createdAt = "2026-01-01T00:00:00.000Z";
        data.requests[second.id].createdAt = "2026-02-01T00:00:00.000Z";
      });
      const listed = records.listRequestsFor(BUYER.companyId).filter((request) => request.offerId === sized.id);
      assert.deepEqual(listed.map((request) => request.id), [second.id, first.id]);
      assert.equal(records.listRequestsFor(THIRD.companyId).length, 0);
    });
  });
});

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

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

async function withApp(run) {
  const dir = tempDir();
  const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const port = await mock.listen();
  const origin = `http://127.0.0.1:${port}`;
  const storePath = path.join(dir, "store.json");
  const recordsPath = path.join(dir, "records.json");
  const config = testConfig(origin);
  const store = openStore(storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const server = createServer({ config, store, records });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.redirectUri = `${base}/oauth/callback`;
  try {
    await run({ base, origin, store, records, recordsPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function connectOwner({ base, origin }) {
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
  assert.equal(callback.status, 302);
  return { cookie, csrf };
}

function seedCompany(store, sid, csrf, profile) {
  store.saveConnection(sid, {
    refreshToken: `refresh-${sid}`,
    scopes: ["profile:read", "rates:read", "sailings:read"],
    profile: {
      name: profile.companyName,
      companyType: "Contract Owner",
      active: true,
      ...profile,
    },
  });
  return { cookie: sessionCookie(sid, csrf), csrf };
}

function elementText(html, id) {
  const match = html.match(new RegExp(`id="${id}">([^<]*)`));
  return match ? match[1] : "";
}

function sidOf(cookie) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  const session = readSession(token, SESSION_SECRET);
  return session && session.sid;
}

async function pageOf(base, cookie, target) {
  const response = await fetch(new URL(target, base), { headers: { cookie }, redirect: "manual" });
  const html = await response.text();
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  return { response, html, csrf: match ? match[1] : "" };
}

async function postForm(base, cookie, target, fields) {
  return fetch(new URL(target, base), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function diskRequests(recordsPath) {
  return JSON.parse(fileText(recordsPath)).requests;
}

describe("request screens", () => {
  it("requests, counters, accepts, and refuses a second take of the same quantity", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const home = await pageOf(base, seller.cookie, "/");
      assert.match(home.html, /href="\/requests"/);

      const offer = publish(records, manualTerms({ quantity: 10, codeShareName: "Lane One" }));
      const hidden = await pageOf(base, seller.cookie, `/market/${offer.id}`);
      assert.equal(hidden.html.includes('id="request-form"'), false);
      assert.match(hidden.html, /10 of 10 containers available in OceanRelay/);
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.match(detail.html, /id="request-form"/);
      assert.match(detail.html, /Accepted in OceanRelay means a marketplace agreement\. It is not a carrier booking\./);
      assert.match(detail.html, /This quantity limit applies only inside OceanRelay\. It does not hold carrier space or stop the seller promising the same space elsewhere\./);
      const version = detail.html.match(/name="version" value="([^"]+)"/)[1];

      const requested = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version,
        quantity: "6",
      });
      assert.equal(requested.status, 302);
      const requestPath = requested.headers.get("location");
      assert.match(requestPath, /^\/requests\/[0-9a-f-]{36}$/);
      const before = fileText(recordsPath);
      const stale = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version: "1",
        quantity: "0",
      });
      assert.equal(stale.status, 400);
      assert.match(await stale.text(), /positive whole number/);
      assert.equal(fileText(recordsPath), before);

      const buyerPage = await pageOf(base, buyer.cookie, requestPath);
      assert.match(buyerPage.html, /Lane One, operated by ABC/);
      assert.match(buyerPage.html, /Pending/);
      assert.match(buyerPage.html, /Version 1/);
      assert.equal(buyerPage.html.includes("Kings"), false);
      assert.equal(buyerPage.html.includes("Other Co"), false);
      assert.equal(buyerPage.html.includes("A contract owner"), false);
      const sellerPage = await pageOf(base, seller.cookie, requestPath);
      assert.match(sellerPage.html, /A contract owner/);
      assert.equal(sellerPage.html.includes("Other Co"), false);
      assert.equal(sellerPage.html.includes("Kings"), false);

      const listed = await pageOf(base, buyer.cookie, "/requests");
      assert.match(listed.html, /Requests you made/);
      assert.match(listed.html, /Requests on your offers/);
      assert.match(listed.html, /Lane One, operated by ABC/);
      assert.match(listed.html, /Pending/);
      const sellerList = await pageOf(base, seller.cookie, "/requests");
      assert.match(sellerList.html, /id="requests-received"/);

      const preview = await pageOf(base, seller.cookie, `/offers/${offer.id}`);
      assert.match(preview.html, /Incoming requests/);
      assert.match(preview.html, /10 of 10 available/);

      const countered = await postForm(base, seller.cookie, `${requestPath}/counter`, {
        csrf_token: sellerPage.csrf,
        quantity: "6",
        unitPrice: "15.00",
        serviceTerms: "Counter service only",
      });
      assert.equal(countered.status, 302);
      const buyerCounter = await pageOf(base, buyer.cookie, requestPath);
      assert.match(buyerCounter.html, /Countered/);
      assert.match(buyerCounter.html, /Counter service only/);
      const accepted = await postForm(base, buyer.cookie, `${requestPath}/accept`, {
        csrf_token: buyerCounter.csrf,
      });
      assert.equal(accepted.status, 302);
      const done = await pageOf(base, buyer.cookie, requestPath);
      assert.match(done.html, /id="acceptance"/);
      assert.match(done.html, /15\.00 USD/);
      assert.match(done.html, /90\.00 USD/);
      assert.match(done.html, /Terms fingerprint/);
      assert.match(done.html, /Accepted in OceanRelay means a marketplace agreement\. It is not a carrier booking\./);
      assert.match(done.html, /This quantity limit applies only inside OceanRelay/);
      assert.match(done.html, /id="seller-name">Kings/);
      assert.match(done.html, /id="buyer-name">Other Co/);
      assert.equal(done.html.includes("A contract owner"), false);
      const sellerDone = await pageOf(base, seller.cookie, requestPath);
      assert.match(sellerDone.html, /id="seller-name">Kings/);
      assert.match(sellerDone.html, /id="buyer-name">Other Co/);
      const stored = Object.values(diskRequests(recordsPath))[0];
      assert.equal(stored.acceptance.totalMinor, 9000);
      assert.equal(stored.acceptance.quantity, 6);
      assert.equal(done.html.includes(stored.acceptance.termsHash.slice(0, 12)), true);

      const after = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.match(after.html, /4 of 10 containers available in OceanRelay/);
      const sellerAfter = await pageOf(base, seller.cookie, `/offers/${offer.id}`);
      assert.match(sellerAfter.html, /4 of 10 available/);

      const rest = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: after.csrf,
        version: after.html.match(/name="version" value="([^"]+)"/)[1],
        quantity: "4",
      });
      assert.equal(rest.status, 302);
      const restId = rest.headers.get("location").split("/").pop();
      const sellerRest = await pageOf(base, seller.cookie, `/requests/${restId}`);
      assert.equal((await postForm(base, seller.cookie, `/requests/${restId}/accept`, {
        csrf_token: sellerRest.csrf,
      })).status, 302);
      const empty = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.match(empty.html, /0 of 10 containers available in OceanRelay/);
      assert.equal(empty.html.includes('id="request-form"'), false);
      const beforeRefuse = fileText(recordsPath);
      const over = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: empty.csrf || after.csrf,
        version: "1",
        quantity: "1",
      });
      assert.equal(over.status, 400);
      assert.match(await over.text(), /available in OceanRelay/);
      assert.equal(fileText(recordsPath), beforeRefuse);
    });
  });

  it("accepts only one of two concurrent requests and refuses a superseded version", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const offer = publish(records, manualTerms({ quantity: 10, codeShareName: "Race Lane" }));
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      const version = detail.html.match(/name="version" value="([^"]+)"/)[1];
      const first = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version,
        quantity: "6",
      });
      const second = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version,
        quantity: "6",
      });
      assert.equal(first.status, 302);
      assert.equal(second.status, 302);
      const paths = [first.headers.get("location"), second.headers.get("location")];
      const sellerPage = await pageOf(base, seller.cookie, paths[0]);
      const [left, right] = await Promise.all(paths.map((target) => postForm(base, seller.cookie, `${target}/accept`, {
        csrf_token: sellerPage.csrf,
      })));
      const statuses = [left.status, right.status].sort();
      assert.deepEqual(statuses, [302, 400]);
      const failed = left.status === 400 ? left : right;
      assert.match(await failed.text(), /no longer available/);
      const taken = Object.values(diskRequests(recordsPath))
        .filter((request) => request.state === "accepted")
        .reduce((sum, request) => sum + request.acceptance.quantity, 0);
      assert.equal(taken, 6);

      const v2 = editName(records, offer, manualTerms({ quantity: 10, codeShareName: "Race Lane" }), "Race Two");
      assert.equal(v2.currentVersion, 2);
      const current = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.match(current.html, /Version 2/);
      const pinned = current.html.match(/name="version" value="([^"]+)"/)[1];
      const opened = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: current.csrf,
        version: pinned,
        quantity: "1",
      });
      assert.equal(opened.status, 302);
      const requestPath = opened.headers.get("location");
      editName(records, v2, manualTerms({ quantity: 10, codeShareName: "Race Two" }), "Race Three");
      const before = fileText(recordsPath);
      const sellerPinned = await pageOf(base, seller.cookie, requestPath);
      assert.match(sellerPinned.html, /This offer changed/);
      assert.match(sellerPinned.html, /Superseded/);
      const refused = await postForm(base, seller.cookie, `${requestPath}/accept`, {
        csrf_token: sellerPinned.csrf,
      });
      assert.equal(refused.status, 400);
      const html = await refused.text();
      assert.match(html, /This offer changed/);
      assert.equal(fileText(recordsPath), before);
      const stored = Object.values(diskRequests(recordsPath)).find((request) => request.version === 2);
      assert.equal(stored.state, "pending");
      assert.equal(stored.acceptance, null);

      const fresh = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      const stalePost = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: fresh.csrf,
        version: pinned,
        quantity: "1",
      });
      assert.equal(stalePost.status, 400);
      const staleHtml = await stalePost.text();
      assert.match(staleHtml, /changed since you opened it/);
      assert.match(staleHtml, /Version 3/);
      assert.equal(Object.values(diskRequests(recordsPath)).filter((request) => request.version === 3).length, 0);
    });
  });

  it("refuses the wrong role and gives a third company the same 404 as an unknown id", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const third = seedCompany(store, "sid-third", "csrf-third", THIRD);
      const offer = publish(records, manualTerms({ codeShareName: "Role Lane" }));
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      const requested = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version: detail.html.match(/name="version" value="([^"]+)"/)[1],
        quantity: "1",
      });
      const requestPath = requested.headers.get("location");
      const buyerPage = await pageOf(base, buyer.cookie, requestPath);
      const before = fileText(recordsPath);
      const buyerAccept = await postForm(base, buyer.cookie, `${requestPath}/accept`, { csrf_token: buyerPage.csrf });
      assert.equal(buyerAccept.status, 400);
      assert.match(await buyerAccept.text(), /You cannot take that action/);
      assert.equal(fileText(recordsPath), before);

      const sellerPage = await pageOf(base, seller.cookie, requestPath);
      const sellerWithdraw = await postForm(base, seller.cookie, `${requestPath}/withdraw`, { csrf_token: sellerPage.csrf });
      assert.equal(sellerWithdraw.status, 400);
      assert.equal(fileText(recordsPath), before);

      const countered = await postForm(base, seller.cookie, `${requestPath}/counter`, {
        csrf_token: sellerPage.csrf,
        quantity: "1",
        unitPrice: "10.00",
        serviceTerms: "Held",
      });
      assert.equal(countered.status, 302);
      const afterCounter = fileText(recordsPath);
      const sellerAccept = await postForm(base, seller.cookie, `${requestPath}/accept`, { csrf_token: sellerPage.csrf });
      assert.equal(sellerAccept.status, 400);
      assert.match(await sellerAccept.text(), /You cannot take that action/);
      assert.equal(fileText(recordsPath), afterCounter);
      assert.equal(Object.values(diskRequests(recordsPath))[0].state, "countered");

      const unknown = await pageOf(base, buyer.cookie, "/requests/00000000-0000-4000-8000-000000000000");
      const foreign = await pageOf(base, third.cookie, requestPath);
      assert.equal(unknown.response.status, 404);
      assert.equal(foreign.response.status, 404);
      assert.equal(foreign.html, unknown.html);
      for (const action of ["accept", "decline", "counter", "withdraw"]) {
        const response = await postForm(base, third.cookie, `${requestPath}/${action}`, {
          csrf_token: "csrf-third",
          quantity: "1",
          unitPrice: "1.00",
          serviceTerms: "nope",
        });
        assert.equal(response.status, 404);
        assert.equal(await response.text(), unknown.html);
      }
      assert.equal(fileText(recordsPath), afterCounter);

      const missing = await postForm(base, seller.cookie, `${requestPath}/decline`, {});
      assert.equal(missing.status, 403);
      assert.deepEqual(JSON.parse(await missing.text()), { error: "invalid_csrf" });
      assert.equal(fileText(recordsPath), afterCounter);

      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      await pageOf(base, seller.cookie, "/requests");
      await pageOf(base, buyer.cookie, requestPath);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
    });
  });

  it("escapes code-share names and counter service terms", async () => {
    await withApp(async ({ base, origin, store, records }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const nasty = `Share${MARKUP}`;
      const terms = `Terms${MARKUP}`;
      const offer = publish(records, manualTerms({ codeShareName: nasty, serviceTerms: terms }));
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      const requested = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version: "1",
        quantity: "1",
      });
      const requestPath = requested.headers.get("location");
      const sellerPage = await pageOf(base, seller.cookie, requestPath);
      const countered = await postForm(base, seller.cookie, `${requestPath}/counter`, {
        csrf_token: sellerPage.csrf,
        quantity: "1",
        unitPrice: "10.00",
        serviceTerms: terms,
      });
      assert.equal(countered.status, 302);
      const list = await pageOf(base, buyer.cookie, "/requests");
      const page = await pageOf(base, buyer.cookie, requestPath);
      for (const html of [list.html, page.html]) {
        assert.equal(html.includes(MARKUP), false);
        assert.equal(html.includes("<img"), false);
        assert.equal(html.includes(`Share&lt;img src=x onerror=alert(1)&gt;`), true);
      }
      assert.equal(page.html.includes(`Terms&lt;img src=x onerror=alert(1)&gt;`), true);
    });
  });

  it("refuses a draft, a paused offer, and the seller's own offer without writing a request", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const draft = records.createOffer(SELLER, {
        source: "manual",
        terms: manualTerms({ codeShareName: "Draft Lane" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const before = fileText(recordsPath);
      const draftPost = await postForm(base, buyer.cookie, `/market/${draft.id}/requests`, {
        csrf_token: "csrf-buyer",
        version: "1",
        quantity: "1",
      });
      assert.equal(draftPost.status, 404);
      const pausedOffer = publish(records, manualTerms({ codeShareName: "Paused Lane" }));
      records.setOfferState(SELLER.companyId, pausedOffer.id, "paused", SELLER.sub, TODAY);
      const pausedPost = await postForm(base, buyer.cookie, `/market/${pausedOffer.id}/requests`, {
        csrf_token: "csrf-buyer",
        version: "1",
        quantity: "1",
      });
      assert.equal(pausedPost.status, 404);
      const own = publish(records, manualTerms({ codeShareName: "Own Lane" }));
      const ownPage = await pageOf(base, seller.cookie, "/");
      const ownPost = await postForm(base, seller.cookie, `/market/${own.id}/requests`, {
        csrf_token: ownPage.csrf,
        version: "1",
        quantity: "1",
      });
      assert.equal(ownPost.status, 400);
      assert.match(await ownPost.text(), /your own company/);
      assert.equal(Object.keys(diskRequests(recordsPath)).length, 0);
      assert.equal(draftPost.status, 404);
      const unknown = await pageOf(base, buyer.cookie, `/market/${draft.id}`);
      assert.equal(await draftPost.text(), unknown.html);
      assert.equal(fileText(recordsPath).includes("Draft Lane"), true);
      assert.equal(before.includes("requests"), true);
    });
  });

  it("shows the quantity Accept commits and keeps snapshotted names after disconnect", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyerName = `Harbor${MARKUP}`;
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", { ...BUYER, companyName: buyerName });
      const offer = publish(records, manualTerms({ quantity: 10, codeShareName: "Commit Lane" }));
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      const requested = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version: detail.html.match(/name="version" value="([^"]+)"/)[1],
        quantity: "3",
      });
      assert.equal(requested.status, 302);
      const requestPath = requested.headers.get("location");
      const created = Object.values(diskRequests(recordsPath))[0];
      assert.equal(created.quantity, 3);
      assert.equal(created.buyerCompanyName, buyerName);
      assert.equal(created.sellerCompanyName, null);

      const buyerPending = await pageOf(base, buyer.cookie, requestPath);
      const sellerPending = await pageOf(base, seller.cookie, requestPath);
      for (const html of [buyerPending.html, sellerPending.html]) {
        assert.equal(elementText(html, "requested-quantity"), "3");
        assert.match(elementText(html, "listed-quantity"), /^10 /);
        assert.equal(html.includes('id="accept-quantity"'), false);
        assert.equal(html.includes("Harbor"), false);
        assert.equal(html.includes("Kings"), false);
        assert.equal(html.includes(MARKUP), false);
      }
      const buyerList = await pageOf(base, buyer.cookie, "/requests");
      const sellerList = await pageOf(base, seller.cookie, "/requests");
      const preview = await pageOf(base, seller.cookie, `/offers/${offer.id}`);
      for (const html of [buyerList.html, sellerList.html, preview.html]) {
        assert.equal(html.includes("Harbor"), false);
        assert.equal(html.includes("Kings"), false);
        assert.equal(html.includes(MARKUP), false);
      }

      const countered = await postForm(base, seller.cookie, `${requestPath}/counter`, {
        csrf_token: sellerPending.csrf,
        quantity: "4",
        unitPrice: "25.00",
        serviceTerms: "Counter terms",
      });
      assert.equal(countered.status, 302);
      const storedCounter = Object.values(diskRequests(recordsPath))[0];
      assert.equal(storedCounter.sellerCompanyName, "Kings");
      assert.equal(storedCounter.buyerCompanyName, buyerName);
      for (const cookie of [buyer.cookie, seller.cookie]) {
        const page = await pageOf(base, cookie, requestPath);
        assert.equal(elementText(page.html, "requested-quantity"), "3");
        assert.equal(elementText(page.html, "accept-quantity"), "4");
        assert.equal(elementText(page.html, "accept-unit-price").includes("25.00"), true);
        assert.equal(elementText(page.html, "accept-total").includes("100.00"), true);
        assert.match(page.html, /Accept commits these terms/);
        assert.equal(page.html.includes("Harbor"), false);
        assert.equal(page.html.includes("Kings"), false);
        assert.equal(page.html.includes(MARKUP), false);
      }
      const counteredList = await pageOf(base, seller.cookie, "/requests");
      const counteredPreview = await pageOf(base, seller.cookie, `/offers/${offer.id}`);
      const counteredBuyerList = await pageOf(base, buyer.cookie, "/requests");
      for (const html of [counteredList.html, counteredPreview.html, counteredBuyerList.html]) {
        assert.equal(html.includes("Harbor"), false);
        assert.equal(html.includes("Kings"), false);
      }

      const buyerCounter = await pageOf(base, buyer.cookie, requestPath);
      const accepted = await postForm(base, buyer.cookie, `${requestPath}/accept`, {
        csrf_token: buyerCounter.csrf,
      });
      assert.equal(accepted.status, 302);
      const escaped = "Harbor&lt;img src=x onerror=alert(1)&gt;";
      const buyerDone = await pageOf(base, buyer.cookie, requestPath);
      const sellerDone = await pageOf(base, seller.cookie, requestPath);
      for (const html of [buyerDone.html, sellerDone.html]) {
        assert.equal(html.includes(MARKUP), false);
        assert.equal(html.includes(escaped), true);
        assert.match(html, /id="seller-name">Kings/);
      }

      store.deleteConnection("sid-buyer");
      const sellerAfter = await pageOf(base, seller.cookie, requestPath);
      assert.equal(sellerAfter.response.status, 200);
      assert.equal(sellerAfter.html.includes(escaped), true);
      assert.match(sellerAfter.html, /id="seller-name">Kings/);

      seedCompany(store, "sid-buyer", "csrf-buyer", { ...BUYER, companyName: buyerName });
      store.deleteConnection(sidOf(seller.cookie));
      const buyerAfter = await pageOf(base, buyer.cookie, requestPath);
      assert.equal(buyerAfter.response.status, 200);
      assert.equal(buyerAfter.html.includes(escaped), true);
      assert.match(buyerAfter.html, /id="seller-name">Kings/);
    });
  });
});
