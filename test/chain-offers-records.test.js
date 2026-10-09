"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { keccak_256 } = require("@noble/hashes/sha3.js");
const { openRecords, M6_BAK_SUFFIX } = require("../lib/records");
const { buyerTermsCanonical } = require("../lib/terms-hash");
const { commitmentForVersion, expiresAtOf } = require("../lib/commitment");

const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const TODAY = "2026-10-08";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-records-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
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

function createDraft(records, spec = terms()) {
  return records.createOffer(SELLER, {
    source: "manual",
    terms: spec,
    snapshot: { secret: "do-not-commit", baseMinor: 1 },
    sourceRecordId: "rate-9",
    overriddenFields: ["origin"],
  });
}

function canonicalOf(offer, version, quantity = version.terms.quantity, unitBuyerMinor = version.terms.buyerMinor) {
  const viewTerms = version.terms;
  return buyerTermsCanonical({
    offerId: offer.id,
    version: version.n,
    counter: null,
    codeShareLine: `${viewTerms.codeShareName}, operated by ${viewTerms.operatingCarrier}`,
    origin: viewTerms.origin,
    destination: viewTerms.destination,
    equipment: viewTerms.equipment,
    unit: viewTerms.unit,
    quantity,
    sailingStart: viewTerms.sailingStart,
    sailingEnd: viewTerms.sailingEnd,
    cutoffDate: viewTerms.cutoffDate,
    validityDeadline: viewTerms.validityDeadline,
    currency: viewTerms.currency,
    unitBuyerMinor,
    totalMinor: quantity * unitBuyerMinor,
    serviceTerms: viewTerms.serviceTerms,
    capacityStatus: version.capacityStatus,
  });
}

function formula(canonical, salt) {
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest();
  const packed = Buffer.concat([Buffer.from(salt.slice(2), "hex"), digest]);
  return `0x${Buffer.from(keccak_256(packed)).toString("hex")}`;
}

function populatedV5() {
  return {
    schemaVersion: 5,
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
            terms: { origin: "CNSHA", destination: "USLAX", quantity: 4, buyerMinor: 2000, baseMinor: 1500, markup: { type: "absolute", minor: 500 } },
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
        state: "accepted",
        quantity: 2,
        buyerCompanyName: "Other",
        sellerCompanyName: "Kings",
        fulfilment: {
          status: "carrier_pending",
          history: [{ from: "accepted", to: "carrier_pending", note: "café", role: "seller" }],
          cancellation: null,
          cancellationEvents: [],
        },
      },
    },
    audit: [{ id: "a1", event: "offer.created", at: "2026-09-01T00:00:00.000Z", note: "kept" }],
    companies: {
      kings: {
        companyKey: `0x${"ab".repeat(32)}`,
        createdAt: "2026-10-01T00:00:00.000Z",
        wallets: [{
          wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          boundBy: "user-owner",
          state: "confirmed",
          deadline: 1893456000,
          txHash: `0x${"44".repeat(32)}`,
          error: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        }],
      },
    },
    future: { keep: true },
    operatorNote: "café",
  };
}

