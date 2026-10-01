"use strict";

const { CURRENCIES, buyerView } = require("../offer-domain");
const { effectiveRequestState, nextCarrierStatuses } = require("../records");
const { parseDecimalToMinor } = require("../money");
const { requestQuantity, requestStateLabel, fulfilmentStatusLabel } = require("../views/format");
const views = require("../views/requests");

const ACTION_ERRORS = {
  forbidden: "You cannot take that action.",
  final: "This request is already closed.",
  superseded: "This offer changed. The request is superseded and cannot be accepted.",
  unavailable: "That quantity is no longer available in OceanRelay.",
  expired: "This offer has expired.",
  not_published: "This offer is not published.",
  draft: "This offer is not published.",
  paused: "This offer is not published.",
  not_frozen: "This offer is not published.",
  bad_quantity: "Enter a positive whole number.",
  bad_price: "Enter a price greater than zero.",
  bad_terms: "Service terms are too long.",
  overflow: "That price is too large to store.",
  invalid: "That request cannot be accepted.",
  not_accepted: "That action is only available after acceptance.",
  illegal_transition: "That status change is not allowed.",
  bad_note: "The note must be 500 characters or fewer.",
  bad_reason: "The reason must be 500 characters or fewer.",
};

function register(router, deps) {
  router.get("/requests", handleList);
  router.pattern("GET", /^\/requests\/([^/]+)$/, handleShow);
  router.pattern("POST", /^\/requests\/([^/]+)\/accept$/, handleAccept);
  router.pattern("POST", /^\/requests\/([^/]+)\/decline$/, handleDecline);
  router.pattern("POST", /^\/requests\/([^/]+)\/counter$/, handleCounter);
  router.pattern("POST", /^\/requests\/([^/]+)\/withdraw$/, handleWithdraw);
  router.pattern("POST", /^\/requests\/([^/]+)\/status$/, handleStatus);
  router.pattern("POST", /^\/requests\/([^/]+)\/cancel\/propose$/, handlePropose);
  router.pattern("POST", /^\/requests\/([^/]+)\/cancel\/withdraw$/, handleWithdrawCancellation);
  router.pattern("POST", /^\/requests\/([^/]+)\/cancel\/agree$/, handleAgree);
  router.pattern("POST", /^\/requests\/([^/]+)\/cancel\/refuse$/, handleRefuse);

  function gate(req, res) {
    const result = deps.requireIdentity(req, res);
    if (!result) return null;
    return {
      session: result.session,
      identity: result.identity,
      cookies: deps.cookieFor(req, result.session),
    };
  }

  function handleList(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    const companyId = auth.identity.companyId;
    const requests = deps.records.listRequestsFor(companyId);
    const rows = deps.records.view((draft) => requests.map((request) => {
      const offer = draft.offers[request.offerId];
      const pinned = offer && Array.isArray(offer.versions)
        ? offer.versions.find((version) => version && version.n === request.version)
        : null;
      const terms = pinned && pinned.terms && typeof pinned.terms === "object" ? pinned.terms : {};
      const view = buyerView({
        ...terms,
        capacityStatus: pinned ? pinned.capacityStatus : "",
      });
      return {
        id: request.id,
        codeShareLine: view.codeShareLine,
        quantity: requestQuantity(request),
        state: requestStateLabel(effectiveRequestState(request, offer)),
        version: request.version,
        made: request.buyerCompanyId === companyId,
        fulfilment: request.state === "accepted" && request.fulfilment
          ? fulfilmentStatusLabel(request.fulfilment.status)
          : "",
        dispute: Boolean(
          request.fulfilment
          && request.fulfilment.cancellation
          && request.fulfilment.cancellation.state === "disputed",
        ),
      };
    }));
    deps.sendHtml(res, 200, views.renderList({
      made: rows.filter((row) => row.made),
      received: rows.filter((row) => !row.made),
    }), auth.cookies);
  }

  function handleShow(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const presentation = present(auth.identity.companyId, pathId(match));
    if (!presentation) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    sendDetail(res, auth, presentation, "");
  }

  async function handleAccept(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.acceptRequest(posted.auth.identity, posted.id, todayUtc());
    finish(res, posted.auth, posted.id, result);
  }

  async function handleDecline(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.declineRequest(posted.auth.identity, posted.id);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleWithdraw(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.withdrawRequest(posted.auth.identity, posted.id);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleStatus(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const note = typeof posted.form.note === "string" ? posted.form.note : "";
    const to = typeof posted.form.to === "string" ? posted.form.to : "";
    const result = deps.records.recordCarrierStatus(posted.auth.identity, posted.id, to, note);
    finish(res, posted.auth, posted.id, result);
  }

  async function handlePropose(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const reason = typeof posted.form.reason === "string" ? posted.form.reason : "";
    const result = deps.records.proposeCancellation(posted.auth.identity, posted.id, reason);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleWithdrawCancellation(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.withdrawCancellation(posted.auth.identity, posted.id);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleAgree(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.agreeCancellation(posted.auth.identity, posted.id);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleRefuse(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const result = deps.records.refuseCancellation(posted.auth.identity, posted.id);
    finish(res, posted.auth, posted.id, result);
  }

  async function handleCounter(req, res, url, match) {
    const posted = await readPost(req, res, match);
    if (!posted) return;
    const presentation = present(posted.auth.identity.companyId, posted.id);
    if (!presentation) {
      deps.sendHtml(res, 404, views.renderNotFound(), posted.auth.cookies);
      return;
    }
    const quantity = parseQuantity(posted.form.quantity);
    const exponent = CURRENCIES[presentation.currency];
    const price = typeof exponent === "number"
      ? parseDecimalToMinor(typeof posted.form.unitPrice === "string" ? posted.form.unitPrice : "", exponent)
      : { ok: false, error: "Enter a price." };
    const serviceTerms = typeof posted.form.serviceTerms === "string" ? posted.form.serviceTerms : "";
    if (!quantity.ok || !price.ok || !Number.isSafeInteger(price.minor) || price.minor < 1) {
      const message = !quantity.ok
        ? "Enter a positive whole number."
        : (price.ok ? "Enter a price greater than zero." : price.error);
      sendDetail(res, posted.auth, presentation, message, 400);
      return;
    }
    const result = deps.records.counterRequest(posted.auth.identity, posted.id, {
      quantity: quantity.quantity,
      unitBuyerMinor: price.minor,
      serviceTerms,
    }, todayUtc());
    finish(res, posted.auth, posted.id, result);
  }

  async function readPost(req, res, match) {
    const auth = gate(req, res);
    if (!auth) return null;
    let form;
    try {
      form = deps.formBody(await deps.readBody(req));
    } catch {
      deps.sendJson(res, 400, { error: "bad_request" });
      return null;
    }
    if (!deps.safeEqual(form.csrf_token || "", auth.session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return null;
    }
    return { auth, form, id: pathId(match) };
  }

  function present(companyId, requestId) {
    return deps.records.view((draft) => {
      const request = draft.requests && draft.requests[requestId];
      if (!request || (request.buyerCompanyId !== companyId && request.sellerCompanyId !== companyId)) return null;
      const offer = draft.offers[request.offerId] || null;
      const pinned = offer && Array.isArray(offer.versions)
        ? offer.versions.find((version) => version && version.n === request.version)
        : null;
      const terms = pinned && pinned.terms && typeof pinned.terms === "object" ? pinned.terms : {};
      const view = buyerView({
        ...terms,
        capacityStatus: pinned ? pinned.capacityStatus : "",
      });
      const shown = structuredClone(request);
      if (shown.state === "accepted" && shown.fulfilment && shown.fulfilment.status !== "cancelled" && shown.fulfilment.status !== "completed") {
        shown.carrierMoves = nextCarrierStatuses(shown.fulfilment.status);
      }
      return {
        request: shown,
        view,
        effective: effectiveRequestState(request, offer),
        role: request.buyerCompanyId === companyId ? "buyer" : "seller",
        currency: view.currency,
      };
    });
  }

  function sendDetail(res, auth, presentation, error, status = 200) {
    deps.sendHtml(res, status, views.renderDetail({
      request: presentation.request,
      view: presentation.view,
      role: presentation.role,
      effective: presentation.effective,
      csrf: auth.session.csrf,
      error,
    }), auth.cookies);
  }

  function finish(res, auth, id, result) {
    if (!result.ok && result.error === "not_found") {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    if (result.ok) {
      deps.redirect(res, `/requests/${id}`, auth.cookies);
      return;
    }
    const presentation = present(auth.identity.companyId, id);
    if (!presentation) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    sendDetail(res, auth, presentation, ACTION_ERRORS[result.error] || "That action was refused.", 400);
  }
}

function parseQuantity(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) return { ok: false };
  const quantity = Number(value.trim());
  if (!Number.isSafeInteger(quantity)) return { ok: false };
  return { ok: true, quantity };
}

function pathId(match) {
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { register };
