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
const { openRecords, effectiveState } = require("../lib/records");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const ACTOR = "user-owner";
const COMPANY = "kings";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-versions-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function bakPath(file) {
  return `${file}.pre-m2.bak`;
}

function stampFiles(files) {
  const stamp = new Date("2020-01-01T00:00:00.000Z");
  for (const file of files) fs.utimesSync(file, stamp, stamp);
  return stamp.getTime();
}

function manualTerms(extra = {}) {
  return {
    source: "manual",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 4,
    unit: "container",
    sailingStart: "2026-12-20",
    sailingEnd: "2026-12-20",
    validityDeadline: "2026-12-01",
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

function rateTerms(extra = {}) {
  return {
    source: "rn_rate",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 4,
    unit: "container",
    sailingStart: "2026-12-20",
    sailingEnd: "2026-12-20",
    validityDeadline: "2026-12-01",
    currency: "USD",
    baseMinor: 150000,
    markup: { type: "percent", bps: 1000 },
    buyerMinor: 165000,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function current(offer) {
  return offer.versions.find((version) => version.n === offer.currentVersion);
}

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

function rateRow(id) {
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
  };
}

async function withApp(run) {
  const dir = tempDir();
  const mock = createMockRateNinja({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    rates: [rateRow("rate-hc-a")],
    sailings: [],
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
  return { cookie };
}

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

async function pageOf(base, cookie, target) {
  const response = await fetch(new URL(target, base), { headers: { cookie } });
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

describe("M-2 records migration", () => {
  it("migrates a populated v1 file forward and leaves a byte-identical bak", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const snapshot = {
        dto: { notes: "keep-me", originPort: "CNSHA" },
        equipment: "40HC",
        baseAmount: 1500,
        retrievedAt: "2026-09-01T00:00:00.000Z",
        seeded: { origin: "CNSHA", destination: "USLAX", carrier: "ABC", baseAmount: 1500 },
      };
      const rateOfferTerms = rateTerms();
      const handTerms = manualTerms({ codeShareName: "Hand Lane", baseMinor: 2000, buyerMinor: 2000 });
      const v1 = {
        schemaVersion: 1,
        offers: {
          "rate-1": {
            id: "rate-1",
            companyId: "kings",
            createdBy: "user-owner",
            createdAt: "2026-09-01T00:00:00.000Z",
            state: "draft",
            source: "rn_rate",
            terms: rateOfferTerms,
            snapshot,
            sourceRecordId: "rate-hc-a",
            overriddenFields: ["origin"],
            capacityStatus: "carrier_pending",
            statusHistory: [{
              from: "seller_asserted",
              to: "carrier_pending",
              actor: "user-owner",
              at: "2026-09-02T00:00:00.000Z",
              note: "kept",
            }],
            customOfferKey: { keep: true },
          },
          "man-1": {
            id: "man-1",
            companyId: "other",
            createdBy: "user-b",
            createdAt: "2026-09-03T00:00:00.000Z",
            state: "draft",
            source: "manual",
            terms: handTerms,
            snapshot: null,
            sourceRecordId: null,
            overriddenFields: [],
            capacityStatus: "seller_asserted",
            statusHistory: [],
          },
        },
        audit: [{ event: "noted", at: "2026-09-01T00:00:00.000Z" }],
        future: { keep: true },
        operatorNote: "café",
      };
      const original = Buffer.from(JSON.stringify(v1));
      fs.writeFileSync(file, original);
      const records = openRecords(file);
      const bak = bakPath(file);
      assert.deepEqual(fs.readFileSync(bak), original);
      assert.equal(mode(bak), 0o600);

      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(migrated.schemaVersion, 2);
      assert.deepEqual(migrated.audit, v1.audit);
      assert.equal(migrated.future.keep, true);
      assert.equal(migrated.operatorNote, "café");

      const rate = migrated.offers["rate-1"];
      assert.equal(rate.id, "rate-1");
      assert.equal(rate.companyId, "kings");
      assert.equal(rate.createdBy, "user-owner");
      assert.equal(rate.createdAt, "2026-09-01T00:00:00.000Z");
      assert.equal(rate.state, "draft");
      assert.equal(rate.publishedAt, null);
      assert.deepEqual(rate.stateHistory, []);
      assert.equal(rate.currentVersion, 1);
      assert.equal(rate.customOfferKey.keep, true);
      assert.equal(rate.terms, undefined);
      assert.equal(rate.snapshot, undefined);
      assert.equal(rate.source, undefined);
      const rateVersion = rate.versions[0];
      assert.equal(rateVersion.n, 1);
      assert.equal(rateVersion.frozen, false);
      assert.equal(rateVersion.source, "rn_rate");
      assert.equal(rateVersion.sourceRecordId, "rate-hc-a");
      assert.deepEqual(rateVersion.snapshot, snapshot);
      assert.deepEqual(rateVersion.terms, rateOfferTerms);
      assert.deepEqual(rateVersion.overriddenFields, ["origin"]);
      assert.equal(rateVersion.capacityStatus, "carrier_pending");
      assert.equal(rateVersion.statusHistory, undefined);
      assert.deepEqual(rate.statusHistory, [{
        from: "seller_asserted",
        to: "carrier_pending",
        actor: "user-owner",
        at: "2026-09-02T00:00:00.000Z",
        note: "kept",
        version: 1,
      }]);

      const hand = migrated.offers["man-1"];
      assert.equal(hand.companyId, "other");
      assert.equal(hand.createdBy, "user-b");
      assert.equal(current(hand).source, "manual");
      assert.equal(current(hand).snapshot, null);
      assert.equal(current(hand).sourceRecordId, null);
      assert.deepEqual(current(hand).terms, handTerms);
      assert.equal(current(hand).capacityStatus, "seller_asserted");
      assert.equal(current(hand).statusHistory, undefined);
      assert.deepEqual(hand.statusHistory, []);
      assert.deepEqual(hand.stateHistory, []);

      const settled = fs.readFileSync(file);
      const settledBak = fs.readFileSync(bak);
      const mtime = stampFiles([file, bak]);
      const again = openRecords(file);
      again.view((data) => {
        assert.equal(data.schemaVersion, 2);
        assert.equal(data.offers["rate-1"].customOfferKey.keep, true);
        assert.deepEqual(data.offers["rate-1"].versions[0].snapshot, snapshot);
      });
      assert.deepEqual(fs.readFileSync(file), settled);
      assert.deepEqual(fs.readFileSync(bak), settledBak);
      assert.equal(fs.statSync(file).mtimeMs, mtime);
      assert.equal(fs.statSync(bak).mtimeMs, mtime);
      assert.equal(records.filePath, file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates an empty v1 file and does not overwrite an existing bak", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "nested", "records.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const original = Buffer.from('{\n  "schemaVersion": 1,\n  "offers": {},\n  "audit": []\n}\n');
      fs.writeFileSync(file, original);
      openRecords(file);
      assert.deepEqual(fs.readFileSync(bakPath(file)), original);
      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(migrated.schemaVersion, 2);
      assert.deepEqual(migrated.offers, {});
      assert.deepEqual(migrated.audit, []);
      const settled = fs.readFileSync(file);
      const mtime = stampFiles([file, bakPath(file)]);
      openRecords(file);
      assert.deepEqual(fs.readFileSync(file), settled);
      assert.deepEqual(fs.readFileSync(bakPath(file)), original);
      assert.equal(fs.statSync(file).mtimeMs, mtime);
      assert.equal(fs.statSync(bakPath(file)).mtimeMs, mtime);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a bak that is already present", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const original = JSON.stringify({ schemaVersion: 1, offers: {}, audit: [{ event: "old" }] });
      fs.writeFileSync(file, original);
      fs.writeFileSync(bakPath(file), "sentinel-bak", { mode: 0o600 });
      openRecords(file);
      assert.equal(fs.readFileSync(bakPath(file), "utf8"), "sentinel-bak");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).audit, [{ event: "old" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a v2 file as-is and does not write a bak", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const body = JSON.stringify({
        schemaVersion: 2,
        offers: { a: { qty: 1, companyId: "kings" } },
        audit: [{ event: "x" }],
        future: { keep: true },
      });
      fs.writeFileSync(file, body);
      const mtime = stampFiles([file]);
      const records = openRecords(file);
      records.view((data) => {
        assert.equal(data.schemaVersion, 2);
        assert.equal(data.future.keep, true);
        assert.equal(data.offers.a.qty, 1);
        data.offers.a.qty = 9;
      });
      assert.equal(fs.readFileSync(file, "utf8"), body);
      assert.equal(fs.existsSync(bakPath(file)), false);
      assert.equal(fs.statSync(file).mtimeMs, mtime);
      records.view((data) => {
        assert.equal(data.offers.a.qty, 1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("records view", () => {
  it("does not persist and rejects an async callback", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      records.transact((data) => {
        data.audit.push({ event: "kept" });
      });
      const before = fs.readFileSync(file);
      const mtime = stampFiles([file]);
      assert.throws(() => records.view(async () => {}), /synchronous/);
      assert.throws(() => records.view(() => Promise.resolve(1)), /synchronous/);
      assert.throws(() => records.view(() => records.view(() => 1)), /nested/);
      assert.throws(() => records.transact(() => records.view(() => 1)), /nested/);
      assert.throws(() => records.transact(() => {
        records.transact(() => {});
      }), /transact cannot be nested/);
      const seen = records.view((data) => {
        data.audit.push({ event: "nope" });
        data.offers.leak = { qty: 1 };
        return data.audit.map((entry) => entry.event);
      });
      assert.deepEqual(seen, ["kept", "nope"]);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.statSync(file).mtimeMs, mtime);
      records.view((data) => {
        assert.deepEqual(data.audit, [{ event: "kept" }]);
        assert.equal(data.offers.leak, undefined);
      });
      records.transact((data) => {
        assert.deepEqual(data.audit, [{ event: "kept" }]);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("versioned offers", () => {
  it("edits version 1 in place before publish and keeps that version byte-identical afterwards", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const created = records.createOffer(
        { companyId: COMPANY, sub: ACTOR },
        { source: "manual", terms: manualTerms(), snapshot: null, sourceRecordId: null, overriddenFields: [] },
      );
      assert.equal(created.state, "draft");
      assert.equal(created.publishedAt, null);
      assert.equal(created.versions.length, 1);
      assert.equal(created.versions[0].frozen, false);

      const edited = records.editOffer(COMPANY, created.id, {
        terms: manualTerms({ quantity: 9 }),
        overriddenFields: [],
      }, ACTOR, "2026-10-01");
      assert.equal(edited.ok, true);
      assert.equal(edited.offer.versions.length, 1);
      assert.equal(edited.offer.currentVersion, 1);
      assert.equal(edited.offer.versions[0].n, 1);
      assert.equal(edited.offer.versions[0].terms.quantity, 9);
      assert.equal(edited.offer.versions[0].frozen, false);

      const published = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-10-01");
      assert.equal(published.ok, true);
      assert.equal(published.offer.state, "published");
      assert.equal(published.offer.versions[0].frozen, true);
      assert.equal(typeof published.offer.publishedAt, "string");
      const frozen = JSON.stringify(records.getCompanyOffer(COMPANY, created.id).versions[0]);

      const renamed = records.editOffer(COMPANY, created.id, {
        terms: manualTerms({ quantity: 9, codeShareName: "Next" }),
        overriddenFields: [],
      }, "user-editor", "2026-10-02");
      assert.equal(renamed.ok, true);
      assert.equal(renamed.offer.currentVersion, 2);
      assert.equal(renamed.offer.versions[1].frozen, true);
      assert.equal(renamed.offer.versions[1].terms.codeShareName, "Next");
      assert.equal(renamed.offer.versions[1].terms.baseMinor, 2000);

      const pending = records.setCapacityStatus(COMPANY, created.id, "carrier_pending", ACTOR);
      assert.equal(pending.ok, true);
      assert.equal(pending.offer.currentVersion, 3);
      assert.equal(pending.offer.versions[2].capacityStatus, "carrier_pending");
      assert.equal(pending.offer.versions[2].frozen, true);
      assert.equal(pending.offer.statusHistory.at(-1).version, 3);
      assert.equal(pending.offer.statusHistory.at(-1).to, "carrier_pending");

      const confirmed = records.setCapacityStatus(COMPANY, created.id, "carrier_confirmed", ACTOR);
      assert.equal(confirmed.ok, true);
      assert.equal(confirmed.offer.versions.length, 4);
      assert.equal(confirmed.offer.currentVersion, 4);
      assert.equal(confirmed.offer.versions[3].capacityStatus, "carrier_confirmed");
      assert.equal(confirmed.offer.versions[3].frozen, true);
      assert.equal(JSON.stringify(confirmed.offer.versions[0]), frozen);
      assert.equal(JSON.stringify(records.getCompanyOffer(COMPANY, created.id).versions[0]), frozen);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a rate snapshot and base price when an edit posts different price fields", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const snapshot = { baseAmount: 1500, dto: { notes: "keep-me" }, retrievedAt: "2026-09-01T00:00:00.000Z" };
      const created = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "rn_rate",
        terms: rateTerms(),
        snapshot,
        sourceRecordId: "rate-hc-a",
        overriddenFields: [],
      });
      const tampered = {
        ...rateTerms({ codeShareName: "Renamed", baseMinor: 1, buyerMinor: 1, equipment: "20D", source: "manual" }),
        snapshot: { baseAmount: 1 },
        companyId: "intruder",
      };
      const edited = records.editOffer(COMPANY, created.id, {
        terms: tampered,
        overriddenFields: ["origin"],
        snapshot: { baseAmount: 1 },
        source: "manual",
        sourceRecordId: "forged",
        baseMinor: 1,
      }, ACTOR, "2026-10-01");
      assert.equal(edited.ok, true);
      const version = edited.offer.versions[0];
      assert.equal(version.terms.baseMinor, 150000);
      assert.equal(version.terms.buyerMinor, 165000);
      assert.equal(version.terms.equipment, "40HC");
      assert.equal(version.terms.source, "rn_rate");
      assert.equal(version.terms.codeShareName, "Renamed");
      assert.equal(version.terms.companyId, undefined);
      assert.equal(version.terms.snapshot, undefined);
      assert.deepEqual(version.snapshot, snapshot);
      assert.equal(version.source, "rn_rate");
      assert.equal(version.sourceRecordId, "rate-hc-a");

      const manual = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "manual",
        terms: manualTerms(),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const repriced = records.editOffer(COMPANY, manual.id, {
        terms: manualTerms({ baseMinor: 3000, buyerMinor: 1 }),
        overriddenFields: [],
      }, ACTOR, "2026-10-01");
      assert.equal(repriced.offer.versions[0].terms.baseMinor, 3000);
      assert.equal(repriced.offer.versions[0].terms.buyerMinor, 3000);
      assert.equal(repriced.offer.versions[0].snapshot, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows draft, published, and paused moves and refuses the others without writing", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const created = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "manual",
        terms: manualTerms(),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const beforeIllegal = fs.readFileSync(file);
      const draftPause = records.setOfferState(COMPANY, created.id, "paused", ACTOR, "2026-10-01");
      assert.deepEqual(draftPause, { ok: false, error: "illegal_transition" });
      assert.deepEqual(fs.readFileSync(file), beforeIllegal);
      assert.equal(records.getCompanyOffer(COMPANY, created.id).state, "draft");
      assert.deepEqual(records.getCompanyOffer(COMPANY, created.id).stateHistory, []);

      const published = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-10-01");
      const paused = records.setOfferState(COMPANY, created.id, "paused", ACTOR, "2026-10-02");
      const resumed = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-10-03");
      assert.equal(published.ok, true);
      assert.equal(paused.ok, true);
      assert.equal(resumed.ok, true);
      assert.equal(resumed.offer.publishedAt, published.offer.publishedAt);
      assert.deepEqual(resumed.offer.stateHistory.map((entry) => entry.from), ["draft", "published", "paused"]);
      assert.deepEqual(resumed.offer.stateHistory.map((entry) => entry.to), ["published", "paused", "published"]);
      assert.deepEqual(resumed.offer.stateHistory.map((entry) => entry.actor), [ACTOR, ACTOR, ACTOR]);
      assert.equal(resumed.offer.stateHistory.every((entry) => entry.version === undefined), true);
      assert.equal(resumed.offer.stateHistory.every((entry) => Number.isNaN(Date.parse(entry.at)) === false), true);

      const beforeBack = fs.readFileSync(file);
      const backToDraft = records.setOfferState(COMPANY, created.id, "draft", ACTOR, "2026-10-03");
      assert.deepEqual(backToDraft, { ok: false, error: "illegal_transition" });
      assert.deepEqual(fs.readFileSync(file), beforeBack);
      assert.equal(records.getCompanyOffer(COMPANY, created.id).state, "published");
      assert.equal(records.getCompanyOffer(COMPANY, created.id).stateHistory.length, 3);

      const pausedOffer = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "manual",
        terms: manualTerms({ codeShareName: "Paused" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      records.setOfferState(COMPANY, pausedOffer.id, "published", ACTOR, "2026-10-01");
      const pausedFrozen = JSON.stringify(records.getCompanyOffer(COMPANY, pausedOffer.id).versions[0]);
      records.setOfferState(COMPANY, pausedOffer.id, "paused", ACTOR, "2026-10-01");
      const whilePaused = records.editOffer(COMPANY, pausedOffer.id, {
        terms: manualTerms({ codeShareName: "Paused", quantity: 6 }),
        overriddenFields: [],
      }, ACTOR, "2026-10-02");
      assert.equal(whilePaused.offer.currentVersion, 2);
      assert.equal(whilePaused.offer.versions[1].frozen, false);
      const stillPaused = records.editOffer(COMPANY, pausedOffer.id, {
        terms: manualTerms({ codeShareName: "Paused", quantity: 7 }),
        overriddenFields: [],
      }, ACTOR, "2026-10-02");
      assert.equal(stillPaused.offer.versions.length, 3);
      assert.equal(stillPaused.offer.currentVersion, 3);
      assert.equal(stillPaused.offer.versions[2].frozen, false);
      assert.equal(stillPaused.offer.versions[2].terms.quantity, 7);
      assert.equal(stillPaused.offer.versions[1].terms.quantity, 6);
      const resumedAfterEdit = records.setOfferState(COMPANY, pausedOffer.id, "published", ACTOR, "2026-10-03");
      assert.equal(resumedAfterEdit.offer.versions[2].frozen, true);
      assert.equal(JSON.stringify(resumedAfterEdit.offer.versions[0]), pausedFrozen);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats the deadline as valid and the next UTC day as expired", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const created = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "manual",
        terms: manualTerms({ validityDeadline: "2026-10-31" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const published = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-10-31");
      assert.equal(published.ok, true);
      const live = records.getCompanyOffer(COMPANY, created.id);
      assert.equal(effectiveState(live, "2026-10-31"), "published");
      assert.equal(records.effectiveState(live, "2026-10-31"), "published");
      assert.equal(records.effectiveState(live, "2026-11-01"), "expired");
      assert.equal(live.state, "published");

      records.setOfferState(COMPANY, created.id, "paused", ACTOR, "2026-10-31");
      const before = fs.readFileSync(file);
      const resume = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-11-01");
      const edit = records.editOffer(COMPANY, created.id, {
        terms: manualTerms({ validityDeadline: "2026-10-31", quantity: 8 }),
        overriddenFields: [],
      }, ACTOR, "2026-11-01");
      const republish = records.setOfferState(COMPANY, created.id, "published", ACTOR, "2026-11-01");
      assert.deepEqual(resume, { ok: false, error: "expired" });
      assert.deepEqual(edit, { ok: false, error: "expired" });
      assert.deepEqual(republish, { ok: false, error: "expired" });
      assert.deepEqual(fs.readFileSync(file), before);
      const stored = records.getCompanyOffer(COMPANY, created.id);
      assert.equal(stored.state, "paused");
      assert.equal(current(stored).terms.quantity, 4);
      assert.equal(stored.versions.length, 1);

      const draft = records.createOffer({ companyId: COMPANY, sub: ACTOR }, {
        source: "manual",
        terms: manualTerms({ validityDeadline: "2026-10-31" }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      assert.equal(records.effectiveState(records.getCompanyOffer(COMPANY, draft.id), "2026-11-01"), "draft");
      const late = records.setOfferState(COMPANY, draft.id, "published", ACTOR, "2026-11-01");
      assert.equal(late.ok, true);
      assert.equal(late.offer.state, "published");
      assert.equal(records.effectiveState(late.offer, "2026-11-01"), "expired");
      const beforeLate = fs.readFileSync(file);
      const lateEdit = records.editOffer(COMPANY, draft.id, {
        terms: manualTerms({ validityDeadline: "2026-10-31", quantity: 8 }),
        overriddenFields: [],
      }, ACTOR, "2026-11-01");
      const latePause = records.setOfferState(COMPANY, draft.id, "paused", ACTOR, "2026-11-01");
      assert.deepEqual(lateEdit, { ok: false, error: "expired" });
      assert.deepEqual(latePause, { ok: false, error: "expired" });
      assert.deepEqual(fs.readFileSync(file), beforeLate);
      assert.equal(records.getCompanyOffer(COMPANY, draft.id).state, "published");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seller version screens", () => {
  it("does not rewrite the records file on the list or the preview", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ markupType: "absolute", markupValue: "0" }),
      });
      assert.equal(saved.status, 302);
      const before = fs.readFileSync(recordsPath);
      const mtime = stampFiles([recordsPath]);
      const list = await pageOf(base, cookie, "/offers");
      const preview = await pageOf(base, cookie, saved.headers.get("location"));
      assert.equal(list.response.status, 200);
      assert.equal(preview.response.status, 200);
      assert.match(list.html, /draft · version 1/);
      assert.match(preview.html, /id="offer-version">1/);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, mtime);
    });
  });

  it("publishes, pauses, resumes, and refuses an illegal move", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({ markupType: "absolute", markupValue: "0" }),
      });
      const id = saved.headers.get("location").split("/").pop();
      const draft = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(draft.html, />Publish</);
      assert.equal(draft.html.includes(">Pause<"), false);
      assert.match(draft.html, /id="offer-state">draft/);
      const beforePause = fs.readFileSync(recordsPath);
      const pausedEarly = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: draft.csrf,
        to: "paused",
      });
      assert.equal(pausedEarly.status, 400);
      assert.match(await pausedEarly.text(), /not allowed/);
      assert.deepEqual(fs.readFileSync(recordsPath), beforePause);

      const published = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: draft.csrf,
        to: "published",
      });
      assert.equal(published.status, 302);
      const live = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(live.html, /id="offer-state">published/);
      assert.match(live.html, />Pause</);
      assert.match(live.html, /id="version-list"/);
      assert.match(live.html, /Initial version/);
      const paused = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: live.csrf,
        to: "paused",
      });
      assert.equal(paused.status, 302);
      const held = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(held.html, /id="offer-state">paused/);
      assert.match(held.html, />Resume</);
      const beforeDraft = fs.readFileSync(recordsPath);
      const drafted = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: held.csrf,
        to: "draft",
      });
      assert.equal(drafted.status, 400);
      assert.deepEqual(fs.readFileSync(recordsPath), beforeDraft);
      const resumed = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: held.csrf,
        to: "published",
      });
      assert.equal(resumed.status, 302);
      const offer = openRecords(recordsPath).getCompanyOffer("kings", id);
      assert.equal(offer.state, "published");
      assert.deepEqual(offer.stateHistory.map((entry) => entry.to), ["published", "paused", "published"]);
      const list = await pageOf(base, cookie, "/offers");
      assert.match(list.html, /published · version 1/);
    });
  });

  it("keeps the Rate Ninja price when the edit form posts a different one", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=rn_rate&rateId=rate-hc-a&equipment=40HC");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "rn_rate",
        rateId: "rate-hc-a",
        equipment: "40HC",
        ...sellerFields(),
      });
      const location = saved.headers.get("location");
      const edit = await pageOf(base, cookie, `${location}/edit`);
      assert.equal(edit.response.status, 200);
      assert.match(edit.html, /value="XYZ"/);
      assert.match(edit.html, /value="4"/);
      assert.match(edit.html, /1500\.00 USD/);
      assert.match(edit.html, /This price cannot be edited/);
      assert.match(edit.html, /snapshot-note-private/);
      assert.equal(edit.html.includes('name="baseMinor"'), false);
      assert.equal(edit.html.includes('name="baseAmount"'), false);
      assert.equal(edit.html.includes('name="snapshot"'), false);
      const posted = await postForm(base, cookie, `${location}/edit`, {
        csrf_token: edit.csrf,
        source: "manual",
        equipment: "20D",
        ...sellerFields({ codeShareName: "Renamed", quantity: "9" }),
        baseMinor: "1",
        baseAmount: "1",
        snapshot: JSON.stringify({ baseAmount: 1, dto: { notes: "forged" } }),
        companyId: "intruder",
      });
      assert.equal(posted.status, 302);
      const offer = openRecords(recordsPath).getCompanyOffer("kings", location.split("/").pop());
      assert.equal(offer.companyId, "kings");
      assert.equal(offer.versions.length, 1);
      const version = current(offer);
      assert.equal(version.terms.baseMinor, 150000);
      assert.equal(version.terms.buyerMinor, 165000);
      assert.equal(version.terms.quantity, 9);
      assert.equal(version.terms.codeShareName, "Renamed");
      assert.equal(version.terms.equipment, "40HC");
      assert.equal(version.snapshot.baseAmount, 1500);
      assert.equal(version.snapshot.dto.notes, "snapshot-note-private");
      assert.equal(version.sourceRecordId, "rate-hc-a");

      const preview = await pageOf(base, cookie, location);
      const published = await postForm(base, cookie, `${location}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      });
      assert.equal(published.status, 302);
      const frozen = JSON.stringify(openRecords(recordsPath).getCompanyOffer("kings", offer.id).versions[0]);
      const again = await pageOf(base, cookie, `${location}/edit`);
      const second = await postForm(base, cookie, `${location}/edit`, {
        csrf_token: again.csrf,
        ...sellerFields({ codeShareName: "After", quantity: "9" }),
        baseMinor: "2",
        baseAmount: "2",
        snapshot: "{\"baseAmount\":2}",
      });
      assert.equal(second.status, 302);
      const stored = openRecords(recordsPath).getCompanyOffer("kings", offer.id);
      assert.equal(JSON.stringify(stored.versions[0]), frozen);
      assert.equal(stored.currentVersion, 2);
      assert.equal(stored.versions[1].terms.baseMinor, 150000);
      assert.equal(stored.versions[1].terms.codeShareName, "After");
      assert.deepEqual(stored.versions[1].snapshot, stored.versions[0].snapshot);
      const shown = await pageOf(base, cookie, location);
      assert.match(shown.html, /id="offer-version">2/);
      assert.match(shown.html, /code-share name Renamed → After/);
    });
  });

  it("refuses publish and edit once the deadline has passed", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
        ...sellerFields({
          markupType: "absolute",
          markupValue: "0",
          validityDeadline: "2020-01-01",
        }),
      });
      assert.equal(saved.status, 302);
      const id = saved.headers.get("location").split("/").pop();
      const preview = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(preview.html, /id="offer-state">draft/);
      assert.match(preview.html, />Publish</);
      const published = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: preview.csrf,
        to: "published",
      });
      assert.equal(published.status, 302);
      const expired = await pageOf(base, cookie, `/offers/${id}`);
      assert.match(expired.html, /id="offer-state">expired/);
      assert.equal(expired.html.includes(">Pause<"), false);
      assert.equal(expired.html.includes(">Publish<"), false);
      const before = fs.readFileSync(recordsPath);
      const pause = await postForm(base, cookie, `/offers/${id}/state`, {
        csrf_token: expired.csrf,
        to: "paused",
      });
      assert.equal(pause.status, 400);
      assert.match(await pause.text(), /expired/);
      const edit = await pageOf(base, cookie, `/offers/${id}/edit`);
      assert.equal(edit.response.status, 400);
      const posted = await postForm(base, cookie, `/offers/${id}/edit`, {
        csrf_token: expired.csrf,
        ...sellerFields({ quantity: "8", validityDeadline: "2020-01-01", markupType: "absolute", markupValue: "0" }),
        source: "manual",
        equipment: "40HC",
        baseAmount: "20",
      });
      assert.equal(posted.status, 400);
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      const offer = openRecords(recordsPath).getCompanyOffer("kings", id);
      assert.equal(offer.state, "published");
      assert.equal(effectiveState(offer, new Date().toISOString().slice(0, 10)), "expired");
      assert.equal(current(offer).terms.quantity, 4);
    });
  });

  it("returns 404 for another company's edit and state changes and persists nothing", async () => {
    await withApp(async ({ base, origin, store, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "20D",
        baseAmount: "10",
        ...sellerFields({ markupType: "absolute", markupValue: "0", codeShareName: "Hidden Lane" }),
      });
      const id = saved.headers.get("location").split("/").pop();
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
      const before = fs.readFileSync(recordsPath);
      const foreignGet = await pageOf(base, otherCookie, `/offers/${id}/edit`);
      const unknownGet = await pageOf(base, cookie, `/offers/${crypto.randomUUID()}/edit`);
      assert.equal(foreignGet.response.status, 404);
      assert.equal(unknownGet.response.status, 404);
      assert.equal(foreignGet.html, unknownGet.html);
      const foreignPost = await postForm(base, otherCookie, `/offers/${id}/edit`, {
        csrf_token: "csrf-other",
        ...sellerFields(),
        source: "manual",
        equipment: "20D",
        baseAmount: "99",
      });
      const unknownPost = await postForm(base, cookie, `/offers/${crypto.randomUUID()}/edit`, {
        csrf_token: form.csrf,
        ...sellerFields(),
        source: "manual",
        equipment: "20D",
        baseAmount: "99",
      });
      assert.equal(foreignPost.status, 404);
      assert.equal(unknownPost.status, 404);
      assert.equal(await foreignPost.text(), await unknownPost.text());
      const foreignState = await postForm(base, otherCookie, `/offers/${id}/state`, {
        csrf_token: "csrf-other",
        to: "published",
      });
      const unknownState = await postForm(base, cookie, `/offers/${crypto.randomUUID()}/state`, {
        csrf_token: form.csrf,
        to: "published",
      });
      assert.equal(foreignState.status, 404);
      assert.equal(unknownState.status, 404);
      assert.equal(await foreignState.text(), await unknownState.text());
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(openRecords(recordsPath).getCompanyOffer("kings", id).state, "draft");
    });
  });

  it("rejects an edit or state change that has no CSRF token", async () => {
    await withApp(async ({ base, origin, recordsPath }) => {
      const { cookie } = await connectOwner({ base, origin });
      const form = await pageOf(base, cookie, "/offers/new?source=manual");
      const saved = await postForm(base, cookie, "/offers", {
        csrf_token: form.csrf,
        source: "manual",
        equipment: "40HC",
        baseAmount: "15",
        ...sellerFields({ markupType: "absolute", markupValue: "0" }),
      });
      const id = saved.headers.get("location").split("/").pop();
      const before = fs.readFileSync(recordsPath);
      const edit = await postForm(base, cookie, `/offers/${id}/edit`, {
        ...sellerFields(),
        source: "manual",
        equipment: "40HC",
        baseAmount: "15",
      });
      const state = await postForm(base, cookie, `/offers/${id}/state`, { to: "published" });
      assert.equal(edit.status, 403);
      assert.equal(state.status, 403);
      assert.deepEqual(JSON.parse(await edit.text()), { error: "invalid_csrf" });
      assert.deepEqual(JSON.parse(await state.text()), { error: "invalid_csrf" });
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(openRecords(recordsPath).getCompanyOffer("kings", id).state, "draft");
    });
  });
});
