"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createChain } = require("../lib/chain");
const { decodeLog } = require("../lib/chain/abi");
const { keccak } = require("../lib/chain/keccak");
const { addressToWord, bytesToHex, hexToBytes, utf8, wordToAddress } = require("../lib/chain/hex");

// Anvil's published default keys. Test only.
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const REGISTRAR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ACCESS_ID = "cf-access-id-test-only-9f3a";
const ACCESS_SECRET = "cf-access-secret-test-only-b7c2";
const ADDRESS = "0x481175bC15eE6e22EAB97176540a98aB6a2925eF";
const READ_URL = "http://127.0.0.1:9/";
const WRITE_URL = "http://127.0.0.1:8/";

function topic(signature) {
  return bytesToHex(keccak(utf8(signature)));
}

function word(value) {
  if (typeof value === "string") return value.toLowerCase().slice(2).padStart(64, "0");
  return BigInt(value).toString(16).padStart(64, "0");
}

function log(fields) {
  return {
    address: ADDRESS,
    topics: fields.topics,
    data: fields.data || "0x",
    blockNumber: "0x" + fields.block.toString(16),
    transactionHash: fields.hash,
    logIndex: "0x" + fields.index.toString(16),
  };
}

function chainWith(handler, block = 0) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), method: body.method, params: body.params });
    const result = await handler(body, calls);
    return {
      status: result && result.status ? result.status : 200,
      async text() {
        if (result && result.raw) return result.raw;
        return JSON.stringify({ jsonrpc: "2.0", id: 1, result: result ? result.result : null });
      },
    };
  };
  const chain = createChain({
    config: {
      chain: {
        relayerKey: RELAYER_KEY,
        registrarKey: REGISTRAR_KEY,
        accessClientId: ACCESS_ID,
        accessClientSecret: ACCESS_SECRET,
        readRpc: READ_URL,
        writeRpc: WRITE_URL,
        maxFeeGwei: 1,
      },
    },
    deployment: {
      chainId: 31337,
      genesisHash: "0x" + "11".repeat(32),
      address: ADDRESS,
      runtimeCodeHash: "0x" + "22".repeat(32),
      block,
    },
    fetchImpl,
  });
  return { chain, calls };
}

describe("ledger log decoding", () => {
  it("decodes indexed and plain event fields, and skips an unknown topic", () => {
    const company = "0x" + "ab".repeat(32);
    const wallet = "0x00000000000000000000000000000000000000ab";
    const bound = decodeLog({
      topics: [topic("WalletBound(bytes32,address)"), company, bytesToHex(addressToWord(wallet))],
      data: "0x",
    });
    assert.equal(bound.name, "WalletBound");
    assert.equal(bound.args.companyKey, company);
    assert.equal(bound.args.wallet.toLowerCase(), wallet);

    const offer = "0x" + "11".repeat(32);
    const commitment = "0x" + "22".repeat(32);
    const published = decodeLog({
      topics: [
        topic("OfferPublished(bytes32,bytes32,address,uint32,bytes32,uint64)"),
        offer,
        company,
        bytesToHex(addressToWord(wallet)),
      ],
      data: "0x" + word(1) + word(commitment) + word(1893456000),
    });
    assert.equal(published.name, "OfferPublished");
    assert.equal(published.args.offerId, offer);
    assert.equal(published.args.version, 1);
    assert.equal(published.args.commitment, commitment);
    assert.equal(published.args.expiresAt, 1893456000);

    const paused = decodeLog({
      topics: [topic("Paused(address)")],
      data: "0x" + word(bytesToHex(addressToWord(wallet))),
    });
    assert.equal(paused.name, "Paused");
    assert.equal(paused.args.account.toLowerCase(), wallet);
    assert.equal(decodeLog({ topics: ["0x" + "ee".repeat(32)], data: "0x" }), null);
    assert.equal(wordToAddress(hexToBytes(bytesToHex(addressToWord(wallet)))).toLowerCase(), wallet);
  });
});

describe("chain.events", () => {
  it("reads the deployment block through latest on the read RPC only", async () => {
    const { chain, calls } = chainWith((body) => {
      if (body.method === "eth_blockNumber") return { result: "0x64" };
      assert.equal(body.method, "eth_getLogs");
      return { result: [] };
    }, 80);
    assert.deepEqual(await chain.events({}), []);
    assert.deepEqual(calls.map((call) => call.method), ["eth_blockNumber", "eth_getLogs"]);
    assert.equal(calls[1].params[0].fromBlock, "0x50");
    assert.equal(calls[1].params[0].toBlock, "0x64");
    assert.equal(calls[1].params[0].address, ADDRESS);
    assert.equal(calls.every((call) => call.url === READ_URL), true);
  });

  it("returns boundary logs once each, in order, and skips unknown topics", async () => {
    const company = "0x" + "ab".repeat(32);
    const wallet = "0x00000000000000000000000000000000000000ab";
    const boundTopic = topic("WalletBound(bytes32,address)");
    const pausedTopic = topic("Paused(address)");
    const at = (block, index, name) => log({
      topics: name === "paused"
        ? [pausedTopic]
        : [boundTopic, company, bytesToHex(addressToWord(wallet))],
      data: name === "paused" ? "0x" + word(bytesToHex(addressToWord(wallet))) : "0x",
      block,
      index,
      hash: "0x" + block.toString(16).padStart(64, "0"),
    });
    const { chain, calls } = chainWith((body) => {
      const from = Number(BigInt(body.params[0].fromBlock));
      const to = Number(BigInt(body.params[0].toBlock));
      const found = [];
      for (const entry of [
        at(49999, 1, "bound"),
        at(50000, 0, "bound"),
        at(0, 2, "paused"),
        log({
          topics: ["0x" + "ee".repeat(32)],
          block: 1,
          index: 0,
          hash: "0x" + "01".repeat(32),
        }),
      ]) {
        const block = Number(BigInt(entry.blockNumber));
        if (block >= from && block <= to) found.push(entry);
      }
      return { result: found };
    });
    const logs = await chain.events({ fromBlock: 0, toBlock: 100000 });
    const ranges = calls.map((call) => [call.params[0].fromBlock, call.params[0].toBlock]);
    assert.deepEqual(ranges, [
      ["0x0", "0xc34f"],
      ["0xc350", "0x1869f"],
      ["0x186a0", "0x186a0"],
    ]);
    assert.equal(logs.filter((entry) => entry.name === "WalletBound").length, 2);
    assert.deepEqual(logs.map((entry) => entry.blockNumber), [0, 49999, 50000]);
    assert.equal(logs[0].name, "Paused");
    assert.equal(logs[1].logIndex, 1);
    assert.equal(logs[2].logIndex, 0);
    assert.equal(logs.some((entry) => entry.transactionHash === "0x" + "01".repeat(32)), false);
    assert.equal(calls.every((call) => call.url === READ_URL), true);
  });

  it("returns an empty range without asking the RPC, and throws on an outage", async () => {
    const quiet = chainWith(() => {
      throw new Error("should not fetch");
    });
    assert.deepEqual(await quiet.chain.events({ fromBlock: 10, toBlock: 9 }), []);
    assert.equal(quiet.calls.length, 0);

    const down = chainWith(() => ({ status: 503, raw: "no" }));
    await assert.rejects(
      () => down.chain.events({ fromBlock: 0, toBlock: 1 }),
      (err) => err instanceof Error && err.message === "chain_unavailable" && !String(err).includes(ACCESS_SECRET)
    );
    assert.equal(down.calls.every((call) => call.url === READ_URL), true);
  });
});
