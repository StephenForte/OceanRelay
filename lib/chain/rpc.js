"use strict";

const defaultTimers = {
  setTimeout(fn, ms) {
    return globalThis.setTimeout(fn, ms);
  },
  clearTimeout(id) {
    globalThis.clearTimeout(id);
  },
};

class RpcFailure extends Error {
  constructor(kind, reason, extra = {}) {
    super(reason);
    this.kind = kind;
    this.reason = reason;
    this.nonceTooLow = extra.nonceTooLow === true;
    this.revertData = extra.revertData || null;
  }
}

function createRpc({ url, headers, fetchImpl, timeoutMs = 10_000, timers = defaultTimers }) {
  if (typeof url !== "string" || url.length === 0) {
    throw new RpcFailure("mismatch", "bad_url");
  }
  async function request(method, params) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        if (isAbort(err)) throw new RpcFailure("outage", "timeout");
        throw new RpcFailure("outage", "network");
      }
      const status = Number(response.status);
      let text = "";
      try {
        text = await response.text();
      } catch {
        throw new RpcFailure("outage", "network");
      }
      if (status === 408 || status === 429 || status >= 500) {
        throw new RpcFailure("outage", "http_" + status);
      }
      if (status < 200 || status >= 300) {
        throw new RpcFailure("mismatch", "http_" + status);
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RpcFailure("outage", "bad_json");
      }
      if (payload && payload.error) throw failureFromError(payload.error);
      return payload ? payload.result : null;
    } finally {
      timers.clearTimeout(timer);
    }
  }
  return { request };
}

function failureFromError(error) {
  const message = error && typeof error.message === "string" ? error.message : "";
  const nonceTooLow = /nonce too low/i.test(message);
  const data = revertDataOf(error);
  if (nonceTooLow) return new RpcFailure("reject", "nonce_too_low", { nonceTooLow: true });
  if (data != null || /execution reverted/i.test(message)) {
    return new RpcFailure("revert", "reverted", { revertData: data || "0x" });
  }
  const code = error && error.code;
  if (code === -32600 || code === -32601 || code === -32602) {
    return new RpcFailure("mismatch", "rpc_method");
  }
  return new RpcFailure("outage", "rpc_error");
}

function revertDataOf(error) {
  const data = error && error.data;
  if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data)) return data;
  if (data && typeof data.data === "string" && /^0x[0-9a-fA-F]*$/.test(data.data)) return data.data;
  return null;
}

function isAbort(err) {
  return !!err && (err.name === "AbortError" || err.name === "TimeoutError");
}

function createReadClient({ url, fetchImpl, timeoutMs, timers }) {
  const rpc = createRpc({
    url,
    headers: { "content-type": "application/json" },
    fetchImpl,
    timeoutMs,
    timers,
  });
  return {
    request(method, params) {
      return rpc.request(method, params);
    },
  };
}

function createWriteClient({ url, fetchImpl, timeoutMs, timers, accessClientId, accessClientSecret }) {
  const rpc = createRpc({
    url,
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": accessClientId,
      "CF-Access-Client-Secret": accessClientSecret,
    },
    fetchImpl,
    timeoutMs,
    timers,
  });
  return {
    sendRawTransaction(raw) {
      return rpc.request("eth_sendRawTransaction", [raw]);
    },
  };
}

module.exports = {
  RpcFailure,
  createReadClient,
  createWriteClient,
};
