"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  CURRENCIES,
  CAPACITY_STATUSES,
  SELLER_CLAIM_CAVEAT,
  CARRIER_CONFIRMED_CAVEAT,
  CAPACITY_CAVEATS,
  LIMITS,
  canChangeCapacityStatus,
  validateDraft,
  priceBuyer,
  snapshotFromRate,
  sourceWarnings,
  canonicalTerms,
  termsHash,
  buyerView,
} = require("../lib/offer-domain");

const SELLER_CLAIM = "Quantity is the seller's claim. OceanRelay has not confirmed the space.";
const CARRIER_CONFIRMED = "A carrier confirmation was recorded. The carrier can still roll, change, or cancel.";

function draft(overrides = {}) {
  return {
    source: "rn_rate",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 12,
    unit: "container",
    sailingStart: "2026-11-01",
    sailingEnd: "2026-11-20",
    validityDeadline: "2026-11-18",
    cutoffDate: "2026-10-28",
    currency: "USD",
    baseMinor: 2468013579,
    markup: { type: "absolute", minor: 1357924680 },
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY. No hazardous cargo.",
    ...overrides,
  };
}

function rateDto(overrides = {}) {
  return {
    id: "rate_1",
    source: "contract",
    allocationEvidence: false,
    capacityQuantity: null,
    carrier: "ABC",
    contractOwner: "Kings",
    ownerCompanyId: "kings",
    originPort: "CNSHA",
    destinationPort: "USLAX",
    inlandDeliveryLocation: null,
    commodityType: "FAK",
    rate20D: 1200,
    rate40D: 0,
    rate40HC: 2100,
    currency: null,
    rateEffectiveDate: "2026-09-01",
    rateExpirationDate: "2026-12-31",
    updatedAt: null,
    notes: "rn-internal-note",
    ...overrides,
  };
}

function keysDeep(value, found = []) {
  if (!value || typeof value !== "object") return found;
  for (const key of Object.keys(value)) {
    found.push(key);
    keysDeep(value[key], found);
  }
  return found;
}

describe("currencies and status copy", () => {
  it("lists D-5 currencies and exponents", () => {
    assert.deepEqual(CURRENCIES, {
      USD: 2,
      EUR: 2,
      GBP: 2,
      CNY: 2,
      HKD: 2,
      SGD: 2,
      JPY: 0,
      KRW: 0,
    });
  });

  it("lists the three capacity statuses and the shared caveat sentences", () => {
    assert.deepEqual(CAPACITY_STATUSES, ["seller_asserted", "carrier_pending", "carrier_confirmed"]);
    assert.equal(SELLER_CLAIM_CAVEAT, SELLER_CLAIM);
    assert.equal(CARRIER_CONFIRMED_CAVEAT, CARRIER_CONFIRMED);
    assert.equal(CAPACITY_CAVEATS.seller_asserted, SELLER_CLAIM);
    assert.equal(CAPACITY_CAVEATS.carrier_pending, SELLER_CLAIM);
    assert.equal(CAPACITY_CAVEATS.carrier_confirmed, CARRIER_CONFIRMED);
  });
});

describe("canChangeCapacityStatus", () => {
  it("allows asserted to pending to confirmed, asserted straight to confirmed, and back down to asserted", () => {
    assert.equal(canChangeCapacityStatus("seller_asserted", "carrier_pending"), true);
    assert.equal(canChangeCapacityStatus("carrier_pending", "carrier_confirmed"), true);
    assert.equal(canChangeCapacityStatus("seller_asserted", "carrier_confirmed"), true);
    assert.equal(canChangeCapacityStatus("carrier_pending", "seller_asserted"), true);
    assert.equal(canChangeCapacityStatus("carrier_confirmed", "seller_asserted"), true);
  });

  it("refuses a sideways drop, a no-op, and unknown statuses", () => {
    assert.equal(canChangeCapacityStatus("carrier_confirmed", "carrier_pending"), false);
    assert.equal(canChangeCapacityStatus("seller_asserted", "seller_asserted"), false);
    assert.equal(canChangeCapacityStatus("carrier_pending", "carrier_pending"), false);
    assert.equal(canChangeCapacityStatus("nope", "carrier_confirmed"), false);
    assert.equal(canChangeCapacityStatus("seller_asserted", "rolled"), false);
  });

  it("does not let any Rate Ninja field change a capacity status", () => {
    assert.equal(canChangeCapacityStatus.length, 2);
    const rate = rateDto({
      allocationEvidence: true,
      capacityQuantity: 40,
      notes: "carrier_confirmed",
    });
    delete rate.notes;
    rate.notes = "carrier confirmed text";
    for (const value of Object.values(rate)) {
      assert.equal(canChangeCapacityStatus("seller_asserted", value), false);
      assert.equal(canChangeCapacityStatus(value, "carrier_confirmed"), false);
      assert.equal(canChangeCapacityStatus(value, "carrier_pending"), false);
    }
    assert.equal(canChangeCapacityStatus("seller_asserted", "carrier_confirmed", rate), true);
    assert.equal(canChangeCapacityStatus("seller_asserted", rate), false);
    assert.equal(canChangeCapacityStatus(rate, "carrier_confirmed"), false);
  });
});

