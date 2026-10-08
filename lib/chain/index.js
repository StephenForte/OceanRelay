"use strict";

const { inspect } = require("node:util");
const { digestHex } = require("./eip712");
const { tryRecover } = require("./recover");
const { openKey } = require("./keys");
const { encodeCall, decodeResult, decodeRevert } = require("./abi");
const { createReadClient, createWriteClient } = require("./rpc");
const { checksumAddress, hexToBytes, sameAddress, sameHex } = require("./hex");
const { keccakHex } = require("./keccak");

const DEFAULT_READ_RPC = "https://fortel2-sequencer-rpc.onrender.com/";
const DEFAULT_WRITE_RPC = "https://fortel2-write.ente.ltd";
const LOW_BALANCE_WEI = 1_000_000_000_000_000n;
const ALLOWED_CHAIN_IDS = new Set([852, 31337]);

const defaultTimers = {
  setTimeout(fn, ms) {
    return globalThis.setTimeout(fn, ms);
  },
  clearTimeout(id) {
    globalThis.clearTimeout(id);
  },
};

function createChain({
  config,
  deployment: deploymentInput,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timers = defaultTimers,
  advance = null,
  timeoutMs = 10_000,
  pollIntervalMs = 1_000,
  receiptTimeoutMs = 30_000,
  retryMs = 60_000,
} = {}) {
  const deployment = normalizeDeployment(deploymentInput);
  const chain = chainSettings(config);
  const domain = {
    name: "OceanRelay",
    version: "1",
    chainId: deployment.chainId,
    verifyingContract: deployment.address,
  };
  const presence = countSecrets(chain);
  const keys = presence === 4 ? openKeys(chain) : { relayer: null, registrar: null, problem: null };
  const capWei = gweiToWei(chain.maxFeeGwei);
  const clients = presence === 4 && !keys.problem && capWei != null && validRpcUrl(chain.readRpc) && validRpcUrl(chain.writeRpc)
    ? openClients(chain, fetchImpl, timeoutMs, timers)
    : null;

  let snapshot = baseStatus(deployment, keys, initialState(presence, keys, chain, capWei, deployment));
  let nextNonce = null;
  let gate = Promise.resolve();
  let inflight = Promise.resolve();
  let started = false;
  let running = false;
  let retryTimer = null;

  function status() {
    return {
      state: snapshot.state,
      reason: snapshot.reason,
      chainId: snapshot.chainId,
      address: snapshot.address,
      relayer: snapshot.relayer,
      registrar: snapshot.registrar,
      relayerBalanceWei: snapshot.relayerBalanceWei,
      lowBalance: snapshot.lowBalance,
    };
  }

  function publish(next) {
    snapshot = {
      state: next.state,
      reason: next.reason == null ? null : next.reason,
      chainId: deployment.chainId,
      address: deployment.address,
      relayer: keys.relayer ? keys.relayer.address : null,
      registrar: keys.registrar ? keys.registrar.address : null,
      relayerBalanceWei: Object.prototype.hasOwnProperty.call(next, "relayerBalanceWei")
        ? next.relayerBalanceWei
        : snapshot.relayerBalanceWei,
      lowBalance: Object.prototype.hasOwnProperty.call(next, "lowBalance")
        ? next.lowBalance
        : snapshot.lowBalance,
    };
  }

  function failClosed(reason) {
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    publish({ state: "misconfigured", reason, relayerBalanceWei: snapshot.relayerBalanceWei, lowBalance: snapshot.lowBalance });
    console.error("chain_misconfigured");
    return status();
  }

  function degrade(reason) {
    publish({ state: "degraded", reason: reason || "unreachable" });
    console.error("chain_unavailable");
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      inflight = runCheck();
    }, retryMs);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
    return status();
  }

  function start() {
    if (started) return inflight;
    started = true;
    inflight = runCheck();
    return inflight;
  }

  function settled() {
    return inflight;
  }

  async function runCheck() {
    if (snapshot.state === "disabled" || snapshot.state === "misconfigured") return status();
    if (!clients) return failClosed(snapshot.reason || "incomplete");
    if (running) return inflight;
    running = true;
    try {
      const reported = Number(parseQuantity(await clients.read.request("eth_chainId", [])));
      if (reported !== deployment.chainId) return failClosed("chain_id");
      const genesis = await clients.read.request("eth_getBlockByNumber", ["0x0", false]);
      if (!genesis || !sameHex(genesis.hash, deployment.genesisHash)) return failClosed("genesis");
      const code = await clients.read.request("eth_getCode", [deployment.address, "latest"]);
      if (!sameHex(keccakHex(hexToBytes(code)), deployment.runtimeCodeHash)) return failClosed("code_hash");
      const relayerOnChain = decodeResult("relayer", await viewCall("relayer"));
      if (!sameAddress(relayerOnChain, keys.relayer.address)) return failClosed("relayer");
      const registrarOnChain = decodeResult("registrar", await viewCall("registrar"));
      if (!sameAddress(registrarOnChain, keys.registrar.address)) return failClosed("registrar");
      const paused = decodeResult("paused", await viewCall("paused"));
      if (paused) return failClosed("paused");
      const balance = parseQuantity(await clients.read.request("eth_getBalance", [keys.relayer.address, "latest"]));
      if (retryTimer) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
      }
      publish({
        state: "ready",
        reason: null,
        relayerBalanceWei: balance.toString(),
        lowBalance: balance < LOW_BALANCE_WEI,
      });
      return status();
    } catch (err) {
      if (err && err.kind === "mismatch") return failClosed(err.reason || "mismatch");
      if (err && err.kind === "revert") return failClosed("code_hash");
      return degrade(err && err.reason ? err.reason : "unreachable");
    } finally {
      running = false;
    }
  }

  async function viewCall(name) {
    const data = encodeCall(name, []);
    const result = await clients.read.request("eth_call", [{ to: deployment.address, data }, "latest"]);
    return result;
  }

  function typedDigest(type, message) {
    return digestHex(domain, type, message);
  }

  function registrarSign(message) {
    if (!keys.registrar) throw new Error("registrar_unavailable");
    return keys.registrar.signDigest(typedDigest("Binding", message));
  }

  async function submit(fn, args) {
    if (snapshot.state !== "ready" || !clients || !keys.relayer) {
      return refused("ChainNotReady", [snapshot.state, snapshot.reason]);
    }
    let data;
    try {
      data = encodeCall(fn, args || []);
    } catch {
      return refused("BadCall", []);
    }
    const call = { from: keys.relayer.address, to: deployment.address, data };
    try {
      await clients.read.request("eth_call", [call, "latest"]);
    } catch (err) {
      if (err && err.kind === "revert") return refusedError(decodeRevert(err.revertData));
      noteOutage(err);
      console.error("chain_submit_failed");
      return refused("RpcUnavailable", []);
    }
    let gasLimit;
    let fee;
    try {
      const estimate = parseQuantity(await clients.read.request("eth_estimateGas", [call, "latest"]));
      gasLimit = (estimate * 5n + 3n) / 4n;
      fee = await loadFees();
    } catch (err) {
      if (err && err.kind === "revert") return refusedError(decodeRevert(err.revertData));
      if (err && err.reason === "no_base_fee") return refused("NoBaseFee", []);
      noteOutage(err);
      console.error("chain_submit_failed");
      return refused("RpcUnavailable", []);
    }
    try {
      const sent = await exclusive(() => broadcast(data, gasLimit, fee));
      const found = await waitForReceipt(sent.hash);
      return finish(found, sent.hash, sent.nonce);
    } catch (err) {
      noteOutage(err);
      console.error("chain_submit_failed");
      return refused("SendFailed", []);
    }
  }

  async function loadFees() {
    const block = await clients.read.request("eth_getBlockByNumber", ["latest", false]);
    if (!block || typeof block.baseFeePerGas !== "string") {
      const error = new Error("no_base_fee");
      error.reason = "no_base_fee";
      throw error;
    }
    const base = parseQuantity(block.baseFeePerGas);
    let priority = parseQuantity(await clients.read.request("eth_maxPriorityFeePerGas", []));
    let maxFee = base * 2n + priority;
    if (maxFee > capWei) maxFee = capWei;
    if (priority > maxFee) priority = maxFee;
    return { maxPriorityFeePerGas: priority, maxFeePerGas: maxFee };
  }

  async function broadcast(data, gasLimit, fee) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = await currentNonce();
      const raw = keys.relayer.signTransaction({
        chainId: deployment.chainId,
        nonce,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        maxFeePerGas: fee.maxFeePerGas,
        gasLimit,
        to: deployment.address,
        value: 0n,
        data,
      });
      try {
        const hash = await clients.write.sendRawTransaction(raw);
        return { hash, nonce };
      } catch (err) {
        if (nextNonce === nonce + 1n) nextNonce = nonce;
        if (attempt === 0 && err && err.nonceTooLow) {
          nextNonce = null;
          continue;
        }
        throw err;
      }
    }
    throw new Error("send_failed");
  }

  async function currentNonce() {
    if (nextNonce == null) {
      nextNonce = parseQuantity(await clients.read.request("eth_getTransactionCount", [keys.relayer.address, "pending"]));
    }
    const nonce = nextNonce;
    nextNonce += 1n;
    return nonce;
  }

  function exclusive(task) {
    const run = gate.then(task, task);
    gate = run.then(() => undefined, () => undefined);
    return run;
  }

  async function waitForReceipt(hash) {
    const deadline = now() + receiptTimeoutMs;
    for (;;) {
      const found = await readReceipt(hash);
      if (found) return found;
      if (now() >= deadline) return null;
      await delay(pollIntervalMs);
      if (now() >= deadline) return null;
    }
  }

  async function readReceipt(hash) {
    try {
      const found = await clients.read.request("eth_getTransactionReceipt", [hash]);
      if (!found) return null;
      return found;
    } catch {
      return null;
    }
  }

  async function receipt(hash) {
    if (!clients || snapshot.state === "disabled" || snapshot.state === "misconfigured") {
      return { state: "pending" };
    }
    const found = await readReceipt(hash);
    if (!found) return { state: "pending" };
    return receiptState(found);
  }

  async function call(fn, args) {
    if (!clients || (snapshot.state !== "ready" && snapshot.state !== "degraded")) {
      throw new Error("chain_not_ready");
    }
    const data = encodeCall(fn, args || []);
    try {
      const result = await clients.read.request("eth_call", [{ to: deployment.address, data }, "latest"]);
      return decodeResult(fn, result);
    } catch (err) {
      if (err && err.kind === "revert") {
        const error = new Error("chain_reverted");
        error.decoded = decodeRevert(err.revertData);
        throw error;
      }
      throw new Error("chain_unavailable");
    }
  }

  function noteOutage(err) {
    if (err && err.kind === "outage" && snapshot.state === "ready") {
      degrade(err.reason || "unreachable");
    }
  }

  function delay(ms) {
    if (typeof advance === "function") {
      advance(ms);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const id = timers.setTimeout(resolve, ms);
      if (id && typeof id.unref === "function") id.unref();
    });
  }

  const api = {
    status,
    start,
    settled,
    typed: {
      digest: typedDigest,
      recover(type, message, signature) {
        return tryRecover(typedDigest(type, message), signature);
      },
    },
    registrarSign,
    submit,
    receipt,
    call,
  };
  Object.defineProperty(api, inspect.custom, {
    enumerable: false,
    value() {
      return "OceanRelayChain";
    },
  });
  Object.defineProperty(api, "toJSON", {
    enumerable: false,
    value() {
      return status();
    },
  });
  return api;
}

