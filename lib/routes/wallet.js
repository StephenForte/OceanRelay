"use strict";

const { checksumAddress, sameAddress } = require("../chain/hex");
const { viewerFor } = require("../views/layout");
const { renderWallet } = require("../views/wallet");
const { href: scriptHref } = require("../wallet-script");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ZERO = "0x0000000000000000000000000000000000000000";
const WINDOW_SECONDS = 15 * 60;
const PROPOSE_SECONDS = 10 * 60;
const RECEIPT_BUFFER_SECONDS = 120;
const ACTIVE = new Set(["submitting", "pending", "confirmed"]);
const ERROR_NAMES = new Set([
  "SignerMismatch",
  "NotRegistrar",
  "DuplicateSigner",
  "DigestUsed",
  "DeadlineExpired",
  "ZeroCompanyKey",
  "ZeroAddress",
  "ChainNotReady",
  "BadCall",
  "RpcUnavailable",
  "NoBaseFee",
  "SendFailed",
  "Revert",
]);

const MESSAGES = Object.freeze({
  bound: { kind: "success", text: "The wallet is bound to your company." },
  pending: { kind: "info", text: "The binding is pending. It stays pending until you check it." },
  unchanged: { kind: "info", text: "The binding is still pending." },
  reverted: { kind: "error", text: "The binding transaction reverted." },
  refused: { kind: "error", text: "The binding was refused." },
  other_company: { kind: "error", text: "This wallet belongs to another company." },
  mismatch: { kind: "error", text: "The signature does not match this wallet." },
  deadline: { kind: "error", text: "That deadline is outside the 15-minute window." },
  cap: { kind: "error", text: "A company can bind at most 5 wallets." },
  in_flight: { kind: "error", text: "A binding is already in progress for your company." },
  already: { kind: "error", text: "This wallet is already recorded for your company." },
  unavailable: { kind: "error", text: "Binding is unavailable." },
  reserved: { kind: "error", text: "That address cannot be bound." },
  expired: { kind: "error", text: "The binding expired." },
  prepare_first: { kind: "error", text: "Prepare a company key before binding a wallet." },
  no_key: { kind: "error", text: "Prepare a company key before binding a wallet." },
});

