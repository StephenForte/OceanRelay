const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openRecords } = require("../lib/records");
const { auditEntry, DETAIL_KEYS, EVENTS } = require("../lib/audit");
const { priceBuyer } = require("../lib/offer-domain");
const { createServer } = require("../server");
const { COOKIE_NAME, signSession } = require("../lib/session");
const { loadConfig } = require("../lib/config");
const { openStore } = require("../lib/store");
const { decryptString } = require("../lib/crypto-box");
const { createMockRateNinja } = require("./mock-rate-ninja");

const TODAY = "2026-10-01";
const SELLER = { companyId: "kings", sub: "user-owner", companyName: "Kings" };
const BUYER = { companyId: "other-co", sub: "user-other", companyName: "Other Co" };
const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";
const SESSION_SECRET = "test-session-secret-value";
const ENCRYPTION_KEY = "test-token-encryption-key";
const PENDING_AAD = "oceanrelay-pkce-verifier";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-audit-"));
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

function readAudit(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).audit;
}

function publish(records, terms = manualTerms()) {
  const created = records.createOffer(SELLER, {
    source: terms.source,
    terms,
    snapshot: null,
    sourceRecordId: null,
    overriddenFields: [],
  });
  const published = records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
  assert.equal(published.ok, true);
  return published.offer;
}

function assertActor(entry, { sub, companyId, role }) {
  assert.deepEqual(entry.actor, { sub, companyId, role });
}

function assertSubject(entry, subject) {
  assert.deepEqual(entry.subject, subject);
}

describe("audit whitelist", () => {
  it("keeps only the listed detail keys and drops secrets", () => {
    const secret = `secret-${crypto.randomBytes(8).toString("hex")}`;
    const entry = auditEntry({
      event: "auth.refused",
      actor: { sub: "user-owner", companyId: "kings", role: "user", access_token: secret },
      subject: { offerId: "offer-1", requestId: "request-1", version: 2, code: secret },
      detail: {
        reason: "only_contract_owner",
        from: "pending",
        to: "accepted",
        counter: 3,
        quantity: 4,
        version: 2,
        access_token: secret,
        note: secret,
        markup: secret,
      },
    });
    assert.equal(JSON.stringify(entry).includes(secret), false);
    assert.deepEqual(Object.keys(entry.detail), DETAIL_KEYS.filter((key) => key in entry.detail));
    assert.deepEqual(entry.detail, {
      counter: 3,
      from: "pending",
      quantity: 4,
      reason: "only_contract_owner",
      to: "accepted",
      version: 2,
    });
    assert.deepEqual(entry.subject, { offerId: "offer-1", requestId: "request-1", version: 2 });
    assert.equal(EVENTS.includes("auth.refused"), true);
  });
});

