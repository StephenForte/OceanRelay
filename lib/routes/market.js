"use strict";

const { CURRENCIES } = require("../offer-domain");
const { filterMarket } = require("../market");
const { parseDecimalToMinor } = require("../money");
const views = require("../views/market");

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
    const results = matched.map((entry) => ({
      id: entry.id,
      version: entry.version,
      view: entry.view,
      yours: entry.companyId === auth.identity.companyId,
    }));
    deps.sendHtml(res, 200, views.renderMarket({
      results,
      query,
      error: parsed.error,
      publishedCount: published.length,
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
    deps.sendHtml(res, 200, views.renderDetail({
      view: entry.view,
      version: entry.version,
      yours: entry.companyId === auth.identity.companyId,
    }), auth.cookies);
  }
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
