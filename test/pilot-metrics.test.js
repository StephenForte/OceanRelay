const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "pilot-metrics.js");
const README = path.join(__dirname, "..", "README.md");
const HOUR_MS = 60 * 60 * 1000;

const SUB = {
  "seller-a": "sub-seller-a",
  "seller-b": "sub-seller-b",
  "buyer-a": "sub-buyer-a",
  "buyer-b": "sub-buyer-b",
};
const NAME = {
  "seller-a": "Alpha Shipping",
  "seller-b": "Beta Lines",
  "buyer-a": "Buyer One",
  "buyer-b": "Buyer Two",
};

function hoursAfter(iso, hours) {
  return new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
}

function historyEntry(from, to, actor, at, counter) {
  return { from, to, actor, at, counter: counter == null ? null : counter };
}

function offer(id, companyId, createdAt, publishedAt, actions) {
  const row = {
    id,
    companyId,
    createdBy: SUB[companyId],
    createdAt,
    state: publishedAt ? "published" : "draft",
    publishedAt,
    currentVersion: 1,
    versions: [],
    statusHistory: [],
    stateHistory: [],
  };
  if (actions) row.chain = { actions };
  return row;
}

function requestRow(spec) {
  return {
    id: spec.id,
    offerId: spec.offerId,
    version: 1,
    createdAt: spec.createdAt,
    sellerCompanyId: spec.seller,
    buyerCompanyId: spec.buyer,
    buyerSub: SUB[spec.buyer],
    buyerCompanyName: NAME[spec.buyer],
    sellerCompanyName: spec.sellerName === undefined ? NAME[spec.seller] : spec.sellerName,
    quantity: 1,
    state: spec.state,
    counters: spec.counters || [],
    history: spec.history,
    acceptance: spec.acceptanceAt
      ? { at: spec.acceptanceAt, by: spec.acceptanceBy, counter: spec.acceptanceCounter == null ? null : spec.acceptanceCounter }
      : null,
    fulfilment: spec.fulfilment === undefined ? null : spec.fulfilment,
  };
}

function counterRow(seller, at) {
  return { n: 1, quantity: 1, unitBuyerMinor: 100, serviceTerms: "CY/CY", at, by: SUB[seller] };
}

