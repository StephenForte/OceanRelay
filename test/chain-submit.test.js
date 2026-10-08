"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createChain } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { selectorOf } = require("../lib/chain/abi");
const { keccakHex } = require("../lib/chain/keccak");
const { hexToBytes } = require("../lib/chain/hex");
const { keccak_256 } = require("@noble/hashes/sha3.js");
const { createMockChain } = require("./mock-chain");

const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const REGISTRAR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ACCESS_ID = "cf-access-id-test-only-9f3a";
const ACCESS_SECRET = "cf-access-secret-test-only-b7c2";
const OFFER = "0x" + "22".repeat(32);

function deploymentFor(mock) {
  return {
    chainId: mock.chainId,
    genesisHash: mock.genesisHash,
    address: "0x481175bC15eE6e22EAB97176540a98aB6a2925eF",
    runtimeCodeHash: mock.runtimeCodeHash,
  };
}

function configFor(mock) {
  return {
    chain: {
      relayerKey: RELAYER_KEY,
      registrarKey: REGISTRAR_KEY,
      accessClientId: ACCESS_ID,
      accessClientSecret: ACCESS_SECRET,
      readRpc: mock.readUrl,
      writeRpc: mock.writeUrl,
      maxFeeGwei: 1,
    },
  };
}

async function readyChain(mock, options = {}) {
  const chain = createChain({
    config: configFor(mock),
    deployment: deploymentFor(mock),
    fetchImpl: mock.fetchImpl,
    ...options,
  });
  await chain.start();
  assert.equal(chain.status().state, "ready");
  return chain;
}

function readItem(bytes, offset) {
  const prefix = bytes[offset];
  if (prefix < 0x80) return { start: offset, end: offset + 1, next: offset + 1 };
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    return { start: offset + 1, end: offset + 1 + len, next: offset + 1 + len };
  }
  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7;
    const len = readLength(bytes, offset + 1, lenOfLen);
    const start = offset + 1 + lenOfLen;
    return { start, end: start + len, next: start + len };
  }
  if (prefix <= 0xf7) {
    const len = prefix - 0xc0;
    const start = offset + 1;
    return { start, end: start + len, next: start + len, list: true };
  }
  const lenOfLen = prefix - 0xf7;
  const len = readLength(bytes, offset + 1, lenOfLen);
  const start = offset + 1 + lenOfLen;
  return { start, end: start + len, next: start + len, list: true };
}

function readLength(bytes, offset, size) {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = (value * 256) + bytes[offset + i];
  return value;
}

function txFields(raw) {
  const bytes = Buffer.from(raw.slice(2), "hex");
  assert.equal(bytes[0], 0x02);
  const list = readItem(bytes, 1);
  const items = [];
  let offset = list.start;
  while (offset < list.end) {
    const item = readItem(bytes, offset);
    items.push(bytes.subarray(item.start, item.end));
    offset = item.next;
  }
  return items.map(uint);
}