describe("validateDraft", () => {
  it("normalizes a windowed draft and drops unknown keys", () => {
    const input = draft({
      origin: "  CNSHA  ",
      currency: " usd ",
      markup: { bps: 1, ignored: true, type: "absolute", minor: 0 },
      futurePrivateField: "x",
      privateNotes: "keep-off",
      buyerMinor: 1,
      capacityStatus: "carrier_confirmed",
    });
    const result = validateDraft(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, {});
    assert.equal(result.value.origin, "CNSHA");
    assert.equal(result.value.currency, "USD");
    assert.deepEqual(result.value.markup, { type: "absolute", minor: 0 });
    assert.equal(result.value.futurePrivateField, undefined);
    assert.equal(result.value.privateNotes, undefined);
    assert.equal(result.value.buyerMinor, undefined);
    assert.equal(result.value.capacityStatus, undefined);
    assert.equal(Object.hasOwn(result.value, "companyId"), false);
    input.markup.minor = 99;
    assert.equal(result.value.markup.minor, 0);
  });

  it("normalizes a single sailing date into a one-day window and omits an empty cutoff", () => {
    const result = validateDraft(draft({
      sailingStart: undefined,
      sailingEnd: undefined,
      sailingDate: "2026-11-12",
      validityDeadline: "2026-11-12",
      cutoffDate: "  ",
    }));
    assert.equal(result.ok, true);
    assert.equal(result.value.sailingStart, "2026-11-12");
    assert.equal(result.value.sailingEnd, "2026-11-12");
    assert.equal(Object.hasOwn(result.value, "sailingDate"), false);
    assert.equal(Object.hasOwn(result.value, "cutoffDate"), false);
  });

  it("does not carry companyId or sub from the input into value", () => {
    const result = validateDraft(draft({ companyId: "kings", sub: "user-owner" }));
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.value, "companyId"), false);
    assert.equal(Object.hasOwn(result.value, "sub"), false);
    const parsed = JSON.parse('{"__proto__":{"admin":true},"source":"manual"}');
    const dropped = validateDraft({ ...draft(), ...parsed });
    assert.equal(dropped.ok, true);
    assert.equal(dropped.value.source, "manual");
    assert.equal(Object.hasOwn(dropped.value, "__proto__"), false);
    assert.equal(Object.hasOwn(dropped.value, "admin"), false);
    assert.equal(Object.prototype.admin, undefined);
  });

  it("keys an error to every required field when the input is empty", () => {
    const result = validateDraft({});
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    const required = [
      "source",
      "origin",
      "destination",
      "equipment",
      "quantity",
      "unit",
      "sailingStart",
      "sailingEnd",
      "validityDeadline",
      "currency",
      "baseMinor",
      "markup",
      "codeShareName",
      "operatingCarrier",
      "serviceTerms",
    ];
    for (const field of required) {
      assert.equal(typeof result.errors[field], "string", field);
      assert.ok(result.errors[field].length > 0, field);
    }
  });

  it("keys an error to each required field when that field alone is missing", () => {
    const fields = [
      "source",
      "origin",
      "destination",
      "equipment",
      "quantity",
      "unit",
      "validityDeadline",
      "currency",
      "baseMinor",
      "markup",
      "codeShareName",
      "operatingCarrier",
      "serviceTerms",
    ];
    for (const field of fields) {
      const input = draft();
      delete input[field];
      const result = validateDraft(input);
      assert.equal(result.ok, false, field);
      assert.equal(typeof result.errors[field], "string", field);
    }
    const window = validateDraft(draft({ sailingStart: undefined, sailingEnd: undefined }));
    assert.equal(typeof window.errors.sailingStart, "string");
    assert.equal(typeof window.errors.sailingEnd, "string");
  });

  it("rejects a sailing window whose end is before its start", () => {
    const result = validateDraft(draft({
      sailingStart: "2026-11-20",
      sailingEnd: "2026-11-01",
      validityDeadline: "2026-11-01",
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.sailingEnd, /not be before the start/);
  });

  it("rejects a validity deadline after the sailing window end", () => {
    const result = validateDraft(draft({ validityDeadline: "2026-11-21" }));
    assert.equal(result.ok, false);
    assert.match(result.errors.validityDeadline, /not be after the sailing window end/);
  });

  it("accepts a deadline on the window end and a same-day window", () => {
    const onEnd = validateDraft(draft({ validityDeadline: "2026-11-20" }));
    assert.equal(onEnd.ok, true);
    const sameDay = validateDraft(draft({
      sailingStart: "2026-11-20",
      sailingEnd: "2026-11-20",
      validityDeadline: "2026-11-20",
    }));
    assert.equal(sameDay.ok, true);
  });

  it("rejects an impossible calendar date and a bad cutoff", () => {
    const badDay = validateDraft(draft({ sailingEnd: "2026-02-31", validityDeadline: "2026-02-28" }));
    assert.equal(badDay.ok, false);
    assert.match(badDay.errors.sailingEnd, /YYYY-MM-DD/);
    const badCutoff = validateDraft(draft({ cutoffDate: "28/10/2026" }));
    assert.equal(badCutoff.ok, false);
    assert.match(badCutoff.errors.cutoffDate, /YYYY-MM-DD/);
  });

  it("rejects a sailing date that disagrees with the window", () => {
    const result = validateDraft(draft({ sailingDate: "2026-11-02" }));
    assert.equal(result.ok, false);
    assert.equal(typeof result.errors.sailingDate, "string");
  });

  it("enforces string limits, integer money, and the unit allowlist", () => {
    const longOrigin = validateDraft(draft({ origin: "A".repeat(LIMITS.origin + 1) }));
    assert.match(longOrigin.errors.origin, /80/);
    const longTerms = validateDraft(draft({ serviceTerms: "A".repeat(LIMITS.serviceTerms + 1) }));
    assert.match(longTerms.errors.serviceTerms, /4000/);
    assert.equal(validateDraft(draft({ quantity: 0 })).errors.quantity !== undefined, true);
    assert.equal(validateDraft(draft({ quantity: 1.5 })).errors.quantity !== undefined, true);
    assert.equal(validateDraft(draft({ quantity: "12" })).errors.quantity !== undefined, true);
    assert.equal(validateDraft(draft({ baseMinor: 0 })).errors.baseMinor !== undefined, true);
    assert.equal(validateDraft(draft({ currency: "US" })).errors.currency !== undefined, true);
    assert.equal(validateDraft(draft({ equipment: "45HC" })).errors.equipment !== undefined, true);
    assert.equal(validateDraft(draft({ unit: "teu" })).errors.unit !== undefined, true);
    assert.equal(validateDraft(draft({ source: "rate" })).errors.source !== undefined, true);
    const percent = validateDraft(draft({ markup: { type: "percent", bps: 0, note: "no" } }));
    assert.equal(percent.ok, true);
    assert.deepEqual(percent.value.markup, { type: "percent", bps: 0 });
    assert.equal(validateDraft(draft({ markup: { type: "percent", bps: -1 } })).ok, false);
    assert.equal(validateDraft(draft({ markup: { type: "absolute", minor: -1 } })).ok, false);
  });

  it("rejects a non-object and a buyer price that cannot fit in a safe integer", () => {
    const missing = validateDraft(null);
    assert.equal(missing.ok, false);
    assert.equal(typeof missing.errors.origin, "string");
    const huge = validateDraft(draft({
      baseMinor: Number.MAX_SAFE_INTEGER,
      markup: { type: "absolute", minor: 1 },
    }));
    assert.equal(huge.ok, false);
    assert.match(huge.errors.markup, /too large/);
  });
});