describe("audit events", () => {
  it("records offer.created with the seller and the quantity", () => {
    withRecords((records, file) => {
      const created = records.createOffer(SELLER, {
        source: "manual",
        terms: manualTerms({ quantity: 8 }),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "offer.created");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: created.id, version: 1 });
      assert.deepEqual(entry.detail, { quantity: 8 });
    });
  });

  it("records offer.edited with the new version and quantity", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const before = readAudit(file).length;
      const edited = records.editOffer(SELLER.companyId, offer.id, {
        terms: manualTerms({ quantity: 9 }),
        overriddenFields: [],
      }, SELLER.sub, TODAY);
      assert.equal(edited.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(readAudit(file).length, before + 1);
      assert.equal(entry.event, "offer.edited");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: offer.id, version: edited.offer.currentVersion });
      assert.deepEqual(entry.detail, { quantity: 9 });
    });
  });

  it("records offer.state with from and to", () => {
    withRecords((records, file) => {
      const created = records.createOffer(SELLER, {
        source: "manual",
        terms: manualTerms(),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      const published = records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
      assert.equal(published.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "offer.state");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: created.id, version: 1 });
      assert.deepEqual(entry.detail, { from: "draft", to: "published" });
    });
  });

  it("records offer.capacity_status with from and to", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const moved = records.setCapacityStatus(SELLER.companyId, offer.id, "carrier_pending", SELLER.sub, TODAY);
      assert.equal(moved.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "offer.capacity_status");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assert.equal(entry.subject.offerId, offer.id);
      assert.deepEqual(entry.detail, { from: "seller_asserted", to: "carrier_pending" });
    });
  });

  it("records request.created with the buyer, the pinned version and the quantity", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, offer.currentVersion, 3, TODAY);
      assert.equal(created.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "request.created");
      assertActor(entry, { sub: BUYER.sub, companyId: BUYER.companyId, role: "buyer" });
      assertSubject(entry, { offerId: offer.id, requestId: created.request.id, version: offer.currentVersion });
      assert.deepEqual(entry.detail, { quantity: 3 });
    });
  });

  it("records request.countered with the counter number and quantity", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 3, TODAY);
      const countered = records.counterRequest(SELLER, created.request.id, {
        quantity: 2,
        unitBuyerMinor: 2500,
        serviceTerms: "Counter",
      }, TODAY);
      assert.equal(countered.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "request.countered");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: offer.id, requestId: created.request.id, version: 1 });
      assert.deepEqual(entry.detail, { counter: 1, quantity: 2 });
      assert.equal(JSON.stringify(entry).includes("2500"), false);
    });
  });

  it("records request.accepted with the acting role and quantity", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 3, TODAY);
      const accepted = records.acceptRequest(SELLER, created.request.id, TODAY);
      assert.equal(accepted.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "request.accepted");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: offer.id, requestId: created.request.id, version: 1 });
      assert.deepEqual(entry.detail, { from: "pending", quantity: 3, to: "accepted" });
    });
  });

  it("records request.declined", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 3, TODAY);
      const declined = records.declineRequest(SELLER, created.request.id);
      assert.equal(declined.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "request.declined");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assertSubject(entry, { offerId: offer.id, requestId: created.request.id, version: 1 });
      assert.deepEqual(entry.detail, { from: "pending", to: "declined" });
    });
  });

  it("records request.withdrawn", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 3, TODAY);
      const withdrawn = records.withdrawRequest(BUYER, created.request.id);
      assert.equal(withdrawn.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "request.withdrawn");
      assertActor(entry, { sub: BUYER.sub, companyId: BUYER.companyId, role: "buyer" });
      assertSubject(entry, { offerId: offer.id, requestId: created.request.id, version: 1 });
      assert.deepEqual(entry.detail, { from: "pending", to: "withdrawn" });
    });
  });

  it("records fulfilment.status for a party", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 3, TODAY);
      const accepted = records.acceptRequest(SELLER, created.request.id, TODAY);
      const moved = records.recordCarrierStatus(BUYER, accepted.request.id, "carrier_pending", "asked");
      assert.equal(moved.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "fulfilment.status");
      assertActor(entry, { sub: BUYER.sub, companyId: BUYER.companyId, role: "buyer" });
      assertSubject(entry, { offerId: offer.id, requestId: accepted.request.id, version: 1 });
      assert.deepEqual(entry.detail, { from: "accepted", to: "carrier_pending" });
      assert.equal(JSON.stringify(entry).includes("asked"), false);
    });
  });

  it("records cancellation.proposed", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 2, TODAY);
      records.acceptRequest(SELLER, created.request.id, TODAY);
      const proposed = records.proposeCancellation(SELLER, created.request.id, "stop");
      assert.equal(proposed.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "cancellation.proposed");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assert.equal(entry.subject.requestId, created.request.id);
      assert.deepEqual(entry.detail, {});
      assert.equal(JSON.stringify(entry).includes("stop"), false);
    });
  });

  it("records cancellation.withdrawn", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 2, TODAY);
      records.acceptRequest(SELLER, created.request.id, TODAY);
      records.proposeCancellation(SELLER, created.request.id, "stop");
      const withdrawn = records.withdrawCancellation(SELLER, created.request.id);
      assert.equal(withdrawn.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "cancellation.withdrawn");
      assertActor(entry, { sub: SELLER.sub, companyId: SELLER.companyId, role: "seller" });
      assert.equal(entry.subject.requestId, created.request.id);
      assert.deepEqual(entry.detail, {});
    });
  });

  it("records cancellation.agreed with the move to cancelled", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 2, TODAY);
      records.acceptRequest(SELLER, created.request.id, TODAY);
      records.proposeCancellation(SELLER, created.request.id, "stop");
      const agreed = records.agreeCancellation(BUYER, created.request.id);
      assert.equal(agreed.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "cancellation.agreed");
      assertActor(entry, { sub: BUYER.sub, companyId: BUYER.companyId, role: "buyer" });
      assert.equal(entry.subject.requestId, created.request.id);
      assert.deepEqual(entry.detail, { from: "accepted", to: "cancelled" });
    });
  });

  it("records cancellation.refused", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const created = records.createRequest(BUYER, offer.id, 1, 2, TODAY);
      records.acceptRequest(SELLER, created.request.id, TODAY);
      records.proposeCancellation(SELLER, created.request.id, "stop");
      const refused = records.refuseCancellation(BUYER, created.request.id);
      assert.equal(refused.ok, true);
      const entry = readAudit(file).at(-1);
      assert.equal(entry.event, "cancellation.refused");
      assertActor(entry, { sub: BUYER.sub, companyId: BUYER.companyId, role: "buyer" });
      assert.equal(entry.subject.requestId, created.request.id);
      assert.deepEqual(entry.detail, {});
    });
  });

  it("appends nothing when the action is refused", () => {
    withRecords((records, file) => {
      const offer = publish(records);
      const before = fs.readFileSync(file);
      const declined = records.declineRequest(BUYER, "missing");
      assert.equal(declined.ok, false);
      const withdrawn = records.withdrawRequest(SELLER, "missing");
      assert.equal(withdrawn.ok, false);
      const created = records.createRequest(BUYER, offer.id, 1, 99, TODAY);
      assert.equal(created.ok, false);
      assert.equal(fs.readFileSync(file).equals(before), true);
      assert.equal(readAudit(file).some((entry) => entry.event === "request.created"), false);
    });
  });

  it("leaves neither the change nor its entry when persist throws", () => {
    withRecords((records, file) => {
      const before = fs.readFileSync(file);
      const original = fs.writeFileSync;
      fs.writeFileSync = (target, ...args) => {
        if (String(target).startsWith(file)) throw new Error("persist failed");
        return original(target, ...args);
      };
      try {
        assert.throws(() => records.createOffer(SELLER, {
          source: "manual",
          terms: manualTerms(),
          snapshot: null,
          sourceRecordId: null,
          overriddenFields: [],
        }), /persist failed/);
      } finally {
        fs.writeFileSync = original;
      }
      assert.equal(fs.readFileSync(file).equals(before), true);
      assert.deepEqual(readAudit(file), []);
      assert.equal(records.getCompanyOffer(SELLER.companyId, "any"), null);
      records.view((data) => {
        assert.deepEqual(data.offers, {});
        assert.deepEqual(data.audit, []);
      });
    });
  });

  it("preserves old audit content and appends new entries after it", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const prior = { id: "legacy", event: "legacy", at: "2020-01-01T00:00:00.000Z", note: "keep" };
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 4,
        offers: {},
        requests: {},
        audit: [prior],
      }));
      const records = openRecords(file);
      records.createOffer(SELLER, {
        source: "manual",
        terms: manualTerms(),
        snapshot: null,
        sourceRecordId: null,
        overriddenFields: [],
      });
      records.appendAudit("auth.connected", { sub: SELLER.sub, companyId: SELLER.companyId, role: "user" }, {});
      const audit = readAudit(file);
      assert.deepEqual(audit[0], prior);
      assert.equal(audit[1].event, "offer.created");
      assert.equal(audit[2].event, "auth.connected");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sessionCookie(sid, csrf) {
  const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, SESSION_SECRET));
  return `${COOKIE_NAME}=${value}`;
}

