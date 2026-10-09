"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openRecords, M7_BAK_SUFFIX } = require("../lib/records");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-requests-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function populatedV6() {
  return {
    schemaVersion: 6,
    offers: {
      "offer-1": {
        id: "offer-1",
        companyId: "kings",
        state: "published",
        currentVersion: 1,
        versions: [{ n: 1, terms: { quantity: 4, buyerMinor: 2500, baseMinor: 2000 }, frozen: true }],
        chain: {
          offerKey: `0x${"ab".repeat(32)}`,
          enabledAt: "2026-10-01T00:00:00.000Z",
          enabledBy: "user-owner",
          salts: { "1": `0x${"cd".repeat(32)}` },
          confirmed: { version: 1, state: "published", stateSeq: 0 },
          actions: [{
            id: "act-1",
            kind: "publish",
            version: 1,
            to: "published",
            seq: null,
            signer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            deadline: 1893456000,
            status: "confirmed",
            txHash: `0x${"44".repeat(32)}`,
            error: null,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          }],
        },
      },
    },
    requests: {
      "req-1": {
        id: "req-1",
        offerId: "offer-1",
        version: 1,
        state: "accepted",
        quantity: 2,
        buyerCompanyName: "Other",
        sellerCompanyName: "Kings",
        acceptance: { termsHash: "abc", quantity: 2, counter: null },
        fulfilment: {
          status: "carrier_pending",
          history: [{ from: "accepted", to: "carrier_pending", note: "café", role: "seller" }],
          cancellation: null,
          cancellationEvents: [{ event: "proposed", reason: "weather", role: "buyer" }],
        },
        custom: { keep: true },
      },
    },
    audit: [{ id: "a1", event: "request.accepted", at: "2026-10-02T00:00:00.000Z", note: "kept" }],
    companies: {
      kings: {
        companyKey: `0x${"11".repeat(32)}`,
        createdAt: "2026-10-01T00:00:00.000Z",
        wallets: [{ wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", state: "confirmed" }],
      },
    },
    future: { keep: true },
    operatorNote: "café",
  };
}

describe("schema 6 to 7", () => {
  it("keeps every v6 field and writes a backup", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const original = populatedV6();
      const bytes = Buffer.from(JSON.stringify(original));
      fs.writeFileSync(file, bytes);
      const records = openRecords(file);
      const bak = `${file}${M7_BAK_SUFFIX}`;
      assert.deepEqual(fs.readFileSync(bak), bytes);
      assert.equal(mode(bak), 0o600);
      assert.equal(fs.existsSync(`${file}.pre-m6.bak`), false);
      const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(migrated.schemaVersion, 7);
      assert.equal(JSON.stringify(migrated.offers), JSON.stringify(original.offers));
      assert.equal(JSON.stringify(migrated.requests), JSON.stringify(original.requests));
      assert.equal(JSON.stringify(migrated.audit), JSON.stringify(original.audit));
      assert.equal(JSON.stringify(migrated.companies), JSON.stringify(original.companies));
      assert.deepEqual(migrated.future, original.future);
      assert.equal(migrated.operatorNote, original.operatorNote);
      assert.equal(migrated.offers["offer-1"].chain.confirmed.state, "published");
      assert.equal(migrated.requests["req-1"].fulfilment.history[0].note, "café");
      assert.equal(migrated.requests["req-1"].fulfilment.cancellationEvents[0].reason, "weather");
      assert.equal(migrated.requests["req-1"].custom.keep, true);
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(file, stamp, stamp);
      const settled = fs.readFileSync(file);
      records.view(() => {});
      openRecords(file).view((data) => {
        assert.equal(data.schemaVersion, 7);
        assert.equal(data.offers["offer-1"].chain.offerKey, original.offers["offer-1"].chain.offerKey);
      });
      assert.deepEqual(fs.readFileSync(file), settled);
      assert.equal(fs.statSync(file).mtimeMs, stamp.getTime());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a chain request without signatures", () => {
    const dir = tempDir();
    try {
      const records = openRecords(path.join(dir, "records.json"));
      const signature = `0x${"aa".repeat(65)}`;
      records.transact((data) => {
        data.requests.req = {
          id: "req",
          buyerCompanyId: "buyer",
          sellerCompanyId: "seller",
          chain: {
            requestKey: `0x${"ab".repeat(32)}`,
            salts: { "0": `0x${"cd".repeat(32)}` },
            proposals: { "0": { signer: "0x1", signature, termsHash: "abc", deadline: 9, at: "t" } },
            cancelProposal: { signer: "0x2", signature, deadline: 9, at: "t" },
            confirmed: null,
            actions: [],
          },
        };
      });
      const chain = records.chainRequestFor("req");
      assert.equal(chain.proposals["0"].signature, undefined);
      assert.equal(chain.proposals["0"].termsHash, "abc");
      assert.equal(chain.cancelProposal.signature, undefined);
      assert.equal(chain.cancelProposal.signer, "0x2");
      assert.equal(chain.salts["0"], `0x${"cd".repeat(32)}`);
      assert.equal(JSON.stringify(chain).includes(signature), false);
      assert.equal(records.chainRequestFor("missing"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