describe("priceBuyer", () => {
  it("adds an absolute markup and leaves a zero percent markup unchanged", () => {
    assert.equal(priceBuyer({ baseMinor: 1000, markup: { type: "absolute", minor: 25 } }), 1025);
    assert.equal(priceBuyer({ baseMinor: 1000, markup: { type: "percent", bps: 0 } }), 1000);
    assert.equal(priceBuyer({ baseMinor: Number.MAX_SAFE_INTEGER, markup: { type: "percent", bps: 0 } }), Number.MAX_SAFE_INTEGER);
  });

  it("rounds a percent markup that lands on exactly .5 half-up", () => {
    assert.equal(priceBuyer({ baseMinor: 1, markup: { type: "percent", bps: 5000 } }), 2);
    assert.equal(priceBuyer({ baseMinor: 100, markup: { type: "percent", bps: 50 } }), 101);
    assert.equal(priceBuyer({ baseMinor: 3, markup: { type: "percent", bps: 5000 } }), 5);
  });

  it("keeps a large half-up boundary as a safe integer where float rounding is short", () => {
    const baseMinor = 100000000020001;
    const markup = { type: "percent", bps: 25000 };
    const floatMarkup = Math.round(baseMinor * markup.bps / 10000);
    const exactMarkup = Number((BigInt(baseMinor) * BigInt(markup.bps) + 5000n) / 10000n);
    assert.notEqual(floatMarkup, exactMarkup);
    assert.equal(priceBuyer({ baseMinor, markup }), baseMinor + exactMarkup);
    assert.equal(Number.isSafeInteger(priceBuyer({ baseMinor, markup })), true);
  });

  it("refuses a buyer price past MAX_SAFE_INTEGER", () => {
    assert.throws(
      () => priceBuyer({ baseMinor: Number.MAX_SAFE_INTEGER, markup: { type: "absolute", minor: 1 } }),
      RangeError,
    );
  });
});

