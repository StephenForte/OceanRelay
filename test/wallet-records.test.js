"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openRecords, M5_BAK_SUFFIX } = require("../lib/records");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-wallet-records-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function populatedV4() {
  return {
    schemaVersion: 4,
    offers: {
      "offer-1": {
        id: "offer-1",
        companyId: "kings",
        createdBy: "user-owner",
        createdAt: "2026-09-01T00:00:00.000Z",
        state: "published",
        publishedAt: "2026-09-02T00:00:00.000Z",
        currentVersion: 2,
        versions: [
          {
            n: 1,
            createdAt: "2026-09-01T00:00:00.000Z",
            createdBy: "user-owner",
            source: "manual",
            terms: { origin: "CNSHA", destination: "USLAX", quantity: 4, buyerMinor: 2000 },
            snapshot: { dto: { notes: "keep" } },
            sourceRecordId: null,
            overriddenFields: ["origin"],
            capacityStatus: "seller_asserted",
            frozen: true,
          },
          {
            n: 2,
            createdAt: "2026-09-03T00:00:00.000Z",
            createdBy: "user-owner",
            source: "manual",
            terms: { origin: "CNSHA", destination: "USLAX", quantity: 6, buyerMinor: 2100 },
            snapshot: null,
            sourceRecordId: "rate-1",
            overriddenFields: [],
            capacityStatus: "carrier_confirmed",
            frozen: true,
          },
        ],
        statusHistory: [{ from: "seller_asserted", to: "carrier_confirmed", actor: "user-owner", at: "2026-09-03T00:00:00.000Z", version: 2 }],
        stateHistory: [{ from: "draft", to: "published", actor: "user-owner", at: "2026-09-02T00:00:00.000Z" }],
        customOffer: { keep: true },
      },
    },
    requests: {
      "req-1": {
        id: "req-1",
        offerId: "offer-1",
        version: 2,
        createdAt: "2026-09-04T00:00:00.000Z",
        sellerCompanyId: "kings",
        buyerCompanyId: "other",
        buyerSub: "user-buyer",
        buyerCompanyName: "Other",
        sellerCompanyName: "Kings",
        quantity: 2,
        state: "accepted",
        counters: [{ n: 1, quantity: 2, unitBuyerMinor: 2100, serviceTerms: "CY/CY", at: "2026-09-04T01:00:00.000Z", by: "user-owner" }],
        history: [{ from: "pending", to: "countered", actor: "user-owner", at: "2026-09-04T01:00:00.000Z", counter: 1 }],
        acceptance: { at: "2026-09-04T02:00:00.000Z", by: "user-buyer", quantity: 2, termsHash: "abc" },
        fulfilment: {
          status: "carrier_pending",
          history: [{
            from: "accepted",
            to: "carrier_pending",
            actorSub: "user-owner",
            actorCompanyId: "kings",
            role: "seller",
            at: "2026-09-05T00:00:00.000Z",
            note: "café",
          }],
          cancellation: null,
          cancellationEvents: [],
        },
      },
    },
    audit: [
      { id: "a1", at: "2026-09-01T00:00:00.000Z", event: "offer.created", actor: { sub: "user-owner", companyId: "kings", role: "seller" }, subject: { offerId: "offer-1" }, detail: { quantity: 4 } },
      { id: "a2", at: "2026-09-04T02:00:00.000Z", event: "request.accepted", note: "kept even if extra" },
    ],
    future: { keep: true },
    operatorNote: "café",
  };
}

