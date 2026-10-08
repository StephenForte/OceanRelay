"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createReadClient, createWriteClient, RpcFailure } = require("../lib/chain/rpc");

const ACCESS_ID = "cf-access-id-test-only-9f3a";
const ACCESS_SECRET = "cf-access-secret-test-only-b7c2";
const READ_URL = "http://read.test/rpc";
const WRITE_URL = "http://write.test/rpc";

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function recordedFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init) {
    const headers = {};
    for (const [key, value] of Object.entries(init.headers || {})) headers[key] = value;
    const body = JSON.parse(init.body);
    calls.push({ url, headers, method: body.method, params: body.params });
    return handler(body, url, init);
  }
  return { fetchImpl, calls };
}

describe("RPC clients", () => {
  it("sends reads without Access headers and writes only raw transactions", async () => {
    const { fetchImpl, calls } = recordedFetch(async (body) => {
      if (body.method === "eth_chainId") return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: "0x354" });
      if (body.method === "eth_sendRawTransaction") return jsonResponse(200, { jsonrpc: "2.0", id: 1, result: "0xabc" });
      return jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } });
    });
    const read = createReadClient({ url: READ_URL, fetchImpl });
    const write = createWriteClient({
      url: WRITE_URL,
      fetchImpl,
      accessClientId: ACCESS_ID,
      accessClientSecret: ACCESS_SECRET,
    });
    assert.equal(await read.request("eth_chainId", []), "0x354");
    assert.equal(await write.sendRawTransaction("0x02ff"), "0xabc");
    assert.equal(typeof write.request, "undefined");
    const readCall = calls.find((call) => call.url === READ_URL);
    const writeCall = calls.find((call) => call.url === WRITE_URL);
    const readHeaders = JSON.stringify(readCall.headers).toLowerCase();
    assert.equal(readHeaders.includes("cf-access"), false);
    assert.equal(readHeaders.includes(ACCESS_ID), false);
    assert.equal(readHeaders.includes(ACCESS_SECRET), false);
    assert.equal(readCall.method, "eth_chainId");
    assert.equal(writeCall.method, "eth_sendRawTransaction");
    assert.equal(writeCall.headers["CF-Access-Client-Id"], ACCESS_ID);
    assert.equal(writeCall.headers["CF-Access-Client-Secret"], ACCESS_SECRET);
    assert.equal(calls.filter((call) => call.url === WRITE_URL).every((call) => call.method === "eth_sendRawTransaction"), true);
  });

  it("classifies timeouts, server errors, reverts and nonce errors without echoing them", async () => {
    const secret = ACCESS_SECRET;
    const hanging = createReadClient({
      url: READ_URL,
      timeoutMs: 20,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted " + secret);
          error.name = "AbortError";
          reject(error);
        });
      }),
    });
    await assert.rejects(hanging.request("eth_chainId", []), (err) => {
      assert.ok(err instanceof RpcFailure);
      assert.equal(err.kind, "outage");
      assert.equal(err.reason, "timeout");
      assert.equal(String(err.message).includes(secret), false);
      assert.equal(String(err.stack).includes(secret), false);
      return true;
    });

    const failing = recordedFetch(async (body) => {
      if (body.method === "eth_call") {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: 1,
          error: { code: 3, message: "execution reverted " + secret, data: "0xdead" },
        });
      }
      if (body.method === "eth_sendRawTransaction") {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "nonce too low: " + secret },
        });
      }
      return jsonResponse(503, "upstream " + secret);
    });
    const read = createReadClient({ url: READ_URL, fetchImpl: failing.fetchImpl });
    const write = createWriteClient({
      url: WRITE_URL,
      fetchImpl: failing.fetchImpl,
      accessClientId: ACCESS_ID,
      accessClientSecret: ACCESS_SECRET,
    });
    await assert.rejects(read.request("eth_getCode", ["0x1"]), (err) => {
      assert.equal(err.kind, "outage");
      assert.equal(err.reason, "http_503");
      assert.equal(err.message.includes(secret), false);
      return true;
    });
    await assert.rejects(read.request("eth_call", [{}]), (err) => {
      assert.equal(err.kind, "revert");
      assert.equal(err.revertData, "0xdead");
      assert.equal(err.message.includes(secret), false);
      return true;
    });
    await assert.rejects(write.sendRawTransaction("0x02"), (err) => {
      assert.equal(err.nonceTooLow, true);
      assert.equal(err.kind, "reject");
      assert.equal(err.message.includes(secret), false);
      return true;
    });
  });
});