// Dates are UTC on purpose. 2026-10-01T00:00:00Z is still 30 September in
// Pacific time, so a local-day filter would disagree with these counts.
function buildFixture() {
  const completedAt = "2026-10-01T00:00:00.000Z";
  const cancelledAt = "2026-10-01T01:00:00.000Z";
  const rolledAt = "2026-10-01T02:00:00.000Z";
  const withdrawnAt = "2026-10-01T03:00:00.000Z";
  const disputedAt = "2026-10-02T00:00:00.000Z";
  const rejectedAt = "2026-10-02T01:00:00.000Z";
  const sellerDeclinedAt = "2026-10-02T02:00:00.000Z";
  const buyerDeclinedAt = "2026-10-02T03:00:00.000Z";
  const pendingAt = "2026-10-02T04:00:00.000Z";
  const oldAt = "2026-09-15T12:00:00.000Z";

  return {
    schemaVersion: 7,
    offers: {
      "o-a1": offer("o-a1", "seller-a", "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z", [
        { kind: "publish", status: "confirmed" },
      ]),
      "o-a2": offer("o-a2", "seller-a", "2026-10-03T08:00:00.000Z", "2026-10-03T09:00:00.000Z", [
        { kind: "publish", status: "pending" },
        { kind: "state", status: "confirmed", to: "paused" },
      ]),
      "o-b1": offer("o-b1", "seller-b", "2026-10-02T00:00:00.000Z", null, null),
      "o-b2": offer("o-b2", "seller-b", "2026-09-15T00:00:00.000Z", "2026-09-15T01:00:00.000Z", [
        { kind: "publish", status: "confirmed" },
      ]),
    },
    requests: {
      "r-completed": requestRow({
        id: "r-completed",
        offerId: "o-a1",
        createdAt: completedAt,
        buyer: "buyer-a",
        seller: "seller-a",
        state: "accepted",
        history: [
          historyEntry(null, "pending", SUB["buyer-a"], completedAt, null),
          historyEntry("pending", "accepted", SUB["seller-a"], hoursAfter(completedAt, 2), null),
        ],
        acceptanceAt: hoursAfter(completedAt, 2),
        acceptanceBy: SUB["seller-a"],
        fulfilment: {
          status: "completed",
          history: [
            { from: "accepted", to: "carrier_confirmed" },
            { from: "carrier_confirmed", to: "completed" },
          ],
          cancellation: null,
          cancellationEvents: [],
        },
      }),
      "r-cancelled": requestRow({
        id: "r-cancelled",
        offerId: "o-a1",
        createdAt: cancelledAt,
        buyer: "buyer-a",
        seller: "seller-a",
        state: "accepted",
        counters: [counterRow("seller-a", hoursAfter(cancelledAt, 4))],
        history: [
          historyEntry(null, "pending", SUB["buyer-a"], cancelledAt, null),
          historyEntry("pending", "countered", SUB["seller-a"], hoursAfter(cancelledAt, 4), 1),
          historyEntry("countered", "accepted", SUB["buyer-a"], hoursAfter(cancelledAt, 10), 1),
        ],
        acceptanceAt: hoursAfter(cancelledAt, 10),
        acceptanceBy: SUB["buyer-a"],
        acceptanceCounter: 1,
        fulfilment: {
          status: "cancelled",
          history: [{ from: "carrier_confirmed", to: "cancelled" }],
          cancellation: null,
          cancellationEvents: [{ event: "proposed" }, { event: "agreed" }],
        },
      }),
      "r-rolled": requestRow({
        id: "r-rolled",
        offerId: "o-a1",
        createdAt: rolledAt,
        buyer: "buyer-a",
        seller: "seller-a",
        state: "accepted",
        history: [
          historyEntry(null, "pending", SUB["buyer-a"], rolledAt, null),
          historyEntry("pending", "accepted", SUB["seller-a"], hoursAfter(rolledAt, 8), null),
        ],
        acceptanceAt: hoursAfter(rolledAt, 8),
        acceptanceBy: SUB["seller-a"],
        fulfilment: {
          status: "carrier_confirmed",
          history: [
            { from: "accepted", to: "carrier_confirmed" },
            { from: "carrier_confirmed", to: "rolled" },
            { from: "rolled", to: "carrier_confirmed" },
          ],
          cancellation: null,
          cancellationEvents: [],
        },
      }),
      "r-withdrawn": requestRow({
        id: "r-withdrawn",
        offerId: "o-a1",
        createdAt: withdrawnAt,
        buyer: "buyer-a",
        seller: "seller-a",
        sellerName: null,
        state: "withdrawn",
        history: [
          historyEntry(null, "pending", SUB["buyer-a"], withdrawnAt, null),
          historyEntry("pending", "withdrawn", SUB["buyer-a"], hoursAfter(withdrawnAt, 7), null),
        ],
      }),
      "r-disputed": requestRow({
        id: "r-disputed",
        offerId: "o-b1",
        createdAt: disputedAt,
        buyer: "buyer-b",
        seller: "seller-b",
        state: "accepted",
        counters: [counterRow("seller-b", hoursAfter(disputedAt, 12))],
        history: [
          historyEntry(null, "pending", SUB["buyer-b"], disputedAt, null),
          historyEntry("pending", "countered", SUB["seller-b"], hoursAfter(disputedAt, 12), 1),
          historyEntry("countered", "accepted", SUB["buyer-b"], hoursAfter(disputedAt, 20), 1),
        ],
        acceptanceAt: hoursAfter(disputedAt, 20),
        acceptanceBy: SUB["buyer-b"],
        acceptanceCounter: 1,
        fulfilment: {
          status: "carrier_confirmed",
          history: [{ from: "accepted", to: "carrier_confirmed" }],
          cancellation: { state: "proposed" },
          cancellationEvents: [{ event: "proposed" }, { event: "refused" }, { event: "proposed" }],
        },
      }),
      "r-rejected": requestRow({
        id: "r-rejected",
        offerId: "o-b1",
        createdAt: rejectedAt,
        buyer: "buyer-b",
        seller: "seller-b",
        state: "accepted",
        history: [
          historyEntry(null, "pending", SUB["buyer-b"], rejectedAt, null),
          historyEntry("pending", "accepted", SUB["seller-b"], hoursAfter(rejectedAt, 6), null),
        ],
        acceptanceAt: hoursAfter(rejectedAt, 6),
        acceptanceBy: SUB["seller-b"],
        fulfilment: {
          status: "rejected",
          history: [
            { from: "accepted", to: "carrier_pending" },
            { from: "carrier_pending", to: "rejected" },
          ],
          cancellation: null,
          cancellationEvents: [],
        },
      }),
      "r-seller-declined": requestRow({
        id: "r-seller-declined",
        offerId: "o-b1",
        createdAt: sellerDeclinedAt,
        buyer: "buyer-b",
        seller: "seller-b",
        state: "declined",
        history: [
          historyEntry(null, "pending", SUB["buyer-b"], sellerDeclinedAt, null),
          historyEntry("pending", "declined", SUB["seller-b"], hoursAfter(sellerDeclinedAt, 1), null),
        ],
      }),
      "r-buyer-declined": requestRow({
        id: "r-buyer-declined",
        offerId: "o-a1",
        createdAt: buyerDeclinedAt,
        buyer: "buyer-b",
        seller: "seller-a",
        state: "declined",
        counters: [counterRow("seller-a", hoursAfter(buyerDeclinedAt, 3))],
        history: [
          historyEntry(null, "pending", SUB["buyer-b"], buyerDeclinedAt, null),
          historyEntry("pending", "countered", SUB["seller-a"], hoursAfter(buyerDeclinedAt, 3), 1),
          historyEntry("countered", "declined", SUB["buyer-b"], hoursAfter(buyerDeclinedAt, 5), 1),
        ],
      }),
      "r-pending": requestRow({
        id: "r-pending",
        offerId: "o-b1",
        createdAt: pendingAt,
        buyer: "buyer-b",
        seller: "seller-b",
        sellerName: null,
        state: "pending",
        history: [historyEntry(null, "pending", SUB["buyer-b"], pendingAt, null)],
      }),
      "r-old": requestRow({
        id: "r-old",
        offerId: "o-b2",
        createdAt: oldAt,
        buyer: "buyer-a",
        seller: "seller-b",
        sellerName: null,
        state: "pending",
        history: [historyEntry(null, "pending", SUB["buyer-a"], oldAt, null)],
      }),
    },
    audit: [],
    companies: {},
  };
}