function uint(bytes) {
  if (bytes.length === 0) return 0n;
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

function rawTransactions(mock) {
  return mock.writes()
    .filter((call) => call.method === "eth_sendRawTransaction")
    .map((call) => call.params[0]);
}

function localHash(raw) {
  return keccakHex(hexToBytes(raw));
}

function fakeTimers() {
  const queue = [];
  return {
    setTimeout(fn, ms) {
      const item = { fn, ms };
      queue.push(item);
      return item;
    },
    clearTimeout(item) {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
    },
    fire() {
      const item = queue.shift();
      if (item) item.fn();
    },
  };
}

function pendingReads(mock) {
  return mock.reads().filter((call) => call.method === "eth_getTransactionCount");
}

function clocked() {
  let clock = 1_000;
  const timers = fakeTimers();
  return {
    timers,
    options: {
      timers,
      now: () => clock,
      advance(ms) {
        clock += ms;
      },
    },
  };
}

const errorLines = [];
const originalError = console.error;

describe("chain submitter", () => {
  before(() => {
    console.error = (...args) => {
      errorLines.push(args.map(String).join(" "));
    };
  });
  after(() => {
    console.error = originalError;
  });

  it("gives concurrent submissions distinct nonces and prices the fee", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    mock.setNonce(7);
    const chain = await readyChain(mock);
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => chain.submit("markExpired", [OFFER])));
    assert.deepEqual(results.map((result) => result.state), ["confirmed", "confirmed", "confirmed", "confirmed", "confirmed"]);
    const nonces = rawTransactions(mock).map((raw) => txFields(raw)[1]);
    assert.deepEqual(nonces.map(Number), [7, 8, 9, 10, 11]);
    const fields = txFields(rawTransactions(mock)[0]);
    assert.equal(fields[0], 852n);
    assert.equal(fields[2], 1_000_000n);
    assert.equal(fields[3], 2n * 251n + 1_000_000n);
    assert.equal(fields[4], 26_250n);
    assert.equal(mock.writes().every((call) => call.method === "eth_sendRawTransaction"), true);
    assert.equal(mock.reads().every((call) => call.method !== "eth_sendRawTransaction"), true);
    for (const call of mock.reads()) {
      const headers = JSON.stringify(call.headers);
      assert.equal(headers.includes(ACCESS_ID), false);
      assert.equal(headers.includes(ACCESS_SECRET), false);
      assert.equal(headers.toLowerCase().includes("cf-access"), false);
    }
  });

  it("sends nothing when the simulation reverts", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const chain = await readyChain(mock);
    const digest = "0x" + "44".repeat(32);
    const selector = Buffer.from(keccak_256(new TextEncoder().encode("DigestUsed(bytes32)"))).subarray(0, 4);
    mock.setRevert("0x" + Buffer.concat([selector, Buffer.from(digest.slice(2), "hex")]).toString("hex"));
    const before = mock.calls.length;
    const result = await chain.submit("markExpired", [OFFER]);
    assert.equal(result.state, "refused");
    assert.equal(result.error.name, "DigestUsed");
    assert.equal(result.error.args[0], digest);
    assert.equal(result.hash, undefined);
    const after = mock.calls.slice(before);
    assert.equal(after.some((call) => call.method === "eth_sendRawTransaction"), false);
    assert.equal(after.some((call) => call.method === "eth_estimateGas"), false);
  });

  it("returns pending until a later receipt confirms", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    mock.setHoldReceipts(true);
    let clock = 1_000;
    const chain = await readyChain(mock, {
      now: () => clock,
      advance(ms) {
        clock += ms;
      },
    });
    const result = await chain.submit("markExpired", [OFFER]);
    assert.equal(result.state, "pending");
    assert.match(result.hash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(await chain.receipt(result.hash), { state: "pending" });
    mock.addReceipt(result.hash, { status: "0x1", blockNumber: "0x20" });
    assert.deepEqual(await chain.receipt(result.hash), { state: "confirmed", blockNumber: 32 });
  });

  it("resyncs once when the sequencer reports nonce too low", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    mock.setNonce(3);
    mock.setNonceTooLow(1, 9);
    const chain = await readyChain(mock);
    const result = await chain.submit("markExpired", [OFFER]);
    assert.equal(result.state, "confirmed");
    assert.equal(result.nonce, 9);
    const raw = rawTransactions(mock);
    assert.equal(raw.length, 2);
    assert.equal(txFields(raw[0])[1], 3n);
    assert.equal(txFields(raw[1])[1], 9n);
    assert.equal(selectorOf("markExpired").slice(0, 2), "0x");
  });

  it("returns the local hash when the write host accepts and then times out", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const timers = fakeTimers();
    const chain = await readyChain(mock, { timers });
    mock.setNonce(7);
    mock.loseNextSend();
    const result = await chain.submit("markExpired", [OFFER]);
    const raw = rawTransactions(mock);
    assert.notEqual(result.state, "refused");
    assert.equal(result.hash, localHash(raw[0]));
    assert.equal(result.hash, mock.acceptedHashes()[0]);
    assert.equal(result.nonce, 7);
    assert.equal(result.state, "confirmed");
    assert.equal(chain.status().state, "degraded");
    assert.equal(errorLines.join("\n").includes(raw[0]), false);
    timers.fire();
    await chain.settled();
    assert.equal(chain.status().state, "ready");
    const next = await chain.submit("markExpired", [OFFER]);
    assert.equal(next.state, "confirmed");
    assert.equal(next.nonce, 8);
    assert.equal(txFields(rawTransactions(mock)[1])[1], 8n);
  });

  it("refuses a definitive rejection and takes the next nonce from the chain", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const chain = await readyChain(mock);
    mock.setNonce(4);
    mock.rejectNextSend("insufficient funds", 15);
    const result = await chain.submit("markExpired", [OFFER]);
    assert.equal(result.state, "refused");
    assert.equal(result.error.name, "SendFailed");
    assert.equal(result.hash, undefined);
    assert.equal(mock.acceptedHashes().length, 0);
    assert.equal(chain.status().state, "ready");
    const text = errorLines.join("\n");
    assert.equal(text.includes("insufficient funds"), false);
    assert.equal(text.includes(rawTransactions(mock)[0]), false);
    const next = await chain.submit("markExpired", [OFFER]);
    assert.equal(next.state, "confirmed");
    assert.equal(next.nonce, 15);
    assert.equal(txFields(rawTransactions(mock).at(-1))[1], 15n);
  });

  it("treats an already-known transaction as sent", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const chain = await readyChain(mock);
    mock.setNonce(7);
    mock.knowNextSend();
    const result = await chain.submit("markExpired", [OFFER]);
    const raw = rawTransactions(mock);
    assert.notEqual(result.state, "refused");
    assert.equal(result.hash, localHash(raw[0]));
    assert.equal(result.hash, mock.acceptedHashes()[0]);
    assert.equal(result.nonce, 7);
    assert.equal(chain.status().state, "ready");
    const reads = pendingReads(mock).length;
    const next = await chain.submit("markExpired", [OFFER]);
    assert.equal(next.state, "confirmed");
    assert.equal(next.nonce, 8);
    assert.equal(pendingReads(mock).length, reads);
  });

  it("reuses the nonce when the send never reaches the node", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const time = clocked();
    const chain = await readyChain(mock, time.options);
    mock.setNonce(7);
    mock.dropNextSend();
    const lost = await chain.submit("markExpired", [OFFER]);
    assert.equal(lost.state, "pending");
    assert.equal(lost.nonce, 7);
    assert.equal(lost.hash, localHash(rawTransactions(mock)[0]));
    assert.equal(mock.acceptedHashes().length, 0);
    assert.equal(chain.status().state, "degraded");
    time.timers.fire();
    await chain.settled();
    const follow = [];
    for (let i = 0; i < 3; i += 1) follow.push(await chain.submit("markExpired", [OFFER]));
    assert.deepEqual(follow.map((result) => result.state), ["confirmed", "confirmed", "confirmed"]);
    assert.deepEqual(follow.map((result) => result.nonce), [7, 8, 9]);
    assert.deepEqual(pendingReads(mock).map((call) => call.params[1]), ["pending", "pending"]);
  });

  it("reuses the nonce when the write host answers HTTP 429", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const time = clocked();
    const chain = await readyChain(mock, time.options);
    mock.setNonce(7);
    mock.failNextSend(429);
    const lost = await chain.submit("markExpired", [OFFER]);
    assert.equal(lost.state, "pending");
    assert.equal(lost.nonce, 7);
    assert.equal(lost.hash, localHash(rawTransactions(mock)[0]));
    assert.equal(mock.acceptedHashes().length, 0);
    time.timers.fire();
    await chain.settled();
    const follow = [];
    for (let i = 0; i < 3; i += 1) follow.push(await chain.submit("markExpired", [OFFER]));
    assert.deepEqual(follow.map((result) => result.state), ["confirmed", "confirmed", "confirmed"]);
    assert.deepEqual(follow.map((result) => result.nonce), [7, 8, 9]);
  });

  it("re-reads the pending count after an accepted send whose reply is lost", async () => {
    const relayer = openKey(RELAYER_KEY);
    const registrar = openKey(REGISTRAR_KEY);
    const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
    const time = clocked();
    const chain = await readyChain(mock, time.options);
    mock.setNonce(7);
    mock.loseNextSend();
    const lost = await chain.submit("markExpired", [OFFER]);
    assert.equal(lost.state, "confirmed");
    assert.equal(lost.nonce, 7);
    assert.equal(pendingReads(mock).length, 1);
    time.timers.fire();
    await chain.settled();
    const follow = [];
    for (let i = 0; i < 3; i += 1) follow.push(await chain.submit("markExpired", [OFFER]));
    assert.deepEqual(follow.map((result) => result.state), ["confirmed", "confirmed", "confirmed"]);
    assert.deepEqual(follow.map((result) => result.nonce), [8, 9, 10]);
    assert.equal(pendingReads(mock).length, 2);
    assert.equal(txFields(rawTransactions(mock)[1])[1], 8n);
  });
});
