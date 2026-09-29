const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";

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

function rateRow(id, overrides = {}) {
  return {
    id,
    source: "base_contract",
    allocationEvidence: false,
    capacityQuantity: null,
    carrier: "ABC",
    contractOwner: "Kings",
    ownerCompanyId: "kings",
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
    notes: "snapshot-note-private",
    ...overrides,
  };
}

function sailingRow() {
  return {
    id: "sail-1",
    source: "schedule",
    allocationEvidence: false,
    capacityQuantity: null,
    departure: "2026-12-20T00:00:00.000Z",
    arrival: "2027-01-10T00:00:00.000Z",
    transitTime: "21",
    vessel: "Vessel Example",
    voyage: "V9",
    service: "TP1",
    carrier: "ABC",
    departurePort: "CNSHA",
    ownerCompanyId: "kings",
    currency: null,
    updatedAt: null,
  };
}

function assertNoDemoApi(mock) {
  for (const req of mock.requests) {
    assert.equal(req.pathname.startsWith("/api/v1/"), false, req.pathname);
    const headerText = JSON.stringify(req.headers).toLowerCase();
    assert.equal(headerText.includes("api-key"), false);
    assert.equal(headerText.includes("api_key"), false);
  }
}

async function withApp({ rates = [], sailings = [sailingRow()], userinfo } = {}, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-offers-"));
  const mock = createMockRateNinja({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    rates,
    sailings,
    userinfo,
  });
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
    await run({ base, origin, mock, store, records, recordsPath, storePath, dir });
    assertNoDemoApi(mock);
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

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

async function pageOf(base, cookie, path) {
  const response = await fetch(new URL(path, base), { headers: { cookie } });
  const html = await response.text();
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  return { response, html, csrf: match ? match[1] : "" };
}

async function postForm(base, cookie, path, fields) {
  return fetch(new URL(path, base), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

function sellerFields(extra = {}) {
  return {
    origin: "CNSHA",
    destination: "USLAX",
    quantity: "4",
    unit: "container",
    sailingDate: "2026-12-20",
    sailingStart: "",
    sailingEnd: "",
    cutoffDate: "",
    validityDeadline: "2026-12-01",
    currency: "USD",
    markupType: "percent",
    markupValue: "10",
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY. No hazardous cargo.",
    ...extra,
  };
}

function diskOffers(recordsPath) {
  return JSON.parse(fs.readFileSync(recordsPath, "utf8")).offers;
}

function onlyOffer(recordsPath) {
  const offers = Object.values(diskOffers(recordsPath));
  assert.equal(offers.length, 1);
  return offers[0];
}

function versionOf(offer) {
  assert.ok(offer && Array.isArray(offer.versions));
  const version = offer.versions.find((item) => item.n === offer.currentVersion);
  assert.ok(version);
  return version;
}

function panel(html, id) {
  const marker = `<section class="panel" id="${id}">`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, id);
  const end = html.indexOf("</section>", start);
  assert.notEqual(end, -1, id);
  return html.slice(start, end);
}

const MARKUP = "<img src=x onerror=alert(1)>";

function marked(label) {
  return `${label}${MARKUP}`;
}

function escapedMark(label) {
  return `${label}&lt;img src=x onerror=alert(1)&gt;`;
}

function assertMarkupEscaped(html, labels, where) {
  assert.equal(html.includes(MARKUP), false, `${where} rendered raw markup`);
  assert.equal(html.includes("<img"), false, `${where} rendered a raw img tag`);
  for (const label of labels) {
    assert.equal(html.includes(escapedMark(label)), true, `${where} is missing escaped ${label}`);
  }
}

function partnerRequests(mock) {
  return mock.requests.filter((req) => req.pathname.startsWith("/api/partner/"));
}

describe("offer drafts", () => {
  it("saves a rate-based offer from a 1500 USD rate with a 10% markup", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const home = await pageOf(base, cookie, "/");
      assert.match(home.html, /Your offers/);
      const chooser = await pageOf(base, cookie, "/offers/new");
      assert.match(chooser.html, /40HC: 1500/);
      assert.match(chooser.html, /40D: no price/);
      assert.match(chooser.html, /CNSHA/);
      assert.match(chooser.html, /ABC/);
      assert.match(chooser.html, /2026-09-01/);
      assert.match(chooser.html, /2099-12-31/);
      assert.match(chooser.html, /OceanRelay retrieved this list at /);
      assert.match(chooser.html, /Schedule only\. A sailing is not a quantity of space\./);
      assert.match(chooser.html, /Enter an offer by hand/);
      const sailingCalls = mock.requests.filter((req) => req.pathname === "/api/partner/v1/me/sailings");
      assert.equal(sailingCalls.length, 1);
      assert.equal(new URL(sailingCalls[0].url, origin).searchParams.get("pageSize"), "100");

      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      assert.match(form.html, /from Rate Ninja/);
      assert.match(form.html, /1500 whole units/);
      assert.match(form.html, /Seller-provided\. Not a carrier endorsement\./);
      assert.match(form.html, /Choose a currency/);
      assert.equal(form.html.includes('value="USD" selected'), false);
      assert.equal(form.html.includes('name="baseMinor"'), false);
      assert.equal(form.html.includes('name="snapshot"'), false);

      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
      });
      assert.equal(saved.status, 302);
      const location = saved.headers.get("location");
      assert.match(location, /^\/offers\/[0-9a-f-]{36}$/);
      const reopened = openRecords(recordsPath);
      const listed = reopened.listCompanyOffers("kings");
      assert.equal(listed.length, 1);
      assert.equal(versionOf(listed[0]).terms.baseMinor, 150000);
      assert.equal(versionOf(listed[0]).terms.buyerMinor, 165000);
      assert.notEqual(versionOf(listed[0]).terms.baseMinor, versionOf(listed[0]).snapshot.baseAmount);
      assert.equal(versionOf(listed[0]).snapshot.baseAmount, 1500);
      assert.equal(versionOf(listed[0]).capacityStatus, "seller_asserted");
      const preview = await pageOf(base, cookie, location);
      assert.match(preview.html, /Private, only you see this/);
      assert.match(preview.html, /What a buyer will see/);
      const buyer = panel(preview.html, "buyer-panel");
      assert.match(buyer, /165000/);
      assert.match(buyer, /operated by/);
      assert.match(buyer, /XYZ, operated by ABC/);
      assert.match(buyer, /Quantity is the seller(?:'|&#39;)s claim/);
      assert.equal(buyer.includes("150000"), false);
      assert.equal(buyer.includes("1500"), false);
      assert.equal(buyer.includes("basis points"), false);
      assert.equal(buyer.includes("snapshot-note-private"), false);
      assert.equal(buyer.includes("rate-hc-a"), false);
      const stored = versionOf(onlyOffer(recordsPath));
      assert.equal(stored.terms.baseMinor, 150000);
      assert.equal(stored.terms.buyerMinor, 165000);
    });
  });

  it("ignores a tampered base price, snapshot, and company id", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
        baseMinor: "1",
        baseAmount: "1",
        snapshot: JSON.stringify({ baseAmount: 1, dto: { notes: "forged" } }),
        companyId: "intruder",
      });
      assert.equal(saved.status, 302);
      const offer = onlyOffer(recordsPath);
      const version = versionOf(offer);
      assert.equal(offer.companyId, "kings");
      assert.notEqual(offer.companyId, "intruder");
      assert.equal(version.terms.baseMinor, 150000);
      assert.equal(version.terms.buyerMinor, 165000);
      assert.equal(version.snapshot.baseAmount, 1500);
      assert.equal(version.snapshot.dto.notes, "snapshot-note-private");
      const reloaded = openRecords(recordsPath).getCompanyOffer("kings", offer.id);
      assert.equal(versionOf(reloaded).terms.baseMinor, 150000);
      assert.equal(reloaded.companyId, "kings");
    });
  });

  it("uses the rate price fetched at save time when the rate changed", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      assert.match(form.html, /1500 whole units/);
      assert.equal(mock.updateRate("rate-hc-a", { rate40HC: 1800 }), true);
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
      });
      assert.equal(saved.status, 302);
      const offer = versionOf(onlyOffer(recordsPath));
      assert.equal(offer.snapshot.baseAmount, 1800);
      assert.equal(offer.terms.baseMinor, 180000);
      assert.equal(offer.terms.buyerMinor, 198000);
      assert.notEqual(offer.terms.baseMinor, 150000);
    });
  });

  it("lets a no-rates account save a manual offer", async () => {
    await withApp({ rates: [], sailings: [] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const chooser = await pageOf(base, cookie, "/offers/new");
      assert.equal(chooser.response.status, 200);
      assert.match(chooser.html, /Your Rate Ninja account has no rates\. You can still enter an offer by hand\./);
      assert.match(chooser.html, /Enter an offer by hand/);
      assert.equal(chooser.html.includes("Could not reach Rate Ninja"), false);
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ markupType: "absolute", markupValue: "0" }),
      });
      assert.equal(saved.status, 302);
      const offer = onlyOffer(recordsPath);
      const version = versionOf(offer);
      assert.equal(version.source, "manual");
      assert.equal(version.snapshot, null);
      assert.equal(version.capacityStatus, "seller_asserted");
      assert.equal(version.terms.baseMinor, 2000);
      assert.equal(offer.companyId, "kings");
      const preview = await pageOf(base, cookie, saved.headers.get("location"));
      assert.match(preview.html, /Quantity is the seller(?:'|&#39;)s claim/);
      assert.match(panel(preview.html, "buyer-panel"), /operated by/);
      const again = versionOf(openRecords(recordsPath).getCompanyOffer("kings", offer.id));
      assert.equal(again.source, "manual");
      assert.equal(again.snapshot, null);
    });
  });

  it("hides the buy rate, markup, source id, and notes from the buyer panel", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
      });
      const preview = await pageOf(base, cookie, saved.headers.get("location"));
      const buyer = panel(preview.html, "buyer-panel");
      const priv = panel(preview.html, "private-panel");
      assert.match(buyer, /165000/);
      assert.match(buyer, /operated by ABC/);
      assert.equal(buyer.includes("150000"), false);
      assert.equal(buyer.includes("basis points"), false);
      assert.equal(buyer.includes("rate-hc-a"), false);
      assert.equal(buyer.includes("snapshot-note-private"), false);
      assert.match(priv, /150000/);
      assert.match(priv, /basis points/);
      assert.match(priv, /rate-hc-a/);
      assert.match(priv, /snapshot-note-private/);
    });
  });

  it("returns the same 404 for another company and an unknown id", async () => {
    await withApp({ rates: [], sailings: [] }, async ({ base, origin, store, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "20D",
        baseAmount: "10",
        ...sellerFields({ markupValue: "0", codeShareName: "Hidden Lane" }),
      });
      const id = onlyOffer(recordsPath).id;
      store.saveConnection("sid-other", {
        refreshToken: "refresh-other",
        scopes: ["profile:read", "rates:read", "sailings:read"],
        profile: {
          sub: "user-other",
          name: "Other",
          companyId: "other-co",
          companyName: "Other Co",
          companyType: "Contract Owner",
          active: true,
        },
      });
      const otherCookie = sessionCookie("sid-other", "csrf-other");
      const foreign = await pageOf(base, otherCookie, `/offers/${id}`);
      const unknown = await pageOf(base, cookie, `/offers/${crypto.randomUUID()}`);
      assert.equal(foreign.response.status, 404);
      assert.equal(unknown.response.status, 404);
      assert.equal(foreign.html, unknown.html);
      assert.match(foreign.html, /That offer was not found/);
      const otherList = await pageOf(base, otherCookie, "/offers");
      assert.equal(otherList.response.status, 200);
      assert.match(otherList.html, /No offers yet/);
      assert.equal(otherList.html.includes(id), false);
      assert.equal(otherList.html.includes("Hidden Lane"), false);
      const ownList = await pageOf(base, cookie, "/offers");
      assert.match(ownList.html, new RegExp(id));
      assert.match(ownList.html, /Hidden Lane/);
    });
  });

  it("records a capacity status change and refuses an illegal one", async () => {
    await withApp({ rates: [], sailings: [] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "15",
        ...sellerFields({ markupValue: "0" }),
      });
      const id = saved.headers.get("location").split("/").pop();
      const preview = await pageOf(base, cookie, `/offers/${id}`);
      const confirmed = await postForm(base, cookie, `/offers/${id}/capacity-status`, {
        csrf_token: preview.csrf,
        to: "carrier_confirmed",
      });
      assert.equal(confirmed.status, 302);
      const storedOffer = openRecords(recordsPath).getCompanyOffer("kings", id);
      const offer = versionOf(storedOffer);
      assert.equal(offer.capacityStatus, "carrier_confirmed");
      assert.equal(storedOffer.statusHistory.length, 1);
      assert.equal(storedOffer.statusHistory[0].from, "seller_asserted");
      assert.equal(storedOffer.statusHistory[0].to, "carrier_confirmed");
      assert.equal(storedOffer.statusHistory[0].actor, "user-owner");
      assert.equal(storedOffer.statusHistory[0].version, 1);
      assert.equal(Number.isNaN(Date.parse(storedOffer.statusHistory[0].at)), false);
      const shown = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(shown.html, /roll, change, or cancel/);
      const before = fs.readFileSync(recordsPath);
      const illegal = await postForm(base, cookie, `/offers/${id}/capacity-status`, {
        csrf_token: shown.csrf,
        to: "carrier_pending",
      });
      assert.equal(illegal.status, 400);
      assert.match(await illegal.text(), /not allowed/);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      const afterStored = openRecords(recordsPath).getCompanyOffer("kings", id);
      const afterIllegal = versionOf(afterStored);
      assert.equal(afterIllegal.capacityStatus, "carrier_confirmed");
      assert.equal(afterStored.statusHistory.length, 1);
      const beforeCsrf = fs.readFileSync(recordsPath);
      const missing = await postForm(base, cookie, `/offers/${id}/capacity-status`, { to: "seller_asserted" });
      assert.equal(missing.status, 403);
      assert.deepEqual(JSON.parse(await missing.text()), { error: "invalid_csrf" });
      assert.deepEqual(fs.readFileSync(recordsPath), beforeCsrf);
    });
  });

  it("warns when the source rate changes or expires and still renders after a failed re-fetch", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
      });
      const id = saved.headers.get("location").split("/").pop();
      const before = structuredClone(versionOf(onlyOffer(recordsPath)));
      const fresh = await pageOf(base, cookie, `/offers/${id}`);
      assert.equal(fresh.html.includes("source_changed"), false);
      assert.equal(mock.updateRate("rate-hc-a", { notes: "edited-after-save" }), true);
      const changed = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(changed.html, /source_changed/);
      assert.equal(versionOf(onlyOffer(recordsPath)).snapshot.dto.notes, "snapshot-note-private");
      assert.deepEqual(versionOf(onlyOffer(recordsPath)).snapshot, before.snapshot);
      assert.deepEqual(versionOf(onlyOffer(recordsPath)).terms, before.terms);
      assert.equal(mock.updateRate("rate-hc-a", { rateExpirationDate: "2000-01-01" }), true);
      const expired = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(expired.html, /source_expired/);
      assert.equal(versionOf(onlyOffer(recordsPath)).snapshot.dto.rateExpirationDate, "2099-12-31");
      mock.failNextPartner(500);
      const failed = await pageOf(base, cookie, `/offers/${id}`);
      assert.equal(failed.response.status, 200);
      assert.match(failed.html, /Could not check the Rate Ninja rate right now/);
      assert.match(failed.html, /What a buyer will see/);
      assert.deepEqual(versionOf(onlyOffer(recordsPath)).snapshot, before.snapshot);
      assert.deepEqual(versionOf(onlyOffer(recordsPath)).terms, before.terms);
    });
  });

  it("shows partner errors on the chooser without a 500", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock }) => {
      const { cookie } = await connectOwner({ base, origin });
      const tokenCalls = () => mock.calls.filter((call) => call === "POST /oauth/token").length;
      const before = tokenCalls();
      mock.failNextPartner(401);
      const unauthorized = await pageOf(base, cookie, "/offers/new");
      assert.equal(unauthorized.response.status, 200);
      assert.match(unauthorized.html, /Reconnect/);
      assert.match(unauthorized.html, /Enter an offer by hand/);
      const renewed = await pageOf(base, cookie, "/offers/new");
      assert.equal(renewed.response.status, 200);
      assert.match(renewed.html, /40HC: 1500/);
      assert.equal(tokenCalls(), before + 1);

      mock.failNextPartner(429);
      const limited = await pageOf(base, cookie, "/offers/new");
      assert.equal(limited.response.status, 200);
      assert.match(limited.html, /Rate Ninja is limiting requests\. Try again in a minute\./);

      mock.failNextPartner(403);
      const disabled = await pageOf(base, cookie, "/offers/new");
      assert.equal(disabled.response.status, 200);
      assert.match(disabled.html, /Partner access is off at Rate Ninja\./);
    });
  });

  it("parses money and percentages from strings and rejects bad amounts", async () => {
    await withApp({ rates: [], sailings: [] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const cents = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "0.29",
        ...sellerFields({ markupType: "absolute", markupValue: "0" }),
      });
      assert.equal(cents.status, 302);
      assert.equal(versionOf(onlyOffer(recordsPath)).terms.baseMinor, 29);

      const priced = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "19.99",
        ...sellerFields({ markupType: "absolute", markupValue: "0.29" }),
      });
      assert.equal(priced.status, 302);
      const offers = Object.values(diskOffers(recordsPath)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const second = versionOf(offers[1]);
      assert.equal(second.terms.baseMinor, 1999);
      assert.equal(second.terms.markup.minor, 29);
      assert.equal(second.terms.buyerMinor, 2028);

      const percent = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "100",
        ...sellerFields({ markupType: "percent", markupValue: "2.5" }),
      });
      assert.equal(percent.status, 302);
      const third = versionOf(Object.values(diskOffers(recordsPath)).find((offer) => versionOf(offer).terms.baseMinor === 10000));
      assert.equal(third.terms.markup.bps, 250);
      assert.equal(third.terms.buyerMinor, 10250);

      async function rejected(fields) {
        const before = Object.keys(diskOffers(recordsPath)).length;
        const response = await postForm(base, cookie, "/offers", {
          csrf_token: form.csrf,
          source: "manual",
          equipment: "40HC",
          baseAmount: "10",
          ...sellerFields({ markupValue: "0" }),
          ...fields,
        });
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, /class="error"/);
        assert.equal(Object.keys(diskOffers(recordsPath)).length, before);
        return html;
      }

      const yen = await rejected({ currency: "JPY", baseAmount: "10.5" });
      assert.match(yen, /whole number/);
      await rejected({ baseAmount: "1,000" });
      await rejected({ baseAmount: "-1" });
      await rejected({ baseAmount: "" });
      await rejected({ quantity: "1,000" });
      await rejected({ quantity: "-1" });
      await rejected({ quantity: "" });
    });
  });

  it("converts a JPY rate as whole yen and does not scale it by 100", async () => {
    await withApp({ rates: [rateRow("rate-jpy", { rate40HC: 1500 })] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-jpy&equipment=40HC");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-jpy",
        equipment: "40HC",
        ...sellerFields({ currency: "JPY", markupType: "percent", markupValue: "0" }),
      });
      assert.equal(saved.status, 302);
      const offer = versionOf(onlyOffer(recordsPath));
      assert.equal(offer.terms.currency, "JPY");
      assert.equal(offer.snapshot.baseAmount, 1500);
      assert.equal(offer.terms.baseMinor, 1500);
      assert.equal(offer.terms.buyerMinor, 1500);
    });
  });

  it("does not call Rate Ninja for a rate id that fails the id pattern", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock }) => {
      const { cookie } = await connectOwner({ base, origin });
      const home = await pageOf(base, cookie, "/");
      assert.equal(partnerRequests(mock).length, 0);
      const dotted = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=..&equipment=40HC");
      assert.equal(dotted.response.status, 200);
      assert.match(dotted.html, /That rate was not found/);
      assert.match(dotted.html, /Enter an offer by hand/);
      const slashed = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=a/b&equipment=40HC");
      assert.match(slashed.html, /That rate was not found/);
      const postedDot = await postForm(base, cookie, "/offers", {
        csrf_token: home.csrf,
        source: "rn_rate",
        rateId: "..",
        equipment: "40HC",
        ...sellerFields(),
      });
      assert.equal(postedDot.status, 200);
      assert.match(await postedDot.text(), /That rate was not found/);
      const postedSlash = await postForm(base, cookie, "/offers", {
        csrf_token: home.csrf,
        source: "rn_rate",
        rateId: "a/b",
        equipment: "40HC",
        ...sellerFields(),
      });
      assert.equal(postedSlash.status, 200);
      assert.equal(partnerRequests(mock).length, 0);
    });
  });

  it("says when only the first 1,000 rates are shown", async () => {
    const rates = Array.from({ length: 1001 }, (_, index) => rateRow(`rate-${index}`));
    await withApp({ rates, sailings: [] }, async ({ base, origin }) => {
      const { cookie } = await connectOwner({ base, origin });
      const chooser = await pageOf(base, cookie, "/offers/new");
      assert.equal(chooser.response.status, 200);
      assert.match(chooser.html, /Only the first 1,000 rates are shown\./);
    });
  });

  it("sends a zero-price equipment choice back to the chooser", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin }) => {
      const { cookie } = await connectOwner({ base, origin });
      const chooser = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40D");
      assert.equal(chooser.response.status, 200);
      assert.match(chooser.html, /no price for this equipment/);
      assert.match(chooser.html, /Enter an offer by hand/);
    });
  });

  it("keeps typed values beside field errors", async () => {
    await withApp({ rates: [], sailings: [] }, async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const response = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "10",
        ...sellerFields({ quantity: "", codeShareName: "Kept Name" }),
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Claimed quantity must be a positive whole number/);
      assert.match(html, /value="Kept Name"/);
      assert.equal(Object.keys(diskOffers(recordsPath)).length, 0);
    });
  });

  it("escapes Rate Ninja and seller markup on the chooser, form, preview, and list", async () => {
    const carrier = marked("RN-CARRIER");
    const notes = marked("RN-NOTES");
    const vessel = marked("RN-VESSEL");
    const codeShareName = marked("RN-SHARE");
    const serviceTerms = marked("RN-TERMS");
    const sailing = sailingRow();
    sailing.vessel = vessel;
    sailing.carrier = carrier;
    await withApp({
      rates: [rateRow("rate-hc-a", { carrier, notes })],
      sailings: [sailing],
    }, async ({ base, origin }) => {
      const { cookie } = await connectOwner({ base, origin });
      const chooser = await pageOf(base, cookie, "/offers/new");
      assert.equal(chooser.response.status, 200);
      assertMarkupEscaped(chooser.html, ["RN-CARRIER", "RN-VESSEL"], "chooser");

      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      assert.equal(form.response.status, 200);
      assertMarkupEscaped(form.html, ["RN-CARRIER"], "form");

      const rejected = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields({
          quantity: "",
          operatingCarrier: carrier,
          codeShareName,
          serviceTerms,
        }),
      });
      assert.equal(rejected.status, 200);
      const rejectedHtml = await rejected.text();
      assertMarkupEscaped(rejectedHtml, ["RN-CARRIER", "RN-SHARE", "RN-TERMS"], "form");
      const csrf = rejectedHtml.match(/name="csrf_token" value="([^"]+)"/)[1];

      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields({
          operatingCarrier: carrier,
          codeShareName,
          serviceTerms,
        }),
      });
      assert.equal(saved.status, 302);
      const preview = await pageOf(base, cookie, saved.headers.get("location"));
      assert.equal(preview.response.status, 200);
      assertMarkupEscaped(preview.html, ["RN-CARRIER", "RN-NOTES", "RN-SHARE", "RN-TERMS"], "preview");
      const buyer = panel(preview.html, "buyer-panel");
      assert.equal(buyer.includes("RN-NOTES"), false);
      assert.equal(buyer.includes(MARKUP), false);

      const list = await pageOf(base, cookie, "/offers");
      assert.equal(list.response.status, 200);
      assertMarkupEscaped(list.html, ["RN-SHARE"], "list");
      assert.equal(list.html.includes("RN-NOTES"), false);
      assert.equal(list.html.includes(MARKUP), false);

      const versionList = preview.html.slice(preview.html.indexOf('id="version-list"'), preview.html.indexOf("</ol>", preview.html.indexOf('id="version-list"')));
      assertMarkupEscaped(versionList, ["RN-SHARE"], "version list");
      const edit = await pageOf(base, cookie, `${saved.headers.get("location")}/edit`);
      assert.equal(edit.response.status, 200);
      assertMarkupEscaped(edit.html, ["RN-CARRIER", "RN-NOTES", "RN-SHARE", "RN-TERMS"], "edit form");
      assert.equal(edit.html.includes('name="baseMinor"'), false);
      assert.equal(edit.html.includes('name="snapshot"'), false);
      const published = await postForm(base, cookie, `${saved.headers.get("location")}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      });
      assert.equal(published.status, 302);
      const editAgain = await pageOf(base, cookie, `${saved.headers.get("location")}/edit`);
      const changed = await postForm(base, cookie, `${saved.headers.get("location")}/edit`, {
        csrf_token: editAgain.csrf,
        source: "rn_rate",
        equipment: "40HC",
        ...sellerFields({
          operatingCarrier: "Plain Carrier",
          codeShareName: "Safe Name",
          serviceTerms: "Plain terms",
        }),
      });
      assert.equal(changed.status, 302);
      const after = await pageOf(base, cookie, saved.headers.get("location"));
      const diffList = after.html.slice(after.html.indexOf('id="version-list"'), after.html.indexOf("</ol>", after.html.indexOf('id="version-list"')));
      assertMarkupEscaped(diffList, ["RN-SHARE", "RN-CARRIER", "RN-TERMS"], "version diff");
    });
  });

  it("re-renders the create form with typed values when Rate Ninja limits the save", async () => {
    await withApp({ rates: [rateRow("rate-hc-a")] }, async ({ base, origin, mock, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      mock.failNextPartner(429);
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields({ codeShareName: "Kept Share", quantity: "6" }),
      });
      assert.equal(saved.status, 200);
      const html = await saved.text();
      assert.match(html, /Rate Ninja is limiting requests\. Try again in a minute\./);
      assert.match(html, /value="Kept Share"/);
      assert.match(html, /value="6"/);
      assert.match(html, /name="codeShareName"/);
      assert.equal(html.includes("Enter an offer by hand"), false);
      assert.equal(Object.keys(diskOffers(recordsPath)).length, 0);
    });
  });
});
