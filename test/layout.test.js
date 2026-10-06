const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { renderPage } = require("../lib/page");
const { stylesheet, stylesheetHash, stylesheetHref } = require("../lib/views/styles");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const TODAY = "2026-10-05";
const MARKUP = "<img src=x onerror=alert(1)>";
const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";
const KINGS = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const OTHER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const OPERATOR = { companyId: "ops-co", sub: "user-operator", companyName: "Ops Co" };

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
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
    codeShareName: "Lane",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function publish(records, seller, name) {
  const created = records.createOffer(seller, {
    source: "manual",
    terms: manualTerms({ codeShareName: name }),
    snapshot: null,
    sourceRecordId: null,
    overriddenFields: [],
  });
  const published = records.setOfferState(seller.companyId, created.id, "published", seller.sub, TODAY);
  assert.equal(published.ok, true);
  return published.offer;
}

async function withApp(run, { subs = "", rates = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-layout-"));
  const mock = createMockRateNinja({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...(Array.isArray(rates) ? { rates } : {}),
  });
  const port = await mock.listen();
  const origin = `http://127.0.0.1:${port}`;
  const recordsPath = path.join(dir, "records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: origin,
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_OPERATOR_SUBS: subs,
    OCEANRELAY_RECORDS_PATH: recordsPath,
    OCEANRELAY_STORE_PATH: path.join(dir, "store.json"),
  });
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const server = createServer({ config, store, records });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store, records, recordsPath, mock });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedCompany(store, mock, sid, csrf, profile) {
  const refreshToken = `refresh-${sid}`;
  mock.refreshTokens.set(refreshToken, true);
  store.saveConnection(sid, {
    refreshToken,
    scopes: ["profile:read", "rates:read", "sailings:read"],
    profile: {
      name: profile.name || profile.companyName,
      companyType: "Contract Owner",
      active: true,
      ...profile,
    },
  });
  return { cookie: sessionCookie(sid, csrf), csrf };
}

async function textOf(base, cookie, target) {
  const response = await fetch(new URL(target, base), { headers: { cookie }, redirect: "manual" });
  return { response, html: await response.text() };
}

