const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession, readSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { openRecords, M4_BAK_SUFFIX } = require("../lib/records");
const { createMockRateNinja } = require("./mock-rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const TODAY = "2026-10-01";
const V3_COMMIT = "bafe338060f978d656a9faa0b6cd42ec00e81463";
const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const BUYER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const THIRD = { companyId: "third-co", sub: "user-third", companyName: "Third Co" };
const MARKUP = "<img src=x onerror=alert(1)>";
const AGREEMENT = "Accepted in OceanRelay means a marketplace agreement. It is not a carrier booking.";
const DISPUTE = "Unresolved dispute. No fee and no payment moves in OceanRelay.";
const INITIAL = { status: "accepted", history: [], cancellation: null, cancellationEvents: [] };

// D-20's table, written out here so a drifted implementation fails these tests.
const EDGES = [
  ["accepted", "carrier_pending"],
  ["accepted", "carrier_confirmed"],
  ["carrier_pending", "carrier_confirmed"],
  ["carrier_pending", "rejected"],
  ["carrier_confirmed", "rolled"],
  ["carrier_confirmed", "completed"],
  ["carrier_confirmed", "rejected"],
  ["rolled", "carrier_pending"],
  ["rolled", "carrier_confirmed"],
];
const REACH = {
  accepted: [],
  carrier_pending: ["carrier_pending"],
  carrier_confirmed: ["carrier_confirmed"],
  rejected: ["carrier_pending", "rejected"],
  rolled: ["carrier_confirmed", "rolled"],
  completed: ["carrier_confirmed", "completed"],
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-fulfilment-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
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

function publish(records, terms = manualTerms(), seller = SELLER) {
  const created = records.createOffer(seller, {
    source: terms.source,
    terms,
    snapshot: null,
    sourceRecordId: null,
    overriddenFields: [],
  });
  const published = records.setOfferState(seller.companyId, created.id, "published", seller.sub, TODAY);
  assert.equal(published.ok, true);
  return published.offer;
}

function acceptPending(records, offer, quantity, buyer = BUYER) {
  const created = records.createRequest(buyer, offer.id, offer.currentVersion, quantity, TODAY);
  assert.equal(created.ok, true);
  const accepted = records.acceptRequest(SELLER, created.request.id, TODAY);
  assert.equal(accepted.ok, true);
  return accepted.request;
}

function reach(records, requestId, status, actor = SELLER) {
  for (const step of REACH[status]) {
    const moved = records.recordCarrierStatus(actor, requestId, step, "");
    assert.equal(moved.ok, true, `${status} via ${step}`);
  }
}

function unchanged(file, run) {
  const before = fs.readFileSync(file, "utf8");
  const result = run();
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  return result;
}

function counted(file, offerId) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let total = 0;
  for (const request of Object.values(data.requests || {})) {
    if (!request || request.offerId !== offerId || request.state !== "accepted") continue;
    if (request.fulfilment && request.fulfilment.status === "cancelled") continue;
    total += request.acceptance.quantity;
  }
  return total;
}

function withoutFulfilment(request) {
  const copy = { ...request };
  delete copy.fulfilment;
  return copy;
}

describe("M-4 migration", () => {
  it("migrates a v3 file made by the pre-T7 screens and leaves a byte-identical bak", async () => {
    const repo = path.resolve(__dirname, "..");
    const dir = tempDir();
    const work = path.join(dir, "main");
    const recordsPath = path.join(dir, "v3.json");
    const driver = path.join(dir, "drive-v3.js");
    fs.writeFileSync(driver, v3Driver());
    let removeFailed = null;
    try {
      execFileSync("git", ["worktree", "add", "--detach", work, V3_COMMIT], {
        cwd: repo,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      execFileSync(process.execPath, [driver, work, recordsPath], {
        cwd: work,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const original = fs.readFileSync(recordsPath);
      const v3 = JSON.parse(original.toString("utf8"));
      assert.equal(v3.schemaVersion, 3);
      const states = Object.values(v3.requests).map((request) => request.state).sort();
      assert.deepEqual(states, ["accepted", "declined", "pending", "withdrawn"]);
      const acceptedBefore = Object.values(v3.requests).find((request) => request.state === "accepted");
      assert.equal(acceptedBefore.acceptance.counter > 0, true);
      assert.equal(acceptedBefore.fulfilment, undefined);

      const records = openRecords(recordsPath);
      const bak = `${recordsPath}${M4_BAK_SUFFIX}`;
      assert.deepEqual(fs.readFileSync(bak), original);
      assert.equal(mode(bak), 0o600);
      const v4 = JSON.parse(fs.readFileSync(recordsPath, "utf8"));
      assert.equal(v4.schemaVersion, 5);
      assert.deepEqual(v4.companies, {});
      const rest = (data) => {
        const copy = { ...data };
        delete copy.schemaVersion;
        delete copy.requests;
        delete copy.companies;
        return JSON.stringify(copy);
      };
      assert.equal(rest(v4), rest(v3));
      assert.equal(JSON.stringify(v4.offers), JSON.stringify(v3.offers));
      for (const id of Object.keys(v3.requests)) {
        const before = v3.requests[id];
        const after = v4.requests[id];
        assert.equal(JSON.stringify(withoutFulfilment(after)), JSON.stringify(before));
        if (before.state === "accepted") assert.deepEqual(after.fulfilment, INITIAL);
        else assert.equal(after.fulfilment, null);
      }
      const stamp = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      fs.utimesSync(bak, stamp, stamp);
      const settled = fs.readFileSync(recordsPath);
      const settledBak = fs.readFileSync(bak);
      records.view((data) => {
        assert.equal(data.schemaVersion, 5);
      });
      openRecords(recordsPath).view((data) => {
        assert.equal(data.requests[acceptedBefore.id].fulfilment.status, "accepted");
      });
      assert.deepEqual(fs.readFileSync(recordsPath), settled);
      assert.deepEqual(fs.readFileSync(bak), settledBak);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
      assert.equal(fs.statSync(bak).mtimeMs, stamp.getTime());
    } catch (error) {
      const stderr = error.stderr ? error.stderr.toString("utf8") : "";
      const stdout = error.stdout ? error.stdout.toString("utf8") : "";
      throw new Error(`${error.message}\n${stderr}\n${stdout}`);
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", work], { cwd: repo, stdio: "pipe" });
      } catch (error) {
        removeFailed = error;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(removeFailed, null);
  });

  it("reaches v4 from v1 and from v2 in one open, and does not overwrite an existing bak", () => {
    const dir = tempDir();
    try {
      const v1Path = path.join(dir, "v1.json");
      const v1 = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        offers: { a: { id: "a", companyId: "kings", state: "draft", source: "manual", terms: { quantity: 1 }, capacityStatus: "seller_asserted" } },
        audit: [{ event: "old" }],
        future: { keep: true },
      }));
      fs.writeFileSync(v1Path, v1);
      openRecords(v1Path);
      assert.deepEqual(fs.readFileSync(`${v1Path}.pre-m2.bak`), v1);
      assert.equal(JSON.parse(fs.readFileSync(`${v1Path}.pre-m3.bak`, "utf8")).schemaVersion, 2);
      assert.equal(JSON.parse(fs.readFileSync(`${v1Path}.pre-m4.bak`, "utf8")).schemaVersion, 3);
      const v1Now = JSON.parse(fs.readFileSync(v1Path, "utf8"));
      assert.equal(v1Now.schemaVersion, 5);
      assert.deepEqual(v1Now.companies, {});
      assert.equal(v1Now.future.keep, true);
      assert.deepEqual(v1Now.requests, {});

      const v2Path = path.join(dir, "v2.json");
      const v2 = Buffer.from(JSON.stringify({
        schemaVersion: 2,
        offers: { a: { id: "a", custom: "café" } },
        audit: [],
        future: { keep: 2 },
      }));
      fs.writeFileSync(v2Path, v2);
      openRecords(v2Path);
      assert.equal(fs.existsSync(`${v2Path}.pre-m2.bak`), false);
      assert.deepEqual(fs.readFileSync(`${v2Path}.pre-m3.bak`), v2);
      assert.equal(JSON.parse(fs.readFileSync(`${v2Path}.pre-m4.bak`, "utf8")).schemaVersion, 3);
      const v2Now = JSON.parse(fs.readFileSync(v2Path, "utf8"));
      assert.equal(v2Now.schemaVersion, 5);
      assert.deepEqual(v2Now.companies, {});
      assert.equal(v2Now.offers.a.custom, "café");
      assert.equal(v2Now.future.keep, 2);

      const v3Path = path.join(dir, "v3.json");
      const pending = { id: "p", state: "pending", extra: { keep: true }, quantity: 2 };
      const accepted = { id: "a", state: "accepted", acceptance: { termsHash: "abc", quantity: 3 }, note: "café" };
      const v3 = {
        schemaVersion: 3,
        offers: { o: { qty: 9, custom: true } },
        requests: { p: pending, a: accepted },
        audit: [{ event: "stay" }],
        future: { keep: 3 },
      };
      fs.writeFileSync(v3Path, JSON.stringify(v3));
      fs.writeFileSync(`${v3Path}.pre-m4.bak`, "sentinel-m4", { mode: 0o600 });
      openRecords(v3Path);
      assert.equal(fs.readFileSync(`${v3Path}.pre-m4.bak`, "utf8"), "sentinel-m4");
      const migrated = JSON.parse(fs.readFileSync(v3Path, "utf8"));
      assert.equal(migrated.schemaVersion, 5);
      assert.deepEqual(migrated.companies, {});
      assert.equal(migrated.future.keep, 3);
      assert.equal(JSON.stringify(migrated.offers), JSON.stringify(v3.offers));
      assert.equal(JSON.stringify(withoutFulfilment(migrated.requests.p)), JSON.stringify(pending));
      assert.equal(migrated.requests.p.fulfilment, null);
      assert.equal(JSON.stringify(withoutFulfilment(migrated.requests.a)), JSON.stringify(accepted));
      assert.deepEqual(migrated.requests.a.fulfilment, INITIAL);

      const v6Path = path.join(dir, "v6.json");
      const v6 = JSON.stringify({ schemaVersion: 6, offers: { keep: { qty: 7 } }, requests: {}, audit: ["stay"], future: 1 });
      fs.writeFileSync(v6Path, v6);
      assert.throws(() => openRecords(v6Path), /schemaVersion/);
      assert.equal(fs.readFileSync(v6Path, "utf8"), v6);
      assert.equal(fs.existsSync(`${v6Path}.pre-m5.bak`), false);
      assert.equal(fs.existsSync(`${v6Path}.pre-m4.bak`), false);
      assert.equal(fs.existsSync(`${v6Path}.pre-m3.bak`), false);
      assert.equal(fs.existsSync(`${v6Path}.pre-m2.bak`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("carrier status moves", () => {
  for (const [from, to] of EDGES) {
    it(`records ${from} → ${to}`, () => {
      withRecords((records, file) => {
        const offer = publish(records);
        const request = acceptPending(records, offer, 1);
        const actor = from === "rolled" ? BUYER : SELLER;
        reach(records, request.id, from, actor);
        const before = JSON.stringify(records.getRequestFor(SELLER.companyId, request.id).acceptance);
        const moved = records.recordCarrierStatus(actor, request.id, to, "noted");
        assert.equal(moved.ok, true);
        assert.equal(moved.request.fulfilment.status, to);
        assert.equal(moved.request.state, "accepted");
        const entry = moved.request.fulfilment.history.at(-1);
        assert.equal(entry.from, from);
        assert.equal(entry.to, to);
        assert.equal(entry.role, actor === SELLER ? "seller" : "buyer");
        assert.equal(entry.actorSub, actor.sub);
        assert.equal(entry.actorCompanyId, actor.companyId);
        assert.equal(entry.note, "noted");
        assert.equal(typeof entry.at, "string");
        assert.equal(JSON.stringify(moved.request.acceptance), before);
        assert.equal(JSON.stringify(records.getRequestFor(BUYER.companyId, request.id).acceptance), before);
        assert.equal(fs.readFileSync(file, "utf8").includes(before.slice(1, 20)), true);
      });
    });
  }

  it("refuses a move outside the table and leaves the file unchanged", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const request = acceptPending(records, offer, 1);
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, request.id, "completed", "")).error, "illegal_transition");
      assert.equal(unchanged(file, () => records.recordCarrierStatus(BUYER, request.id, "rejected", "")).error, "illegal_transition");
      reach(records, request.id, "rejected");
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, request.id, "carrier_confirmed", "")).error, "illegal_transition");
      const pending = records.createRequest(BUYER, offer.id, offer.currentVersion, 1, TODAY).request;
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, pending.id, "carrier_pending", "")).error, "not_accepted");
      const done = acceptPending(records, publish(records), 1);
      reach(records, done.id, "completed");
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, done.id, "rolled", "")).error, "final");
      const cancelled = acceptPending(records, publish(records), 1);
      records.proposeCancellation(SELLER, cancelled.id, "");
      records.agreeCancellation(BUYER, cancelled.id);
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, cancelled.id, "carrier_pending", "")).error, "final");
      assert.equal(unchanged(file, () => records.recordCarrierStatus(SELLER, request.id, "carrier_pending", "x".repeat(501))).error, "bad_note");
      const wide = acceptPending(records, publish(records), 1);
      const noted = records.recordCarrierStatus(SELLER, wide.id, "carrier_confirmed", "z".repeat(500));
      assert.equal(noted.ok, true);
      assert.equal(noted.request.fulfilment.history[0].note.length, 500);
    });
  });
});