function party(companyId, companyName, offersCreated, requestsMade, requestsReceived, requestsAccepted, firstActivity, lastActivity, again) {
  return {
    companyId,
    companyName,
    offersCreated,
    requestsMade,
    requestsReceived,
    requestsAccepted,
    firstActivity,
    lastActivity,
    again,
  };
}

function duration(count, medianHours, p90Hours, maxHours, notYet) {
  return { count, medianHours, p90Hours, maxHours, notYet };
}

const EMPTY = {
  offers: { created: 0, published: 0, onChain: 0 },
  requests: { arrived: 0, accepted: 0, declined: 0, withdrawn: 0, open: 0 },
  firstResponse: duration(0, null, null, null, 0),
  finalDecision: duration(0, null, null, null, 0),
  afterAcceptance: { completed: 0, cancelled: 0, rolled: 0, disputed: 0, carrierRejected: 0 },
  counters: { requests: 0, total: 0 },
  repeat: { again: 0, participants: [] },
};

// Unfiltered hand count.
// Offers: o-a1 published+confirmed, o-a2 published but publish still pending,
// o-b1 draft, o-b2 published+confirmed. created 4, published 3, on chain 2.
// Requests: 5 accepted, 2 declined, 1 withdrawn, 2 open (pending + old).
// First response hours, sorted: 1, 2, 3, 4, 6, 8, 12.
//   seller decline 1, direct accept 2, buyer-decline counter 3 (not the later 5),
//   counter-then-accept 4, carrier reject 6, rolled accept 8, dispute counter 12.
//   n=7, median = 4, p90 rank ceil(0.9*7)=7 → 12, max 12.
//   not yet: withdrawn, pending, old.
// Final decision hours, sorted: 1, 2, 5, 6, 7, 8, 10, 20.
//   n=8, median = (6+7)/2 = 6.5, p90 rank ceil(0.9*8)=8 → 20, max 20.
//   not yet: pending, old.
// After acceptance: one each of completed, cancelled, rolled (history, status is
// carrier_confirmed), disputed (refused event, cancellation.state is proposed),
// carrier rejected.
// Counters: cancelled, disputed, buyer-declined. 3 requests, 3 rows.
// Again: seller-a (1 Oct, 2 Oct, 3 Oct), seller-b (15 Sep, 2 Oct), buyer-a (15 Sep, 1 Oct).
const FULL = {
  offers: { created: 4, published: 3, onChain: 2 },
  requests: { arrived: 10, accepted: 5, declined: 2, withdrawn: 1, open: 2 },
  firstResponse: duration(7, 4, 12, 12, 3),
  finalDecision: duration(8, 6.5, 20, 20, 2),
  afterAcceptance: { completed: 1, cancelled: 1, rolled: 1, disputed: 1, carrierRejected: 1 },
  counters: { requests: 3, total: 3 },
  repeat: {
    again: 3,
    participants: [
      party("buyer-a", "Buyer One", 0, 5, 0, 3, "2026-09-15", "2026-10-01", true),
      party("buyer-b", "Buyer Two", 0, 5, 0, 2, "2026-10-02", "2026-10-02", false),
      party("seller-a", "Alpha Shipping", 2, 0, 5, 3, "2026-10-01", "2026-10-03", true),
      party("seller-b", "Beta Lines", 2, 0, 5, 2, "2026-09-15", "2026-10-02", true),
    ],
  },
};

