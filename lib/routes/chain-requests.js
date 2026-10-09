"use strict";

const { checksumAddress, sameAddress, sameHex } = require("../chain/hex");
const { expiresAtOf, commitmentFromTermsHash } = require("../commitment");
const { renderNotFound } = require("../views/requests");
const { viewerFor } = require("../views/layout");
const { renderChainRequest } = require("../views/chain-requests");
const { href: scriptHref } = require("../wallet-script");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const WINDOW_SECONDS = 15 * 60;
const PROPOSE_SECONDS = 10 * 60;
const PROPOSAL_SECONDS = 14 * 24 * 60 * 60;
const CANCEL_SECONDS = 7 * 24 * 60 * 60;
const RECEIPT_BUFFER_SECONDS = 120;
const KINDS = new Set(["request", "proposal", "accept", "status", "cancellation"]);
const CHAIN_STATUS = Object.freeze({
  carrier_pending: 3,
  carrier_confirmed: 4,
  rejected: 5,
  rolled: 6,
  completed: 7,
  cancelled: 8,
});
const DOMAIN_FIELDS = Object.freeze([
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
]);
const TYPE_FIELDS = Object.freeze({
  Request: Object.freeze([
    { name: "requestId", type: "bytes32" },
    { name: "offerId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ]),
  Acceptance: Object.freeze([
    { name: "requestId", type: "bytes32" },
    { name: "counter", type: "uint32" },
    { name: "termsCommitment", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ]),
  Status: Object.freeze([
    { name: "requestId", type: "bytes32" },
    { name: "status", type: "uint8" },
    { name: "seq", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ]),
  Cancellation: Object.freeze([
    { name: "requestId", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ]),
});

const MESSAGES = Object.freeze({
  recorded: { kind: "success", text: "The chain recorded this action." },
  proposed: { kind: "success", text: "The signature is stored. The other company can sign." },
  pending: { kind: "info", text: "The action is pending. It stays pending until you check it." },
  unchanged: { kind: "info", text: "The action is still pending." },
  reverted: { kind: "error", text: "The chain transaction reverted." },
  refused: { kind: "error", text: "The chain refused this action." },
  expired: { kind: "error", text: "The signature expired before the action was confirmed." },
  in_flight: { kind: "error", text: "A chain action is already in progress for this request." },
  not_next: { kind: "error", text: "That is not the next chain action for this request." },
  mismatch: { kind: "error", text: "The signature does not match this request." },
  not_signer: { kind: "error", text: "That wallet cannot sign for this company." },
  deadline: { kind: "error", text: "That deadline is outside the signing window." },
  unavailable: { kind: "error", text: "Recording on chain is unavailable." },
  blocked: { kind: "error", text: "This acceptance cannot be recorded." },
  paused: { kind: "error", text: "The seller must first record the offer's state." },
  offer_inflight: { kind: "error", text: "The offer has a chain action in progress." },
  unlinked: { kind: "error", text: "This request is not linked on chain yet." },
  expired_proposal: { kind: "error", text: "That proposal has expired." },
  terms: { kind: "error", text: "Those terms do not match the proposal." },
  need_wallet: { kind: "error", text: "Bind a confirmed wallet before recording this request." },
  prepare_first: { kind: "error", text: "Prepare this request before signing." },
  final: { kind: "error", text: "This request is already closed." },
  unavailable_qty: { kind: "error", text: "That quantity is no longer available in OceanRelay." },
  superseded: { kind: "error", text: "This offer changed. The request is superseded and cannot be accepted." },
});

const BLOCKED_TEXT = Object.freeze({
  stale: "This acceptance cannot be recorded.",
  blocked: "This acceptance cannot be recorded.",
  paused: "The seller must first record the offer's state.",
  offer_inflight: "The offer has a chain action in progress.",
  unlinked_offer: "This request cannot be linked until the seller records this version on chain.",
  not_published: "This request cannot be linked until the seller records this version on chain.",
  missing: "This request cannot be linked until the seller records this version on chain.",
});

function register(router, deps) {
  router.pattern("GET", /^\/chain\/requests\/([^/]+)$/, handlePage);
  router.pattern("POST", /^\/chain\/requests\/([^/]+)\/prepare$/, handlePrepare);
  router.pattern("POST", /^\/chain\/requests\/([^/]+)\/sign$/, handleSign);
  router.pattern("POST", /^\/chain\/requests\/([^/]+)\/check$/, handleCheck);

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
    const target = `/chain/requests/${id}`;
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

  function hasConfirmedWallet(companyId) {
    return deps.records.walletsFor(companyId).some((entry) => entry && entry.state === "confirmed");
  }

  function load(companyId, requestId) {
    return deps.records.view((draft) => {
      const request = draft.requests && draft.requests[requestId];
      if (!request) return null;
      if (request.buyerCompanyId !== companyId && request.sellerCompanyId !== companyId) return null;
      const offer = draft.offers[request.offerId] || null;
      return {
        request: structuredClone(request),
        offer: offer ? structuredClone(offer) : null,
      };
    });
  }

  function counterKey(request) {
    if (request.state === "accepted" && request.acceptance && request.acceptance.counter != null) {
      return String(request.acceptance.counter);
    }
    if (request.state === "countered" && Array.isArray(request.counters) && request.counters.length) {
      const latest = request.counters[request.counters.length - 1];
      if (latest && Number.isInteger(latest.n) && latest.n > 0) return String(latest.n);
    }
    return "0";
  }

  function proposalFor(request) {
    const proposals = request.chain && request.chain.proposals;
    const proposal = proposals && proposals[counterKey(request)];
    return proposal && typeof proposal === "object" ? proposal : null;
  }

  function versionOf(offer, n) {
    const versions = offer && Array.isArray(offer.versions) ? offer.versions : [];
    return versions.find((version) => version && version.n === n) || null;
  }

  function proposalCap(offer, request, seconds) {
    const version = versionOf(offer, request.version);
    const expiresAt = expiresAtOf(version && version.terms && version.terms.validityDeadline);
    if (expiresAt == null) return null;
    return Math.min(expiresAt, seconds + PROPOSAL_SECONDS);
  }

  function saltFor(request) {
    const salts = request.chain && request.chain.salts;
    const salt = salts && salts[counterKey(request)];
    return typeof salt === "string" ? salt : null;
  }

  function offerInFlight(offer) {
    const actions = offer && offer.chain && Array.isArray(offer.chain.actions) ? offer.chain.actions : [];
    return actions.some((action) => action && (action.status === "submitting" || action.status === "pending"));
  }

  function acceptanceMessage(request, deadline) {
    const proposal = proposalFor(request);
    const termsHash = proposal && proposal.termsHash;
    const salt = saltFor(request);
    const requestKey = request.chain && request.chain.requestKey;
    if (typeof requestKey !== "string" || typeof termsHash !== "string" || !salt) return null;
    let commitment;
    try {
      commitment = commitmentFromTermsHash(termsHash, salt);
    } catch {
      return null;
    }
    return {
      type: "Acceptance",
      message: {
        requestId: requestKey,
        counter: Number(counterKey(request)),
        termsCommitment: commitment,
        deadline,
      },
    };
  }

  function builtFor(loaded, step, deadline) {
    const { request, offer } = loaded;
    const requestKey = request.chain && request.chain.requestKey;
    const offerKey = offer && offer.chain && offer.chain.offerKey;
    if (step.kind === "request") {
      if (typeof requestKey !== "string" || typeof offerKey !== "string") return null;
      return {
        type: "Request",
        message: { requestId: requestKey, offerId: offerKey, version: request.version, deadline },
      };
    }
    if (step.kind === "proposal") {
      const hashed = deps.records.acceptanceTermsHash(request.id, todayUtc());
      const salt = saltFor(request);
      if (!hashed.ok || typeof requestKey !== "string" || !salt) return null;
      let commitment;
      try {
        commitment = commitmentFromTermsHash(hashed.termsHash, salt);
      } catch {
        return null;
      }
      return {
        type: "Acceptance",
        message: {
          requestId: requestKey,
          counter: Number(counterKey(request)),
          termsCommitment: commitment,
          deadline,
        },
        termsHash: hashed.termsHash,
      };
    }
    if (step.kind === "accept") {
      const proposal = proposalFor(request);
      if (!proposal) return null;
      return acceptanceMessage(request, proposal.deadline);
    }
    if (step.kind === "status") {
      const status = CHAIN_STATUS[step.status];
      if (!status || typeof requestKey !== "string" || !Number.isInteger(step.seq)) return null;
      return {
        type: "Status",
        message: { requestId: requestKey, status, seq: step.seq, deadline },
      };
    }
    if (step.kind === "cancellation") {
      if (typeof requestKey !== "string") return null;
      const stored = request.chain && request.chain.cancelProposal;
      const when = step.leg === "second" && stored ? stored.deadline : deadline;
      return { type: "Cancellation", message: { requestId: requestKey, deadline: when } };
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

  function recover(type, message, signature) {
    try {
      const recovered = deps.chain.typed.recover(type, message, signature);
      if (!recovered) return null;
      return checksumAddress(recovered);
    } catch {
      return null;
    }
  }

  function deadlineFor(kind, step, posted, loaded, seconds) {
    if (kind === "accept") {
      const proposal = proposalFor(loaded.request);
      return proposal && Number.isInteger(proposal.deadline) ? proposal.deadline : null;
    }
    if (kind === "cancellation" && step && step.leg === "second") {
      const stored = loaded.request.chain && loaded.request.chain.cancelProposal;
      return stored && Number.isInteger(stored.deadline) ? stored.deadline : null;
    }
    if (posted == null || posted <= seconds) return null;
    if (kind === "request" || kind === "status") {
      return posted <= seconds + WINDOW_SECONDS ? posted : null;
    }
    if (kind === "proposal") {
      const cap = proposalCap(loaded.offer, loaded.request, seconds);
      if (cap == null || posted > cap) return null;
      return posted;
    }
    if (kind === "cancellation") {
      return posted <= seconds + CANCEL_SECONDS ? posted : null;
    }
    return null;
  }

  function proposedDeadline(step, loaded, seconds) {
    if (!step || step.step !== "sign") return seconds + PROPOSE_SECONDS;
    if (step.kind === "proposal") return proposalCap(loaded.offer, loaded.request, seconds);
    if (step.kind === "accept" || (step.kind === "cancellation" && step.leg === "second")) return step.deadline;
    if (step.kind === "cancellation") return seconds + CANCEL_SECONDS;
    return seconds + PROPOSE_SECONDS;
  }

  function pageModel(loaded, status, seconds) {
    const ready = chainReady(status);
    const viewerId = status.viewerId;
    let step = deps.records.requestChainStep(viewerId, loaded.request.id, seconds);
    if (!step) step = { step: "none" };
    if (!ready) step = { step: "unavailable" };
    else if (step.step === "sign" || step.step === "prepare") {
      if (!hasConfirmedWallet(viewerId)) step = { step: "need_wallet" };
    }
    const deadline = proposedDeadline(step, loaded, seconds);
    const domain = step.step === "sign"
      ? {
        name: "OceanRelay",
        version: "1",
        chainId: status.chainId,
        verifyingContract: status.address,
      }
      : null;
    const built = step.step === "sign" && deadline != null ? builtFor(loaded, step, deadline) : null;
    if (step.step === "sign" && !built) step = { step: "blocked", reason: "blocked" };
    return {
      step: step.step,
      kind: step.kind || "",
      retry: step.retry === true,
      reason: step.reason || "",
      domain: step.step === "sign" ? domain : null,
      typed: step.step === "sign" && built && domain ? typedData(domain, built) : null,
      deadline,
    };
  }

  function sendPage(res, auth, url, loaded) {
    const status = chainStatus();
    const model = pageModel(loaded, { ...status, viewerId: auth.identity.companyId }, nowSec());
    let banner = noticeFor(url);
    if (model.step === "unavailable" && !banner) banner = MESSAGES.unavailable;
    deps.sendHtml(res, 200, renderChainRequest({
      viewer: viewerFor(deps, auth),
      requestId: loaded.request.id,
      chain: deps.records.chainRequestFor(loaded.request.id),
      chainStatus: { ready: chainReady(status), state: status.state },
      step: model.step,
      kind: model.kind,
      retry: model.retry,
      blockedText: BLOCKED_TEXT[model.reason] || BLOCKED_TEXT.blocked,
      banner,
      csrf: auth.session.csrf,
      domain: model.domain,
      typed: model.typed,
      deadline: model.deadline,
      script: model.step === "sign" && model.typed ? scriptHref : "",
    }), auth.cookies, {
      "Content-Security-Policy": CSP,
    });
  }

  function handlePage(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const loaded = load(auth.identity.companyId, pathId(match));
    if (!loaded) {
      notFound(res, auth);
      return;
    }
    sendPage(res, auth, url, loaded);
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
    const loaded = load(auth.identity.companyId, id);
    if (!loaded) {
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
    const step = deps.records.requestChainStep(auth.identity.companyId, id, nowSec());
    if (!step || step.step !== "prepare") {
      seeOther(res, auth, id, step && step.step === "blocked" ? "blocked" : "not_next");
      return;
    }
    const prepared = deps.records.prepareChainRequest(auth.identity.companyId, id, auth.identity.sub);
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
    const loaded = load(companyId, id);
    if (!loaded) {
      notFound(res, auth);
      return;
    }
    const status = chainStatus();
    if (!chainReady(status)) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    const seconds = nowSec();
    const today = todayUtc();
    const postedKind = typeof form.kind === "string" ? form.kind : "";
    if (!KINDS.has(postedKind)) {
      seeOther(res, auth, id, "not_next");
      return;
    }
    if (postedKind === "request" && companyId !== loaded.request.buyerCompanyId) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    if (postedKind === "proposal") {
      const counter = Number(counterKey(loaded.request));
      const proposer = counter === 0 ? loaded.request.buyerCompanyId : loaded.request.sellerCompanyId;
      if (companyId !== proposer) {
        seeOther(res, auth, id, "not_signer");
        return;
      }
    }
    const step = deps.records.requestChainStep(companyId, id, seconds) || { step: "none" };
    if (step.step === "check") {
      seeOther(res, auth, id, "in_flight");
      return;
    }
    if (step.step === "blocked") {
      const reason = step.reason === "paused" || step.reason === "offer_inflight" ? step.reason : "blocked";
      seeOther(res, auth, id, reason);
      return;
    }
    if (postedKind === "accept") {
      const linked = loaded.request.chain && loaded.request.chain.confirmed && loaded.request.chain.confirmed.recorded === true;
      if (!linked) {
        seeOther(res, auth, id, "unlinked");
        return;
      }
      const proposal = proposalFor(loaded.request);
      if (!proposal || !Number.isInteger(proposal.deadline) || proposal.deadline <= seconds) {
        seeOther(res, auth, id, "expired_proposal");
        return;
      }
    }
    if (step.step !== "sign" || step.kind !== postedKind) {
      seeOther(res, auth, id, "not_next");
      return;
    }
    const postedDeadline = parseDeadline(typeof form.deadline === "string" ? form.deadline : "");
    const deadline = deadlineFor(postedKind, step, postedDeadline, loaded, seconds);
    if (deadline == null) {
      seeOther(res, auth, id, "deadline");
      return;
    }
    const built = builtFor(loaded, step, deadline);
    if (!built) {
      seeOther(res, auth, id, "prepare_first");
      return;
    }
    const signer = recover(built.type, built.message, typeof form.signature === "string" ? form.signature : "");
    if (!signer) {
      seeOther(res, auth, id, "mismatch");
      return;
    }
    if (typeof status.relayer === "string" && sameAddress(signer, status.relayer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const signature = typeof form.signature === "string" ? form.signature : "";
    if (postedKind === "proposal") {
      await signProposal(res, auth, loaded, built, signer, deadline, signature, seconds);
      return;
    }
    if (postedKind === "accept") {
      await signAccept(res, auth, loaded, built, signer, signature, seconds, today, status);
      return;
    }
    if (postedKind === "cancellation" && step.leg !== "second") {
      await signCancellationFirst(res, auth, loaded, signer, deadline, signature, seconds);
      return;
    }
    if (postedKind === "cancellation") {
      await signCancellationSecond(res, auth, loaded, signer, signature, seconds);
      return;
    }
    if (postedKind === "request") {
      if (!confirmedSigner(loaded.request.buyerCompanyId, signer)) {
        seeOther(res, auth, id, "not_signer");
        return;
      }
      const begun = deps.records.beginChainRequest(companyId, id, { signer, deadline });
      if (!begun.ok) {
        seeOther(res, auth, id, begun.error === "in_flight" ? "in_flight" : "not_next");
        return;
      }
      await submitAndFinish(res, auth, id, begun.action.id, "recordRequest", [
        built.message.requestId,
        built.message.offerId,
        built.message.version,
        built.message.deadline,
        signature,
      ]);
      return;
    }
    if (!confirmedSigner(companyId, signer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const begun = deps.records.beginChainStatus(companyId, id, {
      signer,
      deadline,
      status: step.status,
      seq: step.seq,
    });
    if (!begun.ok) {
      seeOther(res, auth, id, begun.error === "in_flight" ? "in_flight" : "not_next");
      return;
    }
    await submitAndFinish(res, auth, id, begun.action.id, "recordStatus", [
      built.message.requestId,
      built.message.status,
      built.message.seq,
      built.message.deadline,
      signature,
    ]);
  }

  async function signProposal(res, auth, loaded, built, signer, deadline, signature, seconds) {
    const request = loaded.request;
    const id = request.id;
    const counter = Number(counterKey(request));
    const proposer = counter === 0 ? request.buyerCompanyId : request.sellerCompanyId;
    if (auth.identity.companyId !== proposer || !confirmedSigner(proposer, signer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const hashed = deps.records.acceptanceTermsHash(id, todayUtc());
    if (!hashed.ok || hashed.termsHash !== built.termsHash) {
      seeOther(res, auth, id, "terms");
      return;
    }
    const stored = deps.records.storeChainProposal(auth.identity.companyId, id, {
      signer,
      deadline,
      signature,
      termsHash: hashed.termsHash,
      nowSec: seconds,
    });
    seeOther(res, auth, id, stored.ok ? "proposed" : (stored.error === "in_flight" ? "in_flight" : "not_next"));
  }

  async function signAccept(res, auth, loaded, built, signer, signature, seconds, today, status) {
    const request = loaded.request;
    const offer = loaded.offer;
    const id = request.id;
    const companyId = auth.identity.companyId;
    const guard = acceptanceGuard(loaded, signer, seconds, today, built);
    if (guard) {
      seeOther(res, auth, id, guard);
      return;
    }
    void offer;
    void status;
    const begun = deps.records.beginChainAcceptance(auth.identity, id, today, { signer, nowSec: seconds });
    if (!begun.ok) {
      const code = begun.error === "unavailable" ? "unavailable_qty" : begun.error;
      seeOther(res, auth, id, MESSAGES[code] ? code : "not_next");
      return;
    }
    const after = load(companyId, id);
    const storedHash = after && after.request.acceptance && after.request.acceptance.termsHash;
    const proposal = after && proposalFor(after.request);
    if (!after || storedHash !== begun.termsHash || !proposal || proposal.termsHash !== storedHash) {
      deps.records.finishChainRequest(companyId, id, begun.action.id, {
        state: "refused",
        txHash: null,
        error: null,
        actorSub: auth.identity.sub,
      });
      seeOther(res, auth, id, "terms");
      return;
    }
    await submitAndFinish(res, auth, id, begun.action.id, "recordAcceptance", [
      built.message.requestId,
      built.message.counter,
      built.message.termsCommitment,
      begun.deadline,
      begun.signature,
      signature,
    ]);
  }

  function acceptanceGuard(loaded, signer, seconds, today, built) {
    const { request, offer } = loaded;
    const confirmed = offer && offer.chain && offer.chain.confirmed;
    if (!request.chain || !request.chain.confirmed || request.chain.confirmed.recorded !== true) return "unlinked";
    if (request.chain.confirmed.status || request.chain.confirmed.cancelled) return "not_next";
    const actions = Array.isArray(request.chain.actions) ? request.chain.actions : [];
    if (actions.some((action) => action && (action.status === "submitting" || action.status === "pending"))) {
      return "in_flight";
    }
    if (!confirmed || confirmed.version !== request.version) return "blocked";
    if (offerInFlight(offer)) return "offer_inflight";
    if (confirmed.state === "paused") return "paused";
    if (confirmed.state !== "published") return "blocked";
    const proposal = proposalFor(request);
    if (!proposal || !Number.isInteger(proposal.deadline) || proposal.deadline <= seconds) return "expired_proposal";
    const hashed = deps.records.acceptanceTermsHash(request.id, today);
    if (!hashed.ok) return hashed.error === "unavailable" ? "unavailable_qty" : "terms";
    if (hashed.termsHash !== proposal.termsHash) return "terms";
    const counter = Number(counterKey(request));
    const proposer = counter === 0 ? request.buyerCompanyId : request.sellerCompanyId;
    const accepter = proposer === request.buyerCompanyId ? request.sellerCompanyId : request.buyerCompanyId;
    if (!confirmedSigner(proposer, proposal.signer)) return "not_signer";
    if (!confirmedSigner(accepter, signer)) return "not_signer";
    if (loaded.request.buyerCompanyId !== accepter && loaded.request.sellerCompanyId !== accepter) return "not_signer";
    const again = recover("Acceptance", built.message, proposal.signature);
    if (!again || !sameAddress(again, proposal.signer)) return "mismatch";
    return "";
  }

  async function signCancellationFirst(res, auth, loaded, signer, deadline, signature, seconds) {
    const id = loaded.request.id;
    if (!confirmedSigner(auth.identity.companyId, signer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const stored = deps.records.storeChainCancellation(auth.identity.companyId, id, {
      signer,
      deadline,
      signature,
      nowSec: seconds,
    });
    seeOther(res, auth, id, stored.ok ? "proposed" : (stored.error === "in_flight" ? "in_flight" : "not_next"));
  }

  async function signCancellationSecond(res, auth, loaded, signer, signature, seconds) {
    const id = loaded.request.id;
    const companyId = auth.identity.companyId;
    if (!confirmedSigner(companyId, signer)) {
      seeOther(res, auth, id, "not_signer");
      return;
    }
    const begun = deps.records.beginChainCancellation(companyId, id, { signer, nowSec: seconds });
    if (!begun.ok) {
      const code = begun.error === "expired_proposal" || begun.error === "in_flight" ? begun.error : "not_next";
      seeOther(res, auth, id, code);
      return;
    }
    await submitAndFinish(res, auth, id, begun.action.id, "recordCancellation", [
      loaded.request.chain.requestKey,
      begun.deadline,
      begun.signature,
      signature,
    ]);
  }

  async function submitAndFinish(res, auth, id, actionId, name, args) {
    let submitted;
    try {
      submitted = await deps.chain.submit(name, args);
    } catch {
      seeOther(res, auth, id, "pending");
      return;
    }
    const mapped = mapSubmit(submitted);
    const finished = deps.records.finishChainRequest(auth.identity.companyId, id, actionId, {
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
    const loaded = load(companyId, id);
    if (!loaded) {
      notFound(res, auth);
      return;
    }
    if (!chainReady(chainStatus())) {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    const seconds = nowSec();
    const open = loaded.request.chain && Array.isArray(loaded.request.chain.actions)
      ? loaded.request.chain.actions.filter((action) => action && (action.status === "submitting" || action.status === "pending"))
      : [];
    const updates = [];
    try {
      for (const action of open) {
        const update = await resolveAction(loaded, action, seconds);
        if (update) updates.push({ ...update, actorSub: auth.identity.sub });
      }
    } catch {
      seeOther(res, auth, id, "unavailable");
      return;
    }
    if (updates.length > 0) deps.records.applyChainRequestChecks(companyId, id, updates);
    seeOther(res, auth, id, checkResult(updates, open));
  }

  async function resolveAction(loaded, action, seconds) {
    const pastBuffer = Number.isInteger(action.deadline) && seconds > action.deadline + RECEIPT_BUFFER_SECONDS;
    const deadlinePassed = Number.isInteger(action.deadline) && seconds > action.deadline;
    if (storedHash(action.txHash) && !pastBuffer) {
      const found = await deps.chain.receipt(action.txHash);
      if (!found || found.state === "pending") return null;
      if (found.state === "confirmed") return { id: action.id, state: "confirmed", error: null };
      if (found.state === "reverted") return { id: action.id, state: "reverted", error: null };
      return null;
    }
    let onChain;
    try {
      onChain = await deps.chain.call("getRequest", [loaded.request.chain.requestKey]);
    } catch {
      return null;
    }
    if (landed(onChain, action, loaded)) return { id: action.id, state: "confirmed", error: null };
    if (deadlinePassed) return { id: action.id, state: "expired", error: null };
    return null;
  }

  function landed(onChain, action, loaded) {
    if (!Array.isArray(onChain) || onChain.length < 6) return false;
    const [offerId, buyerCompany, version, statusSeq, status, termsCommitment] = onChain;
    const offerKey = loaded.offer && loaded.offer.chain && loaded.offer.chain.offerKey;
    const buyerKey = deps.records.companyKeyFor(loaded.request.buyerCompanyId);
    if (action.kind === "request") {
      return sameHex(offerId, offerKey)
        && sameHex(buyerCompany, buyerKey)
        && numberOf(version) === loaded.request.version
        && numberOf(status) === 1;
    }
    if (action.kind === "acceptance") {
      const salt = loaded.request.chain && loaded.request.chain.salts
        && loaded.request.chain.salts[action.counter == null ? "0" : String(action.counter)];
      const termsHash = loaded.request.acceptance && loaded.request.acceptance.termsHash;
      let expected = null;
      try {
        if (salt && termsHash) expected = commitmentFromTermsHash(termsHash, salt);
      } catch {
        expected = null;
      }
      return numberOf(status) === 2 && expected && sameHex(termsCommitment, expected);
    }
    if (action.kind === "status") {
      return numberOf(status) === CHAIN_STATUS[action.to] && numberOf(statusSeq) === action.seq + 1;
    }
    if (action.kind === "cancellation") return numberOf(status) === 8;
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

function numberOf(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

module.exports = { register, CSP };