describe("mutual cancellation", () => {
  it("proposes, withdraws, agrees, and refuses only for the right party", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const request = acceptPending(records, offer, 2);
      const proposed = records.proposeCancellation(BUYER, request.id, "space fell through");
      assert.equal(proposed.ok, true);
      assert.equal(proposed.request.fulfilment.cancellation.state, "proposed");
      assert.equal(proposed.request.fulfilment.cancellation.proposedByCompanyId, BUYER.companyId);
      assert.equal(proposed.request.fulfilment.status, "accepted");
      const event = proposed.request.fulfilment.cancellationEvents[0];
      assert.equal(event.event, "proposed");
      assert.equal(event.role, "buyer");
      assert.equal(event.bySub, BUYER.sub);
      assert.equal(event.byCompanyId, BUYER.companyId);
      assert.equal(event.reason, "space fell through");

      assert.equal(unchanged(file, () => records.agreeCancellation(BUYER, request.id)).error, "forbidden");
      assert.equal(unchanged(file, () => records.refuseCancellation(BUYER, request.id)).error, "forbidden");
      assert.equal(unchanged(file, () => records.withdrawCancellation(SELLER, request.id)).error, "forbidden");
      assert.equal(unchanged(file, () => records.proposeCancellation(SELLER, request.id, "again")).error, "forbidden");

      const withdrawn = records.withdrawCancellation(BUYER, request.id);
      assert.equal(withdrawn.ok, true);
      assert.equal(withdrawn.request.fulfilment.cancellation, null);
      assert.equal(withdrawn.request.fulfilment.cancellationEvents.at(-1).event, "withdrawn");
      assert.equal(withdrawn.request.fulfilment.status, "accepted");

      const bare = acceptPending(records, publish(records), 1);
      assert.equal(unchanged(file, () => records.agreeCancellation(SELLER, bare.id)).error, "forbidden");
      assert.equal(unchanged(file, () => records.refuseCancellation(BUYER, bare.id)).error, "forbidden");
      assert.equal(unchanged(file, () => records.withdrawCancellation(SELLER, bare.id)).error, "forbidden");

      records.proposeCancellation(SELLER, request.id, "please release");
      const agreed = records.agreeCancellation(BUYER, request.id);
      assert.equal(agreed.ok, true);
      assert.equal(agreed.request.fulfilment.status, "cancelled");
      assert.equal(agreed.request.fulfilment.cancellation, null);
      assert.equal(agreed.request.state, "accepted");
      const cancelEntry = agreed.request.fulfilment.history.at(-1);
      assert.equal(cancelEntry.from, "accepted");
      assert.equal(cancelEntry.to, "cancelled");
      assert.equal(cancelEntry.role, "buyer");
      assert.equal(cancelEntry.actorCompanyId, BUYER.companyId);
      assert.equal(agreed.request.fulfilment.cancellationEvents.at(-1).event, "agreed");
      assert.equal(records.availableQuantity(offer), 10);

      const disputedOffer = publish(records);
      const disputed = acceptPending(records, disputedOffer, 4);
      records.proposeCancellation(SELLER, disputed.id, "no");
      const refused = records.refuseCancellation(BUYER, disputed.id);
      assert.equal(refused.ok, true);
      assert.equal(refused.request.fulfilment.cancellation.state, "disputed");
      assert.equal(refused.request.fulfilment.cancellation.respondedByCompanyId, BUYER.companyId);
      assert.equal(refused.request.fulfilment.status, "accepted");
      assert.equal(records.availableQuantity(disputedOffer), 6);
      assert.equal(unchanged(file, () => records.agreeCancellation(SELLER, disputed.id)).error, "forbidden");
      const again = records.proposeCancellation(BUYER, disputed.id, "second");
      assert.equal(again.ok, true);
      assert.equal(again.request.fulfilment.cancellation.state, "proposed");
      assert.equal(again.request.fulfilment.cancellation.proposedByCompanyId, BUYER.companyId);
      const closed = records.agreeCancellation(SELLER, disputed.id);
      assert.equal(closed.ok, true);
      assert.equal(closed.request.fulfilment.status, "cancelled");
      assert.equal(records.availableQuantity(disputedOffer), 10);
    });
  });

  it("allows cancellation from every status except completed and cancelled, including rejected", () => {
    withRecords((records, file) => {
      for (const status of ["accepted", "carrier_pending", "carrier_confirmed", "rolled", "rejected"]) {
        const request = acceptPending(records, publish(records), 1);
        reach(records, request.id, status);
        const proposed = records.proposeCancellation(SELLER, request.id, status);
        assert.equal(proposed.ok, true, status);
        if (status === "rejected") {
          assert.equal(records.agreeCancellation(BUYER, request.id).ok, true);
          assert.equal(records.getRequestFor(SELLER.companyId, request.id).fulfilment.status, "cancelled");
          continue;
        }
        records.withdrawCancellation(SELLER, request.id);
        const during = records.proposeCancellation(BUYER, request.id, "open");
        assert.equal(during.ok, true);
        const next = status === "accepted"
          ? "carrier_pending"
          : status === "rolled"
            ? "carrier_confirmed"
            : status === "carrier_pending"
              ? "rejected"
              : "rolled";
        const moved = records.recordCarrierStatus(SELLER, request.id, next, "");
        assert.equal(moved.ok, true, `status during ${status}`);
        records.withdrawCancellation(BUYER, request.id);
        assert.equal(records.proposeCancellation(BUYER, request.id, "end").ok, true);
        assert.equal(records.agreeCancellation(SELLER, request.id).ok, true);
      }
      const done = acceptPending(records, publish(records), 1);
      reach(records, done.id, "completed");
      assert.equal(unchanged(file, () => records.proposeCancellation(SELLER, done.id, "no")).error, "final");
      const cancelled = acceptPending(records, publish(records), 1);
      records.proposeCancellation(SELLER, cancelled.id, "");
      records.agreeCancellation(BUYER, cancelled.id);
      assert.equal(unchanged(file, () => records.proposeCancellation(BUYER, cancelled.id, "again")).error, "final");
      const pending = records.createRequest(BUYER, publish(records).id, 1, 1, TODAY).request;
      assert.equal(unchanged(file, () => records.proposeCancellation(SELLER, pending.id, "no")).error, "not_accepted");
      assert.equal(unchanged(file, () => records.proposeCancellation(SELLER, done.id, "y".repeat(501))).error, "bad_reason");
      assert.equal(unchanged(file, () => records.proposeCancellation(THIRD, done.id, "no")).error, "not_found");
      assert.equal(unchanged(file, () => records.recordCarrierStatus(THIRD, done.id, "rolled", "")).error, "not_found");
      assert.equal(unchanged(file, () => records.withdrawCancellation(THIRD, done.id)).error, "not_found");
      assert.equal(unchanged(file, () => records.agreeCancellation(THIRD, done.id)).error, "not_found");
      assert.equal(unchanged(file, () => records.refuseCancellation(THIRD, done.id)).error, "not_found");
    });
  });

  it("keeps the acceptance byte-identical through every carrier status and the dispute cycle", () => {
    withRecords((records) => {
      const offer = publish(records);
      const request = acceptPending(records, offer, 3);
      const frozen = JSON.stringify(request.acceptance);
      const hash = request.acceptance.termsHash;
      const steps = [
        () => records.recordCarrierStatus(SELLER, request.id, "carrier_pending", "a"),
        () => records.recordCarrierStatus(BUYER, request.id, "carrier_confirmed", "b"),
        () => records.proposeCancellation(SELLER, request.id, "first"),
        () => records.refuseCancellation(BUYER, request.id),
        () => records.recordCarrierStatus(SELLER, request.id, "rolled", "still a fact"),
        () => records.recordCarrierStatus(BUYER, request.id, "carrier_pending", ""),
        () => records.recordCarrierStatus(SELLER, request.id, "carrier_confirmed", ""),
        () => records.recordCarrierStatus(BUYER, request.id, "rejected", ""),
        () => records.proposeCancellation(BUYER, request.id, "second"),
        () => records.agreeCancellation(SELLER, request.id),
      ];
      for (const step of steps) {
        const result = step();
        assert.equal(result.ok, true);
        assert.equal(JSON.stringify(result.request.acceptance), frozen);
        assert.equal(result.request.acceptance.termsHash, hash);
        assert.equal(JSON.stringify(records.getRequestFor(SELLER.companyId, request.id).acceptance), frozen);
      }
      assert.equal(records.getRequestFor(SELLER.companyId, request.id).fulfilment.status, "cancelled");

      const other = acceptPending(records, publish(records), 1);
      const otherFrozen = JSON.stringify(other.acceptance);
      reach(records, other.id, "completed", BUYER);
      const completed = records.getRequestFor(BUYER.companyId, other.id);
      assert.equal(completed.fulfilment.status, "completed");
      assert.equal(JSON.stringify(completed.acceptance), otherFrozen);
    });
  });

  it("lets the seller decline a countered request", () => {
    withRecords((records) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 2, TODAY);
      records.counterRequest(SELLER, created.request.id, {
        quantity: 2,
        unitBuyerMinor: 100,
        serviceTerms: "Counter",
      }, TODAY);
      const declined = records.declineRequest(SELLER, created.request.id);
      assert.equal(declined.ok, true);
      assert.equal(declined.request.state, "declined");
      assert.equal(declined.request.fulfilment, null);
      assert.equal(declined.request.acceptance, null);
      assert.equal(records.availableQuantity(offer), 10);
    });
  });
});