function register(router, deps) {
  router.get("/wallet", handlePage);
  router.post("/wallet/prepare", handlePrepare);
  router.post("/wallet/bind", handleBind);
  router.post("/wallet/check", handleCheck);

  function nowSec() {
    const clock = typeof deps.now === "function" ? deps.now() : Date.now();
    return Math.floor(Number(clock) / 1000);
  }

  function gate(req, res) {
    const result = deps.requireIdentity(req, res);
    if (!result) return null;
    return {
      session: result.session,
      identity: result.identity,
      cookies: deps.cookieFor(req, result.session),
    };
  }

  async function readForm(req) {
    const text = await deps.readBody(req);
    return deps.formBody(text);
  }

  function csrfOk(session, form) {
    return deps.safeEqual(form.csrf_token || "", session.csrf);
  }

  function chainStatus() {
    try {
      const status = deps.chain && typeof deps.chain.status === "function" ? deps.chain.status() : null;
      return status && typeof status === "object" ? status : { state: "disabled" };
    } catch {
      return { state: "disabled" };
    }
  }

  function chainReady(status) {
    return Boolean(status)
      && status.state === "ready"
      && Number.isInteger(status.chainId)
      && typeof status.address === "string"
      && status.address !== "";
  }

  function seeOther(res, result, cookies, code) {
    const params = new URLSearchParams();
    if (result) params.set("result", result);
    if (result === "refused" && code && ERROR_NAMES.has(code)) params.set("code", code);
    const query = params.toString();
    deps.redirect(res, query ? `/wallet?${query}` : "/wallet", cookies, 303);
  }

  function noticeFor(url) {
    const result = url.searchParams.get("result") || "";
    const code = url.searchParams.get("code") || "";
    if (result === "refused" && ERROR_NAMES.has(code)) {
      return { kind: "error", text: `The binding was refused (${code}).` };
    }
    return MESSAGES[result] || null;
  }

  function canonicalWallet(value) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
    try {
      return checksumAddress(value);
    } catch {
      return null;
    }
  }

  function reserved(wallet, status) {
    if (sameAddress(wallet, ZERO)) return true;
    if (typeof status.relayer === "string" && sameAddress(wallet, status.relayer)) return true;
    if (typeof status.registrar === "string" && sameAddress(wallet, status.registrar)) return true;
    return false;
  }

  function parseDeadline(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }

  function deadlineOpen(deadline, seconds) {
    return deadline > seconds && deadline <= seconds + WINDOW_SECONDS;
  }

  function errorName(result) {
    const name = result && result.error && result.error.name;
    return typeof name === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
  }

  function sameKey(left, right) {
    return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
  }

  function storedHash(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
  }

  function mapSubmit(result, companyKey) {
    const state = result && result.state;
    if (state === "confirmed") {
      return { state: "confirmed", error: null, audit: true, hash: storedHash(result.hash), result: "bound" };
    }
    if (state === "pending") {
      return { state: "pending", error: null, audit: false, hash: storedHash(result.hash), result: "pending" };
    }
    if (state === "reverted") {
      return { state: "reverted", error: null, audit: false, hash: storedHash(result.hash), result: "reverted" };
    }
    const name = errorName(result);
    if (name === "WalletAlreadyBound") {
      const existing = result.error && Array.isArray(result.error.args) ? result.error.args[1] : null;
      if (sameKey(existing, companyKey)) {
        return { state: "confirmed", error: null, audit: true, hash: null, result: "bound" };
      }
      return { state: "refused", error: "WalletAlreadyBound", audit: false, hash: null, result: "other_company" };
    }
    return {
      state: "refused",
      error: name && ERROR_NAMES.has(name) ? name : null,
      audit: false,
      hash: null,
      result: "refused",
      code: name && ERROR_NAMES.has(name) ? name : null,
    };
  }

  function sendPage(res, auth, url) {
    const status = chainStatus();
    const ready = chainReady(status);
    const companyId = auth.identity.companyId;
    const companyKey = deps.records.companyKeyFor(companyId);
    const wallets = deps.records.walletsFor(companyId);
    const active = wallets.filter((entry) => entry && ACTIVE.has(entry.state));
    const inFlight = active.some((entry) => entry.state === "submitting" || entry.state === "pending");
    const atCap = active.length >= 5;
    let action = "none";
    if (ready && !companyKey) action = "prepare";
    else if (ready && inFlight) action = "check";
    else if (ready && !atCap) action = "sign";
    const seconds = nowSec();
    const deadline = String(seconds + PROPOSE_SECONDS);
    const domain = action === "sign"
      ? {
        name: "OceanRelay",
        version: "1",
        chainId: status.chainId,
        verifyingContract: status.address,
      }
      : null;
    let banner = noticeFor(url);
    if (!ready && !banner) banner = MESSAGES.unavailable;
    deps.sendHtml(res, 200, renderWallet({
      viewer: viewerFor(deps, auth),
      wallets,
      companyKey,
      chain: { ready, state: status.state },
      action,
      atCap: ready && atCap && !inFlight,
      banner,
      csrf: auth.session.csrf,
      domain,
      deadline,
      script: action === "sign" ? scriptHref : "",
    }), auth.cookies, {
      "Content-Security-Policy": CSP,
    });
  }

  async function handlePage(req, res, url) {
    const auth = gate(req, res);
    if (!auth) return;
    sendPage(res, auth, url);
  }

  async function handlePrepare(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    let form;
    try {
      form = await readForm(req);
    } catch {
      deps.sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!csrfOk(auth.session, form)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    if (!chainReady(chainStatus())) {
      seeOther(res, "unavailable", auth.cookies);
      return;
    }
    const created = deps.records.ensureCompanyKey(auth.identity.companyId);
    seeOther(res, created && created.ok ? "" : "unavailable", auth.cookies);
  }

  async function handleBind(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    let form;
    try {
      form = await readForm(req);
    } catch {
      deps.sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!csrfOk(auth.session, form)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const status = chainStatus();
    if (!chainReady(status)) {
      seeOther(res, "unavailable", auth.cookies);
      return;
    }
    const wallet = canonicalWallet(form.wallet);
    const deadline = parseDeadline(typeof form.deadline === "string" ? form.deadline : "");
    const signature = typeof form.signature === "string" ? form.signature : "";
    if (!wallet || reserved(wallet, status)) {
      seeOther(res, "reserved", auth.cookies);
      return;
    }
    if (deadline == null || !deadlineOpen(deadline, nowSec())) {
      seeOther(res, "deadline", auth.cookies);
      return;
    }
    const companyId = auth.identity.companyId;
    const companyKey = deps.records.companyKeyFor(companyId);
    if (!companyKey) {
      seeOther(res, "prepare_first", auth.cookies);
      return;
    }
    let recovered = null;
    try {
      recovered = deps.chain.typed.recover("Binding", { companyKey, wallet, deadline }, signature);
    } catch {
      recovered = null;
    }
    if (!recovered || !sameAddress(recovered, wallet)) {
      seeOther(res, "mismatch", auth.cookies);
      return;
    }
    const begun = deps.records.beginWalletBind(companyId, {
      wallet,
      boundBy: auth.identity.sub,
      deadline,
    });
    if (!begun.ok) {
      seeOther(res, begun.error === "cap" || begun.error === "in_flight" || begun.error === "already" ? begun.error : "unavailable", auth.cookies);
      return;
    }
    let registrarSig;
    try {
      registrarSig = deps.chain.registrarSign({ companyKey, wallet, deadline });
    } catch {
      // Nothing was sent. Leave the row terminal so the company can bind again.
      deps.records.finishWalletBind(companyId, wallet, {
        state: "refused",
        txHash: null,
        error: null,
        audit: false,
      });
      seeOther(res, "unavailable", auth.cookies);
      return;
    }
    let submitted;
    try {
      submitted = await deps.chain.submit("bindWallet", [companyKey, wallet, deadline, signature, registrarSig]);
    } catch {
      seeOther(res, "pending", auth.cookies);
      return;
    }
    const mapped = mapSubmit(submitted, companyKey);
    deps.records.finishWalletBind(companyId, wallet, {
      state: mapped.state,
      txHash: mapped.hash,
      error: mapped.error,
      audit: mapped.audit,
    });
    seeOther(res, mapped.result, auth.cookies, mapped.code);
  }

  async function handleCheck(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    let form;
    try {
      form = await readForm(req);
    } catch {
      deps.sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!csrfOk(auth.session, form)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    if (!chainReady(chainStatus())) {
      seeOther(res, "unavailable", auth.cookies);
      return;
    }
    const companyId = auth.identity.companyId;
    const companyKey = deps.records.companyKeyFor(companyId);
    const open = deps.records.walletsFor(companyId).filter((entry) => {
      return entry && (entry.state === "submitting" || entry.state === "pending");
    });
    if (!companyKey || open.length === 0) {
      seeOther(res, "", auth.cookies);
      return;
    }
    const seconds = nowSec();
    const updates = [];
    try {
      for (const entry of open) {
        const update = await resolveEntry(entry, companyKey, seconds);
        if (update) updates.push(update);
      }
    } catch {
      seeOther(res, "unavailable", auth.cookies);
      return;
    }
    if (updates.length > 0) deps.records.applyWalletChecks(companyId, updates);
    seeOther(res, checkResult(updates, open), auth.cookies);
  }

  async function resolveEntry(entry, companyKey, seconds) {
    const deadline = entry.deadline;
    const pastBuffer = Number.isInteger(deadline) && seconds > deadline + RECEIPT_BUFFER_SECONDS;
    const deadlinePassed = Number.isInteger(deadline) && seconds > deadline;
    if (storedHash(entry.txHash) && !pastBuffer) {
      const found = await deps.chain.receipt(entry.txHash);
      if (!found || found.state === "pending") return null;
      if (found.state === "confirmed") return { wallet: entry.wallet, state: "confirmed", audit: true, error: null };
      if (found.state === "reverted") return { wallet: entry.wallet, state: "reverted", error: null };
      return null;
    }
    const onChain = await deps.chain.call("walletCompany", [entry.wallet]);
    if (sameKey(onChain, companyKey)) return { wallet: entry.wallet, state: "confirmed", audit: true, error: null };
    if (deadlinePassed) return { wallet: entry.wallet, state: "expired", error: null };
    return null;
  }

  function checkResult(updates, open) {
    if (updates.some((update) => update.state === "confirmed")) return "bound";
    if (updates.some((update) => update.state === "expired")) return "expired";
    if (updates.some((update) => update.state === "reverted")) return "reverted";
    if (open.length > 0) return "unchanged";
    return "";
  }
}

module.exports = { register, CSP };
