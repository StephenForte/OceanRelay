const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig, publicConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const TODAY = "2026-10-01";
const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const BUYER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const OPERATOR = { companyId: "ops-co", sub: "user-operator", companyName: "Ops Co" };
const MARKUP = "<img src=x onerror=alert(1)>";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-operator-"));
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

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function testConfig(baseUrl, subs = OPERATOR.sub) {
  return loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: baseUrl,
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_OPERATOR_SUBS: subs,
  });
}

async function withApp(run, subs = OPERATOR.sub) {
  const dir = tempDir();
  const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const port = await mock.listen();
  const origin = `http://127.0.0.1:${port}`;
  const recordsPath = path.join(dir, "records.json");
  const config = testConfig(origin, subs);
  const store = openStore(path.join(dir, "store.json"), config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const server = createServer({ config, store, records });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.redirectUri = `${base}/oauth/callback`;
  try {
    await run({ base, origin, store, records, recordsPath, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  return { cookie: sessionCookie(sid, csrf), csrf, sid };
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

function publish(records, terms = manualTerms()) {
  const created = records.createOffer(SELLER, {
    source: terms.source,
    terms,
    snapshot: null,
    sourceRecordId: null,
    overriddenFields: [],
  });
  const published = records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
  assert.equal(published.ok, true);
  return published.offer;
}

function acceptPending(records, offer, quantity = 3) {
  const created = records.createRequest(BUYER, offer.id, offer.currentVersion, quantity, TODAY);
  assert.equal(created.ok, true);
  const accepted = records.acceptRequest(SELLER, created.request.id, TODAY);
  assert.equal(accepted.ok, true);
  return accepted.request;
}

async function pageOf(base, cookie, target) {
  const response = await fetch(new URL(target, base), { headers: cookie ? { cookie } : {}, redirect: "manual" });
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

async function signature(base, target, { cookie, method = "GET", fields } = {}) {
  const response = await fetch(new URL(target, base), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? new URLSearchParams(fields || { csrf_token: "x", to: "carrier_pending", note: "n" }) : undefined,
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

describe("operator configuration", () => {
  it("parses operator subs into a frozen set and publishes only the count", () => {
    const config = loadConfig({
      OCEANRELAY_OPERATOR_SUBS: " user-operator , , user-owner ,user-operator ",
    });
    assert.equal(config.operatorSubs.size, 2);
    assert.equal(config.operatorSubs.has("user-operator"), true);
    assert.equal(config.operatorSubs.has("user-owner"), true);
    assert.equal(config.operatorSubs.has(""), false);
    assert.equal(Object.isFrozen(config.operatorSubs), true);
    assert.equal(typeof config.operatorSubs.add, "undefined");
    const view = publicConfig(config);
    assert.equal(view.operatorCount, 2);
    assert.equal(JSON.stringify(view).includes("user-operator"), false);
    assert.equal(JSON.stringify(view).includes("user-owner"), false);
    assert.equal(publicConfig(loadConfig({})).operatorCount, 0);
  });
});

describe("operator gate", () => {
  it("matches an unknown page for signed-out users and signed-in non-operators", async () => {
    await withApp(async ({ base, origin, store, records }) => {
      const seller = await connectOwner({ base, origin });
      const offer = publish(records);
      const request = acceptPending(records, offer);
      const paths = [
        ["/operator", "GET"],
        ["/operator/audit", "GET"],
        [`/operator/requests/${request.id}`, "GET"],
        ["/operator/requests/not-a-request", "GET"],
        [`/operator/requests/${request.id}/status`, "POST"],
      ];
      for (const [target, method] of paths) {
        const signedOut = await signature(base, target, { method });
        const unknownOut = await signature(base, "/no-such-page", { method });
        assert.deepEqual(signedOut, unknownOut, `signed out ${method} ${target}`);
        const signedIn = await signature(base, target, { method, cookie: seller.cookie });
        const unknownIn = await signature(base, "/no-such-page", { method, cookie: seller.cookie });
        assert.deepEqual(signedIn, unknownIn, `signed in ${method} ${target}`);
      }
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const allowed = await pageOf(base, operator.cookie, "/operator");
      assert.equal(allowed.response.status, 200);
      assert.match(allowed.html, /<h1>Operator<\/h1>/);
    });
  });

  it("shows the signed-in sub on the home page and only the count on /config", async () => {
    await withApp(async ({ base, origin }) => {
      const seller = await connectOwner({ base, origin });
      const home = await pageOf(base, seller.cookie, "/");
      assert.match(home.html, /Your Rate Ninja user id: user-owner/);
      const config = await fetch(`${base}/config`);
      const body = await config.text();
      const view = JSON.parse(body);
      assert.equal(view.operatorCount, 1);
      assert.equal(body.includes("user-operator"), false);
      assert.equal(body.includes(OPERATOR.sub), false);
      assert.equal(Object.prototype.hasOwnProperty.call(view, "operatorSubs"), false);
    });
  });
});

describe("operator screens", () => {
  it("lists each D-21 inconsistency and does not repair it", async () => {
    await withApp(async ({ base, store, records, recordsPath }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const over = publish(records, manualTerms({ quantity: 10, codeShareName: "Over" }));
      const accepted = acceptPending(records, over, 4);
      const edited = records.editOffer(SELLER.companyId, over.id, {
        terms: manualTerms({ quantity: 1, codeShareName: "Over" }),
        overriddenFields: [],
      }, SELLER.sub, TODAY);
      assert.equal(edited.ok, true, "D-15 allows a new version with a lower quantity");

      const disputedOffer = publish(records, manualTerms({ codeShareName: "Dispute" }));
      const disputed = acceptPending(records, disputedOffer, 1);
      records.proposeCancellation(SELLER, disputed.id, "no");
      records.refuseCancellation(BUYER, disputed.id);

      const proposedOffer = publish(records, manualTerms({ codeShareName: "Proposed" }));
      const proposed = acceptPending(records, proposedOffer, 1);
      records.proposeCancellation(BUYER, proposed.id, "please");

      const totalOffer = publish(records, manualTerms({ codeShareName: "Total" }));
      const badTotal = acceptPending(records, totalOffer, 1);
      const hashOffer = publish(records, manualTerms({ codeShareName: "Hash" }));
      const missingHash = acceptPending(records, hashOffer, 1);
      const goneOffer = publish(records, manualTerms({ codeShareName: "Gone" }));
      const missingOffer = acceptPending(records, goneOffer, 1);
      const bareOffer = publish(records, manualTerms({ codeShareName: "Bare" }));
      const bare = acceptPending(records, bareOffer, 1);
      records.transact((data) => {
        data.requests[badTotal.id].acceptance.totalMinor += 1;
        delete data.requests[missingHash.id].acceptance.termsHash;
        delete data.offers[goneOffer.id];
        data.requests[bare.id].fulfilment = null;
      });

      const before = fs.readFileSync(recordsPath);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      const page = await pageOf(base, operator.cookie, "/operator");
      assert.match(page.html, new RegExp(`Offer ${over.id} is over-committed: accepted quantity 4 exceeds listed quantity 1`));
      assert.match(page.html, new RegExp(`Request ${disputed.id} is an open dispute`));
      assert.match(page.html, new RegExp(`Request ${proposed.id} has a cancellation proposal awaiting a response`));
      assert.match(page.html, new RegExp(`Request ${badTotal.id} acceptance total does not match quantity times unit price`));
      assert.match(page.html, new RegExp(`Request ${missingHash.id} acceptance is missing its terms fingerprint`));
      assert.match(page.html, new RegExp(`Request ${missingOffer.id} names an offer that is not in the records`));
      assert.match(page.html, new RegExp(`Request ${bare.id} is accepted and has no fulfilment record`));
      assert.equal(page.html.includes(SELLER.companyName), true);
      assert.match(page.html, /manual/);
      await pageOf(base, operator.cookie, "/operator");
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
      assert.equal(records.getRequestFor(SELLER.companyId, badTotal.id).acceptance.totalMinor, badTotal.acceptance.totalMinor + 1);
    });
  });

  it("does not write when an operator screen is opened twice", async () => {
    await withApp(async ({ base, store, records, recordsPath }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const offer = publish(records);
      const request = acceptPending(records, offer);
      const before = fs.readFileSync(recordsPath);
      const stamp = new Date("2020-02-02T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      await pageOf(base, operator.cookie, "/operator");
      await pageOf(base, operator.cookie, "/operator");
      await pageOf(base, operator.cookie, "/operator/audit");
      await pageOf(base, operator.cookie, "/operator/audit");
      await pageOf(base, operator.cookie, `/operator/requests/${request.id}`);
      await pageOf(base, operator.cookie, `/operator/requests/${request.id}`);
      await pageOf(base, operator.cookie, "/operator/requests/missing-id");
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
    });
  });

  it("shows an empty state on each operator screen", async () => {
    await withApp(async ({ base, store }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const index = await pageOf(base, operator.cookie, "/operator");
      assert.match(index.html, /No companies in the records yet/);
      assert.match(index.html, /No offers yet/);
      assert.match(index.html, /No requests yet/);
      assert.match(index.html, /No inconsistencies/);
      const audit = await pageOf(base, operator.cookie, "/operator/audit");
      assert.match(audit.html, /No audit entries/);
      const missing = await pageOf(base, operator.cookie, "/operator/requests/missing-id");
      assert.match(missing.html, /No request with that id/);
    });
  });

  it("records only a D-20 carrier status, with a required note, and leaves the acceptance untouched", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const offer = publish(records);
      const request = acceptPending(records, offer, 3);
      const stored = () => JSON.parse(fs.readFileSync(recordsPath, "utf8")).requests[request.id];
      const beforeAcceptance = JSON.stringify(stored().acceptance);
      const beforeCounters = JSON.stringify(stored().counters);
      const beforeHistory = JSON.stringify(stored().history);
      const beforeEvents = JSON.stringify(stored().fulfilment.cancellationEvents);
      const hash = stored().acceptance.termsHash;

      const screen = await pageOf(base, operator.cookie, `/operator/requests/${request.id}`);
      const form = screen.html.slice(screen.html.indexOf('id="operator-status"'), screen.html.indexOf("</form>", screen.html.indexOf('id="operator-status"')));
      assert.match(form, /value="carrier_pending"/);
      assert.match(form, /value="carrier_confirmed"/);
      assert.equal(form.includes("completed"), false);
      assert.equal(form.includes("rejected"), false);
      assert.match(form, /required/);

      const before = fs.readFileSync(recordsPath);
      const empty = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: screen.csrf,
        to: "carrier_confirmed",
        note: "",
      });
      assert.equal(empty.status, 400);
      assert.match(await empty.text(), /A note is required/);
      const blank = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: screen.csrf,
        to: "carrier_confirmed",
        note: "   ",
      });
      assert.equal(blank.status, 400);
      const illegal = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: screen.csrf,
        to: "completed",
        note: "too far",
      });
      assert.equal(illegal.status, 400);
      assert.match(await illegal.text(), /not allowed/);
      const badCsrf = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: "nope",
        to: "carrier_confirmed",
        note: "x",
      });
      assert.equal(badCsrf.status, 403);
      assert.deepEqual(fs.readFileSync(recordsPath), before);

      const posted = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: screen.csrf,
        to: "carrier_confirmed",
        note: MARKUP,
      });
      assert.equal(posted.status, 302);
      const after = stored();
      assert.equal(JSON.stringify(after.acceptance), beforeAcceptance);
      assert.equal(after.acceptance.termsHash, hash);
      assert.equal(JSON.stringify(after.counters), beforeCounters);
      assert.equal(JSON.stringify(after.history), beforeHistory);
      assert.equal(JSON.stringify(after.fulfilment.cancellationEvents), beforeEvents);
      assert.equal(after.fulfilment.status, "carrier_confirmed");
      assert.equal(after.fulfilment.history.at(-1).role, "operator");
      assert.equal(after.fulfilment.history.at(-1).actorCompanyId, OPERATOR.companyId);
      assert.equal(after.fulfilment.history.at(-1).note, MARKUP);
      const audit = JSON.parse(fs.readFileSync(recordsPath, "utf8")).audit.at(-1);
      assert.equal(audit.event, "fulfilment.status");
      assert.equal(audit.actor.role, "operator");
      assert.deepEqual(audit.detail, { from: "accepted", to: "carrier_confirmed" });
      assert.equal(JSON.stringify(audit).includes(MARKUP), false);

      const operatorPage = await pageOf(base, operator.cookie, `/operator/requests/${request.id}`);
      assert.match(operatorPage.html, /recorded by the OceanRelay operator|OceanRelay operator/);
      assert.equal(operatorPage.html.includes(MARKUP), false);
      assert.match(operatorPage.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      const party = await pageOf(base, buyer.cookie, `/requests/${request.id}`);
      assert.match(party.html, /recorded by the OceanRelay operator on \d{4}-\d{2}-\d{2}/);
      assert.equal(party.html.includes(MARKUP), false);
      assert.match(party.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      const sellerPage = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      assert.match(sellerPage.html, /recorded by the OceanRelay operator on \d{4}-\d{2}-\d{2}/);
    });
  });

  it("lets only the status POST change the records file", async () => {
    await withApp(async ({ base, store, records, recordsPath }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const offer = publish(records);
      const request = acceptPending(records, offer);
      const untouched = async (run) => {
        const before = fs.readFileSync(recordsPath);
        await run();
        assert.deepEqual(fs.readFileSync(recordsPath), before);
      };
      await untouched(() => postForm(base, operator.cookie, "/operator", { csrf_token: operator.csrf }));
      await untouched(() => postForm(base, operator.cookie, "/operator/audit", { csrf_token: operator.csrf }));
      await untouched(() => postForm(base, operator.cookie, `/operator/requests/${request.id}`, { csrf_token: operator.csrf }));
      await untouched(() => postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: operator.csrf,
        to: "completed",
        note: "no",
      }));
      const before = fs.readFileSync(recordsPath);
      const wrote = await postForm(base, operator.cookie, `/operator/requests/${request.id}/status`, {
        csrf_token: operator.csrf,
        to: "carrier_pending",
        note: "operator note",
      });
      assert.equal(wrote.status, 302);
      assert.equal(fs.readFileSync(recordsPath).equals(before), false);
    });
  });

  it("does not let an operator use another company's party routes", async () => {
    await withApp(async ({ base, store, records, recordsPath }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const offer = publish(records);
      const request = acceptPending(records, offer);
      const pending = records.createRequest(BUYER, offer.id, 1, 1, TODAY);
      records.counterRequest(SELLER, pending.request.id, {
        quantity: 1,
        unitBuyerMinor: 1500,
        serviceTerms: "Held",
      }, TODAY);
      const unknown = await pageOf(base, operator.cookie, "/requests/00000000-0000-4000-8000-000000000000");
      const before = fs.readFileSync(recordsPath);
      const actions = [
        [`/requests/${request.id}/accept`, {}],
        [`/requests/${request.id}/decline`, {}],
        [`/requests/${pending.request.id}/counter`, { quantity: "1", unitPrice: "10.00", serviceTerms: "no" }],
        [`/requests/${pending.request.id}/withdraw`, {}],
        [`/requests/${request.id}/cancel/propose`, { reason: "no" }],
        [`/requests/${request.id}/cancel/withdraw`, {}],
        [`/requests/${request.id}/cancel/agree`, {}],
        [`/requests/${request.id}/cancel/refuse`, {}],
        [`/requests/${request.id}/status`, { to: "carrier_confirmed", note: "no" }],
      ];
      for (const [target, fields] of actions) {
        const response = await postForm(base, operator.cookie, target, {
          csrf_token: operator.csrf,
          ...fields,
        });
        assert.equal(response.status, 404, target);
        assert.equal(await response.text(), unknown.html, target);
      }
      assert.deepEqual(fs.readFileSync(recordsPath), before);
    });
  });

  it("shows the latest 200 audit entries, newest first, and filters by request or offer", async () => {
    await withApp(async ({ base, store, records, recordsPath }) => {
      const operator = seedCompany(store, "sid-operator", "csrf-operator", OPERATOR);
      const offer = publish(records);
      const request = acceptPending(records, offer, 1);
      records.transact((data) => {
        for (let i = 0; i < 201; i += 1) {
          data.audit.push({
            id: `noise-${i}`,
            at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
            event: "auth.connected",
            actor: null,
            subject: {},
            detail: {},
          });
        }
      });
      const page = await pageOf(base, operator.cookie, "/operator/audit");
      const newest = new Date(Date.UTC(2026, 0, 1) + 200 * 1000).toISOString();
      const oldest = new Date(Date.UTC(2026, 0, 1)).toISOString();
      assert.match(page.html, /Showing the latest 200/);
      assert.ok(page.html.indexOf(newest) < page.html.indexOf(new Date(Date.UTC(2026, 0, 1) + 199 * 1000).toISOString()));
      assert.equal(page.html.includes(oldest), false);
      const filtered = await pageOf(base, operator.cookie, `/operator/audit?requestId=${request.id}`);
      assert.match(filtered.html, /request.accepted/);
      assert.equal(filtered.html.includes(newest), false);
      const byOffer = await pageOf(base, operator.cookie, `/operator/audit?offerId=${offer.id}`);
      assert.match(byOffer.html, new RegExp(offer.id));
      assert.equal(byOffer.html.includes("noise-200"), false);
      assert.equal(JSON.parse(fs.readFileSync(recordsPath, "utf8")).audit.length > 200, true);
    });
  });
});
