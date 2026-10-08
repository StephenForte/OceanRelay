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
  let reportedChainId = chainId;
  let failReads = false;
  let failStatus = 503;
  let revertData = null;
  let nonceTooLowLeft = 0;
  let nonceAfterTooLow = 10n;
  let holdReceipts = false;
  let loseSend = false;
  let dropSend = false;
  let httpFault = 0;
  let sendError = null;
  let alreadyKnown = false;
  const accepted = [];
  const queued = new Map();
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
    if (result && result.httpStatus) {
      return { status: result.httpStatus, async text() { return ""; } };
    }
    if (result && result.error) return json(200, { jsonrpc: "2.0", id: 1, error: result.error });
    return json(200, { jsonrpc: "2.0", id: 1, result });
  }

  function answer(method, params, href) {
    if (href === writeUrl && method !== "eth_sendRawTransaction") {
      return { error: { code: -32601, message: "write_method" } };
    }
    if (method === "eth_chainId") return "0x" + reportedChainId.toString(16);
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
      if (sendError) {
        const fault = sendError;
        sendError = null;
        if (fault.nextNonce != null) pendingNonce = fault.nextNonce;
        return { error: { code: -32000, message: fault.message } };
      }
      const raw = params[0];
      if (dropSend) {
        dropSend = false;
        const error = new TypeError("fetch failed");
        throw error;
      }
      if (httpFault) {
        const status = httpFault;
        httpFault = 0;
        return { httpStatus: status };
      }
      if (alreadyKnown) {
        alreadyKnown = false;
        remember(raw);
        return { error: { code: -32000, message: "already known" } };
      }
      if (loseSend) {
        loseSend = false;
        remember(raw);
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return remember(raw);
    }
    if (method === "eth_getTransactionReceipt") {
      return receipts.get(params[0]) || null;
    }
    return { error: { code: -32601, message: "method_not_found" } };
  }

  function remember(raw) {
    const hash = keccakHex(hexToBytes(raw));
    accepted.push(hash);
    queued.set(nonceOf(raw), hash);
    while (queued.has(pendingNonce)) {
      const mined = queued.get(pendingNonce);
      queued.delete(pendingNonce);
      if (!holdReceipts) {
        receipts.set(mined, { status: "0x1", blockNumber: "0x11", transactionHash: mined });
      }
      pendingNonce += 1n;
    }
    return hash;
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
    setReportedChainId(next) {
      reportedChainId = next;
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
      queued.clear();
    },
    setNonceTooLow(times, next = 10n) {
      nonceTooLowLeft = times;
      nonceAfterTooLow = BigInt(next);
    },
    setHoldReceipts(next) {
      holdReceipts = next;
    },
    loseNextSend() {
      loseSend = true;
    },
    dropNextSend() {
      dropSend = true;
    },
    failNextSend(status) {
      httpFault = status;
    },
    rejectNextSend(message, nextNonce) {
      sendError = { message, nextNonce: nextNonce == null ? null : BigInt(nextNonce) };
    },
    knowNextSend() {
      alreadyKnown = true;
    },
    acceptedHashes() {
      return accepted.slice();
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

function nonceOf(raw) {
  const bytes = hexToBytes(raw);
  const list = rlpItem(bytes, 1);
  const chainId = rlpItem(bytes, list.start);
  const nonce = rlpItem(bytes, chainId.next);
  let value = 0n;
  for (let i = nonce.start; i < nonce.end; i += 1) value = (value << 8n) + BigInt(bytes[i]);
  return value;
}

function rlpItem(bytes, offset) {
  const prefix = bytes[offset];
  if (prefix < 0x80) return { start: offset, end: offset + 1, next: offset + 1 };
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    return { start: offset + 1, end: offset + 1 + len, next: offset + 1 + len };
  }
  if (prefix <= 0xbf) {
    const size = prefix - 0xb7;
    let len = 0;
    for (let i = 0; i < size; i += 1) len = (len * 256) + bytes[offset + 1 + i];
    const start = offset + 1 + size;
    return { start, end: start + len, next: start + len };
  }
  if (prefix <= 0xf7) {
    const len = prefix - 0xc0;
    return { start: offset + 1, end: offset + 1 + len, next: offset + 1 + len };
  }
  const size = prefix - 0xf7;
  let len = 0;
  for (let i = 0; i < size; i += 1) len = (len * 256) + bytes[offset + 1 + i];
  const start = offset + 1 + size;
  return { start, end: start + len, next: start + len };
}

module.exports = { createMockChain };