function cookieHeader(response) {
  const raw = response.headers.getSetCookie?.() || [];
  return raw.map((value) => value.split(";")[0]).join("; ");
}

async function startAuditedApp(env, dir) {
  const config = loadConfig(env);
  const store = openStore(path.join(dir, "store.json"), config.tokenEncryptionKey);
  const records = openRecords(path.join(dir, "records.json"));
  const server = createServer({ config, store, records });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  return {
    config,
    store,
    records,
    recordsPath: path.join(dir, "records.json"),
    storePath: path.join(dir, "store.json"),
    base: `http://127.0.0.1:${server.address().port}`,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("authentication audit", () => {
  it("records auth.connected with the user and an empty detail", async () => {
    const dir = tempDir();
    const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const port = await mock.listen();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${port}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    try {
      const connected = await connectOnce(app, mock);
      assert.equal(connected.result, "connected");
      const entry = readAudit(app.recordsPath).at(-1);
      assert.equal(entry.event, "auth.connected");
      assertActor(entry, { sub: "user-owner", companyId: "kings", role: "user" });
      assert.deepEqual(entry.subject, {});
      assert.deepEqual(entry.detail, {});
    } finally {
      await app.close();
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes auth.refused only after a code exchange, with the reason and no token", async () => {
    const denied = tempDir();
    const denyMock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const denyPort = await denyMock.listen();
    const denyApp = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${denyPort}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, denied);
    try {
      const before = fs.readFileSync(denyApp.recordsPath);
      const home = await fetch(denyApp.base);
      const cookie = cookieHeader(home);
      const csrf = (await home.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
      const connect = await fetch(`${denyApp.base}/connect`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      const authorize = new URL(connect.headers.get("location"));
      const decision = await fetch(`http://127.0.0.1:${denyPort}/oauth/decision`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          decision: "customer",
          state: authorize.searchParams.get("state"),
          redirect_uri: authorize.searchParams.get("redirect_uri"),
          code_challenge: authorize.searchParams.get("code_challenge"),
        }),
      });
      const callback = await fetch(decision.headers.get("location"), { headers: { cookie }, redirect: "manual" });
      assert.match(callback.headers.get("location"), /only_contract_owner/);
      assert.deepEqual(fs.readFileSync(denyApp.recordsPath), before);
      assert.equal(readAudit(denyApp.recordsPath).length, 0);
    } finally {
      await denyApp.close();
      await denyMock.close();
      fs.rmSync(denied, { recursive: true, force: true });
    }

    const dir = tempDir();
    const mock = createMockRateNinja({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      userinfo: { profile: { companyType: "Freight Forwarder/Customer" } },
    });
    const port = await mock.listen();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${port}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    try {
      const connected = await connectOnce(app, mock);
      assert.equal(connected.result, "only_contract_owner");
      const entry = readAudit(app.recordsPath).at(-1);
      assert.equal(entry.event, "auth.refused");
      assertActor(entry, { sub: "user-owner", companyId: "kings", role: "user" });
      assert.deepEqual(entry.subject, {});
      assert.deepEqual(entry.detail, { reason: "only_contract_owner" });
      const raw = fs.readFileSync(app.recordsPath, "utf8");
      for (const issued of mock.issued) {
        assert.equal(raw.includes(issued.access_token), false);
        assert.equal(raw.includes(issued.refresh_token), false);
      }
      assert.equal(raw.includes(connected.code), false);
      assert.equal(raw.includes(CLIENT_SECRET), false);
    } finally {
      await app.close();
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the records file unchanged across 150 anonymous callback hits", async () => {
    const dir = tempDir();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    try {
      const before = fs.readFileSync(app.recordsPath);
      const beforeLength = readAudit(app.recordsPath).length;
      const anon = sessionCookie("sid-anon", "csrf-anon");
      for (let i = 0; i < 50; i += 1) {
        const bare = await fetch(`${app.base}/oauth/callback`, { redirect: "manual" });
        const denied = await fetch(`${app.base}/oauth/callback?error=access_denied`, { redirect: "manual" });
        const bogus = await fetch(`${app.base}/oauth/callback?state=x&code=y`, {
          headers: { cookie: anon },
          redirect: "manual",
        });
        assert.equal(bare.status, 302);
        assert.match(bare.headers.get("location"), /invalid_state/);
        assert.equal(denied.status, 302);
        assert.match(denied.headers.get("location"), /access_denied/);
        assert.equal(bogus.status, 302);
        assert.match(bogus.headers.get("location"), /invalid_state/);
      }
      const after = fs.readFileSync(app.recordsPath);
      assert.equal(after.length, before.length);
      assert.deepEqual(after, before);
      assert.equal(readAudit(app.recordsPath).length, beforeLength);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records auth.dropped for an unusable identity on the home page and in requireIdentity", async () => {
    const dir = tempDir();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    try {
      app.store.saveConnection("sid-home", {
        refreshToken: "refresh-home",
        scopes: ["profile:read"],
        profile: { sub: "user-home", companyId: "kings", companyName: "Kings", companyType: "Contract Owner", active: false },
      });
      const home = await fetch(app.base, { headers: { cookie: sessionCookie("sid-home", "csrf-home") } });
      assert.match(await home.text(), /Disconnected/);
      app.store.saveConnection("sid-gate", {
        refreshToken: "refresh-gate",
        scopes: ["profile:read"],
        profile: { sub: "user-gate", companyId: "kings", companyName: "Kings", companyType: "Contract Owner", active: false },
      });
      const gated = await fetch(`${app.base}/offers`, {
        headers: { cookie: sessionCookie("sid-gate", "csrf-gate") },
        redirect: "manual",
      });
      assert.equal(gated.status, 302);
      const dropped = readAudit(app.recordsPath).filter((entry) => entry.event === "auth.dropped");
      assert.equal(dropped.length, 2);
      assert.deepEqual(dropped[0].detail, { reason: "identity_unusable" });
      assertActor(dropped[0], { sub: "user-home", companyId: "kings", role: "user" });
      assert.deepEqual(dropped[0].subject, {});
      assert.deepEqual(dropped[1].detail, { reason: "identity_unusable" });
      assertActor(dropped[1], { sub: "user-gate", companyId: "kings", role: "user" });
      assert.equal(app.store.publicConnection("sid-home"), null);
      assert.equal(app.store.publicConnection("sid-gate"), null);
    } finally {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records auth.disconnected when the user disconnects", async () => {
    const dir = tempDir();
    const mock = createMockRateNinja({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const port = await mock.listen();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${port}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    try {
      const connected = await connectOnce(app, mock);
      const page = await fetch(app.base, { headers: { cookie: connected.cookie } });
      const html = await page.text();
      const csrf = html.match(/name="csrf_token" value="([^"]+)"/)[1];
      const disconnect = await fetch(`${app.base}/disconnect`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: connected.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      assert.match(disconnect.headers.get("location"), /disconnected/);
      const entry = readAudit(app.recordsPath).at(-1);
      assert.equal(entry.event, "auth.disconnected");
      assertActor(entry, { sub: "user-owner", companyId: "kings", role: "user" });
      assert.deepEqual(entry.subject, {});
      assert.deepEqual(entry.detail, {});
    } finally {
      await app.close();
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps tokens, codes, secrets, cookies and PKCE material out of the records file", async () => {
    const dir = tempDir();
    const mock = createMockRateNinja({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      accessTtl: 0,
    });
    const port = await mock.listen();
    const app = await startAuditedApp({
      RATE_NINJA_CLIENT_ID: CLIENT_ID,
      RATE_NINJA_CLIENT_SECRET: CLIENT_SECRET,
      SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      RATE_NINJA_BASE_URL: `http://127.0.0.1:${port}`,
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    }, dir);
    const secrets = [];
    try {
      const first = await connectOnce(app, mock, secrets);
      const chooser = await fetch(`${app.base}/offers/new`, { headers: { cookie: first.cookie } });
      assert.equal(chooser.status, 200);
      assert.ok(mock.issued.length >= 2);
      mock.refreshTokens.clear();
      const dropped = await fetch(app.base, { headers: { cookie: first.cookie } });
      assert.match(await dropped.text(), /Disconnected/);
      const second = await connectOnce(app, mock, secrets);
      const again = await fetch(app.base, { headers: { cookie: second.cookie } });
      const csrf = (await again.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
      secrets.push(csrf);
      const disconnect = await fetch(`${app.base}/disconnect`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: second.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      assert.match(disconnect.headers.get("location"), /disconnected/);
      const raw = fs.readFileSync(app.recordsPath, "utf8");
      const audit = JSON.parse(raw).audit;
      assert.ok(audit.some((entry) => entry.event === "auth.connected"));
      assert.ok(audit.some((entry) => entry.event === "auth.dropped" && entry.detail.reason === "refresh_failed"));
      assert.ok(audit.some((entry) => entry.event === "auth.disconnected"));
      for (const issued of mock.issued) {
        secrets.push(issued.access_token, issued.refresh_token);
      }
      secrets.push(CLIENT_SECRET, SESSION_SECRET);
      for (const secret of secrets) {
        assert.equal(typeof secret, "string");
        assert.ok(secret.length > 8, secret);
        assert.equal(raw.includes(secret), false, secret.slice(0, 12));
      }
    } finally {
      await app.close();
      await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function connectOnce(app, mock, secrets = null) {
  const home = await fetch(app.base);
  const cookie = cookieHeader(home);
  const html = await home.text();
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)[1];
  const connect = await fetch(`${app.base}/connect`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf_token: csrf }),
  });
  const authorize = new URL(connect.headers.get("location"));
  const stored = JSON.parse(fs.readFileSync(app.storePath, "utf8"));
  const pending = Object.values(stored.pending)[0];
  const verifier = decryptString(ENCRYPTION_KEY, pending.verifierCiphertext, PENDING_AAD);
  if (secrets) {
    const cookieValue = decodeURIComponent(cookie.split("=").slice(1).join("="));
    secrets.push(csrf, authorize.searchParams.get("state"), verifier, cookieValue, pending.state);
  }
  const decision = await fetch(`http://127.0.0.1:${mock.server.address().port}/oauth/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      decision: "approve",
      state: authorize.searchParams.get("state"),
      redirect_uri: authorize.searchParams.get("redirect_uri"),
      code_challenge: authorize.searchParams.get("code_challenge"),
    }),
  });
  const callbackUrl = decision.headers.get("location");
  const code = new URL(callbackUrl).searchParams.get("code");
  if (secrets) secrets.push(code);
  const callback = await fetch(callbackUrl, { headers: { cookie }, redirect: "manual" });
  const result = new URL(callback.headers.get("location"), app.base).searchParams.get("result");
  return { cookie, csrf, result, code, verifier };
}

describe("canary commercial fields", () => {
  it("keeps price, markup, snapshot notes and the source id out of the audit", () => {
    withRecords((records, file) => {
      const baseMinor = 100000000 + crypto.randomInt(800000000);
      const markupMinor = 100000000 + crypto.randomInt(800000000);
      const counterPrice = 100000000 + crypto.randomInt(800000000);
      const notes = `notes-${crypto.randomBytes(12).toString("hex")}`;
      const sourceId = `src-${crypto.randomBytes(12).toString("hex")}`;
      const buyerMinor = priceBuyer({ baseMinor, markup: { type: "absolute", minor: markupMinor } });
      const terms = manualTerms({
        source: "rn_rate",
        quantity: 4,
        baseMinor,
        markup: { type: "absolute", minor: markupMinor },
        buyerMinor,
      });
      const created = records.createOffer(SELLER, {
        source: "rn_rate",
        terms,
        snapshot: { notes, sourceId },
        sourceRecordId: sourceId,
        overriddenFields: [],
      });
      const published = records.setOfferState(SELLER.companyId, created.id, "published", SELLER.sub, TODAY);
      assert.equal(published.ok, true);
      const requested = records.createRequest(BUYER, created.id, 1, 2, TODAY);
      assert.equal(requested.ok, true);
      const countered = records.counterRequest(SELLER, requested.request.id, {
        quantity: 2,
        unitBuyerMinor: counterPrice,
        serviceTerms: "Counter terms",
      }, TODAY);
      assert.equal(countered.ok, true);
      const accepted = records.acceptRequest(BUYER, requested.request.id, TODAY);
      assert.equal(accepted.ok, true);
      const total = 2 * counterPrice;
      const blob = JSON.stringify(readAudit(file));
      for (const canary of [String(baseMinor), String(markupMinor), String(buyerMinor), String(counterPrice), String(total), notes, sourceId]) {
        assert.equal(blob.includes(canary), false, canary);
      }
      const events = readAudit(file).map((entry) => entry.event);
      assert.deepEqual(events, [
        "offer.created",
        "offer.state",
        "request.created",
        "request.countered",
        "request.accepted",
      ]);
    });
  });
});