describe("snapshotFromRate", () => {
  it("freezes the full DTO, the chosen column, and the fields it seeds", () => {
    const rate = rateDto();
    const snapshot = snapshotFromRate(rate, "40HC", "2026-09-28T18:00:00.000Z");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.dto), true);
    assert.equal(snapshot.equipment, "40HC");
    assert.equal(snapshot.baseAmount, 2100);
    assert.equal(snapshot.retrievedAt, "2026-09-28T18:00:00.000Z");
    assert.equal(snapshot.dto.notes, "rn-internal-note");
    assert.equal(snapshot.dto.allocationEvidence, false);
    assert.equal(snapshot.dto.capacityQuantity, null);
    assert.equal(snapshot.dto.currency, null);
    assert.deepEqual(snapshot.seededFields, [
      "origin",
      "destination",
      "carrier",
      "effectiveDate",
      "expirationDate",
      "baseAmount",
    ]);
    assert.deepEqual(snapshot.seeded, {
      origin: "CNSHA",
      destination: "USLAX",
      carrier: "ABC",
      effectiveDate: "2026-09-01",
      expirationDate: "2026-12-31",
      baseAmount: 2100,
    });
    assert.equal(Object.hasOwn(snapshot, "capacityStatus"), false);
    rate.notes = "changed-after";
    rate.rate40HC = 1;
    assert.equal(snapshot.dto.notes, "rn-internal-note");
    assert.equal(snapshot.baseAmount, 2100);
    assert.throws(() => {
      snapshot.baseAmount = 1;
    }, TypeError);
  });

  it("refuses a 0 column and a missing column", () => {
    const zero = snapshotFromRate(rateDto(), "40D", "2026-09-28T18:00:00.000Z");
    assert.deepEqual(zero, { ok: false, error: "no_price_for_equipment" });
    const missing = snapshotFromRate(rateDto({ rate20D: undefined }), "20D", "2026-09-28T18:00:00.000Z");
    assert.deepEqual(missing, { ok: false, error: "no_price_for_equipment" });
    const otherColumnStillPriced = snapshotFromRate(rateDto({ rate40HC: 0, rate20D: 500 }), "40HC", "2026-09-28T18:00:00.000Z");
    assert.equal(otherColumnStillPriced.ok, false);
    assert.equal(snapshotFromRate(rateDto(), "45", "2026-09-28T18:00:00.000Z").error, "unknown_equipment");
  });
});