describe("stylesheet", () => {
  it("serves the hashed stylesheet and the home page links that hash", async () => {
    await withApp(async ({ base }) => {
      const css = await fetch(`${base}/assets/oceanrelay.css`);
      const body = await css.text();
      assert.equal(css.status, 200);
      assert.match(css.headers.get("content-type"), /^text\/css/);
      assert.match(css.headers.get("cache-control"), /immutable/);
      assert.match(css.headers.get("cache-control"), /max-age=31536000/);
      assert.equal(crypto.createHash("sha256").update(body).digest("hex"), stylesheetHash);
      assert.equal(body, stylesheet);
      assert.equal(body.includes("@import"), false);
      assert.equal(/url\(\s*['"]?https?:/i.test(body), false);
      const home = await fetch(base);
      const html = await home.text();
      assert.match(html, new RegExp(`href="${stylesheetHref().replace("?", "\\?")}"`));
      assert.equal(html.includes("<style"), false);
      assert.equal(html.includes("<script"), false);
    });
  });
});

describe("landing page", () => {
  it("has no settings list, and disables sign-in when configuration is incomplete", () => {
    const html = renderPage({
      configView: {
        ok: false,
        missing: ["SESSION_SECRET"],
        invalid: [],
        settings: { RATE_NINJA_CLIENT_ID: "missing", OCEANRELAY_STORE_PATH: "/tmp/store.json" },
      },
      connection: null,
      csrf: "csrf-landing",
      result: "config_incomplete",
    });
    assert.match(html, /Sign-in is not available right now/);
    assert.match(html, /<button type="submit" class="btn" disabled>Sign in with Rate Ninja<\/button>/);
    assert.equal(html.includes("Configuration check"), false);
    assert.equal(html.includes("SESSION_SECRET"), false);
    assert.equal(html.includes("OCEANRELAY_STORE_PATH"), false);
    assert.match(html, /OceanRelay is missing configuration, so the connection was not started\./);
    assert.match(html, /action="\/connect"/);
    assert.match(html, /name="csrf_token" value="csrf-landing"/);
  });
});

describe("dashboard", () => {
  it("counts one of each waiting item and does not write the records file", async () => {
    await withApp(async ({ base, store, records, recordsPath, mock }) => {
      const seller = seedCompany(store, mock, "sid-kings", "csrf-kings", KINGS);
      seedCompany(store, mock, "sid-other", "csrf-other", OTHER);
      const offerA = publish(records, KINGS, "Pending Lane");
      records.createRequest(OTHER, offerA.id, offerA.currentVersion, 1, TODAY);
      const offerB = publish(records, OTHER, "Counter Lane");
      const made = records.createRequest(KINGS, offerB.id, offerB.currentVersion, 2, TODAY);
      const countered = records.counterRequest(OTHER, made.request.id, {
        quantity: 2,
        unitBuyerMinor: 2200,
        serviceTerms: "Counter terms",
      }, TODAY);
      assert.equal(countered.ok, true);
      const offerC = publish(records, KINGS, "Accepted Lane");
      const accepted = records.createRequest(OTHER, offerC.id, offerC.currentVersion, 1, TODAY);
      const done = records.acceptRequest(KINGS, accepted.request.id, TODAY);
      assert.equal(done.ok, true);
      const proposed = records.proposeCancellation(OTHER, accepted.request.id, "please release");
      assert.equal(proposed.ok, true);
      records.createOffer(KINGS, {
        source: "manual",
        terms: manualTerms({ codeShareName: "Draft Lane" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });

      const before = fs.readFileSync(recordsPath);
      const mtime = fs.statSync(recordsPath).mtimeMs;
      const home = await textOf(base, seller.cookie, "/");
      const market = await textOf(base, seller.cookie, "/market");
      const requests = await textOf(base, seller.cookie, "/requests");
      const offers = await textOf(base, seller.cookie, "/offers");
      assert.equal(home.response.status, 200);
      assert.equal(market.response.status, 200);
      assert.equal(requests.response.status, 200);
      assert.equal(offers.response.status, 200);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, mtime);

      assert.match(home.html, /Your Rate Ninja user id: user-owner/);
      assert.match(home.html, /stat-count">2<\/span> Your published offers/);
      assert.match(home.html, /stat-count">3<\/span> Requests waiting for you/);
      assert.match(home.html, /stat-count">1<\/span> Your accepted agreements/);
      assert.match(home.html, /href="\/offers"/);
      assert.match(home.html, /href="\/requests"/);
      assert.match(home.html, /href="\/market"/);
      assert.match(home.html, /Create an offer/);
      assert.equal(home.html.includes('href="/operator"'), false);
    });
  });

  it("shows the operator link only for an operator", async () => {
    await withApp(async ({ base, store, mock }) => {
      const operator = seedCompany(store, mock, "sid-ops", "csrf-ops", OPERATOR);
      const owner = seedCompany(store, mock, "sid-kings", "csrf-kings", KINGS);
      const opsHome = await textOf(base, operator.cookie, "/");
      const ownerHome = await textOf(base, owner.cookie, "/");
      assert.match(opsHome.html, /href="\/operator"/);
      assert.equal(ownerHome.html.includes('href="/operator"'), false);
    }, { subs: OPERATOR.sub });
  });
});

describe("header escaping", () => {
  it("escapes a company name in the header", async () => {
    await withApp(async ({ base, store, mock }) => {
      const marked = seedCompany(store, mock, "sid-mark", "csrf-mark", {
        companyId: "mark-co",
        sub: "user-mark",
        companyName: MARKUP,
        name: "Marked",
      });
      const home = await textOf(base, marked.cookie, "/");
      assert.equal(home.html.includes(MARKUP), false);
      assert.equal(home.html.includes("<img"), false);
      assert.equal(home.html.includes(`class="company">${ESCAPED}`), true);
    });
  });
});

function rateRow() {
  return {
    id: "rate-layout",
    source: "base_contract",
    allocationEvidence: false,
    capacityQuantity: null,
    carrier: "ABC",
    contractOwner: "Marked",
    ownerCompanyId: "mark-co",
    originPort: "CNSHA",
    destinationPort: "USLAX",
    inlandDeliveryLocation: "",
    commodityType: "FAK",
    rate20D: 900,
    rate40D: 0,
    rate40HC: 1500,
    currency: null,
    rateEffectiveDate: "2026-09-01",
    rateExpirationDate: "2099-12-31",
    updatedAt: null,
    notes: "private",
  };
}

function assertChrome(html, { operator = false } = {}) {
  assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /<nav class="nav" aria-label="Primary">/);
  assert.match(html, /href="\/market"/);
  assert.match(html, /Your offers/);
  assert.match(html, /href="\/requests"/);
  assert.match(html, new RegExp(`href="${stylesheetHref().replace(/[?]/g, "\\?")}"`));
  assert.equal(html.includes("<style"), false);
  assert.equal(html.includes("<script"), false);
  assertNoRemote(html);
  if (operator) assert.match(html, /href="\/operator"/);
  else assert.equal(html.includes('href="/operator"'), false);
}

function assertNoRemote(html) {
  assert.equal(html.includes("<style"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("@import"), false);
  assert.equal(/url\(\s*['"]?https?:/i.test(html), false);
  assert.equal(/href=["']https?:/i.test(html), false);
  assert.equal(/src=["']https?:/i.test(html), false);
}

async function postForm(base, cookie, target, fields) {
  const response = await fetch(new URL(target, base), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { response, html: await response.text() };
}

describe("signed-in pages", () => {
  it("uses one stylesheet, the header, and the skip link on every page", async () => {
    await withApp(async ({ base, store, records, mock }) => {
      const marked = seedCompany(store, mock, "sid-mark", "csrf-mark", {
        companyId: "mark-co",
        sub: "user-mark",
        companyName: MARKUP,
        name: "Marked",
      });
      const other = seedCompany(store, mock, "sid-other", "csrf-other", OTHER);
      const third = seedCompany(store, mock, "sid-third", "csrf-third", {
        companyId: "third-co",
        sub: "user-third",
        companyName: "Third Co",
      });
      const offer = publish(records, {
        companyId: "mark-co",
        sub: "user-mark",
        companyName: MARKUP,
      }, "Layout Lane");
      const created = records.createRequest(OTHER, offer.id, offer.currentVersion, 1, TODAY);
      const countered = records.counterRequest({
        companyId: "mark-co",
        sub: "user-mark",
        companyName: MARKUP,
      }, created.request.id, {
        quantity: 1,
        unitBuyerMinor: 2100,
        serviceTerms: `Terms${MARKUP}`,
      }, TODAY);
      assert.equal(countered.ok, true);
      const hidden = records.createOffer(OTHER, {
        source: "manual",
        terms: manualTerms({ codeShareName: "Hidden Lane" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const foreignOffer = publish(records, {
        companyId: "third-co",
        sub: "user-third",
        companyName: "Third Co",
      }, "Foreign Lane");
      const foreignRequest = records.createRequest(OTHER, foreignOffer.id, foreignOffer.currentVersion, 1, TODAY);

      const pages = [
        "/",
        "/market",
        `/market/${offer.id}`,
        "/offers",
        "/offers/new",
        "/offers/new?source=manual",
        "/offers/new?source=rn_rate&rateId=rate-layout&equipment=40HC",
        `/offers/${offer.id}`,
        `/offers/${offer.id}/edit`,
        "/requests",
        `/requests/${created.request.id}`,
        "/operator",
        `/operator/requests/${created.request.id}`,
        "/operator/audit",
      ];
      for (const target of pages) {
        const page = await textOf(base, marked.cookie, target);
        assert.equal(page.response.status, 200, target);
        assertChrome(page.html, { operator: true });
        assert.equal(page.html.includes(MARKUP), false, target);
        assert.equal(page.html.includes("<img"), false, target);
        assert.equal(page.html.includes(`class="company">${ESCAPED}`), true, target);
      }
      const detail = await textOf(base, marked.cookie, `/requests/${created.request.id}`);
      const timelineStart = detail.html.indexOf('id="request-timeline"');
      const timeline = detail.html.slice(timelineStart, detail.html.indexOf("</ol>", timelineStart));
      assert.equal(timeline.includes(MARKUP), false);
      assert.equal(timeline.includes(`Terms${ESCAPED}`), true);

      const plain = seedCompany(store, mock, "sid-kings", "csrf-kings", KINGS);
      for (const target of ["/", "/market", "/offers", "/requests"]) {
        const page = await textOf(base, plain.cookie, target);
        assert.equal(page.response.status, 200, target);
        assertChrome(page.html, { operator: false });
      }

      const missingMarket = await textOf(base, marked.cookie, "/market/missing-offer");
      const foreignMarket = await textOf(base, marked.cookie, `/market/${hidden.id}`);
      const otherMarket = await textOf(base, other.cookie, "/market/missing-offer");
      assert.equal(missingMarket.response.status, 404);
      assert.equal(missingMarket.html, foreignMarket.html);
      assert.equal(missingMarket.html, otherMarket.html);
      assert.equal(missingMarket.html.includes(hidden.id), false);
      assertChrome(missingMarket.html, { operator: false });
      assert.equal(missingMarket.html.includes(`class="company"`), false);
      const postMarket = await postForm(base, marked.cookie, "/market/missing-offer/requests", {
        csrf_token: marked.csrf,
        version: "1",
        quantity: "1",
      });
      const postForeignMarket = await postForm(base, marked.cookie, `/market/${hidden.id}/requests`, {
        csrf_token: marked.csrf,
        version: "1",
        quantity: "1",
      });
      assert.equal(postMarket.response.status, 404);
      assert.equal(postMarket.html, missingMarket.html);
      assert.equal(postForeignMarket.html, missingMarket.html);

      const missingOffer = await textOf(base, marked.cookie, "/offers/missing-offer");
      const foreignOfferPage = await textOf(base, marked.cookie, `/offers/${foreignOffer.id}`);
      const otherOfferPage = await textOf(base, other.cookie, "/offers/missing-offer");
      assert.equal(missingOffer.response.status, 404);
      assert.equal(missingOffer.html, foreignOfferPage.html);
      assert.equal(missingOffer.html, otherOfferPage.html);
      assert.equal(missingOffer.html.includes(foreignOffer.id), false);
      const postOffer = await postForm(base, marked.cookie, "/offers/missing-offer/state", {
        csrf_token: marked.csrf,
        to: "published",
      });
      const postForeignOffer = await postForm(base, marked.cookie, `/offers/${foreignOffer.id}/state`, {
        csrf_token: marked.csrf,
        to: "published",
      });
      assert.equal(postOffer.response.status, 404);
      assert.equal(postOffer.html, missingOffer.html);
      assert.equal(postForeignOffer.html, missingOffer.html);

      const missingRequest = await textOf(base, marked.cookie, "/requests/missing-request");
      const foreignRequestPage = await textOf(base, marked.cookie, `/requests/${foreignRequest.request.id}`);
      const otherRequestPage = await textOf(base, other.cookie, "/requests/missing-request");
      assert.equal(missingRequest.response.status, 404);
      assert.equal(missingRequest.html, foreignRequestPage.html);
      assert.equal(missingRequest.html, otherRequestPage.html);
      assert.equal(missingRequest.html.includes(foreignRequest.request.id), false);
      const postRequest = await postForm(base, marked.cookie, "/requests/missing-request/decline", {
        csrf_token: marked.csrf,
      });
      const postForeignRequest = await postForm(base, marked.cookie, `/requests/${foreignRequest.request.id}/decline`, {
        csrf_token: marked.csrf,
      });
      assert.equal(postRequest.response.status, 404);
      assert.equal(postRequest.html, missingRequest.html);
      assert.equal(postForeignRequest.html, missingRequest.html);

      const signedOut = await textOf(base, "", "/");
      assert.equal(signedOut.response.status, 200);
      assertNoRemote(signedOut.html);
      assert.equal(signedOut.html.includes("<nav"), false);
    }, { subs: "user-mark", rates: [rateRow()] });
  });
});