// --since 2026-10-01 drops o-b2 and r-old. Inclusive, so 1 Oct stays.
const SINCE = {
  offers: { created: 3, published: 2, onChain: 1 },
  requests: { arrived: 9, accepted: 5, declined: 2, withdrawn: 1, open: 1 },
  firstResponse: duration(7, 4, 12, 12, 2),
  finalDecision: duration(8, 6.5, 20, 20, 1),
  afterAcceptance: { completed: 1, cancelled: 1, rolled: 1, disputed: 1, carrierRejected: 1 },
  counters: { requests: 3, total: 3 },
  repeat: {
    again: 1,
    participants: [
      party("buyer-a", "Buyer One", 0, 4, 0, 3, "2026-10-01", "2026-10-01", false),
      party("buyer-b", "Buyer Two", 0, 5, 0, 2, "2026-10-02", "2026-10-02", false),
      party("seller-a", "Alpha Shipping", 2, 0, 5, 3, "2026-10-01", "2026-10-03", true),
      party("seller-b", "Beta Lines", 1, 0, 4, 2, "2026-10-02", "2026-10-02", false),
    ],
  },
};

// --until 2026-10-01 keeps 15 Sep and 1 Oct. seller-b's only request in range
// never stored a seller name, and offers do not carry one.
const UNTIL = {
  offers: { created: 2, published: 2, onChain: 2 },
  requests: { arrived: 5, accepted: 3, declined: 0, withdrawn: 1, open: 1 },
  firstResponse: duration(3, 4, 8, 8, 2),
  finalDecision: duration(4, 7.5, 10, 10, 1),
  afterAcceptance: { completed: 1, cancelled: 1, rolled: 1, disputed: 0, carrierRejected: 0 },
  counters: { requests: 1, total: 1 },
  repeat: {
    again: 1,
    participants: [
      party("buyer-a", "Buyer One", 0, 5, 0, 3, "2026-09-15", "2026-10-01", true),
      party("seller-a", "Alpha Shipping", 1, 0, 4, 3, "2026-10-01", "2026-10-01", false),
      party("seller-b", null, 1, 0, 1, 0, "2026-09-15", "2026-09-15", false),
    ],
  },
};

// Both bounds: 1 Oct only. First hours 2, 4, 8. Final hours 2, 7, 8, 10.
const ONE_DAY = {
  offers: { created: 1, published: 1, onChain: 1 },
  requests: { arrived: 4, accepted: 3, declined: 0, withdrawn: 1, open: 0 },
  firstResponse: duration(3, 4, 8, 8, 1),
  finalDecision: duration(4, 7.5, 10, 10, 0),
  afterAcceptance: { completed: 1, cancelled: 1, rolled: 1, disputed: 0, carrierRejected: 0 },
  counters: { requests: 1, total: 1 },
  repeat: {
    again: 0,
    participants: [
      party("buyer-a", "Buyer One", 0, 4, 0, 3, "2026-10-01", "2026-10-01", false),
      party("seller-a", "Alpha Shipping", 1, 0, 4, 3, "2026-10-01", "2026-10-01", false),
    ],
  },
};