function normalizeDeployment(input) {
  const source = input || require("../../deployments/fortel2-sepolia.json");
  return {
    chainId: Number(source.chainId),
    genesisHash: source.genesisHash,
    address: checksumAddress(source.address),
    runtimeCodeHash: String(source.runtimeCodeHash).toLowerCase(),
  };
}

function chainSettings(config) {
  const chain = config && config.chain ? config.chain : {};
  return {
    relayerKey: stringValue(chain.relayerKey),
    registrarKey: stringValue(chain.registrarKey),
    accessClientId: stringValue(chain.accessClientId),
    accessClientSecret: stringValue(chain.accessClientSecret),
    readRpc: stringValue(chain.readRpc) || DEFAULT_READ_RPC,
    writeRpc: stringValue(chain.writeRpc) || DEFAULT_WRITE_RPC,
    maxFeeGwei: chain.maxFeeGwei == null || chain.maxFeeGwei === "" ? 1 : chain.maxFeeGwei,
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function countSecrets(chain) {
  return [chain.relayerKey, chain.registrarKey, chain.accessClientId, chain.accessClientSecret]
    .filter((value) => value.length > 0).length;
}

function openKeys(chain) {
  try {
    const relayer = openKey(chain.relayerKey);
    try {
      const registrar = openKey(chain.registrarKey);
      if (sameAddress(relayer.address, registrar.address)) return { relayer: null, registrar: null, problem: "relayer_registrar" };
      return { relayer, registrar, problem: null };
    } catch {
      return { relayer: null, registrar: null, problem: "registrar_key" };
    }
  } catch {
    return { relayer: null, registrar: null, problem: "relayer_key" };
  }
}

function initialState(presence, keys, chain, capWei, deployment) {
  if (presence === 0) return { state: "disabled", reason: null };
  if (presence < 4) return { state: "misconfigured", reason: "incomplete" };
  if (keys.problem) return { state: "misconfigured", reason: keys.problem };
  if (!ALLOWED_CHAIN_IDS.has(deployment.chainId)) return { state: "misconfigured", reason: "chain_id" };
  if (!validRpcUrl(chain.readRpc)) return { state: "misconfigured", reason: "read_rpc" };
  if (!validRpcUrl(chain.writeRpc)) return { state: "misconfigured", reason: "write_rpc" };
  if (capWei == null) return { state: "misconfigured", reason: "max_fee" };
  return { state: "checking", reason: null };
}

function baseStatus(deployment, keys, initial) {
  return {
    state: initial.state,
    reason: initial.reason,
    chainId: deployment.chainId,
    address: deployment.address,
    relayer: keys.relayer ? keys.relayer.address : null,
    registrar: keys.registrar ? keys.registrar.address : null,
    relayerBalanceWei: null,
    lowBalance: false,
  };
}

function validRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "http:" && local;
}

function gweiToWei(gwei) {
  const text = String(gwei);
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 9) return null;
  const wei = BigInt(whole) * 1_000_000_000n + BigInt((frac + "000000000").slice(0, 9));
  return wei > 0n ? wei : null;
}

