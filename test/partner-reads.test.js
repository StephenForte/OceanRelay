const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMockRateNinja } = require("./mock-rate-ninja");
const {
  listRates,
  getRate,
  listSailings,
  getSailing,
  listAllRates,
} = require("../lib/rate-ninja");

const CLIENT_ID = "capacity-exchange";
const CLIENT_SECRET = "test-client-secret-value";

function sampleRate(id, rate40D = 1800) {
  return {
    id,
    source: "base_contract",
    allocationEvidence: false,
    capacityQuantity: null,
    carrier: "MSC",
    contractOwner: "Kings",
    ownerCompanyId: "kings",
    originPort: "SHA",
    destinationPort: "LAX",
    inlandDeliveryLocation: "",
    commodityType: "FAK",
    rate20D: 1000,
    rate40D,
    rate40HC: 2100,
    currency: null,
    rateEffectiveDate: "2026-04-01",
    rateExpirationDate: "",
    updatedAt: null,
    notes: "",
  };
}

function sampleSailing(id) {
  return {
    id,
    departure: "2026-05-01T00:00:00.000Z",
    arrival: "2026-05-20T00:00:00.000Z",
    transitTime: "19",
    vessel: "MSC TEST",
    voyage: "V1",
    service: "TP1",
    carrier: "MSC",
    departurePort: "SHA",
    ownerCompanyId: "kings",
    currency: null,
    updatedAt: null,
  };
}

function manyRates(count) {
  return Array.from({ length: count }, (_, index) => {
    const id = `rate-${String(index + 1).padStart(4, "0")}`;
    return sampleRate(id, index === 0 ? 0 : 1800);
  });
}

async function withMock(options, fn) {
  const mock = createMockRateNinja({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...options,
  });
  const port = await mock.listen();
  const ctx = {
    mock,
    config: { issuer: `http://127.0.0.1:${port}` },
    accessToken: mock.issueAccessToken(),
  };
  try {
    await fn(ctx);
  } finally {
    await mock.close();
  }
}

function rateListCalls(mock) {
  return mock.requests.filter((req) => req.method === "GET" && req.pathname === "/api/partner/v1/me/rates");
}

function pageNumbers(calls) {
  return calls.map((req) => new URL(req.url, "http://127.0.0.1").searchParams.get("page"));
}