// Drop seller-b. r-old is buyer-a with seller-b, so buyer-a's made count loses it.
// First hours sorted 2, 3, 4, 8: median (3+4)/2 = 3.5, p90 rank 4 → 8.
// Final hours sorted 2, 5, 7, 8, 10: median 7, p90 rank 5 → 10.
const EXCLUDE_SELLER_B = {
  offers: { created: 2, published: 2, onChain: 1 },
  requests: { arrived: 5, accepted: 3, declined: 1, withdrawn: 1, open: 0 },
  firstResponse: duration(4, 3.5, 8, 8, 1),
  finalDecision: duration(5, 7, 10, 10, 0),
  afterAcceptance: { completed: 1, cancelled: 1, rolled: 1, disputed: 0, carrierRejected: 0 },
  counters: { requests: 2, total: 2 },
  repeat: {
    again: 1,
    participants: [
      party("buyer-a", "Buyer One", 0, 4, 0, 3, "2026-10-01", "2026-10-01", false),
      party("buyer-b", "Buyer Two", 0, 1, 0, 0, "2026-10-02", "2026-10-02", false),
      party("seller-a", "Alpha Shipping", 2, 0, 5, 3, "2026-10-01", "2026-10-03", true),
    ],
  },
};

// seller-b and buyer-a. The only request left is the buyer declining a counter:
// first response is the 3h counter, final decision is the 5h decline.
const EXCLUDE_BOTH = {
  offers: { created: 2, published: 2, onChain: 1 },
  requests: { arrived: 1, accepted: 0, declined: 1, withdrawn: 0, open: 0 },
  firstResponse: duration(1, 3, 3, 3, 0),
  finalDecision: duration(1, 5, 5, 5, 0),
  afterAcceptance: { completed: 0, cancelled: 0, rolled: 0, disputed: 0, carrierRejected: 0 },
  counters: { requests: 1, total: 1 },
  repeat: {
    again: 1,
    participants: [
      party("buyer-b", "Buyer Two", 0, 1, 0, 0, "2026-10-02", "2026-10-02", false),
      party("seller-a", "Alpha Shipping", 2, 0, 1, 0, "2026-10-01", "2026-10-03", true),
    ],
  },
};

const NUMBER_KEYS = [
  ["offers.created", (report) => report.offers.created],
  ["offers.published", (report) => report.offers.published],
  ["offers.onChain", (report) => report.offers.onChain],
  ["requests.arrived", (report) => report.requests.arrived],
  ["requests.accepted", (report) => report.requests.accepted],
  ["requests.declined", (report) => report.requests.declined],
  ["requests.withdrawn", (report) => report.requests.withdrawn],
  ["requests.open", (report) => report.requests.open],
  ["firstResponse.count", (report) => report.firstResponse.count],
  ["firstResponse.medianHours", (report) => report.firstResponse.medianHours],
  ["firstResponse.p90Hours", (report) => report.firstResponse.p90Hours],
  ["firstResponse.maxHours", (report) => report.firstResponse.maxHours],
  ["firstResponse.notYet", (report) => report.firstResponse.notYet],
  ["finalDecision.count", (report) => report.finalDecision.count],
  ["finalDecision.medianHours", (report) => report.finalDecision.medianHours],
  ["finalDecision.p90Hours", (report) => report.finalDecision.p90Hours],
  ["finalDecision.maxHours", (report) => report.finalDecision.maxHours],
  ["finalDecision.notYet", (report) => report.finalDecision.notYet],
  ["afterAcceptance.completed", (report) => report.afterAcceptance.completed],
  ["afterAcceptance.cancelled", (report) => report.afterAcceptance.cancelled],
  ["afterAcceptance.rolled", (report) => report.afterAcceptance.rolled],
  ["afterAcceptance.disputed", (report) => report.afterAcceptance.disputed],
  ["afterAcceptance.carrierRejected", (report) => report.afterAcceptance.carrierRejected],
  ["counters.requests", (report) => report.counters.requests],
  ["counters.total", (report) => report.counters.total],
  ["repeat.again", (report) => report.repeat.again],
];

function run(args, extraEnv) {
  const env = { ...process.env };
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value == null) delete env[key];
      else env[key] = value;
    }
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function snapshot(file) {
  const stat = fs.statSync(file, { bigint: true });
  return {
    bytes: fs.readFileSync(file),
    mtimeNs: stat.mtimeNs,
    names: fs.readdirSync(path.dirname(file)).sort(),
  };
}

function assertUnchanged(file, before) {
  const after = snapshot(file);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.ok(after.bytes.equals(before.bytes));
  assert.deepEqual(after.names, before.names);
}

