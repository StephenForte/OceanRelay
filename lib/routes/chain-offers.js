"use strict";

const { checksumAddress, sameAddress, sameHex } = require("../chain/hex");
const { expiresAtOf, commitmentForVersion } = require("../commitment");
const { nextChainStep } = require("../records");
const { renderNotFound } = require("../views/offers");
const { viewerFor } = require("../views/layout");
const { renderChainOffer } = require("../views/chain-offers");
const { href: scriptHref } = require("../wallet-script");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const WINDOW_SECONDS = 15 * 60;
const PROPOSE_SECONDS = 10 * 60;
const RECEIPT_BUFFER_SECONDS = 120;
const KINDS = new Set(["publish", "version", "state"]);
const CHAIN_STATE = Object.freeze({ published: 1, paused: 2 });
const DOMAIN_FIELDS = Object.freeze([
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
]);
const TYPE_FIELDS = Object.freeze({
  Publish: Object.freeze([
    { name: "offerId", type: "bytes32" },
    { name: "commitment", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ]),
  Version: Object.freeze([
    { name: "offerId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "commitment", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ]),
  OfferState: Object.freeze([
    { name: "offerId", type: "bytes32" },
    { name: "state", type: "uint8" },
    { name: "seq", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ]),
});

const MESSAGES = Object.freeze({
  recorded: { kind: "success", text: "The chain recorded this action." },
  pending: { kind: "info", text: "The action is pending. It stays pending until you check it." },
  unchanged: { kind: "info", text: "The action is still pending." },
  reverted: { kind: "error", text: "The chain transaction reverted." },
  refused: { kind: "error", text: "The chain refused this action." },
  expired: { kind: "error", text: "The signature expired before the action was confirmed." },
  in_flight: { kind: "error", text: "A chain action is already in progress for this offer." },
  not_next: { kind: "error", text: "That is not the next chain action for this offer." },
  mismatch: { kind: "error", text: "The signature does not match this offer." },
  not_signer: { kind: "error", text: "That wallet cannot sign for this company." },
  deadline: { kind: "error", text: "That deadline is outside the 15-minute window." },
  unavailable: { kind: "error", text: "Recording on chain is unavailable." },
  blocked: { kind: "error", text: "This offer cannot be recorded." },
  not_draft: { kind: "error", text: "An offer that is already published is not put on chain." },
  need_wallet: { kind: "error", text: "Bind a confirmed wallet before recording this offer." },
  prepare_first: { kind: "error", text: "Prepare this offer before signing." },
});

function register(router, deps) {
  router.pattern("GET", /^\/chain\/offers\/([^/]+)$/, handlePage);
  router.pattern("POST", /^\/chain\/offers\/([^/]+)\/prepare$/, handlePrepare);
  router.pattern("POST", /^\/chain\/offers\/([^/]+)\/sign$/, handleSign);
  router.pattern("POST", /^\/chain\/offers\/([^/]+)\/check$/, handleCheck);

  function nowMs() {
    const clock = typeof deps.now === "function" ? Number(deps.now()) : Date.now();
    return Number.isFinite(clock) ? clock : Date.now();
  }

  function nowSec() {
    return Math.floor(nowMs() / 1000);
  }

  function todayUtc() {
    return new Date(nowMs()).toISOString().slice(0, 10);
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

  function pathId(match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function notFound(res, auth) {
    deps.sendHtml(res, 404, renderNotFound(), auth.cookies);
  }

  function seeOther(res, auth, id, result, code) {
    const params = new URLSearchParams();
    if (result) params.set("result", result);
    if (result === "refused" && code && /^[A-Z][A-Za-z0-9]{0,63}$/.test(code)) params.set("code", code);
    const query = params.toString();
    const target = `/chain/offers/${id}`;
    deps.redirect(res, query ? `${target}?${query}` : target, auth.cookies, 303);
  }

  function noticeFor(url) {
    const result = url.searchParams.get("result") || "";
    const code = url.searchParams.get("code") || "";
    if (result === "refused" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(code)) {
      return { kind: "error", text: `The chain refused this action (${code}).` };
    }
    return MESSAGES[result] || null;
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

  function storedHash(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
  }

  function confirmedSigner(companyId, address) {
    return deps.records.walletsFor(companyId).some((entry) => {
      return entry && entry.state === "confirmed" && sameAddress(entry.wallet, address);
    });
  }

  function versionOf(offer, n) {
    const versions = offer && Array.isArray(offer.versions) ? offer.versions : [];
    return versions.find((version) => version && version.n === n) || null;
  }

  function saltFor(offer, n) {
    const salts = offer && offer.chain && offer.chain.salts;
    const salt = salts && salts[String(n)];
    return typeof salt === "string" ? salt : null;
  }

  function builtMessage(offer, action, deadline) {
    const offerKey = offer.chain && offer.chain.offerKey;
    if (typeof offerKey !== "string") return null;
    if (action.kind === "publish" || action.kind === "version") {
      const n = action.kind === "publish" ? 1 : action.version;
      const version = versionOf(offer, n);
      const salt = saltFor(offer, n);
      if (!version || !salt) return null;
      let commitment;
      try {
        commitment = commitmentForVersion(offer.id, version, salt);
      } catch {
        return null;
      }
      const expiresAt = expiresAtOf(version.terms && version.terms.validityDeadline);
      if (expiresAt == null) return null;
      if (action.kind === "publish") {
        return { type: "Publish", message: { offerId: offerKey, commitment, expiresAt, deadline } };
      }
      return {
        type: "Version",
        message: { offerId: offerKey, version: n, commitment, expiresAt, deadline },
      };
    }
    if (action.kind === "state") {
      const state = CHAIN_STATE[action.to];
      if (!state || !Number.isInteger(action.seq)) return null;
      return { type: "OfferState", message: { offerId: offerKey, state, seq: action.seq, deadline } };
    }
    return null;
  }

  function typedData(domain, built) {
    return {
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        [built.type]: TYPE_FIELDS[built.type],
      },
      primaryType: built.type,
      domain,
      message: built.message,
    };
  }

  function mapSubmit(result) {
    const state = result && result.state;
    const hash = storedHash(result && result.hash);
    if (state === "confirmed") return { state: "confirmed", error: null, hash, result: "recorded" };
    if (state === "pending") return { state: "pending", error: null, hash, result: "pending" };
    if (state === "reverted") return { state: "reverted", error: null, hash, result: "reverted" };
    const name = errorName(result);
    return { state: "refused", error: name, hash: null, result: "refused", code: name };
  }

  function hasConfirmedWallet(companyId) {
    return deps.records.walletsFor(companyId).some((entry) => entry && entry.state === "confirmed");
  }

  function saltReady(offer, action) {
    if (!action) return false;
    if (action.kind === "publish") return Boolean(saltFor(offer, 1));
    if (action.kind === "version") return Boolean(saltFor(offer, action.version));
    return true;
  }

  function pageModel(offer, status, seconds) {
    const ready = chainReady(status);
    const today = todayUtc();
    const companyId = offer.companyId;
    let step = "none";
    let blocked = false;
    let expire = false;
    let next = null;
    if (!ready) step = "unavailable";
    else if (!hasConfirmedWallet(companyId)) step = "need_wallet";
    else if (!offer.chain) {
      const version = versionOf(offer, 1);
      const expiresAt = expiresAtOf(version && version.terms && version.terms.validityDeadline);
      if (offer.state !== "draft") step = "closed";
      else if (expiresAt == null || expiresAt <= seconds) blocked = true;
      else step = "prepare";
    } else {
      next = nextChainStep(offer, today, seconds);
      if (next.step === "sign" && !saltReady(offer, next.action)) step = "prepare";
      else if (next.step === "sign") step = "sign";
      else if (next.step === "check") {
        step = "check";
        expire = next.expire === true;
      } else if (next.step === "blocked") blocked = true;
      else if (next.step === "prepare") step = "prepare";
    }
    const deadline = seconds + PROPOSE_SECONDS;
    const domain = step === "sign"
      ? {
        name: "OceanRelay",
        version: "1",
        chainId: status.chainId,
        verifyingContract: status.address,
      }
      : null;
    const built = step === "sign" ? builtMessage(offer, next.action, deadline) : null;
    if (step === "sign" && !built) step = "none";
    return {
      step,
      blocked,
      expire,
      next,
      domain: step === "sign" ? domain : null,
      typed: step === "sign" && built && domain ? typedData(domain, built) : null,
      kind: next && next.action ? next.action.kind : "",
      deadline,
    };
  }

  function sendPage(res, auth, url, offer) {
    const status = chainStatus();
    const model = pageModel(offer, status, nowSec());
    let banner = noticeFor(url);
    if (model.step === "unavailable" && !banner) banner = MESSAGES.unavailable;
    if (model.blocked && !banner) banner = MESSAGES.blocked;
    deps.sendHtml(res, 200, renderChainOffer({
      viewer: viewerFor(deps, auth),
      offerId: offer.id,
      chain: offer.chain || null,
      chainStatus: { ready: chainReady(status), state: status.state },
      step: model.step,
      blocked: model.blocked,
      expire: model.expire,
      banner,
      csrf: auth.session.csrf,
      domain: model.domain,
      typed: model.typed,
      kind: model.kind,
      version: model.next && model.next.action ? model.next.action.version : "",
      deadline: model.deadline,
      script: model.step === "sign" && model.typed ? scriptHref : "",
    }), auth.cookies, {
      "Content-Security-Policy": CSP,
    });
  }

  function handlePage(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const offer = deps.records.getCompanyOffer(auth.identity.companyId, pathId(match));
    if (!offer) {
      notFound(res, auth);
      return;
    }
    sendPage(res, auth, url, offer);
  }

  async function handlePrepare(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const id = pathId(match);
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
    const offer = deps.records.getCompanyOffer(auth.identity.companyId, id);
    if (!offer) {
      notFound(res, auth);
      return;
    }
    if (!chainReady(chainStatus())) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    if (!hasConfirmedWallet(auth.identity.companyId)) {
      seeOther(res, auth, id, "need_wallet");
      return;
    }
    const seconds = nowSec();
    const today = todayUtc();
    const version = versionOf(offer, 1);
    const expiresAt = expiresAtOf(version && version.terms && version.terms.validityDeadline);
    if (!offer.chain && (offer.state !== "draft" || expiresAt == null || expiresAt <= seconds)) {
      seeOther(res, auth, id, offer.state === "draft" ? "blocked" : "not_draft");
      return;
    }
    if (offer.chain && nextChainStep(offer, today, seconds).step === "blocked") {
      seeOther(res, auth, id, "blocked");
      return;
    }
    const prepared = deps.records.prepareChainOffer(auth.identity.companyId, id, auth.identity.sub);
    seeOther(res, auth, id, prepared && prepared.ok ? "" : "unavailable");
  }

  async function handleSign(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const id = pathId(match);
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
    const companyId = auth.identity.companyId;
    const offer = deps.records.getCompanyOffer(companyId, id);
    if (!offer) {
      notFound(res, auth);
      return;
    }
    const status = chainStatus();
    if (!chainReady(status)) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    const seconds = nowSec();
    const deadline = parseDeadline(typeof form.deadline === "string" ? form.deadline : "");
    if (deadline == null || !deadlineOpen(deadline, seconds)) {
      seeOther(res, auth, id, "deadline");
      return;
    }
    const postedKind = typeof form.kind === "string" ? form.kind : "";
    if (!KINDS.has(postedKind)) {
      seeOther(res, auth, id, "not_next");
      return;
    }
    const today = todayUtc();
    const next = offer.chain ? nextChainStep(offer, today, seconds) : { step: "prepare" };
    if (!next || next.step !== "sign" || !next.action || next.action.kind !== postedKind) {
      const inFlight = Boolean(next && next.step === "check" && next.expire !== true);
      seeOther(res, auth, id, inFlight ? "in_flight" : (next && next.step === "blocked" ? "blocked" : "not_next"));
      return;
    }
    const built = builtMessage(offer, next.action, deadline);
    if (!built) {
      seeOther(res, auth, id, "prepare_first");
      return;
    }
    const signature = typeof form.signature === "string" ? form.signature : "";
    let recovered = null;
    try {
      recovered = deps.chain.typed.recover(built.type, built.message, signature);
    } catch {
      recovered = null;
    }
    if (!recovered) {
      seeOther(res, auth, id, "mismatch");
      return;
    }
    let signer;
    try {
      signer = checksumAddress(recovered);
    } catch {
      seeOther(res, auth, id, "mismatch");
      return;
    }
    if (typeof status.relayer === "string" && sameAddress(signer, status.relayer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    if (!confirmedSigner(companyId, signer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const begun = deps.records.beginChainAction(companyId, id, {
      kind: next.action.kind,
      version: next.action.version,
      to: next.action.to,
      seq: next.action.seq,
      signer,
      deadline,
      actorSub: auth.identity.sub,
    }, today, seconds);
    if (!begun.ok) {
      const code = begun.error === "in_flight" || begun.error === "not_next" ? begun.error : "unavailable";
      seeOther(res, auth, id, code === "unavailable" && begun.error === "deadline_passed" ? "blocked" : code);
      return;
    }
    const args = submitArgs(built, signature);
    let submitted;
    try {
      submitted = await deps.chain.submit(submitName(built.type), args);
    } catch {
      seeOther(res, auth, id, "pending");
      return;
    }
    const mapped = mapSubmit(submitted);
    const finished = deps.records.finishChainAction(companyId, id, begun.action.id, {
      state: mapped.state,
      txHash: mapped.hash,
      error: mapped.error,
      actorSub: auth.identity.sub,
    });
    if (!finished.ok) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    seeOther(res, auth, id, mapped.result, mapped.code);
  }

  async function handleCheck(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const id = pathId(match);
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
    const companyId = auth.identity.companyId;
    const offer = deps.records.getCompanyOffer(companyId, id);
    if (!offer) {
      notFound(res, auth);
      return;
    }
    if (!chainReady(chainStatus())) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    const seconds = nowSec();
    const today = todayUtc();
    const open = offer.chain && Array.isArray(offer.chain.actions)
      ? offer.chain.actions.filter((action) => action && (action.status === "submitting" || action.status === "pending"))
      : [];
    const companyKey = deps.records.companyKeyFor(companyId);
    const updates = [];
    try {
      for (const action of open) {
        const update = await resolveAction(offer, action, seconds, companyKey);
        if (update) updates.push({ ...update, actorSub: auth.identity.sub });
      }
    } catch {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    if (updates.length > 0) deps.records.applyChainChecks(companyId, id, updates);
    if (open.length === 0) {
      const expired = await recordExpiry(auth, companyId, id, today, seconds);
      if (expired) {
        seeOther(res, auth, id, expired);
        return;
      }
    }
    seeOther(res, auth, id, checkResult(updates, open));
  }

  async function recordExpiry(auth, companyId, id, today, seconds) {
    const current = deps.records.getCompanyOffer(companyId, id);
    if (!current || !current.chain) return "";
    const next = nextChainStep(current, today, seconds);
    if (!next || next.expire !== true) return "";
    const begun = deps.records.beginChainExpire(companyId, id, today, seconds);
    if (!begun.ok) return "";
    let submitted;
    try {
      submitted = await deps.chain.submit("markExpired", [current.chain.offerKey]);
    } catch {
      return "pending";
    }
    const mapped = mapSubmit(submitted);
    deps.records.finishChainAction(companyId, id, begun.action.id, {
      state: mapped.state,
      txHash: mapped.hash,
      error: mapped.error,
      actorSub: auth.identity.sub,
    });
    return mapped.result;
  }

  async function resolveAction(offer, action, seconds, companyKey) {
    if (action.kind === "expire") {
      const hash = storedHash(action.txHash);
      if (hash) {
        const found = await deps.chain.receipt(action.txHash);
        if (found && found.state === "confirmed") return { id: action.id, state: "confirmed", error: null };
        if (found && found.state === "reverted") return { id: action.id, state: "reverted", error: null };
      }
      try {
        const onChain = await deps.chain.call("getOffer", [offer.chain.offerKey]);
        if (landed(onChain, action, offer, companyKey)) return { id: action.id, state: "confirmed", error: null };
      } catch {
        return null;
      }
      const created = Date.parse(action.createdAt || "");
      if (Number.isFinite(created) && seconds > Math.floor(created / 1000) + RECEIPT_BUFFER_SECONDS) {
        return { id: action.id, state: "expired", error: null };
      }
      return null;
    }
    const deadline = action.deadline;
    const pastBuffer = Number.isInteger(deadline) && seconds > deadline + RECEIPT_BUFFER_SECONDS;
    const deadlinePassed = Number.isInteger(deadline) && seconds > deadline;
    if (storedHash(action.txHash) && !pastBuffer) {
      const found = await deps.chain.receipt(action.txHash);
      if (!found || found.state === "pending") return null;
      if (found.state === "confirmed") return { id: action.id, state: "confirmed", error: null };
      if (found.state === "reverted") return { id: action.id, state: "reverted", error: null };
      return null;
    }
    const onChain = await deps.chain.call("getOffer", [offer.chain.offerKey]);
    if (landed(onChain, action, offer, companyKey)) return { id: action.id, state: "confirmed", error: null };
    if (deadlinePassed) return { id: action.id, state: "expired", error: null };
    return null;
  }

  function landed(onChain, action, offer, companyKey) {
    if (!Array.isArray(onChain) || onChain.length < 6) return false;
    const [key, version, stateSeq, state, , commitment] = onChain;
    if (typeof companyKey !== "string" || !sameHex(key, companyKey)) return false;
    if (action.kind === "publish") {
      const expected = deps.records.commitmentFor(offer.id, 1);
      return version === 1 && state === 1 && sameHex(commitment, expected);
    }
    if (action.kind === "version") {
      const expected = deps.records.commitmentFor(offer.id, action.version);
      return version === action.version && sameHex(commitment, expected);
    }
    if (action.kind === "state") {
      const want = action.to === "paused" ? 2 : 1;
      return state === want && stateSeq === action.seq + 1;
    }
    if (action.kind === "expire") return state === 4;
    return false;
  }

  function checkResult(updates, open) {
    if (updates.some((update) => update.state === "confirmed")) return "recorded";
    if (updates.some((update) => update.state === "expired")) return "expired";
    if (updates.some((update) => update.state === "reverted")) return "reverted";
    if (open.length > 0) return "unchanged";
    return "";
  }
}

function submitName(type) {
  if (type === "Publish") return "publishOffer";
  if (type === "Version") return "publishVersion";
  if (type === "OfferState") return "setOfferState";
  return "";
}

function submitArgs(built, signature) {
  const message = built.message;
  if (built.type === "Publish") {
    return [message.offerId, message.commitment, message.expiresAt, message.deadline, signature];
  }
  if (built.type === "Version") {
    return [message.offerId, message.version, message.commitment, message.expiresAt, message.deadline, signature];
  }
  return [message.offerId, message.state, message.seq, message.deadline, signature];
}

module.exports = { register, CSP };
