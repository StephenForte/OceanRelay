"use strict";

const { CURRENCIES } = require("../offer-domain");
const { filterMarket } = require("../market");
const { parseDecimalToMinor } = require("../money");
const views = require("../views/market");
const { viewerFor } = require("../views/layout");

const QUERY_FIELDS = [
  "origin",
  "destination",
  "carrier",
  "equipment",
  "from",
  "to",
  "maxPrice",
  "currency",
  "capacityStatus",
];

function register(router, deps) {
  router.get("/market", handleList);
  router.pattern("GET", /^\/market\/([^/]+)$/, handleShow);
  router.pattern("POST", /^\/market\/([^/]+)\/requests$/, handleRequest);

  function gate(req, res) {
    const result = deps.requireIdentity(req, res);
    if (!result) return null;
    return {
      session: result.session,
      identity: result.identity,
      cookies: deps.cookieFor(req, result.session),
    };
  }

  function handleList(req, res, url) {
    const auth = gate(req, res);
    if (!auth) return;
    const today = todayUtc();
    const query = readQuery(url);
    const published = deps.records.listPublishedOffers(today);
    const parsed = priceFilter(query);
    const matched = filterMarket(published, parsed.filter, today);
    const withQuantity = matched.map((entry) => ({
      id: entry.id,
      version: entry.version,
      view: entry.view,
      yours: entry.companyId === auth.identity.companyId,
      available: deps.records.availableQuantity({ id: entry.id }),
    }));
    const open = [];
    const taken = [];
    for (const entry of withQuantity) {
      if (entry.available > 0) open.push(entry);
      else taken.push(entry);
    }
    const results = open.concat(taken);
    deps.sendHtml(res, 200, views.renderMarket({
      results,
      query,
      error: parsed.error,
      publishedCount: published.length,
      viewer: viewerFor(deps, auth),
    }), auth.cookies);
  }

  function handleShow(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const today = todayUtc();
    const id = pathId(match);
    const entry = deps.records.listPublishedOffers(today).find((item) => item.id === id);
    if (!entry) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    sendDetail(res, auth, entry, "");
  }

  async function handleRequest(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    let form;
    try {
      form = deps.formBody(await deps.readBody(req));
    } catch {
      deps.sendJson(res, 400, { error: "bad_request" });
      return;
    }
    if (!deps.safeEqual(form.csrf_token || "", auth.session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const today = todayUtc();
    const id = pathId(match);
    const entry = deps.records.listPublishedOffers(today).find((item) => item.id === id);
    if (!entry) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    const pinned = parsePinned(form.version);
    const quantity = parseQuantity(form.quantity);
    if (pinned == null || !quantity.ok) {
      const banner = pinned == null
        ? "This offer changed since you opened it. The request was not created."
        : "Enter a positive whole number.";
      sendDetail(res, auth, entry, banner, 400);
      return;
    }
    const result = deps.records.createRequest(auth.identity, id, pinned, quantity.quantity, today);
    if (result.ok) {
      deps.redirect(res, `/requests/${result.request.id}`, auth.cookies);
      return;
    }
    if (result.error === "stale_version") {
      const fresh = deps.records.listPublishedOffers(today).find((item) => item.id === id);
      if (!fresh) {
        deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
        return;
      }
      sendDetail(res, auth, fresh, "This offer changed since you opened it. The request was not created.", 400);
      return;
    }
    if (result.error === "own_offer" || result.error === "unavailable" || result.error === "bad_quantity") {
      const banner = result.error === "own_offer"
        ? "You cannot request your own company's offer."
        : (result.error === "unavailable"
          ? "That quantity is more than the amount available in OceanRelay."
          : "Enter a positive whole number.");
      sendDetail(res, auth, entry, banner, 400);
      return;
    }
    deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
  }

  function sendDetail(res, auth, entry, banner, status = 200) {
    const offer = deps.records.view((draft) => {
      const found = draft.offers[entry.id];
      return found ? structuredClone(found) : null;
    });
    const available = offer ? deps.records.availableQuantity(offer) : 0;
    deps.sendHtml(res, status, views.renderDetail({
      view: entry.view,
      version: entry.version,
      yours: entry.companyId === auth.identity.companyId,
      available,
      csrf: auth.session.csrf,
      banner,
      offerId: entry.id,
      viewer: viewerFor(deps, auth),
    }), auth.cookies);
  }
}

function parsePinned(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) return null;
  const pinned = Number(value.trim());
  return Number.isSafeInteger(pinned) ? pinned : null;
}

function parseQuantity(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value.trim())) return { ok: false };
  const quantity = Number(value.trim());
  if (!Number.isSafeInteger(quantity)) return { ok: false };
  return { ok: true, quantity };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function pathId(match) {
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function readQuery(url) {
  const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const query = {};
  for (const name of QUERY_FIELDS) {
    const value = params.get(name);
    query[name] = typeof value === "string" ? value : "";
  }
  return query;
}

function priceFilter(query) {
  const filter = {
    origin: query.origin,
    destination: query.destination,
    carrier: query.carrier,
    equipment: query.equipment,
    from: query.from,
    to: query.to,
    capacityStatus: query.capacityStatus,
  };
  if (query.maxPrice.trim() === "") return { filter, error: "" };
  const code = query.currency.trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(CURRENCIES, code)) {
    return { filter, error: "Enter a currency for the maximum price." };
  }
  const parsed = parseDecimalToMinor(query.maxPrice, CURRENCIES[code]);
  if (!parsed.ok) return { filter, error: parsed.error };
  filter.maxPrice = parsed.minor;
  filter.currency = code;
  return { filter, error: "" };
}

module.exports = { register };