describe("sourceWarnings", () => {
  const today = "2026-09-28";

  function frozenSnapshot(overrides) {
    return snapshotFromRate(rateDto(overrides), "40HC", "2026-09-28T18:00:00.000Z");
  }

  it("warns when the current rate is missing and does not change the snapshot", () => {
    const snapshot = frozenSnapshot();
    const before = JSON.stringify(snapshot);
    assert.deepEqual(sourceWarnings(snapshot, null, today), ["source_missing"]);
    assert.deepEqual(sourceWarnings(snapshot, undefined, today), ["source_missing"]);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(Object.isFrozen(snapshot), true);
  });

  it("returns no warnings when the DTO is unchanged and the expiration is still in force", () => {
    const snapshot = frozenSnapshot({ rateExpirationDate: "2026-09-28" });
    const reversed = {};
    for (const key of Object.keys(snapshot.dto).reverse()) reversed[key] = snapshot.dto[key];
    assert.deepEqual(sourceWarnings(snapshot, reversed, today), []);
    assert.deepEqual(sourceWarnings(snapshot, rateDto({ rateExpirationDate: "2026-09-28" }), today), []);
  });

  it("warns when any DTO field differs", () => {
    const snapshot = frozenSnapshot();
    assert.deepEqual(sourceWarnings(snapshot, rateDto({ notes: "edited" }), today), ["source_changed"]);
    assert.deepEqual(
      sourceWarnings(snapshot, rateDto({ allocationEvidence: true }), today),
      ["source_changed"],
    );
  });

  it("warns when the expiration date is before today", () => {
    const snapshot = frozenSnapshot();
    assert.deepEqual(
      sourceWarnings(snapshot, rateDto({ rateExpirationDate: "2026-09-27" }), today),
      ["source_changed", "source_expired"],
    );
    const alreadyExpired = frozenSnapshot({ rateExpirationDate: "2026-01-01" });
    assert.deepEqual(sourceWarnings(alreadyExpired, rateDto({ rateExpirationDate: "2026-01-01" }), today), [
      "source_expired",
    ]);
  });

  it("warns when the expiration date cannot be read, including slash dates and null", () => {
    const snapshot = frozenSnapshot();
    for (const rateExpirationDate of [null, "", "not-a-date", "03/15/2026", "28/09/2026"]) {
      const warnings = sourceWarnings(snapshot, rateDto({ rateExpirationDate }), today);
      assert.equal(warnings.includes("source_expired"), false, String(rateExpirationDate));
      assert.equal(warnings.includes("source_date_unreadable"), true, String(rateExpirationDate));
    }
  });

  it("reads an ISO datetime and an Excel serial without shifting the calendar date", () => {
    // 2026-09-27T23:00:00-05:00 is 2026-09-28 in UTC. Expiry uses the written
    // calendar date, so this is already expired on 2026-09-28.
    const written = "2026-09-27T23:00:00-05:00";
    const snapshot = frozenSnapshot({ rateExpirationDate: written });
    assert.deepEqual(sourceWarnings(snapshot, rateDto({ rateExpirationDate: written }), today), [
      "source_expired",
    ]);
    assert.deepEqual(
      sourceWarnings(snapshot, rateDto({ rateExpirationDate: 46023 }), today),
      ["source_changed", "source_expired"],
    );
    const onDay = frozenSnapshot({ rateExpirationDate: 46293 });
    assert.deepEqual(sourceWarnings(onDay, rateDto({ rateExpirationDate: 46293 }), today), []);
    const before = JSON.stringify(snapshot);
    sourceWarnings(snapshot, rateDto({ rateExpirationDate: "garbage" }), today);
    assert.equal(JSON.stringify(snapshot), before);
  });
});