describe("availability", () => {
  it("releases quantity only when the agreement is cancelled", () => {
    withRecords((records, file) => {
      const offer = publish(records, manualTerms({ quantity: 10 }));
      const rejected = acceptPending(records, offer, 3);
      reach(records, rejected.id, "rejected");
      assert.equal(records.availableQuantity(offer), 7);
      const disputed = acceptPending(records, offer, 2);
      records.proposeCancellation(SELLER, disputed.id, "dispute");
      records.refuseCancellation(BUYER, disputed.id);
      assert.equal(records.availableQuantity(offer), 5);
      const held = acceptPending(records, offer, 1);
      records.proposeCancellation(BUYER, held.id, "release");
      assert.equal(records.availableQuantity(offer), 4);
      records.agreeCancellation(SELLER, held.id);
      assert.equal(records.availableQuantity(offer), 5);
      assert.equal(counted(file, offer.id), 5);
      const created = records.createRequest(THIRD, offer.id, 1, 5, TODAY);
      assert.equal(created.ok, true);
      assert.equal(records.acceptRequest(SELLER, created.request.id, TODAY).ok, true);
      assert.equal(records.availableQuantity(offer), 0);
      assert.equal(unchanged(file, () => records.createRequest(BUYER, offer.id, 1, 1, TODAY)).error, "unavailable");
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

function itemHtml(html, name) {
  const parts = html.split("<li");
  return parts.find((part) => part.includes(name)) || "";
}

function formSlice(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return "";
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

describe("fulfilment screens", () => {
  it("shows the agreement, the recorded-by line, and only the allowed moves", async () => {
    await withApp(async ({ base, origin, store, records }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const offer = publish(records, manualTerms({ codeShareName: "Copy Lane", quantity: 10 }));
      const request = acceptPending(records, offer, 3);
      const accepted = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      assert.match(accepted.html, /id="fulfilment-status">Accepted/);
      assert.match(accepted.html, new RegExp(AGREEMENT.replace(/[.]/g, "\\.")));
      assert.equal(accepted.html.toLowerCase().includes("booked"), false);
      assert.equal(accepted.html.includes('id="carrier-record"'), false);
      const form = formSlice(accepted.html, "status-form");
      assert.match(form, /value="carrier_pending"/);
      assert.match(form, /value="carrier_confirmed"/);
      assert.equal(form.includes("completed"), false);
      assert.equal(form.includes("rejected"), false);
      assert.equal(form.includes("rolled"), false);
      assert.match(accepted.html, /id="cancel-propose"/);

      const pending = await postForm(base, seller.cookie, `/requests/${request.id}/status`, {
        csrf_token: accepted.csrf,
        to: "carrier_pending",
        note: "asked the carrier",
      });
      assert.equal(pending.status, 302);
      const pendingPage = await pageOf(base, buyer.cookie, `/requests/${request.id}`);
      assert.match(pendingPage.html, /id="fulfilment-status">Carrier pending/);
      assert.match(pendingPage.html, /Seller, Kings,/);
      assert.match(pendingPage.html, /asked the carrier/);
      assert.match(pendingPage.html, new RegExp(AGREEMENT.replace(/[.]/g, "\\.")));
      assert.equal(pendingPage.html.toLowerCase().includes("booked"), false);
      const sellerList = await pageOf(base, seller.cookie, "/requests");
      assert.match(sellerList.html, /Carrier pending/);
      assert.equal(sellerList.html.includes("Dispute"), false);

      const confirmed = await postForm(base, buyer.cookie, `/requests/${request.id}/status`, {
        csrf_token: pendingPage.csrf,
        to: "carrier_confirmed",
        note: "carrier said yes",
      });
      assert.equal(confirmed.status, 302);
      const confirmedPage = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      const record = confirmedPage.html.match(/id="carrier-record">([^<]*)</)[1];
      assert.match(record, /recorded by Other Co on \d{4}-\d{2}-\d{2}/);
      assert.match(record, /OceanRelay has not checked this with the carrier/);
      assert.match(record, /A carrier can still roll, change or cancel a booking/);
      assert.match(formSlice(confirmedPage.html, "status-form"), /value="rolled"/);
      assert.match(formSlice(confirmedPage.html, "status-form"), /value="completed"/);
      assert.match(formSlice(confirmedPage.html, "status-form"), /value="rejected"/);
      assert.equal(formSlice(confirmedPage.html, "status-form").includes("carrier_pending"), false);
    });
  });

  it("runs propose, refuse, propose again, and agree, and escapes the note and the reason", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const offer = publish(records, manualTerms({ codeShareName: "Cancel Lane", quantity: 10 }));
      const request = acceptPending(records, offer, 3);
      const sellerPage = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      const proposed = await postForm(base, seller.cookie, `/requests/${request.id}/cancel/propose`, {
        csrf_token: sellerPage.csrf,
        reason: MARKUP,
      });
      assert.equal(proposed.status, 302);
      const noted = await postForm(base, buyer.cookie, `/requests/${request.id}/status`, {
        csrf_token: (await pageOf(base, buyer.cookie, `/requests/${request.id}`)).csrf,
        to: "carrier_pending",
        note: MARKUP,
      });
      assert.equal(noted.status, 302);
      const escaped = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      assert.equal(escaped.html.includes(MARKUP), false);
      assert.match(escaped.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(escaped.html, /id="cancellation-reason">/);
      const proposerView = escaped.html;
      assert.match(proposerView, /id="cancel-withdraw"/);
      assert.equal(proposerView.includes('id="cancel-agree"'), false);
      const other = await pageOf(base, buyer.cookie, `/requests/${request.id}`);
      assert.match(other.html, /id="cancel-agree"/);
      assert.match(other.html, /id="cancel-refuse"/);
      assert.equal(other.html.includes('id="cancel-withdraw"'), false);

      const refused = await postForm(base, buyer.cookie, `/requests/${request.id}/cancel/refuse`, {
        csrf_token: other.csrf,
      });
      assert.equal(refused.status, 302);
      const dispute = await pageOf(base, seller.cookie, `/requests/${request.id}`);
      assert.match(dispute.html, new RegExp(DISPUTE.replace(/[.]/g, "\\.")));
      assert.match(dispute.html, /id="cancel-propose"/);
      const listed = await pageOf(base, buyer.cookie, "/requests");
      assert.match(listed.html, /Dispute/);
      assert.match(listed.html, /Carrier pending/);
      assert.equal(records.availableQuantity(offer), 7);

      const again = await postForm(base, buyer.cookie, `/requests/${request.id}/cancel/propose`, {
        csrf_token: (await pageOf(base, buyer.cookie, `/requests/${request.id}`)).csrf,
        reason: "release the three",
      });
      assert.equal(again.status, 302);
      const agreed = await postForm(base, seller.cookie, `/requests/${request.id}/cancel/agree`, {
        csrf_token: (await pageOf(base, seller.cookie, `/requests/${request.id}`)).csrf,
      });
      assert.equal(agreed.status, 302);
      const done = await pageOf(base, buyer.cookie, `/requests/${request.id}`);
      assert.match(done.html, /id="fulfilment-status">Cancelled/);
      assert.match(done.html, /Both parties agreed/);
      assert.equal(done.html.includes('id="cancel-propose"'), false);
      assert.equal(records.availableQuantity(offer), 10);

      const market = await pageOf(base, buyer.cookie, "/market");
      assert.match(itemHtml(market.html, "Cancel Lane"), /10 of 10 containers available in OceanRelay — Seller&#39;s claim/);
      const detail = await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.match(detail.html, /10 of 10 containers available in OceanRelay/);
      assert.match(detail.html, /<dt>Listed quantity<\/dt>/);
      const preview = await pageOf(base, seller.cookie, `/offers/${offer.id}`);
      assert.match(preview.html, /10 of 10 available/);
      const version = detail.html.match(/name="version" value="([^"]+)"/)[1];
      const requested = await postForm(base, buyer.cookie, `/market/${offer.id}/requests`, {
        csrf_token: detail.csrf,
        version,
        quantity: "10",
      });
      assert.equal(requested.status, 302);
      const requestPath = requested.headers.get("location");
      const sellerRequest = await pageOf(base, seller.cookie, requestPath);
      const took = await postForm(base, seller.cookie, `${requestPath}/accept`, { csrf_token: sellerRequest.csrf });
      assert.equal(took.status, 302);
      assert.equal(records.availableQuantity(offer), 0);
      assert.equal(counted(recordsPath, offer.id), 10);

      const beforeBytes = fs.readFileSync(recordsPath);
      const stamp = new Date("2020-06-01T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      await pageOf(base, buyer.cookie, "/market");
      await pageOf(base, buyer.cookie, `/market/${offer.id}`);
      assert.deepEqual(fs.readFileSync(recordsPath), beforeBytes);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
    });
  });

  it("sorts a fully taken offer last, greys it, and keeps it under a filter", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const taken = publish(records, manualTerms({
        codeShareName: "Taken Lane",
        quantity: 1,
        sailingStart: "2026-11-01",
        sailingEnd: "2026-11-02",
        origin: "CNSHA",
      }));
      acceptPending(records, taken, 1);
      const open = publish(records, manualTerms({
        codeShareName: "Open Lane",
        quantity: 4,
        sailingStart: "2026-12-15",
        sailingEnd: "2026-12-16",
        origin: "CNSHA",
      }));
      const other = publish(records, manualTerms({
        codeShareName: "Other Port",
        quantity: 1,
        sailingStart: "2026-10-05",
        sailingEnd: "2026-10-06",
        origin: "USNYC",
      }));
      acceptPending(records, other, 1);

      const before = fs.readFileSync(recordsPath);
      const stamp = new Date("2020-03-01T00:00:00.000Z");
      fs.utimesSync(recordsPath, stamp, stamp);
      const filtered = await pageOf(base, seller.cookie, "/market?origin=CNSHA");
      assert.equal(filtered.html.includes("Other Port"), false);
      assert.ok(filtered.html.indexOf("Open Lane") < filtered.html.indexOf("Taken Lane"));
      assert.match(itemHtml(filtered.html, "Taken Lane"), /^ class="taken"/);
      assert.match(itemHtml(filtered.html, "Taken Lane"), /Fully taken/);
      assert.match(itemHtml(filtered.html, "Taken Lane"), /0 of 1 container available in OceanRelay — Seller&#39;s claim/);
      assert.match(itemHtml(filtered.html, "Taken Lane"), new RegExp(`href="/market/${taken.id}"`));
      assert.equal(itemHtml(filtered.html, "Open Lane").startsWith(" class=\"taken\""), false);
      assert.match(itemHtml(filtered.html, "Open Lane"), /4 of 4 containers available in OceanRelay — Seller&#39;s claim/);
      const all = await pageOf(base, seller.cookie, "/market");
      assert.ok(all.html.indexOf("Open Lane") < all.html.indexOf("Taken Lane"));
      assert.ok(all.html.indexOf("Open Lane") < all.html.indexOf("Other Port"));
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      assert.equal(fs.statSync(recordsPath).mtimeMs, stamp.getTime());
      assert.equal(records.availableQuantity(open), 4);
      assert.equal(records.availableQuantity(taken), 0);
    });
  });

  it("gives a third company the same 404 as an unknown id", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      const buyer = seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      const third = seedCompany(store, "sid-third", "csrf-third", THIRD);
      const offer = publish(records, manualTerms({ codeShareName: "Hidden Lane" }));
      const request = acceptPending(records, offer, 1);
      const unknown = await pageOf(base, buyer.cookie, "/requests/00000000-0000-4000-8000-000000000000");
      const foreign = await pageOf(base, third.cookie, `/requests/${request.id}`);
      assert.equal(foreign.response.status, 404);
      assert.equal(foreign.html, unknown.html);
      const before = fs.readFileSync(recordsPath);
      for (const action of ["status", "cancel/propose", "cancel/withdraw", "cancel/agree", "cancel/refuse"]) {
        const response = await postForm(base, third.cookie, `/requests/${request.id}/${action}`, {
          csrf_token: third.csrf,
          to: "carrier_confirmed",
          note: "nope",
          reason: "nope",
        });
        assert.equal(response.status, 404, action);
        assert.equal(await response.text(), unknown.html, action);
      }
      assert.deepEqual(fs.readFileSync(recordsPath), before);
      const missing = await postForm(base, seller.cookie, `/requests/${request.id}/status`, { to: "carrier_pending" });
      assert.equal(missing.status, 403);
      assert.deepEqual(fs.readFileSync(recordsPath), before);

      const created = records.createRequest(BUYER, offer.id, 1, 1, TODAY);
      records.counterRequest(SELLER, created.request.id, {
        quantity: 1,
        unitBuyerMinor: 1500,
        serviceTerms: "Held",
      }, TODAY);
      const countered = await pageOf(base, seller.cookie, `/requests/${created.request.id}`);
      assert.match(countered.html, /action="\/requests\/[^"]+\/decline"/);
      const declined = await postForm(base, seller.cookie, `/requests/${created.request.id}/decline`, {
        csrf_token: countered.csrf,
      });
      assert.equal(declined.status, 302);
      assert.equal(records.getRequestFor(BUYER.companyId, created.request.id).state, "declined");
    });
  });

  it("never accepts more than the listed quantity when cancellation and acceptance race", async () => {
    await withApp(async ({ base, origin, store, records, recordsPath }) => {
      const seller = await connectOwner({ base, origin });
      seedCompany(store, "sid-buyer", "csrf-buyer", BUYER);
      seedCompany(store, "sid-third", "csrf-third", THIRD);
      const outcomes = [];
      for (let round = 0; round < 5; round += 1) {
        const offer = publish(records, manualTerms({ quantity: 10, codeShareName: `Race ${round}` }));
        const first = records.createRequest(BUYER, offer.id, 1, 6, TODAY);
        const pending = records.createRequest(THIRD, offer.id, 1, 6, TODAY);
        assert.equal(first.ok, true);
        assert.equal(pending.ok, true);
        const held = records.acceptRequest(SELLER, first.request.id, TODAY);
        assert.equal(held.ok, true);
        assert.equal(records.proposeCancellation(BUYER, held.request.id, "release").ok, true);
        const sellerPage = await pageOf(base, seller.cookie, `/requests/${held.request.id}`);
        const agreeCall = () => postForm(base, seller.cookie, `/requests/${held.request.id}/cancel/agree`, { csrf_token: sellerPage.csrf });
        const acceptCall = () => postForm(base, seller.cookie, `/requests/${pending.request.id}/accept`, { csrf_token: sellerPage.csrf });
        // Alternate which fetch is started first. A single order can hide a
        // check that has left the transaction, because one handler then always
        // finishes before the other.
        const started = round % 2 === 0
          ? [agreeCall(), acceptCall()]
          : [acceptCall(), agreeCall()];
        const finished = await Promise.all(started);
        const agreed = round % 2 === 0 ? finished[0] : finished[1];
        const accepted = round % 2 === 0 ? finished[1] : finished[0];
        assert.equal(agreed.status, 302, `round ${round} agree`);
        assert.ok(accepted.status === 302 || accepted.status === 400, `round ${round} accept ${accepted.status}`);
        const total = counted(recordsPath, offer.id);
        assert.ok(total <= 10, `round ${round} counted ${total}`);
        const stored = JSON.parse(fs.readFileSync(recordsPath, "utf8")).requests;
        const released = stored[held.request.id];
        assert.equal(released.fulfilment.status, "cancelled");
        if (accepted.status === 400) {
          assert.match(await accepted.text(), /no longer available/);
          assert.equal(stored[pending.request.id].state, "pending");
          assert.equal(total, 0);
          outcomes.push("refused");
        } else {
          assert.equal(stored[pending.request.id].state, "accepted");
          assert.equal(total, 6);
          const cancelAt = released.fulfilment.history.at(-1).at;
          const acceptAt = stored[pending.request.id].acceptance.at;
          assert.ok(cancelAt <= acceptAt, `round ${round} acceptance landed before the quantity was released`);
          outcomes.push("accepted");
        }
        assert.equal(JSON.stringify(released.acceptance), JSON.stringify(held.request.acceptance));
      }
      assert.equal(outcomes.length, 5);
    });
  });

  it("shows that a stale availability write can exceed the listed quantity", () => {
    withRecords((records, file) => {
      const offer = publish(records, manualTerms({ quantity: 10 }));
      const first = records.createRequest(BUYER, offer.id, 1, 6, TODAY);
      const pending = records.createRequest(THIRD, offer.id, 1, 6, TODAY);
      assert.equal(first.ok, true);
      assert.equal(pending.ok, true);
      const held = records.acceptRequest(SELLER, first.request.id, TODAY);
      assert.equal(held.ok, true);
      records.proposeCancellation(BUYER, held.request.id, "release");
      const refused = records.acceptRequest(SELLER, pending.request.id, TODAY);
      assert.equal(refused.ok, false);
      assert.equal(refused.error, "unavailable");
      assert.equal(counted(file, offer.id), 6);
      assert.equal(records.agreeCancellation(SELLER, held.request.id).ok, true);
      assert.equal(counted(file, offer.id), 0);
      assert.equal(records.acceptRequest(SELLER, pending.request.id, TODAY).ok, true);
      assert.equal(counted(file, offer.id), 6);

      const again = publish(records, manualTerms({ quantity: 10, codeShareName: "Stale" }));
      const early = records.createRequest(BUYER, again.id, 1, 6, TODAY);
      const second = records.createRequest(THIRD, again.id, 1, 6, TODAY);
      assert.equal(early.ok, true);
      assert.equal(second.ok, true);
      const acceptedEarly = records.acceptRequest(SELLER, early.request.id, TODAY);
      assert.equal(acceptedEarly.ok, true);
      records.proposeCancellation(BUYER, acceptedEarly.request.id, "release");
      const stale = records.view((data) => structuredClone(data));
      assert.equal(records.agreeCancellation(SELLER, acceptedEarly.request.id).ok, true);
      records.transact((data) => {
        data.requests = stale.requests;
        const extra = data.requests[second.request.id];
        extra.state = "accepted";
        extra.fulfilment = {
          status: "accepted",
          history: [],
          cancellation: null,
          cancellationEvents: [],
        };
        extra.acceptance = {
          ...stale.requests[acceptedEarly.request.id].acceptance,
          quantity: 6,
          at: "2026-10-01T00:00:02.000Z",
        };
      });
      assert.ok(counted(file, again.id) > 10);
    });
  });
});

function v3Driver() {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const recordsPath = process.argv[3];
const { createServer } = require(path.join(root, 'server.js'));
const { loadConfig } = require(path.join(root, 'lib/config.js'));
const { openStore } = require(path.join(root, 'lib/store.js'));
const { openRecords } = require(path.join(root, 'lib/records.js'));
const { createMockRateNinja } = require(path.join(root, 'test/mock-rate-ninja.js'));
const { COOKIE_NAME, signSession } = require(path.join(root, 'lib/session.js'));

const CLIENT_ID = 'capacity-exchange';
const CLIENT_SECRET = 'test-client-secret-value';
const SESSION_SECRET = 'test-session-secret-value';
const ENCRYPTION_KEY = 'test-token-encryption-key';

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return COOKIE_NAME + '=' + value;
}

async function pageOf(base, cookie, target) {
  const response = await fetch(new URL(target, base), { headers: { cookie }, redirect: 'manual' });
  const html = await response.text();
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  return { status: response.status, html, csrf: match ? match[1] : '', location: response.headers.get('location') };
}

async function postForm(base, cookie, target, fields) {
  const response = await fetch(new URL(target, base), {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const text = response.status === 302 ? '' : await response.text();
  if (response.status !== 302) throw new Error(target + ' ' + response.status + ' ' + text.slice(0, 500));
  return response.headers.get('location');
}

async function main() {
  const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const port = await mock.listen();
  const origin = 'http://127.0.0.1:' + port;
  const storePath = path.join(path.dirname(recordsPath), 'store.json');
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: CLIENT_ID,
    RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    RATE_NINJA_BASE_URL: origin,
    OCEANRELAY_REDIRECT_URI: 'http://127.0.0.1:9/oauth/callback',
  });
  const store = openStore(storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const server = createServer({ config, store, records });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  config.redirectUri = base + '/oauth/callback';
  try {
    const home = await fetch(base);
    const setCookie = home.headers.getSetCookie;
    const sellerCookie = (typeof setCookie === 'function' ? setCookie.call(home.headers) : []).map((value) => value.split(';')[0]).join('; ');
    const homeHtml = await home.text();
    const csrf = homeHtml.match(/name="csrf_token" value="([^"]+)"/)[1];
    const connect = await fetch(base + '/connect', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: sellerCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    const auth = new URL(connect.headers.get('location'));
    const decision = await fetch(origin + '/oauth/decision', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        decision: 'approve',
        state: auth.searchParams.get('state'),
        redirect_uri: auth.searchParams.get('redirect_uri'),
        code_challenge: auth.searchParams.get('code_challenge'),
      }),
    });
    const callback = await fetch(decision.headers.get('location'), { headers: { cookie: sellerCookie }, redirect: 'manual' });
    if (callback.status !== 302) throw new Error('callback ' + callback.status);
    store.saveConnection('sid-buyer', {
      refreshToken: 'refresh-sid-buyer',
      scopes: ['profile:read', 'rates:read', 'sailings:read'],
      profile: {
        sub: 'user-other',
        name: 'Other',
        companyId: 'other-co',
        companyName: 'Other Co',
        companyType: 'Contract Owner',
        active: true,
      },
    });
    const buyerCookie = sessionCookie('sid-buyer', 'csrf-buyer');
    const form = await pageOf(base, sellerCookie, '/offers/new?source=manual');
    const saved = await postForm(base, sellerCookie, '/offers', {
      csrf_token: form.csrf,
      source: 'manual',
      equipment: '40HC',
      baseAmount: '20',
      origin: 'CNSHA',
      destination: 'USLAX',
      quantity: '10',
      unit: 'container',
      sailingDate: '2026-12-20',
      sailingStart: '',
      sailingEnd: '',
      cutoffDate: '',
      validityDeadline: '2026-12-01',
      currency: 'USD',
      markupType: 'absolute',
      markupValue: '0',
      codeShareName: 'Migrate café',
      operatingCarrier: 'ABC',
      serviceTerms: 'CY/CY',
    });
    const offerId = saved.split('/').pop().split('?')[0];
    const preview = await pageOf(base, sellerCookie, '/offers/' + offerId);
    await postForm(base, sellerCookie, '/offers/' + offerId + '/state', { csrf_token: preview.csrf, to: 'published' });
    async function requestQuantity(quantity) {
      const detail = await pageOf(base, buyerCookie, '/market/' + offerId);
      const version = detail.html.match(/name="version" value="([^"]+)"/)[1];
      return postForm(base, buyerCookie, '/market/' + offerId + '/requests', {
        csrf_token: detail.csrf,
        version,
        quantity: String(quantity),
      });
    }
    const acceptedPath = await requestQuantity(2);
    const sellerRequest = await pageOf(base, sellerCookie, acceptedPath);
    await postForm(base, sellerCookie, acceptedPath + '/counter', {
      csrf_token: sellerRequest.csrf,
      quantity: '2',
      unitPrice: '15.00',
      serviceTerms: 'Counter café',
    });
    const buyerCounter = await pageOf(base, buyerCookie, acceptedPath);
    await postForm(base, buyerCookie, acceptedPath + '/accept', { csrf_token: buyerCounter.csrf });
    await requestQuantity(1);
    const declinePath = await requestQuantity(1);
    const declinePage = await pageOf(base, sellerCookie, declinePath);
    await postForm(base, sellerCookie, declinePath + '/decline', { csrf_token: declinePage.csrf });
    const withdrawPath = await requestQuantity(1);
    const withdrawPage = await pageOf(base, buyerCookie, withdrawPath);
    await postForm(base, buyerCookie, withdrawPath + '/withdraw', { csrf_token: withdrawPage.csrf });
    const written = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
    if (written.schemaVersion !== 3) throw new Error('expected schema 3, got ' + written.schemaVersion);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
}