describe("schema 5 to 6", () => {
  it("keeps every v5 field and writes a backup", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const original = populatedV5();
      const bytes = Buffer.from(JSON.stringify(original));
      fs.writeFileSync(file, bytes);
      const records = openRecords(file);
      const bak = `${file}${M6_BAK_SUFFIX}`;
      assert.deepEqual(fs.readFileSync(bak), bytes);
      assert.equal(mode(bak), 0o600);
      assert.equal(fs.existsSync(`${file}.pre-m5.bak`), false);
      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(migrated.schemaVersion, 6);
      assert.equal(JSON.stringify(migrated.offers), JSON.stringify(original.offers));
      assert.equal(JSON.stringify(migrated.requests), JSON.stringify(original.requests));
      assert.equal(JSON.stringify(migrated.audit), JSON.stringify(original.audit));
      assert.equal(JSON.stringify(migrated.companies), JSON.stringify(original.companies));
      assert.deepEqual(migrated.future, original.future);
      assert.equal(migrated.operatorNote, original.operatorNote);
      assert.equal(migrated.offers["offer-1"].versions[1].terms.quantity, 6);
      assert.equal(migrated.requests["req-1"].fulfilment.history[0].note, "café");
      assert.equal(migrated.companies.kings.wallets[0].state, "confirmed");
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(file, stamp, stamp);
      const settled = fs.readFileSync(file);
      records.view(() => {});
      openRecords(file).view((data) => {
        assert.equal(data.schemaVersion, 6);
        assert.equal(data.companies.kings.companyKey, original.companies.kings.companyKey);
      });
      assert.deepEqual(fs.readFileSync(file), settled);
      assert.equal(fs.statSync(file).mtimeMs, stamp.getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("offer commitment", () => {
  it("matches the documented formula and ignores price secrets", () => {
    const dir = tempDir();
    try {
      const records = openRecords(path.join(dir, "records.json"));
      const offer = createDraft(records);
      const prepared = records.prepareChainOffer(SELLER.companyId, offer.id, SELLER.sub);
      assert.equal(prepared.ok, true);
      assert.match(prepared.offerKey, /^0x[0-9a-f]{64}$/);
      const again = records.prepareChainOffer(SELLER.companyId, offer.id, SELLER.sub);
      assert.equal(again.offerKey, prepared.offerKey);
      const chain = records.chainOfferFor(offer.id);
      const salt = chain.salts["1"];
      assert.match(salt, /^0x[0-9a-f]{64}$/);
      const version = offer.versions[0];
      const expected = formula(canonicalOf(offer, version), salt);
      assert.equal(records.commitmentFor(offer.id, 1), expected);
      assert.equal(commitmentForVersion(offer.id, version, salt), expected);
      assert.equal(expiresAtOf(version.terms.validityDeadline), Math.floor(Date.parse("2099-12-31T23:59:59Z") / 1000));

      records.transact((data) => {
        const stored = data.offers[offer.id].versions[0];
        stored.terms.baseMinor = 1;
        stored.terms.markup = { type: "bps", bps: 1 };
        stored.snapshot = { changed: true };
      });
      assert.equal(records.commitmentFor(offer.id, 1), expected);

      const buyerFields = ["origin", "destination", "equipment", "unit", "quantity", "sailingStart", "sailingEnd", "cutoffDate", "validityDeadline", "currency", "buyerMinor", "codeShareName", "operatingCarrier", "serviceTerms"];
      for (const field of buyerFields) {
        records.transact((data) => {
          const stored = data.offers[offer.id].versions[0].terms;
          if (field === "quantity") stored.quantity = 11;
          else if (field === "buyerMinor") stored.buyerMinor = 2600;
          else if (field === "cutoffDate") stored.cutoffDate = "2026-12-19";
          else stored[field] = `${stored[field]}-x`;
        });
        assert.notEqual(records.commitmentFor(offer.id, 1), expected, field);
        records.transact((data) => {
          data.offers[offer.id].versions[0].terms = structuredClone(version.terms);
          data.offers[offer.id].versions[0].terms.baseMinor = 1;
        });
        assert.equal(records.commitmentFor(offer.id, 1), expected, field);
      }
      records.transact((data) => {
        data.offers[offer.id].versions[0].capacityStatus = "carrier_confirmed";
      });
      assert.notEqual(records.commitmentFor(offer.id, 1), expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives two versions different commitments", () => {
    const dir = tempDir();
    try {
      const records = openRecords(path.join(dir, "records.json"));
      const offer = createDraft(records);
      records.prepareChainOffer(SELLER.companyId, offer.id, SELLER.sub);
      records.setOfferState(SELLER.companyId, offer.id, "published", SELLER.sub, TODAY);
      const edited = records.editOffer(SELLER.companyId, offer.id, {
        terms: terms({ quantity: 8 }),
      }, SELLER.sub, TODAY);
      assert.equal(edited.ok, true);
      records.transact((data) => {
        data.offers[offer.id].chain.confirmed = { version: 1, state: "published", stateSeq: 0 };
        data.offers[offer.id].chain.actions = [{
          id: "a",
          kind: "publish",
          version: 1,
          to: "published",
          seq: null,
          signer: null,
          deadline: 1,
          status: "confirmed",
          txHash: null,
          error: null,
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        }];
      });
      records.prepareChainOffer(SELLER.companyId, offer.id, SELLER.sub);
      const first = records.commitmentFor(offer.id, 1);
      const second = records.commitmentFor(offer.id, 2);
      assert.match(first, /^0x[0-9a-f]{64}$/);
      assert.match(second, /^0x[0-9a-f]{64}$/);
      assert.notEqual(first, second);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an off-chain publish inside the chain transaction without writing", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const offer = createDraft(records, terms({ validityDeadline: "2099-12-31" }));
      records.prepareChainOffer(SELLER.companyId, offer.id, SELLER.sub);
      const before = fs.readFileSync(file);
      const now = Math.floor(Date.parse("2099-06-01T00:00:00Z") / 1000);
      const begun = records.beginChainAction(SELLER.companyId, offer.id, {
        kind: "publish",
        version: 1,
        to: "published",
        seq: null,
        signer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        deadline: now + 60,
        actorSub: SELLER.sub,
      }, "2100-01-01", now);
      assert.equal(begun.ok, false);
      assert.equal(begun.error, "deadline_passed");
      assert.equal(fs.readFileSync(file).equals(before), true);
      assert.equal(records.getCompanyOffer(SELLER.companyId, offer.id).state, "draft");
      assert.equal(records.chainOfferFor(offer.id).actions.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