describe("canonicalTerms and termsHash", () => {
  const included = {
    source: "manual",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "20D",
    quantity: 4,
    unit: "container",
    sailingStart: "2026-11-01",
    sailingEnd: "2026-11-20",
    cutoffDate: "2026-10-28",
    validityDeadline: "2026-11-18",
    currency: "USD",
    baseMinor: 5000,
    markup: { type: "percent", bps: 250 },
    buyerMinor: 5125,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    capacityStatus: "seller_asserted",
  };

  it("is identical for the same content built in different key orders", () => {
    const forward = { ...included, markup: { type: "percent", bps: 250 } };
    const backward = {};
    for (const key of Object.keys(included).reverse()) backward[key] = included[key];
    backward.markup = { bps: 250, type: "percent", extra: "ignore" };
    backward.createdAt = "2026-09-28T00:00:00.000Z";
    backward.updatedAt = "2026-09-28T01:00:00.000Z";
    backward.snapshot = { retrievedAt: "2026-09-28T02:00:00.000Z", dto: { id: "rate_1" } };
    backward.companyId = "kings";
    backward.sub = "user-owner";
    backward.privateNotes = "secret";
    backward.sourceRecordId = "rate_1";
    assert.equal(canonicalTerms(forward), canonicalTerms(backward));
    const parsed = JSON.parse(canonicalTerms(forward));
    assert.deepEqual(Object.keys(parsed), [
      "v",
      "baseMinor",
      "buyerMinor",
      "capacityStatus",
      "codeShareName",
      "currency",
      "cutoffDate",
      "destination",
      "equipment",
      "markup",
      "operatingCarrier",
      "origin",
      "quantity",
      "sailingEnd",
      "sailingStart",
      "serviceTerms",
      "source",
      "unit",
      "validityDeadline",
    ]);
    assert.equal(parsed.v, 1);
    assert.deepEqual(parsed.markup, { bps: 250, type: "percent" });
    assert.equal(canonicalTerms(forward).startsWith('{"v":1,'), true);
  });

  it("differs when any included field changes, and ignores saved-at timestamps", () => {
    const base = canonicalTerms(included);
    const replacements = {
      source: "rn_rate",
      origin: "HKHKG",
      destination: "NLRTM",
      equipment: "40D",
      quantity: 5,
      unit: "box",
      sailingStart: "2026-11-02",
      sailingEnd: "2026-11-21",
      cutoffDate: "2026-10-29",
      validityDeadline: "2026-11-19",
      currency: "EUR",
      baseMinor: 5001,
      markup: { type: "absolute", minor: 10 },
      buyerMinor: 5126,
      codeShareName: "XY",
      operatingCarrier: "MSC",
      serviceTerms: "Door",
      capacityStatus: "carrier_confirmed",
    };
    for (const [field, value] of Object.entries(replacements)) {
      const next = canonicalTerms({ ...included, [field]: value });
      assert.notEqual(next, base, field);
    }
    const withoutCutoff = { ...included, cutoffDate: null };
    delete withoutCutoff.cutoffDate;
    assert.equal(canonicalTerms(withoutCutoff), canonicalTerms({ ...included, cutoffDate: null }));
    assert.notEqual(canonicalTerms(withoutCutoff), base);
    assert.equal(canonicalTerms({ ...included, savedAt: "2099-01-01T00:00:00.000Z" }), base);
  });

  it("hashes the canonical string with SHA-256", () => {
    assert.equal(
      termsHash("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const canonical = canonicalTerms(included);
    const expected = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    assert.equal(termsHash(canonical), expected);
    assert.match(termsHash(canonical), /^[0-9a-f]{64}$/);
    assert.notEqual(termsHash(canonicalTerms({ ...included, quantity: 9 })), termsHash(canonical));
  });
});

describe("buyerView", () => {
  it("projects the code-share line, the seller-provided flag, and the claim copy", () => {
    const view = buyerView({
      ...draft(),
      buyerMinor: 3825938259,
      capacityStatus: "seller_asserted",
    });
    assert.equal(view.codeShareLine, "XYZ, operated by ABC");
    assert.equal(view.codeShareNameIsSellerProvided, true);
    assert.deepEqual(view.lane, { origin: "CNSHA", destination: "USLAX" });
    assert.equal(view.equipment, "40HC");
    assert.deepEqual(view.quantity, {
      value: 12,
      unit: "container",
      label: "Seller's claim",
      caveat: SELLER_CLAIM,
    });
    assert.equal(view.capacityStatus, "seller_asserted");
    assert.equal(view.capacityCaveat, SELLER_CLAIM);
    assert.deepEqual(view.buyerPrice, { minor: 3825938259, currency: "USD" });
    assert.equal(view.serviceTerms, "CY/CY. No hazardous cargo.");
  });

  it("uses the carrier-confirmed caveat only after a confirmation is recorded", () => {
    const pending = buyerView({ ...draft(), buyerMinor: 10, capacityStatus: "carrier_pending" });
    assert.equal(pending.capacityCaveat, SELLER_CLAIM);
    assert.equal(pending.quantity.caveat, SELLER_CLAIM);
    const confirmed = buyerView({ ...draft(), buyerMinor: 10, capacityStatus: "carrier_confirmed" });
    assert.equal(confirmed.capacityCaveat, CARRIER_CONFIRMED);
    assert.equal(confirmed.quantity.caveat, SELLER_CLAIM);
  });

  it("shows the stored buyer price and omits an unknown field from the allowlist", () => {
    const offer = {
      ...draft(),
      buyerMinor: 50,
      capacityStatus: "seller_asserted",
      futurePrivateField: "x",
    };
    const view = buyerView(offer);
    assert.equal(view.buyerPrice.minor, 50);
    assert.equal(view.futurePrivateField, undefined);
    assert.equal(keysDeep(view).includes("futurePrivateField"), false);
    const values = [];
    JSON.stringify(view, (key, value) => {
      values.push(value);
      return value;
    });
    assert.equal(values.includes("x"), false);
    assert.deepEqual(Object.keys(view).sort(), [
      "buyerPrice",
      "capacityCaveat",
      "capacityStatus",
      "codeShareLine",
      "codeShareNameIsSellerProvided",
      "currency",
      "dates",
      "equipment",
      "lane",
      "quantity",
      "serviceTerms",
    ]);
  });

  it("does not serialize the base price, markup, snapshot, source id, notes, or sub", () => {
    const offer = {
      ...draft({
        baseMinor: 2468013579,
        markup: { type: "absolute", minor: 1357924680 },
      }),
      buyerMinor: 3825938259,
      capacityStatus: "carrier_confirmed",
      sub: "sub-secret",
      privateNotes: "PRIV-NOTE",
      notes: "PRIV-NOTE",
      sourceRecordId: "rate-id-secret",
      snapshot: { retrievedAt: "snap-secret", dto: { id: "snap-secret" } },
      futurePrivateField: "x",
      salt: "phase-five-salt",
    };
    const encoded = JSON.stringify(buyerView(offer));
    for (const secret of [
      "2468013579",
      "1357924680",
      "sub-secret",
      "PRIV-NOTE",
      "rate-id-secret",
      "snap-secret",
      "futurePrivateField",
      "phase-five-salt",
      "x",
    ]) {
      assert.equal(encoded.includes(secret), false, secret);
    }
    assert.equal(encoded.includes("3825938259"), true);
    assert.equal(encoded.includes(CARRIER_CONFIRMED), true);
    assert.equal(encoded.includes(SELLER_CLAIM), true);
  });

  it("keeps a percent markup value out of the serialized view", () => {
    const offer = {
      ...draft({
        baseMinor: 864197530,
        markup: { type: "percent", bps: 97531 },
        cutoffDate: undefined,
      }),
      capacityStatus: "seller_asserted",
    };
    delete offer.buyerMinor;
    const view = buyerView(offer);
    assert.equal(view.buyerPrice.minor, 9292802460);
    const encoded = JSON.stringify(view);
    assert.equal(encoded.includes("864197530"), false);
    assert.equal(encoded.includes("97531"), false);
    assert.equal(encoded.includes("9292802460"), true);
    assert.equal(view.dates.cutoffDate, null);
  });
});