describe("partner reads", () => {
  it("treats an empty account as success and listAllRates makes one request", async () => {
    await withMock({}, async ({ mock, config, accessToken }) => {
      const rates = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      const sailings = await listSailings(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(rates.ok, true);
      assert.deepEqual(rates.data, []);
      assert.equal(rates.meta.total, 0);
      assert.equal(rates.meta.returned, 0);
      assert.equal(sailings.ok, true);
      assert.deepEqual(sailings.data, []);
      assert.equal(typeof rates.retrievedAt, "string");
      assert.equal(Number.isNaN(Date.parse(rates.retrievedAt)), false);

      const before = rateListCalls(mock).length;
      const all = await listAllRates(fetch, config, accessToken);
      const made = rateListCalls(mock).slice(before);
      assert.equal(all.ok, true);
      assert.deepEqual(all.data, []);
      assert.equal(all.truncated, false);
      assert.equal(made.length, 1);
      const params = new URL(made[0].url, "http://127.0.0.1").searchParams;
      assert.equal(params.get("page"), "1");
      assert.equal(params.get("pageSize"), "100");
    });
  });

  it("returns 230 rates in 3 requests without marking the list truncated", async () => {
    const rates = manyRates(230);
    await withMock({ rates }, async ({ mock, config, accessToken }) => {
      const all = await listAllRates(fetch, config, accessToken);
      const calls = rateListCalls(mock);
      assert.equal(all.ok, true);
      assert.equal(all.truncated, false);
      assert.equal(all.data.length, 230);
      assert.deepEqual(all.data.map((row) => row.id), rates.map((row) => row.id));
      assert.equal(calls.length, 3);
      assert.deepEqual(pageNumbers(calls), ["1", "2", "3"]);
      assert.ok(calls.every((req) => new URL(req.url, "http://127.0.0.1").searchParams.get("pageSize") === "100"));
    });
  });

  it("stops when meta.total is reached on a full page", async () => {
    await withMock({ rates: manyRates(200) }, async ({ mock, config, accessToken }) => {
      const all = await listAllRates(fetch, config, accessToken);
      const calls = rateListCalls(mock);
      assert.equal(all.ok, true);
      assert.equal(all.data.length, 200);
      assert.equal(all.truncated, false);
      assert.equal(calls.length, 2);
      assert.deepEqual(pageNumbers(calls), ["1", "2"]);
    });
  });

  it("walks 10 pages and reports truncated when 1050 rates remain unread", async () => {
    await withMock({ rates: manyRates(1050) }, async ({ mock, config, accessToken }) => {
      const all = await listAllRates(fetch, config, accessToken);
      const calls = rateListCalls(mock);
      assert.equal(all.ok, true);
      assert.equal(all.truncated, true);
      assert.equal(all.data.length, 1000);
      assert.equal(all.data[0].id, "rate-0001");
      assert.equal(all.data[999].id, "rate-1000");
      assert.equal(calls.length, 10);
      assert.deepEqual(pageNumbers(calls), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    });
  });

  it("does not mark a complete 1000-rate book truncated", async () => {
    await withMock({ rates: manyRates(1000) }, async ({ mock, config, accessToken }) => {
      const all = await listAllRates(fetch, config, accessToken);
      assert.equal(all.ok, true);
      assert.equal(all.data.length, 1000);
      assert.equal(all.truncated, false);
      assert.equal(rateListCalls(mock).length, 10);
    });
  });

  it("fails the whole listAllRates call when page 2 fails", async () => {
    await withMock({ rates: manyRates(230) }, async ({ mock, config, accessToken }) => {
      let seen = 0;
      const fetchImpl = async (url, opts) => {
        seen += 1;
        if (seen === 2) mock.failNextPartner(429);
        return fetch(url, opts);
      };
      const result = await listAllRates(fetchImpl, config, accessToken);
      assert.equal(result.ok, false);
      assert.equal(result.status, 429);
      assert.equal(result.error, "rate_limited");
      assert.equal(Object.hasOwn(result, "data"), false);
      assert.equal(Object.hasOwn(result, "truncated"), false);
      assert.equal(seen, 2);
      assert.equal(rateListCalls(mock).length, 2);
    });
  });

  it("maps 401 to unauthorized and does not keep the fault armed", async () => {
    await withMock({ rates: [sampleRate("kings-rate", 0)] }, async ({ mock, config, accessToken }) => {
      mock.failNextPartner(401);
      const denied = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 401);
      assert.equal(denied.error, "unauthorized");
      assert.equal(denied.detail, undefined);

      const forged = await listRates(fetch, config, "access-not-issued", { page: 1, pageSize: 100 });
      assert.equal(forged.status, 401);
      assert.equal(forged.error, "unauthorized");

      const again = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(again.ok, true);
      assert.equal(again.data.length, 1);
    });
  });

  it("maps 403 partner_oauth_disabled to forbidden and exposes detail", async () => {
    await withMock({}, async ({ mock, config, accessToken }) => {
      mock.failNextPartner(403);
      const result = await listSailings(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
      assert.equal(result.error, "forbidden");
      assert.equal(result.detail, "partner_oauth_disabled");
    });
  });

  it("maps a missing rate or sailing to not_found", async () => {
    await withMock({
      rates: [sampleRate("kings-rate")],
      sailings: [sampleSailing("kings-sailing")],
    }, async ({ config, accessToken }) => {
      const rate = await getRate(fetch, config, accessToken, "other-rate");
      const sailing = await getSailing(fetch, config, accessToken, "other-sailing");
      assert.equal(rate.ok, false);
      assert.equal(rate.status, 404);
      assert.equal(rate.error, "not_found");
      assert.equal(sailing.status, 404);
      assert.equal(sailing.error, "not_found");
    });
  });

  it("maps 429 to rate_limited without a retry", async () => {
    await withMock({}, async ({ mock, config, accessToken }) => {
      mock.failNextPartner(429);
      const result = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(result.ok, false);
      assert.equal(result.status, 429);
      assert.equal(result.error, "rate_limited");
      assert.equal(rateListCalls(mock).length, 1);
    });
  });

  it("maps a thrown fetch to network_error and does not retry", async () => {
    await withMock({}, async ({ config, accessToken }) => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        throw new Error("socket hang up");
      };
      const result = await getRate(fetchImpl, config, accessToken, "kings-rate");
      assert.equal(result.ok, false);
      assert.equal(result.status, 0);
      assert.equal(result.error, "network_error");
      assert.equal(calls, 1);
    });
  });

  it("maps HTML 401, 403, 404, and 429 from the status without reading a JSON body", async () => {
    const config = { issuer: "http://127.0.0.1:9" };
    const cases = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
    ];
    for (const [status, error] of cases) {
      let reads = 0;
      const fetchImpl = async () => {
        const response = new Response("<html><body>gateway</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        });
        const json = response.json.bind(response);
        response.json = async () => {
          reads += 1;
          return json();
        };
        return response;
      };
      const result = await listRates(fetchImpl, config, "access-token", { page: 1, pageSize: 100 });
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.error, error);
      assert.equal(result.detail, undefined);
      assert.equal(reads, status === 403 ? 1 : 0);
    }
  });

  it("returns not_found for dot ids without sending a request", async () => {
    const fetchImpl = async () => {
      throw new Error("should not fetch");
    };
    const config = { issuer: "http://127.0.0.1:9" };
    for (const id of [".", ".."]) {
      const rate = await getRate(fetchImpl, config, "access-token", id);
      const sailing = await getSailing(fetchImpl, config, "access-token", id);
      assert.equal(rate.ok, false);
      assert.equal(rate.status, 404);
      assert.equal(rate.error, "not_found");
      assert.equal(sailing.status, 404);
      assert.equal(sailing.error, "not_found");
    }
  });

  it("maps a non-JSON body, missing data, and the wrong data type to bad_response", async () => {
    await withMock({ rates: [sampleRate("kings-rate")] }, async ({ mock, config, accessToken }) => {
      mock.failNextPartner("non-json");
      const text = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(text.ok, false);
      assert.equal(text.error, "bad_response");

      mock.failNextPartner({ status: 200, json: { meta: { total: 0, page: 1, pageSize: 100, returned: 0 } } });
      const missing = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(missing.status, 200);
      assert.equal(missing.error, "bad_response");

      mock.failNextPartner({ status: 200, json: { data: { id: "kings-rate" } } });
      const wrongList = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(wrongList.error, "bad_response");

      mock.failNextPartner({ status: 200, json: { data: [] } });
      const wrongItem = await getRate(fetch, config, accessToken, "kings-rate");
      assert.equal(wrongItem.error, "bad_response");

      mock.failNextPartner(500);
      const server = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(server.status, 500);
      assert.equal(server.error, "bad_response");
    });
  });

  it("encodes a rate id that contains a slash and does not request another path", async () => {
    const id = "leg-a/other";
    await withMock({
      rates: [sampleRate("leg-a", 999), sampleRate(id, 0)],
      sailings: [sampleSailing("leg-a"), sampleSailing(id)],
    }, async ({ mock, config, accessToken }) => {
      const rate = await getRate(fetch, config, accessToken, id);
      const sailing = await getSailing(fetch, config, accessToken, id);
      assert.equal(rate.ok, true);
      assert.equal(rate.data.id, id);
      assert.equal(rate.data.rate40D, 0);
      assert.equal(sailing.ok, true);
      assert.equal(sailing.data.id, id);

      const urls = mock.requests.map((req) => req.url);
      const encoded = encodeURIComponent(id);
      assert.ok(urls.some((url) => url.startsWith(`/api/partner/v1/me/rates/${encoded}`)));
      assert.ok(urls.some((url) => url.startsWith(`/api/partner/v1/me/sailings/${encoded}`)));
      assert.equal(urls.some((url) => url.includes("/rates/leg-a/other")), false);
      assert.equal(urls.some((url) => url.includes("/sailings/leg-a/other")), false);
      assert.equal(urls.some((url) => url === "/api/partner/v1/me/rates/leg-a" || url.startsWith("/api/partner/v1/me/rates/leg-a?")), false);
    });
  });

  it("passes currency, updatedAt, and a zero amount through and sets retrievedAt", async () => {
    const rate = { ...sampleRate("kings-rate", 0), laneCode: "TP1" };
    const sailing = sampleSailing("kings-sailing");
    await withMock({ rates: [rate], sailings: [sailing] }, async ({ config, accessToken }) => {
      const before = Date.now();
      const listed = await listRates(fetch, config, accessToken, { page: 1, pageSize: 100 });
      const fetched = await getRate(fetch, config, accessToken, rate.id);
      const schedule = await getSailing(fetch, config, accessToken, sailing.id);
      const after = Date.now();

      for (const body of [listed.data[0], fetched.data]) {
        assert.equal(body.currency, null);
        assert.equal(body.updatedAt, null);
        assert.equal(body.rate40D, 0);
        assert.equal(body.laneCode, "TP1");
      }
      assert.equal(schedule.data.currency, null);
      assert.equal(schedule.data.updatedAt, null);
      for (const stamp of [listed.retrievedAt, fetched.retrievedAt, schedule.retrievedAt]) {
        assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const at = Date.parse(stamp);
        assert.ok(at >= before - 1000 && at <= after + 1000);
      }
    });
  });

  it("pages sailings with page and pageSize", async () => {
    const sailings = ["a", "b", "c"].map((id) => sampleSailing(id));
    await withMock({ sailings }, async ({ mock, config, accessToken }) => {
      const page = await listSailings(fetch, config, accessToken, { page: 1, pageSize: 2 });
      assert.equal(page.ok, true);
      assert.deepEqual(page.data.map((row) => row.id), ["a", "b"]);
      assert.equal(page.meta.total, 3);
      assert.equal(page.meta.returned, 2);
      assert.equal(page.meta.pageSize, 2);
      const call = mock.requests.find((req) => req.pathname === "/api/partner/v1/me/sailings");
      const params = new URL(call.url, "http://127.0.0.1").searchParams;
      assert.equal(params.get("page"), "1");
      assert.equal(params.get("pageSize"), "2");
    });
  });

  it("sends bearer auth and never an API key or /api/v1/ request", async () => {
    await withMock({ rates: [sampleRate("kings-rate", 0)] }, async ({ mock, config, accessToken }) => {
      let seen;
      const fetchImpl = async (url, opts) => {
        seen = opts;
        return fetch(url, opts);
      };
      const result = await listRates(fetchImpl, config, accessToken, { page: 1, pageSize: 100 });
      assert.equal(result.ok, true);
      assert.equal(seen.redirect, "error");
      assert.equal(seen.headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(seen.headers.Accept, "application/json");
      assert.equal(seen.headers["x-api-key"], undefined);
      assert.ok(seen.signal instanceof AbortSignal);

      await listAllRates(fetch, config, accessToken);
      await getRate(fetch, config, accessToken, "kings-rate");
      assert.ok(mock.requests.length > 0);
      for (const req of mock.requests) {
        const names = Object.keys(req.headers).map((name) => name.toLowerCase());
        assert.equal(names.some((name) => name.includes("api-key")), false);
        assert.equal(req.headers["x-api-key"], undefined);
        assert.equal(String(req.url).includes("/api/v1/"), false);
        assert.equal(req.pathname.startsWith("/api/v1"), false);
      }
      const partner = mock.requests.filter((req) => req.pathname.startsWith("/api/partner/"));
      assert.ok(partner.length > 0);
      for (const req of partner) {
        assert.match(req.headers.authorization, /^Bearer access-/);
        assert.equal(req.headers.accept, "application/json");
      }
      assert.equal(mock.calls.some((call) => call.includes("/api/v1/")), false);

      const source = fs.readFileSync(path.join(__dirname, "../lib/rate-ninja.js"), "utf8");
      assert.equal(source.includes("/api/v1/"), false);
      assert.equal(source.includes("x-api-key"), false);
      assert.equal(source.includes("api-key"), false);
      assert.ok(source.includes("/api/partner/v1/me/"));
      assert.ok(source.includes("AbortSignal.timeout(10000)"));
    });
  });
});