function withFile(fixture, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-pilot-"));
  const file = path.join(dir, "records.json");
  fs.writeFileSync(file, `${JSON.stringify(fixture)}\n`);
  const before = snapshot(file);
  try {
    fn(file, before);
    assertUnchanged(file, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertSameNumbers(text, report) {
  for (const [key, pick] of NUMBER_KEYS) {
    const match = text.match(new RegExp(`^${key}: (.+)$`, "m"));
    assert.ok(match, key);
    const value = pick(report);
    if (value == null) assert.equal(match[1], "none", key);
    else if (key.endsWith("Hours")) assert.equal(match[1], value.toFixed(1), key);
    else assert.equal(match[1], String(value), key);
  }
}

function assertReport(file, args, expected) {
  const textRun = run(["--file", file, ...args]);
  const jsonRun = run(["--file", file, ...args, "--json"]);
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  assert.equal(textRun.stderr, "");
  assert.equal(jsonRun.stderr, "");
  const report = JSON.parse(jsonRun.stdout);
  assert.deepEqual(report, expected);
  assertSameNumbers(textRun.stdout, report);
  const lines = textRun.stdout.split("\n").filter((line) => line.startsWith("participant "));
  assert.equal(lines.length, expected.repeat.participants.length);
  assert.match(textRun.stdout, /not yet/);
  return textRun.stdout;
}

module.exports = { buildFixture };

describe("pilot metrics", () => {
  it("builds hour offsets on UTC timestamps", () => {
    assert.equal(hoursAfter("2026-10-01T01:00:00.000Z", 10), "2026-10-01T11:00:00.000Z");
    assert.equal(hoursAfter("2026-10-02T00:00:00.000Z", 20), "2026-10-02T20:00:00.000Z");
  });

  it("counts the hand fixture, and the text matches the JSON", () => {
    withFile(buildFixture(), (file) => {
      const text = assertReport(file, [], FULL);
      const headers = text.split("\n").filter((line) => {
        return /^(Range|Offers|Requests|First response|Final decision|After acceptance|Counters|Participants):/.test(line);
      });
      assert.equal(headers.length, 8);
      const readme = fs.readFileSync(README, "utf8");
      for (const header of headers) assert.ok(readme.includes(header), header);
    });
  });

  it("applies an inclusive --since and keeps later days", () => {
    withFile(buildFixture(), (file) => {
      assertReport(file, ["--since", "2026-10-01"], SINCE);
    });
  });

  it("applies an inclusive --until and keeps earlier days", () => {
    withFile(buildFixture(), (file) => {
      assertReport(file, ["--until", "2026-10-01"], UNTIL);
    });
  });

  it("intersects --since and --until", () => {
    withFile(buildFixture(), (file) => {
      assertReport(file, ["--since", "2026-10-01", "--until", "2026-10-01"], ONE_DAY);
    });
  });

  it("drops a request that touches one excluded company", () => {
    withFile(buildFixture(), (file) => {
      assertReport(file, ["--exclude-company", "seller-b"], EXCLUDE_SELLER_B);
    });
  });

  it("applies --exclude-company twice", () => {
    withFile(buildFixture(), (file) => {
      assertReport(file, ["--exclude-company", "seller-b", "--exclude-company", "buyer-a"], EXCLUDE_BOTH);
    });
  });

  it("prints zeros and not yet when nothing matches", () => {
    const empty = { schemaVersion: 7, offers: {}, requests: {} };
    withFile(empty, (file) => {
      assertReport(file, [], EMPTY);
    });
    withFile({ schemaVersion: 7 }, (file) => {
      assertReport(file, [], EMPTY);
    });
    withFile(buildFixture(), (file) => {
      assertReport(file, [
        "--exclude-company", "seller-a",
        "--exclude-company", "seller-b",
        "--exclude-company", "buyer-a",
        "--exclude-company", "buyer-b",
      ], EMPTY);
    });
  });

  it("leaves the fixture bytes and mtime unchanged", () => {
    withFile(buildFixture(), (file, before) => {
      const result = run(["--file", file]);
      assert.equal(result.status, 0);
      assertUnchanged(file, before);
      const again = run(["--file", file, "--json", "--since", "2026-10-01", "--exclude-company", "seller-b"]);
      assert.equal(again.status, 0);
      assertUnchanged(file, before);
    });
  });

  it("exits 2 on a schema other than 7 and does not rewrite the file", () => {
    for (const schemaVersion of [6, 8, "7"]) {
      withFile({ schemaVersion, offers: { kept: true } }, (file) => {
        const result = run(["--file", file]);
        assert.equal(result.status, 2);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.includes("\n"), true);
        assert.equal(result.stdout.trim().split("\n").length, 1);
        assert.match(result.stdout, /expected 7/);
      });
    }
    withFile({ schemaVersion: 6 }, (file) => {
      const result = run(["--file", file]);
      assert.equal(result.stdout, "schemaVersion is 6, expected 7\n");
    });
  });

  it("reads OCEANRELAY_RECORDS_PATH, and --file wins", () => {
    withFile(buildFixture(), (file) => {
      const fromEnv = run([], { OCEANRELAY_RECORDS_PATH: file });
      assert.equal(fromEnv.status, 0, fromEnv.stderr);
      assert.deepEqual(JSON.parse(run(["--json"], { OCEANRELAY_RECORDS_PATH: file }).stdout), FULL);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-pilot-"));
    try {
      const good = path.join(dir, "good.json");
      const old = path.join(dir, "old.json");
      fs.writeFileSync(good, `${JSON.stringify(buildFixture())}\n`);
      fs.writeFileSync(old, `${JSON.stringify({ schemaVersion: 6 })}\n`);
      const result = run(["--file", good, "--json"], { OCEANRELAY_RECORDS_PATH: old });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), FULL);
      assert.equal(fs.readFileSync(old, "utf8"), `${JSON.stringify({ schemaVersion: 6 })}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not call openRecords, write, or open the network", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    assert.equal(source.includes("openRecords"), false);
    assert.equal(source.includes("writeFile"), false);
    assert.equal(source.includes("appendFile"), false);
    assert.equal(source.includes("fetch("), false);
    assert.equal(source.includes("node:http"), false);
    assert.equal(source.includes("node:https"), false);
    assert.equal(source.includes("node:net"), false);
    assert.equal(source.includes("node:dns"), false);
    assert.equal(source.includes("lib/records"), false);
    assert.match(source, /readFileSync/);
    assert.match(source, /JSON\.parse/);
  });

  it("treats a seller decline as the first response and a withdrawal as final only", () => {
    const created = "2026-10-02T02:00:00.000Z";
    const declined = {
      schemaVersion: 7,
      offers: {},
      requests: {
        only: requestRow({
          id: "only",
          offerId: "o-b1",
          createdAt: created,
          buyer: "buyer-b",
          seller: "seller-b",
          state: "declined",
          history: [
            historyEntry(null, "pending", SUB["buyer-b"], created, null),
            historyEntry("pending", "declined", SUB["seller-b"], hoursAfter(created, 1), null),
          ],
        }),
      },
    };
    withFile(declined, (file) => {
      const report = JSON.parse(run(["--file", file, "--json"]).stdout);
      assert.deepEqual(report.firstResponse, duration(1, 1, 1, 1, 0));
      assert.deepEqual(report.finalDecision, duration(1, 1, 1, 1, 0));
    });

    const withdrawnAt = "2026-10-01T03:00:00.000Z";
    const withdrawn = {
      schemaVersion: 7,
      offers: {},
      requests: {
        only: requestRow({
          id: "only",
          offerId: "o-a1",
          createdAt: withdrawnAt,
          buyer: "buyer-a",
          seller: "seller-a",
          state: "withdrawn",
          history: [
            historyEntry(null, "pending", SUB["buyer-a"], withdrawnAt, null),
            historyEntry("pending", "withdrawn", SUB["buyer-a"], hoursAfter(withdrawnAt, 7), null),
          ],
        }),
      },
    };
    withFile(withdrawn, (file) => {
      const report = JSON.parse(run(["--file", file, "--json"]).stdout);
      assert.equal(report.requests.withdrawn, 1);
      assert.deepEqual(report.firstResponse, duration(0, null, null, null, 1));
      assert.deepEqual(report.finalDecision, duration(1, 7, 7, 7, 0));
    });
  });

  it("exits 1 on a missing file or a bad date, and does not create the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-pilot-"));
    try {
      const missing = path.join(dir, "missing.json");
      const result = run(["--file", missing], { OCEANRELAY_RECORDS_PATH: null });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(fs.existsSync(missing), false);
      const bad = run(["--file", missing, "--since", "2026-02-29"]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /YYYY-MM-DD/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
