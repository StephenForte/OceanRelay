"use strict";

const { selectorOf } = require("../lib/chain/abi");
const { keccakHex } = require("../lib/chain/keccak");
const { hexToBytes } = require("../lib/chain/hex");

const VIEWS = new Set(["relayer", "registrar", "paused", "owner"].map((name) => selectorOf(name)));

function createMockChain({
  readUrl = "http://127.0.0.1:9/read",
  writeUrl = "http://127.0.0.1:9/write",
  chainId = 852,
  genesisHash = "0x" + "ab".repeat(32),
  address,
  relayer,
  registrar,
  owner = relayer,
  code = "0x60016000",
  balance = 1_000_000_000_000_000_000n,
  baseFee = 251n,
  priority = 1_000_000n,
  gas = 21_000n,
  paused = false,
} = {}) {
  const calls = [];
  const receipts = new Map();
  let pendingNonce = 0n;
  let failReads = false;
  let failStatus = 503;
  let revertData = null;
  let nonceTooLowLeft = 0;
  let nonceAfterTooLow = 10n;
  let holdReceipts = false;
  let sent = 0;
  const runtimeCodeHash = keccakHex(hexToBytes(code));

  function addressWord(value) {
    return "0x" + value.slice(2).toLowerCase().padStart(64, "0");
  }

  async function fetchImpl(url, init) {
    const target = new URL(url);
    const headers = {};
    for (const [key, value] of Object.entries(init.headers || {})) headers[key] = value;
    const body = JSON.parse(init.body);
    const call = { url: target.href, host: target.host, headers, method: body.method, params: body.params };
    calls.push(call);
    if (failReads && target.href === readUrl) {
      return json(failStatus, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "down" } });
    }
    const result = answer(body.method, body.params || [], target.href);
    if (result && result.error) return json(200, { jsonrpc: "2.0", id: 1, error: result.error });
    return json(200, { jsonrpc: "2.0", id: 1, result });
  }

  function answer(method, params, href) {
    if (href === writeUrl && method !== "eth_sendRawTransaction") {
      return { error: { code: -32601, message: "write_method" } };
    }
    if (method === "eth_chainId") return "0x" + chainId.toString(16);
    if (method === "eth_getBlockByNumber") {
      const which = params[0];
      if (which === "0x0") return { hash: genesisHash, number: "0x0" };
      return { hash: "0x" + "cd".repeat(32), number: "0x10", baseFeePerGas: "0x" + baseFee.toString(16) };
    }
    if (method === "eth_getCode") return code;
    if (method === "eth_getBalance") return "0x" + balance.toString(16);
    if (method === "eth_maxPriorityFeePerGas") return "0x" + priority.toString(16);
    if (method === "eth_estimateGas") {
      if (revertData) return { error: { code: 3, message: "execution reverted", data: revertData } };
      return "0x" + gas.toString(16);
    }
    if (method === "eth_getTransactionCount") return "0x" + pendingNonce.toString(16);
    if (method === "eth_call") {
      const data = params[0] && params[0].data ? params[0].data : "0x";
      const selector = data.slice(0, 10).toLowerCase();
      if (selector === selectorOf("relayer")) return addressWord(relayer);
      if (selector === selectorOf("registrar")) return addressWord(registrar);
      if (selector === selectorOf("owner")) return addressWord(owner);
      if (selector === selectorOf("paused")) return "0x" + (paused ? "1" : "0").padStart(64, "0");
      if (!VIEWS.has(selector) && revertData) {
        return { error: { code: 3, message: "execution reverted", data: revertData } };
      }
      return "0x";
    }
    if (method === "eth_sendRawTransaction") {
      if (nonceTooLowLeft > 0) {
        nonceTooLowLeft -= 1;
        pendingNonce = nonceAfterTooLow;
        return { error: { code: -32000, message: "nonce too low" } };
      }
      sent += 1;
      const hash = "0x" + sent.toString(16).padStart(64, "0");
      if (!holdReceipts) {
        receipts.set(hash, { status: "0x1", blockNumber: "0x11", transactionHash: hash });
      }
      pendingNonce += 1n;
      return hash;
    }
    if (method === "eth_getTransactionReceipt") {
      return receipts.get(params[0]) || null;
    }
    return { error: { code: -32601, message: "method_not_found" } };
  }

  function json(status, body) {
    return {
      status,
      async text() {
        return JSON.stringify(body);
      },
    };
  }

  return {
    fetchImpl,
    calls,
    readUrl,
    writeUrl,
    runtimeCodeHash,
    code,
    genesisHash,
    chainId,
    address,
    setBalance(next) {
      balance = next;
    },
    setPaused(next) {
      paused = next;
    },
    setRevert(data) {
      revertData = data;
    },
    setFailReads(next, status = 503) {
      failReads = next;
      failStatus = status;
    },
    setNonce(next) {
      pendingNonce = BigInt(next);
    },
    setNonceTooLow(times, next = 10n) {
      nonceTooLowLeft = times;
      nonceAfterTooLow = BigInt(next);
    },
    setHoldReceipts(next) {
      holdReceipts = next;
    },
    addReceipt(hash, receipt) {
      receipts.set(hash, receipt);
    },
    reads() {
      return calls.filter((call) => call.url === readUrl);
    },
    writes() {
      return calls.filter((call) => call.url === writeUrl);
    },
  };
}

module.exports = { createMockChain };
