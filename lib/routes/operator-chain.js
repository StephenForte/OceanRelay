"use strict";

const views = require("../views/operator-chain");
const { viewerFor } = require("../views/layout");
const { operatorGate } = require("./operator");
const { compareRecords } = require("../reconcile");

function register(router, deps) {
  router.get("/operator/chain", handleIndex);
  router.post("/operator/chain/reconcile", handleReconcile);
  router.post("/operator/chain/adopt", handleAdopt);

  function handleIndex(req, res, url) {
    const auth = operatorGate(deps, req, res);
    if (!auth) return;
    deps.sendHtml(res, 200, views.renderChain({
      csrf: auth.session.csrf,
      result: url.searchParams.get("result") || "",
    }, viewerFor(deps, auth)));
  }

  async function handleReconcile(req, res) {
    const auth = operatorGate(deps, req, res);
    if (!auth) return;
    const form = deps.formBody(await deps.readBody(req));
    if (!deps.safeEqual(form.csrf_token || "", auth.session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    let findings = null;
    let unavailable = false;
    try {
      findings = await reconcile(deps);
    } catch {
      unavailable = true;
      findings = null;
    }
    deps.sendHtml(res, 200, views.renderChain({
      csrf: auth.session.csrf,
      findings: findings || [],
      unavailable,
    }, viewerFor(deps, auth)));
  }

  async function handleAdopt(req, res) {
    const auth = operatorGate(deps, req, res);
    if (!auth) return;
    const form = deps.formBody(await deps.readBody(req));
    if (!deps.safeEqual(form.csrf_token || "", auth.session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    let packed;
    try {
      packed = await readChain(deps);
    } catch {
      seeChain(res, "unavailable");
      return;
    }
    const finding = packed.findings.find((item) => item.id === form.finding && item.adoptable === true);
    if (!finding) {
      seeChain(res, "refused");
      return;
    }
    let again;
    try {
      again = await rereadOne(deps, finding, packed);
    } catch {
      seeChain(res, "unavailable");
      return;
    }
    const still = compareRecords(again.snapshot, again.events, again.views).find((item) => {
      return item.id === finding.id && item.adoptable === true && item.reason === finding.reason;
    });
    if (!still) {
      seeChain(res, "refused");
      return;
    }
    const result = deps.records.adoptChain(auth.identity, still.id, {
      events: again.events,
      views: again.views,
    });
    seeChain(res, result && result.ok ? "corrected" : "refused");
  }

  function seeChain(res, result) {
    deps.redirect(res, `/operator/chain?result=${result}`, [], 303);
  }
}

async function reconcile(deps) {
  const packed = await readChain(deps);
  return packed.findings;
}

async function readChain(deps) {
  const status = deps.chain.status();
  if (!status || (status.state !== "ready" && status.state !== "degraded")) {
    throw new Error("chain_unavailable");
  }
  const events = await deps.chain.events({});
  const snapshot = deps.records.view((draft) => structuredClone(draft));
  const views = await readViews(deps, snapshot);
  return { snapshot, events, views, findings: compareRecords(snapshot, events, views) };
}

async function rereadOne(deps, finding, packed) {
  const snapshot = deps.records.view((draft) => structuredClone(draft));
  const views = {
    wallets: { ...packed.views.wallets },
    offers: { ...packed.views.offers },
    requests: { ...packed.views.requests },
  };
  const subject = finding.subject || {};
  if (typeof subject.wallet === "string") {
    views.wallets[subject.wallet.toLowerCase()] = await deps.chain.call("walletCompany", [subject.wallet]);
  }
  const offer = subject.offerId && snapshot.offers && snapshot.offers[subject.offerId];
  const offerKey = offer && offer.chain && offer.chain.offerKey;
  if (typeof offerKey === "string") {
    views.offers[offerKey.toLowerCase()] = await deps.chain.call("getOffer", [offerKey]);
  }
  const request = subject.requestId && snapshot.requests && snapshot.requests[subject.requestId];
  const requestKey = request && request.chain && request.chain.requestKey;
  if (typeof requestKey === "string") {
    views.requests[requestKey.toLowerCase()] = await deps.chain.call("getRequest", [requestKey]);
  }
  return { snapshot, events: packed.events, views };
}

async function readViews(deps, snapshot) {
  const wallets = {};
  const offers = {};
  const requests = {};
  const companies = snapshot.companies && typeof snapshot.companies === "object" ? snapshot.companies : {};
  for (const company of Object.values(companies)) {
    const list = company && Array.isArray(company.wallets) ? company.wallets : [];
    for (const entry of list) {
      if (!entry || typeof entry.wallet !== "string") continue;
      const key = entry.wallet.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(wallets, key)) continue;
      wallets[key] = await deps.chain.call("walletCompany", [entry.wallet]);
    }
  }
  const offerRows = snapshot.offers && typeof snapshot.offers === "object" ? snapshot.offers : {};
  for (const offer of Object.values(offerRows)) {
    const offerKey = offer && offer.chain && offer.chain.offerKey;
    if (typeof offerKey !== "string" || Object.prototype.hasOwnProperty.call(offers, offerKey.toLowerCase())) continue;
    offers[offerKey.toLowerCase()] = await deps.chain.call("getOffer", [offerKey]);
  }
  const requestRows = snapshot.requests && typeof snapshot.requests === "object" ? snapshot.requests : {};
  for (const request of Object.values(requestRows)) {
    const requestKey = request && request.chain && request.chain.requestKey;
    if (typeof requestKey !== "string" || Object.prototype.hasOwnProperty.call(requests, requestKey.toLowerCase())) continue;
    requests[requestKey.toLowerCase()] = await deps.chain.call("getRequest", [requestKey]);
  }
  return { wallets, offers, requests };
}

module.exports = { register, reconcile };