describe("schema 4 to 5", () => {
  it("keeps every v4 field and writes a backup", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const original = populatedV4();
      const bytes = Buffer.from(JSON.stringify(original));
      fs.writeFileSync(file, bytes);
      const records = openRecords(file);
      const bak = `${file}${M5_BAK_SUFFIX}`;
      assert.deepEqual(fs.readFileSync(bak), bytes);
      assert.equal(mode(bak), 0o600);
      assert.equal(fs.existsSync(`${file}.pre-m4.bak`), false);
      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(migrated.schemaVersion, 5);
      assert.deepEqual(migrated.companies, {});
      assert.equal(JSON.stringify(migrated.offers), JSON.stringify(original.offers));
      assert.equal(JSON.stringify(migrated.requests), JSON.stringify(original.requests));
      assert.equal(JSON.stringify(migrated.audit), JSON.stringify(original.audit));
      assert.deepEqual(migrated.future, original.future);
      assert.equal(migrated.operatorNote, original.operatorNote);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(file, stamp, stamp);
      fs.utimesSync(bak, stamp, stamp);
      const settled = fs.readFileSync(file);
      const settledBak = fs.readFileSync(bak);
      records.view((data) => {
        assert.equal(data.schemaVersion, 5);
        assert.equal(data.offers["offer-1"].versions[1].terms.quantity, 6);
        assert.equal(data.requests["req-1"].fulfilment.history[0].note, "café");
      });
      openRecords(file).view((data) => {
        assert.equal(data.audit.length, 2);
      });
      assert.deepEqual(fs.readFileSync(file), settled);
      assert.deepEqual(fs.readFileSync(bak), settledBak);
      assert.equal(fs.statSync(file).mtimeMs, stamp.getTime());
      assert.equal(fs.statSync(bak).mtimeMs, stamp.getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing schema 5 backup", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 4, offers: {}, requests: {}, audit: [] }));
      fs.writeFileSync(`${file}${M5_BAK_SUFFIX}`, "sentinel-m5", { mode: 0o600 });
      openRecords(file);
      assert.equal(fs.readFileSync(`${file}${M5_BAK_SUFFIX}`, "utf8"), "sentinel-m5");
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).companies, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("company wallets", () => {
  it("creates a company key once inside a transaction and does not create one on read", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const before = fs.readFileSync(file);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(file, stamp, stamp);
      assert.equal(records.companyKeyFor("kings"), null);
      assert.deepEqual(records.walletsFor("kings"), []);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.statSync(file).mtimeMs, stamp.getTime());
      const first = records.ensureCompanyKey("kings");
      const second = records.ensureCompanyKey("kings");
      assert.equal(first.ok, true);
      assert.equal(first.created, true);
      assert.match(first.companyKey, /^0x[0-9a-f]{64}$/);
      assert.equal(second.created, false);
      assert.equal(second.companyKey, first.companyKey);
      assert.equal(records.companyKeyFor("kings"), first.companyKey);
      const other = records.ensureCompanyKey("other");
      assert.notEqual(other.companyKey, first.companyKey);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second in-flight bind, a sixth wallet, and a wallet already recorded", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      records.ensureCompanyKey("kings");
      const wallet = "0x1111111111111111111111111111111111111111";
      const started = records.beginWalletBind("kings", { wallet, boundBy: "user-owner", deadline: 100 });
      assert.equal(started.ok, true);
      assert.equal(records.walletsFor("kings")[0].state, "submitting");
      const second = records.beginWalletBind("kings", {
        wallet: "0x2222222222222222222222222222222222222222",
        boundBy: "user-owner",
        deadline: 100,
      });
      assert.deepEqual(second, { ok: false, error: "in_flight" });
      assert.equal(records.walletsFor("kings").length, 1);
      records.finishWalletBind("kings", wallet, { state: "confirmed", txHash: null, error: null, audit: false });
      const duplicate = records.beginWalletBind("kings", { wallet, boundBy: "user-owner", deadline: 100 });
      assert.deepEqual(duplicate, { ok: false, error: "already" });
      for (let i = 0; i < 4; i += 1) {
        const address = `0x${String(i + 3).padStart(40, "0")}`;
        const begun = records.beginWalletBind("kings", { wallet: address, boundBy: "user-owner", deadline: 100 });
        assert.equal(begun.ok, true, address);
        records.finishWalletBind("kings", address, { state: "confirmed", txHash: null, error: null, audit: false });
      }
      assert.equal(records.walletsFor("kings").filter((entry) => entry.state === "confirmed").length, 5);
      const capped = records.beginWalletBind("kings", {
        wallet: "0x9999999999999999999999999999999999999999",
        boundBy: "user-owner",
        deadline: 100,
      });
      assert.deepEqual(capped, { ok: false, error: "cap" });
      const copy = records.walletsFor("kings");
      copy[0].state = "tampered";
      assert.equal(records.walletsFor("kings")[0].state, "confirmed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
