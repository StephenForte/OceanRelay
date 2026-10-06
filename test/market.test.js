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
const { buyerView } = require("../lib/offer-domain");
const { filterMarket } = require("../lib/market");
const { parseDecimalToMinor } = require("../lib/money");
const {
  formatBuyerPrice,
  capacityLabel,
  formatCutoff,
  formatQuantity,
} = require("../lib/views/format");
const { renderDetail } = require("../lib/views/market");
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
    rate20D: 0,
    rate40D: 0,
    rate40HC: 1500,
    currency: null,
    rateEffectiveDate: "2026-09-01",
    rateExpirationDate: "2099-12-31",
    updatedAt: null,
    notes: "",
    ...overrides,
  };
}

function terms(extra = {}) {
  return {
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 4,
    unit: "container",
    sailingStart: "2026-12-01",
    sailingEnd: "2026-12-20",
    validityDeadline: "2026-12-31",
    currency: "USD",
    buyerMinor: 165000,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function entry(id, extra = {}, capacityStatus = "seller_asserted") {
  return {
    id,
    version: 1,
    companyId: extra.companyId || "co",
    view: buyerView({ ...terms(extra), capacityStatus }),
  };
}

describe("money parsing", () => {
  it("keeps the T4 decimal rules after the move to lib/money.js", () => {
    assert.deepEqual(parseDecimalToMinor("0.29", 2), { ok: true, minor: 29 });
    assert.deepEqual(parseDecimalToMinor("19.99", 2), { ok: true, minor: 1999 });
    assert.equal(parseDecimalToMinor("10.5", 0).ok, false);
    assert.equal(parseDecimalToMinor("1,000", 2).ok, false);
  });
});

describe("buyer formatting", () => {
  it("formats prices, capacity, cutoff, and quantity for buyers", () => {
    assert.equal(formatBuyerPrice(1204600, "USD"), "12,046.00 USD");
    assert.equal(formatBuyerPrice(100000, "JPY"), "100,000 JPY");
    assert.equal(capacityLabel("seller_asserted"), "Seller-asserted");
    assert.equal(capacityLabel("carrier_pending"), "Carrier pending");
    assert.equal(capacityLabel("carrier_confirmed"), "Carrier confirmed");
    assert.equal(formatCutoff(null), "Not stated");
    assert.equal(formatCutoff(""), "Not stated");
    assert.equal(formatQuantity(1, "container"), "1 container");
    assert.equal(formatQuantity(100, "container"), "100 containers");
    const confirmed = renderDetail({
      view: buyerView({ ...terms(), capacityStatus: "carrier_confirmed" }),
      version: 3,
      yours: false,
    });
    assert.match(confirmed, /Version 3/);
    assert.match(confirmed, /Seller-provided\. Not a carrier endorsement\./);
    assert.match(confirmed, /carrier can still roll, change, or cancel/);
    assert.equal(confirmed.includes("minor units"), false);
  });
});

describe("market filters", () => {
  const today = "2026-10-01";

  it("applies each filter, combinations, edges, price, case, unknown keys, and sort", () => {
    const base = entry("base");
    const other = entry("other", {
      origin: "SGSIN",
      destination: "NLRTM",
      equipment: "20D",
      operatingCarrier: "MSC",
      sailingStart: "2026-08-01",
      sailingEnd: "2026-08-15",
      currency: "JPY",
      buyerMinor: 50,
      codeShareName: "Other",
    }, "carrier_confirmed");

    assert.deepEqual(filterMarket([base, other], { origin: "sha" }, today).map((item) => item.id), ["base"]);
    assert.deepEqual(filterMarket([base, other], { destination: "rtm" }, today).map((item) => item.id), ["other"]);
    assert.deepEqual(filterMarket([base, other], { carrier: "msc" }, today).map((item) => item.id), ["other"]);
    assert.deepEqual(filterMarket([base, other], { equipment: "20D" }, today).map((item) => item.id), ["other"]);
    assert.deepEqual(filterMarket([base, other], { capacityStatus: "carrier_confirmed" }, today).map((item) => item.id), ["other"]);
    assert.deepEqual(filterMarket([base, other], { from: "2026-12-01", to: "2026-12-05" }, today).map((item) => item.id), ["base"]);

    const edge = entry("edge", { sailingStart: "2026-03-01", sailingEnd: "2026-03-10" });
    assert.equal(filterMarket([edge], { from: "2026-03-10", to: "2026-03-20" }, today).length, 1);
    assert.equal(filterMarket([edge], { from: "2026-03-11" }, today).length, 0);
    assert.equal(filterMarket([edge], { from: "2026-02-01", to: "2026-03-01" }, today).length, 1);
    assert.equal(filterMarket([edge], { to: "2026-02-28" }, today).length, 0);

    const priced = [
      entry("cheap", { buyerMinor: 10000, currency: "USD" }),
      entry("exact", { buyerMinor: 10000, currency: "USD", codeShareName: "Exact" }),
      entry("dear", { buyerMinor: 10001, currency: "USD", codeShareName: "Dear" }),
      entry("yen", { buyerMinor: 1, currency: "JPY", codeShareName: "Yen" }),
    ];
    assert.deepEqual(
      filterMarket(priced, { maxPrice: 10000, currency: "USD" }, today).map((item) => item.id),
      ["cheap", "exact"],
    );

    const combined = filterMarket([base, other], {
      origin: "CNSHA",
      destination: "USLAX",
      carrier: "ABC",
      equipment: "40HC",
      from: "2026-12-01",
      to: "2026-12-31",
      maxPrice: 165000,
      currency: "USD",
      capacityStatus: "seller_asserted",
    }, today);
    assert.deepEqual(combined.map((item) => item.id), ["base"]);

    const ignored = filterMarket([base, other], { originPort: "NOMATCH", noise: "x" }, today);
    assert.deepEqual(ignored.map((item) => item.id), ["other", "base"]);

    const early = entry("late-id", { sailingStart: "2026-02-01", sailingEnd: "2026-02-02" });
    const late = entry("early-id", { sailingStart: "2026-06-01", sailingEnd: "2026-06-02" });
    const tieB = entry("b", { sailingStart: "2026-04-01", sailingEnd: "2026-04-02" });
    const tieA = entry("a", { sailingStart: "2026-04-01", sailingEnd: "2026-04-02", codeShareName: "A" });
    assert.deepEqual(
      filterMarket([late, tieB, early, tieA], {}, today).map((item) => item.id),
      ["late-id", "a", "b", "early-id"],
    );

    const sameB = entry("same", { codeShareName: "B" });
    const sameA = entry("same", { codeShareName: "A" });
    sameB.mark = "b";
    sameA.mark = "a";
    assert.deepEqual(filterMarket([sameB, sameA], {}, today).map((item) => item.mark), ["b", "a"]);
  });
});

describe("published offer listing", () => {
  it("lists a published frozen offer on the deadline and drops it the next day", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-market-"));
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const created = records.createOffer({ companyId: "kings", sub: "user-owner" }, {
        source: "manual",
        terms: {
          ...terms({ validityDeadline: "2026-10-31", buyerMinor: 2000 }),
          source: "manual",
          baseMinor: 864201357,
          markup: { type: "absolute", minor: 97531 },
        },
        snapshot: { dto: { notes: "CANARY-NOTES-q7w" } },
        sourceRecordId: "CANARY-RATE-q7w",
        overriddenFields: [],
      });
      assert.equal(records.listPublishedOffers("2026-10-31").length, 0);
      records.setOfferState("kings", created.id, "published", "user-owner", "2026-10-31");
      const listed = records.listPublishedOffers("2026-10-31");
      assert.equal(listed.length, 1);
      assert.deepEqual(Object.keys(listed[0]).sort(), ["companyId", "id", "version", "view"]);
      assert.equal(listed[0].version, 1);
      assert.equal(listed[0].view.buyerPrice.minor, 2000);
      assert.equal(JSON.stringify(listed[0].view).includes("864201357"), false);
      assert.equal(JSON.stringify(listed[0].view).includes("CANARY-NOTES-q7w"), false);
      assert.equal(records.listPublishedOffers("2026-11-01").length, 0);

      records.transact((data) => {
        data.offers[created.id].versions[0].frozen = false;
        data.offers[created.id].versions[0].terms.validityDeadline = "2026-12-31";
      });
      assert.equal(records.listPublishedOffers("2026-10-31").length, 0);

      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(file, stamp, stamp);
      const before = fs.readFileSync(file);
      records.listPublishedOffers("2026-10-31");
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.statSync(file).mtimeMs, stamp.getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
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

async function withApp(options, run) {
  if (typeof options === "function") {
    run = options;
    options = {};
  }
  const { rates = [], sailings = [] } = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-market-http-"));
  const mock = createMockRateNinja({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    rates,
    sailings,
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
    await run({ base, origin, mock, store, records, recordsPath });
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

async function saveManual(base, cookie, fields) {
  const form = await pageOf(base, cookie, "/offers/new?source=manual");
  const saved = await postForm(base, cookie, "/offers", {
    csrf_token: form.csrf,
    source: "manual",
    equipment: "40HC",
    baseAmount: "20",
    ...sellerFields({ markupType: "absolute", markupValue: "0", ...fields }),
  });
  assert.equal(saved.status, 302);
  const location = saved.headers.get("location");
  const id = new URL(location, "http://127.0.0.1").pathname.split("/").pop();
  return { id, location };
}

function otherCompany(store) {
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
  return sessionCookie("sid-other", "csrf-other");
}

describe("marketplace", () => {
  it("lets another company find a published offer and hides everything else", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const home = await pageOf(base, cookie, "/");
      assert.match(home.html, /Marketplace/);
      const empty = await pageOf(base, cookie, "/market");
      assert.match(empty.html, /No published offers yet\./);

      const draft = await saveManual(base, cookie, { codeShareName: "Hidden Draft" });
      assert.match(draft.location, /result=saved_draft/);
      const draftPage = await pageOf(base, cookie, draft.location);
      assert.match(draftPage.html, /Saved as a draft \(version 1\)/);
      const marketDraft = await pageOf(base, cookie, "/market");
      assert.equal(marketDraft.html.includes("Hidden Draft"), false);
      assert.match(marketDraft.html, /No published offers yet\./);

      const preview = await pageOf(base, cookie, `/offers/${draft.id}`);
      const published = await postForm(base, cookie, `/offers/${draft.id}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      });
      assert.equal(published.status, 302);
      const sellerMarket = await pageOf(base, cookie, "/market");
      assert.match(sellerMarket.html, /Hidden Draft, operated by ABC/);
      assert.match(sellerMarket.html, /class="yours"/);
      const sellerDetail = await pageOf(base, cookie, `/market/${draft.id}`);
      assert.equal(sellerDetail.response.status, 200);
      assert.match(sellerDetail.html, /Version 1/);
      assert.match(sellerDetail.html, /Seller-provided\. Not a carrier endorsement\./);
      assert.match(sellerDetail.html, /Quantity is the seller(?:'|&#39;)s claim/);
      assert.equal(sellerDetail.html.includes("minor units"), false);

      const other = otherCompany(store);
      const buyerMarket = await pageOf(base, other, "/market");
      assert.match(buyerMarket.html, /Hidden Draft, operated by ABC/);
      assert.equal(buyerMarket.html.includes('class="yours"'), false);
      const buyerDetail = await pageOf(base, other, `/market/${draft.id}`);
      assert.equal(buyerDetail.response.status, 200);
      assert.match(buyerDetail.html, /4 containers/);
      assert.match(buyerDetail.html, /Not stated/);
      assert.match(buyerDetail.html, /Seller-asserted/);
      assert.equal(buyerDetail.html.includes("seller_asserted"), false);
      assert.equal(buyerDetail.html.includes("minor units"), false);
      const foreignOffer = await pageOf(base, other, `/offers/${draft.id}`);
      assert.equal(foreignOffer.response.status, 404);

      const kept = await pageOf(base, cookie, `/market?origin=CNSHA`);
      assert.match(kept.html, /value="CNSHA"/);
      assert.match(kept.html, /Hidden Draft/);
      const missed = await pageOf(base, cookie, "/market?origin=nowhere");
      assert.match(missed.html, /No offers match these filters/);
      assert.match(missed.html, /Clear filters/);
      assert.match(missed.html, /href="\/market"/);
      const priceError = await pageOf(base, cookie, "/market?maxPrice=10");
      assert.match(priceError.html, /Enter a currency for the maximum price\./);

      const before = fs.readFileSync(recordsPath);
      await pageOf(base, other, "/market");
      await pageOf(base, other, `/market/${draft.id}`);
      assert.deepEqual(fs.readFileSync(recordsPath), before);

      const pausedPost = await postForm(base, cookie, `/offers/${draft.id}/state`, {
        csrf_token: (await pageOf(base, cookie, `/offers/${draft.id}`)).csrf,
        to: "paused",
      });
      assert.equal(pausedPost.status, 302);
      const pausedList = await pageOf(base, other, "/market");
      assert.equal(pausedList.html.includes("Hidden Draft"), false);
      const pausedDetail = await pageOf(base, other, `/market/${draft.id}`);
      const unknownDetail = await pageOf(base, other, `/market/${crypto.randomUUID()}`);
      assert.equal(pausedDetail.response.status, 404);
      assert.equal(unknownDetail.response.status, 404);
      assert.equal(pausedDetail.html, unknownDetail.html);

      const resume = await postForm(base, cookie, `/offers/${draft.id}/state`, {
        csrf_token: (await pageOf(base, cookie, `/offers/${draft.id}`)).csrf,
        to: "published",
      });
      assert.equal(resume.status, 302);
      records.transact((data) => {
        data.offers[draft.id].versions[0].terms.validityDeadline = "2020-01-01";
      });
      const expiredDetail = await pageOf(base, other, `/market/${draft.id}`);
      const stillUnknown = await pageOf(base, other, `/market/${crypto.randomUUID()}`);
      const draftOnly = await saveManual(base, cookie, { codeShareName: "Still Draft" });
      const draftDetail = await pageOf(base, other, `/market/${draftOnly.id}`);
      assert.equal(expiredDetail.response.status, 404);
      assert.equal(draftDetail.response.status, 404);
      assert.equal(expiredDetail.html, stillUnknown.html);
      assert.equal(draftDetail.html, stillUnknown.html);
      assert.equal(expiredDetail.html.includes(draft.id), false);
      assert.equal(draftDetail.html.includes(draftOnly.id), false);
    });
  });

  it("does not leak seller-private values, and redirects when signed out", async () => {
    await withApp(async ({ base, origin, records }) => {
      const created = records.createOffer({ companyId: "CANARY-CO-q7w", sub: "CANARY-SUB-q7w" }, {
        source: "rn_rate",
        terms: {
          ...terms({
            codeShareName: "North Star",
            operatingCarrier: "MSC",
            buyerMinor: 864298888,
            serviceTerms: "Public terms",
          }),
          source: "rn_rate",
          baseMinor: 864201357,
          markup: { type: "absolute", minor: 97531 },
        },
        snapshot: { dto: { notes: "CANARY-NOTES-q7w" }, baseAmount: 1 },
        sourceRecordId: "CANARY-RATE-q7w",
        overriddenFields: [],
      });
      const published = records.setOfferState("CANARY-CO-q7w", created.id, "published", "CANARY-SUB-q7w", "2026-10-01");
      assert.equal(published.ok, true);

      const signedOutList = await fetch(new URL("/market", base), { redirect: "manual" });
      const signedOutDetail = await fetch(new URL(`/market/${created.id}`, base), { redirect: "manual" });
      const signedOutUnknown = await fetch(new URL(`/market/${crypto.randomUUID()}`, base), { redirect: "manual" });
      assert.equal(signedOutList.status, 302);
      assert.equal(signedOutDetail.status, 302);
      assert.equal(signedOutUnknown.status, 302);
      assert.equal(new URL(signedOutList.headers.get("location"), base).pathname, "/");
      assert.equal(signedOutDetail.headers.get("location"), signedOutUnknown.headers.get("location"));
      const signedOutBody = await signedOutDetail.text();
      assert.equal(signedOutBody.includes("North Star"), false);
      assert.equal(signedOutBody.includes("CANARY-CO-q7w"), false);

      const { cookie } = await connectOwner({ base, origin });
      const list = await pageOf(base, cookie, "/market");
      const detail = await pageOf(base, cookie, `/market/${created.id}`);
      for (const html of [list.html, detail.html]) {
        assert.match(html, /North Star, operated by MSC/);
        assert.equal(html.includes("864201357"), false);
        assert.equal(html.includes("97531"), false);
        assert.equal(html.includes("CANARY-NOTES-q7w"), false);
        assert.equal(html.includes("CANARY-RATE-q7w"), false);
        assert.equal(html.includes("CANARY-SUB-q7w"), false);
        assert.equal(html.includes("CANARY-CO-q7w"), false);
        assert.equal(html.includes("minor units"), false);
        assert.equal(html.includes('class="yours"'), false);
      }
      assert.match(detail.html, /8,642,988\.88 USD/);
      assert.match(detail.html, /Seller-provided\. Not a carrier endorsement\./);
    });
  });

  it("hides an unfrozen version while paused and lists it after resume", async () => {
    await withApp(async ({ base, origin, store }) => {
      const { cookie } = await connectOwner({ base, origin });
      const saved = await saveManual(base, cookie, { codeShareName: "Pause Lane" });
      const preview = await pageOf(base, cookie, `/offers/${saved.id}`);
      assert.equal((await postForm(base, cookie, `/offers/${saved.id}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      })).status, 302);
      const live = await pageOf(base, cookie, `/offers/${saved.id}`);
      assert.equal((await postForm(base, cookie, `/offers/${saved.id}/state`, {
        csrf_token: live.csrf,
        to: "paused",
      })).status, 302);
      const edit = await pageOf(base, cookie, `/offers/${saved.id}/edit`);
      const changed = await postForm(base, cookie, `/offers/${saved.id}/edit`, {
        csrf_token: edit.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({
          markupType: "absolute",
          markupValue: "0",
          codeShareName: "Changed Lane",
        }),
      });
      assert.equal(changed.status, 302);
      const other = otherCompany(store);
      const hidden = await pageOf(base, other, "/market");
      assert.equal(hidden.html.includes("Changed Lane"), false);
      assert.equal(hidden.html.includes("Pause Lane"), false);
      const missing = await pageOf(base, other, `/market/${saved.id}`);
      assert.equal(missing.response.status, 404);
      const paused = await pageOf(base, cookie, `/offers/${saved.id}`);
      assert.equal((await postForm(base, cookie, `/offers/${saved.id}/state`, {
        csrf_token: paused.csrf,
        to: "published",
      })).status, 302);
      const shown = await pageOf(base, other, "/market");
      assert.match(shown.html, /Changed Lane, operated by ABC/);
      const detail = await pageOf(base, other, `/market/${saved.id}`);
      assert.equal(detail.response.status, 200);
      assert.match(detail.html, /Version 2/);
      assert.match(detail.html, /Changed Lane, operated by MSC|Changed Lane, operated by ABC/);
    });
  });

  it("filters the rate chooser without another Rate Ninja call", async () => {
    const rates = [
      rateRow("rate-soon", {
        originPort: "Penang",
        destinationPort: "Savannah",
        carrier: "CMA",
        rate20D: 100,
        rate40HC: 0,
        rateExpirationDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      }),
      rateRow("rate-later", {
        originPort: "Hong Kong",
        destinationPort: "Long Beach",
        carrier: "MSC",
        rateExpirationDate: "2026-12-01",
      }),
      rateRow("rate-old", {
        originPort: "New York",
        destinationPort: "Rotterdam",
        carrier: "HMM",
        rateExpirationDate: "2020-01-01",
      }),
      rateRow("rate-unread", {
        originPort: "Rotterdam",
        destinationPort: "Singapore",
        carrier: "ONE",
        rateExpirationDate: "not-a-date",
      }),
    ];
    await withApp({ rates }, async ({ base, origin, mock }) => {
      const { cookie } = await connectOwner({ base, origin });
      const rateCalls = () => mock.requests.filter((req) => req.pathname === "/api/partner/v1/me/rates").length;
      const start = rateCalls();
      const chooser = await pageOf(base, cookie, "/offers/new");
      const plain = rateCalls() - start;
      assert.equal(plain, 1);
      const manualAt = chooser.html.indexOf("Enter an offer by hand");
      const listAt = chooser.html.indexOf('id="rate-list"');
      assert.ok(manualAt !== -1 && listAt !== -1 && manualAt < listAt);
      assert.match(chooser.html, /Showing 3 of 4 rates/);
      assert.equal(chooser.html.includes("rate-old"), false);
      assert.ok(chooser.html.indexOf("rate-soon") < chooser.html.indexOf("rate-later"));
      assert.ok(chooser.html.indexOf("rate-later") < chooser.html.indexOf("rate-unread"));
      assert.match(chooser.html, /Expiration date cannot be read/);

      const filtered = await pageOf(base, cookie, "/offers/new?origin=penang&destination=sav&carrier=cma&equipment=20D");
      assert.equal(rateCalls() - start - plain, 1);
      assert.match(filtered.html, /Showing 1 of 4 rates/);
      assert.match(filtered.html, /rate-soon/);
      assert.equal(filtered.html.includes("rate-later"), false);
      assert.match(filtered.html, /value="penang"/);
      assert.match(filtered.html, /value="cma"/);

      const expired = await pageOf(base, cookie, "/offers/new?showExpired=1");
      assert.match(expired.html, /Showing 4 of 4 rates/);
      assert.match(expired.html, /rate-old/);
      assert.ok(expired.html.indexOf("rate-old") < expired.html.indexOf("rate-soon"));
      assert.ok(expired.html.indexOf("rate-unread") > expired.html.indexOf("rate-later"));
    });
  });

  it("shows a save failure at the top and a fixed banner after a save", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const rejected = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ currency: "" }),
      });
      assert.equal(rejected.status, 200);
      const html = await rejected.text();
      assert.match(html, /Not saved\. Fix the \d+ fields marked below\./);
      assert.ok(html.indexOf("Not saved") < html.indexOf('id="currency"'));
      assert.match(html, /href="#currency"/);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(recordsPath, "utf8")).offers).length, 0);

      const saved = await saveManual(base, cookie, { codeShareName: "Banner Lane" });
      const created = await pageOf(base, cookie, saved.location);
      assert.match(created.html, /Saved as a draft \(version 1\)/);
      const edit = await pageOf(base, cookie, `/offers/${saved.id}/edit`);
      assert.match(edit.html, /This offer has not been published, so your changes update version 1\. After you publish, each change creates a new version\./);
      const preview = await pageOf(base, cookie, `/offers/${saved.id}`);
      assert.equal((await postForm(base, cookie, `/offers/${saved.id}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      })).status, 302);
      const afterPublish = await pageOf(base, cookie, `/offers/${saved.id}/edit`);
      assert.equal(afterPublish.html.includes("your changes update version 1"), false);
      const edited = await postForm(base, cookie, `/offers/${saved.id}/edit`, {
        csrf_token: afterPublish.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ markupType: "absolute", markupValue: "0", codeShareName: "Banner Lane", quantity: "5" }),
      });
      assert.equal(edited.status, 302);
      assert.match(edited.headers.get("location"), /result=saved_version/);
      const versionTwo = await pageOf(base, cookie, edited.headers.get("location"));
      assert.match(versionTwo.html, /Saved as version 2/);
      const unknown = await pageOf(base, cookie, `/offers/${saved.id}?result=nope`);
      assert.equal(unknown.html.includes("Saved as"), false);
      assert.equal(unknown.html.includes("nope"), false);
      const injected = await pageOf(base, cookie, `/offers/${saved.id}?result=${encodeURIComponent("<script>alert(1)</script>")}`);
      assert.equal(injected.html.includes("<script>"), false);
      assert.equal(injected.html.includes("alert(1)"), false);
      assert.equal(injected.html.includes("saved-banner"), false);
    });
  });

  it("counts only visible fields when a manual base price is zero", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const zero = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "0",
        ...sellerFields(),
      });
      assert.equal(zero.status, 200);
      const html = await zero.text();
      assert.match(html, /Not saved\. Fix the 1 field marked below\./);
      assert.equal(html.includes('href="#baseMinor"'), false);
      assert.match(html, /href="#baseAmount"/);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(recordsPath, "utf8")).offers).length, 0);

      const blank = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "",
        ...sellerFields(),
      });
      const blankHtml = await blank.text();
      assert.match(blankHtml, /Not saved\. Fix the 1 field marked below\./);
      assert.equal(blankHtml.includes('href="#baseMinor"'), false);

      const quantity = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ quantity: "" }),
      });
      const quantityHtml = await quantity.text();
      assert.match(quantityHtml, /Not saved\. Fix the 1 field marked below\./);
      assert.match(quantityHtml, /href="#quantity"/);
      assert.equal(quantityHtml.includes('href="#baseMinor"'), false);
    });
  });
});

describe("fully taken marketplace rows", () => {
  it("greys the whole row and shows one merged quantity line", () => {
    const { buyerView } = require("../lib/offer-domain");
    const { renderMarket } = require("../lib/views/market");
    const terms = {
      origin: "CNSHA",
      destination: "USLAX",
      equipment: "40HC",
      quantity: 10,
      unit: "container",
      sailingStart: "2026-12-20",
      sailingEnd: "2026-12-21",
      validityDeadline: "2099-12-31",
      currency: "USD",
      buyerMinor: 2000,
      codeShareName: "Taken Lane",
      operatingCarrier: "ABC",
      serviceTerms: "CY/CY",
      capacityStatus: "seller_asserted",
    };
    const view = buyerView(terms);
    const html = renderMarket({
      publishedCount: 2,
      query: {},
      results: [
        { id: "open-id", available: 4, yours: false, view: { ...view, codeShareLine: "Open Lane, operated by ABC" } },
        { id: "taken-id", available: 0, yours: false, view },
      ],
    });
    const { stylesheet } = require("../lib/views/styles");
    assert.equal(html.includes("<style"), false);
    assert.match(stylesheet, /body \{[^}]*color: #102a43/);
    assert.match(stylesheet, /li\.taken, li\.taken a, li\.taken p \{ color: #6b7280; \}/);
    assert.equal(stylesheet.includes("#334e68"), false);
    assert.equal(stylesheet.includes("#245b8a"), false);
    assert.equal(html.includes("#334e68"), false);
    assert.equal(html.includes("#245b8a"), false);
    const list = html.slice(html.indexOf('id="market-list"'));
    const rows = list.split("<li").slice(1);
    assert.equal(rows.length, 2);
    const taken = rows.find((row) => row.includes("taken-id"));
    const open = rows.find((row) => row.includes("open-id"));
    assert.match(taken, /^ class="taken"/);
    assert.equal(open.startsWith(" class=\"taken\""), false);
    for (const row of rows) {
      const lines = row.match(/containers available in OceanRelay — Seller&#39;s claim/g) || [];
      assert.equal(lines.length, 1);
      assert.equal(row.includes("containers — Seller&#39;s claim"), false);
    }
    assert.match(taken, /Fully taken/);
    assert.match(taken, /0 of 10 containers available in OceanRelay — Seller&#39;s claim/);
    assert.match(open, /4 of 10 containers available in OceanRelay — Seller&#39;s claim/);
    assert.equal(html.includes("Listed quantity"), false);
  });

  it("keeps dollar signs in a code-share line from rewriting the result list", () => {
    const { buyerView } = require("../lib/offer-domain");
    const { renderMarket } = require("../lib/views/market");
    const terms = {
      origin: "CNSHA",
      destination: "USLAX",
      equipment: "40HC",
      quantity: 10,
      unit: "container",
      sailingStart: "2026-12-20",
      sailingEnd: "2026-12-21",
      validityDeadline: "2099-12-31",
      currency: "USD",
      buyerMinor: 2000,
      codeShareName: "Taken Lane",
      operatingCarrier: "ABC",
      serviceTerms: "CY/CY",
      capacityStatus: "seller_asserted",
    };
    const view = buyerView(terms);
    view.codeShareLine = "Dollar $$ $& $` $' Lane, operated by ABC";
    const html = renderMarket({
      publishedCount: 1,
      query: {},
      results: [{ id: "dollar-id", available: 4, yours: false, view }],
    });
    assert.equal(html.includes("<!--results-->"), false);
    assert.equal((html.match(/id="market-filters"/g) || []).length, 1);
    assert.match(html, /Dollar \$\$ \$&amp; \$` \$&#39; Lane, operated by ABC/);
  });
});