function openClients(chain, fetchImpl, timeoutMs, timers) {
  return {
    read: createReadClient({ url: chain.readRpc, fetchImpl, timeoutMs, timers }),
    write: createWriteClient({
      url: chain.writeRpc,
      fetchImpl,
      timeoutMs,
      timers,
      accessClientId: chain.accessClientId,
      accessClientSecret: chain.accessClientSecret,
    }),
  };
}

function parseQuantity(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    const error = new Error("bad_quantity");
    error.kind = "mismatch";
    error.reason = "bad_quantity";
    throw error;
  }
  return BigInt(hex);
}

function refused(name, args) {
  return { state: "refused", error: { name, args } };
}

function refusedError(error) {
  return { state: "refused", error: { name: error.name, args: error.args } };
}

function finish(found, hash, nonce) {
  const body = found ? receiptState(found) : { state: "pending" };
  body.hash = hash;
  body.nonce = nonce <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(nonce) : nonce.toString();
  return body;
}

function receiptState(found) {
  const status = parseQuantity(found.status);
  const body = { state: status === 1n ? "confirmed" : "reverted" };
  if (found.blockNumber) body.blockNumber = Number(parseQuantity(found.blockNumber));
  return body;
}

module.exports = {
  createChain,
  DEFAULT_READ_RPC,
  DEFAULT_WRITE_RPC,
  LOW_BALANCE_WEI,
};
