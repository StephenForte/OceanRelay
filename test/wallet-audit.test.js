"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { auditEntry, EVENTS } = require("../lib/audit");
const { openRecords } = require("../lib/records");

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-wallet-audit-"));
}

describe("wallet.bound", () => {
  it("keeps an EIP-55 wallet and drops anything else", () => {
    assert.equal(EVENTS.includes("wallet.bound"), true);
    const entry = auditEntry({
      event: "wallet.bound",
      actor: { sub: "user-owner", companyId: "kings", role: "user" },
      subject: { wallet: WALLET, offerId: "nope id", note: "secret" },
      detail: { reason: "access_denied", signature: "0xabc", wallet: WALLET },
    });
    assert.equal(entry.event, "wallet.bound");
    assert.deepEqual(entry.actor, { sub: "user-owner", companyId: "kings", role: "user" });
    assert.deepEqual(entry.subject, { wallet: WALLET });
    assert.deepEqual(entry.detail, {});
    assert.equal(JSON.stringify(entry).includes("0xabc"), false);
    const lower = auditEntry({
      event: "wallet.bound",
      actor: { sub: "user-owner", companyId: "kings", role: "user" },
      subject: { wallet: WALLET.toLowerCase() },
    });
    assert.deepEqual(lower.subject, {});
    const flipped = `0xF${WALLET.slice(3)}`;
    const bad = auditEntry({
      event: "wallet.bound",
      actor: { sub: "user-owner", companyId: "kings", role: "user" },
      subject: { wallet: flipped },
    });
    assert.deepEqual(bad.subject, {});
  });

  it("appends wallet.bound when a bind is confirmed", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      records.ensureCompanyKey("kings");
      const begun = records.beginWalletBind("kings", { wallet: WALLET, boundBy: "user-owner", deadline: 100 });
      assert.equal(begun.ok, true);
      const finished = records.finishWalletBind("kings", WALLET, {
        state: "confirmed",
        txHash: "0x" + "ab".repeat(32),
        error: null,
        audit: true,
      });
      assert.equal(finished.ok, true);
      const audit = JSON.parse(fs.readFileSync(file, "utf8")).audit;
      const entry = audit.at(-1);
      assert.equal(entry.event, "wallet.bound");
      assert.deepEqual(entry.actor, { sub: "user-owner", companyId: "kings", role: "user" });
      assert.deepEqual(entry.subject, { wallet: WALLET });
      assert.deepEqual(entry.detail, {});
      assert.equal(JSON.stringify(entry).includes("0x" + "ab".repeat(32)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
