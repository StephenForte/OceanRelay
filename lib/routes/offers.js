"use strict";

const {
  CURRENCIES,
  EQUIPMENT,
  CAPACITY_STATUSES,
  canChangeCapacityStatus,
  validateDraft,
  priceBuyer,
  snapshotFromRate,
  sourceWarnings,
  buyerView,
} = require("../offer-domain");
const { currentVersion } = require("../records");
const { parseDecimalToMinor } = require("../money");
const views = require("../views/offers");

const RATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const WARNING_TEXT = {
  source_changed: "The Rate Ninja rate has changed since this offer was saved.",
  source_expired: "The Rate Ninja rate has expired.",
  source_missing: "The Rate Ninja rate is no longer available.",
  source_date_unreadable: "The Rate Ninja rate expiration date cannot be read.",
};

const FORM_FIELDS = [
  "origin",
  "destination",
  "equipment",
  "quantity",
  "unit",
  "sailingDate",
  "sailingStart",
  "sailingEnd",
  "cutoffDate",
  "validityDeadline",
  "currency",
  "baseAmount",
  "markupType",
  "markupValue",
  "codeShareName",
  "operatingCarrier",
  "serviceTerms",
];

function register(router, deps) {
  router.get("/offers", handleList);
  router.get("/offers/new", handleNew);
  router.post("/offers", handleCreate);
  router.pattern("GET", /^\/offers\/([^/]+)\/edit$/, handleEdit);
  router.pattern("POST", /^\/offers\/([^/]+)\/edit$/, handleEditSave);
  router.pattern("POST", /^\/offers\/([^/]+)\/state$/, handleState);
  router.pattern("GET", /^\/offers\/([^/]+)$/, handleShow);
  router.pattern("POST", /^\/offers\/([^/]+)\/capacity-status$/, handleStatus);

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

  async function handleList(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    const today = todayUtc();
    const offers = deps.records.listCompanyOffers(auth.identity.companyId).map((offer) => ({
      ...offer,
      effectiveState: deps.records.effectiveState(offer, today),
    }));
    deps.sendHtml(res, 200, views.renderList({ offers }), auth.cookies);
  }

  async function handleNew(req, res, url) {
    const auth = gate(req, res);
    if (!auth) return;
    const source = url.searchParams.get("source") || "";
    if (source !== "rn_rate" && source !== "manual") {
      await sendChooser(res, auth, { url });
      return;
    }
    if (source === "manual") {
      sendForm(res, auth, { source: "manual", values: {}, errors: {} });
      return;
    }
    const rateId = url.searchParams.get("rateId") || "";
    const equipment = url.searchParams.get("equipment") || "";
    await sendRateForm(res, auth, { rateId, equipment, values: null });
  }

  async function handleCreate(req, res) {
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
    const source = form.source === "rn_rate" || form.source === "manual" ? form.source : "";
    const values = formValues(form);
    if (source === "manual") {
      await saveManual(res, auth, form, values);
      return;
    }
    if (source === "rn_rate") {
      await sendRateForm(res, auth, {
        rateId: typeof form.rateId === "string" ? form.rateId : "",
        equipment: typeof form.equipment === "string" ? form.equipment : "",
        values,
        form,
        saving: true,
      });
      return;
    }
    sendForm(res, auth, {
      source: "manual",
      values,
      errors: { source: "Source must be a Rate Ninja rate or manual entry." },
    });
  }

  async function handleShow(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const offer = deps.records.getCompanyOffer(auth.identity.companyId, pathId(match));
    if (!offer) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    await sendPreview(res, auth, offer, "", 200, url.searchParams.get("result") || "");
  }

  async function handleStatus(req, res, url, match) {
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
    const id = pathId(match);
    const today = todayUtc();
    const result = deps.records.setCapacityStatus(auth.identity.companyId, id, form.to || "", auth.identity.sub, today);
    if (!result.ok && result.error === "not_found") {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    if (!result.ok) {
      const offer = deps.records.getCompanyOffer(auth.identity.companyId, id);
      const message = result.error === "expired"
        ? "This offer has expired."
        : "That capacity status change is not allowed.";
      await sendPreview(res, auth, offer, message, 400);
      return;
    }
    deps.redirect(res, `/offers/${id}`, auth.cookies);
  }

  async function handleEdit(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const offer = deps.records.getCompanyOffer(auth.identity.companyId, pathId(match));
    if (!offer) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    const today = todayUtc();
    if (deps.records.effectiveState(offer, today) === "expired") {
      await sendPreview(res, auth, offer, "This offer has expired.", 400);
      return;
    }
    sendEditForm(res, auth, offer, valuesFromVersion(currentVersion(offer)), {});
  }

  async function handleEditSave(req, res, url, match) {
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
    const id = pathId(match);
    const offer = deps.records.getCompanyOffer(auth.identity.companyId, id);
    if (!offer) {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    const today = todayUtc();
    if (deps.records.effectiveState(offer, today) === "expired") {
      await sendPreview(res, auth, offer, "This offer has expired.", 400);
      return;
    }
    const version = currentVersion(offer);
    const values = formValues(form);
    const built = draftFromVersion(form, version);
    const validated = validateDraft(built.input);
    const errors = combineErrors(validated.errors, built.errors, { hideServerBase: version.source === "rn_rate" });
    if (!validated.ok || Object.keys(built.errors).length > 0) {
      sendEditForm(res, auth, offer, values, errors);
      return;
    }
    const terms = withBuyerPrice(validated.value);
    let result;
    try {
      result = deps.records.editOffer(auth.identity.companyId, id, {
        terms,
        overriddenFields: version.source === "rn_rate" && version.snapshot
          ? overrides(version.snapshot, validated.value)
          : [],
      }, auth.identity.sub, today);
    } catch {
      sendEditForm(res, auth, offer, values, { markup: "Buyer price is too large to store as a whole number of minor units." });
      return;
    }
    if (!result.ok) {
      const message = result.error === "expired" ? "This offer has expired." : "That edit could not be saved.";
      await sendPreview(res, auth, offer, message, 400);
      return;
    }
    const code = offer.publishedAt ? "saved_version" : "saved_draft";
    deps.redirect(res, `/offers/${id}?result=${code}`, auth.cookies);
  }

  async function handleState(req, res, url, match) {
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
    const id = pathId(match);
    const today = todayUtc();
    const result = deps.records.setOfferState(
      auth.identity.companyId,
      id,
      form.to || "",
      auth.identity.sub,
      today,
    );
    if (!result.ok && result.error === "not_found") {
      deps.sendHtml(res, 404, views.renderNotFound(), auth.cookies);
      return;
    }
    if (!result.ok) {
      const offer = deps.records.getCompanyOffer(auth.identity.companyId, id);
      const message = result.error === "expired"
        ? "This offer has expired."
        : result.error === "deadline_passed"
          ? "The validity deadline has passed. Edit the offer before publishing."
          : "That state change is not allowed.";
      await sendPreview(res, auth, offer, message, 400);
      return;
    }
    deps.redirect(res, `/offers/${id}`, auth.cookies);
  }

  function sendForm(res, auth, fields) {
    deps.sendHtml(res, 200, views.renderForm({
      csrf: auth.session.csrf,
      ...fields,
    }), auth.cookies);
  }

  function sendEditForm(res, auth, offer, values, errors, bannerText = "") {
    const version = currentVersion(offer);
    const terms = version && version.terms ? version.terms : {};
    const fromRate = version && version.source === "rn_rate";
    sendForm(res, auth, {
      mode: "edit",
      offerId: offer.id,
      source: version ? version.source : "manual",
      equipment: terms.equipment || "",
      seeded: fromRate && version.snapshot ? version.snapshot.seeded : null,
      snapshot: fromRate ? version.snapshot : null,
      lockedPrice: fromRate ? formatMinorText(terms.baseMinor, terms.currency) : null,
      values,
      errors,
      bannerText,
      draftNote: offer.publishedAt
        ? ""
        : "This offer has not been published, so your changes update version 1. After you publish, each change creates a new version.",
    });
  }

  async function sendChooser(res, auth, { bannerText = "", skipFetch = false, url = null }) {
    const query = chooserQuery(url);
    const today = todayUtc();
    if (skipFetch) {
      deps.sendHtml(res, 200, views.renderChooser({ bannerText, query }), auth.cookies);
      return;
    }
    const loaded = await loadChooser(auth.session);
    const visible = filterChooserRates(loaded.rates, query, today);
    deps.sendHtml(res, 200, views.renderChooser({
      bannerText,
      errorMessage: loaded.errorMessage,
      rates: visible,
      sailings: loaded.sailings,
      retrievedAt: loaded.retrievedAt,
      truncated: loaded.truncated,
      showEmptyRates: loaded.ok && loaded.rates.length === 0,
      query,
      shown: visible.length,
      total: Array.isArray(loaded.rates) ? loaded.rates.length : 0,
      countRates: loaded.ok || (Array.isArray(loaded.rates) && loaded.rates.length > 0),
    }), auth.cookies);
  }

  async function sendRateForm(res, auth, { rateId, equipment, values, form, saving }) {
    if (!RATE_ID.test(rateId)) {
      await sendChooser(res, auth, { bannerText: "That rate was not found.", skipFetch: true });
      return;
    }
    if (!EQUIPMENT.includes(equipment)) {
      await sendChooser(res, auth, { bannerText: "Choose 20D, 40D, or 40HC.", skipFetch: true });
      return;
    }
    const fetched = await fetchRate(auth.session, rateId);
    if (!fetched.ok) {
      if (saving) {
        sendForm(res, auth, {
          source: "rn_rate",
          rateId,
          equipment,
          baseAmount: null,
          seeded: null,
          values,
          errors: {},
          bannerText: partnerErrorMessage(fetched.error, fetched.detail),
        });
        return;
      }
      await sendChooser(res, auth, { bannerText: partnerErrorMessage(fetched.error, fetched.detail) });
      return;
    }
    const snapshot = snapshotFromRate(fetched.data, equipment, fetched.retrievedAt);
    if (!snapshot || snapshot.ok === false) {
      const bannerText = snapshot && snapshot.error === "no_price_for_equipment"
        ? "That rate has no price for this equipment."
        : "That rate was not found.";
      await sendChooser(res, auth, { bannerText });
      return;
    }
    const seededValues = {
      origin: snapshot.seeded.origin == null ? "" : String(snapshot.seeded.origin),
      destination: snapshot.seeded.destination == null ? "" : String(snapshot.seeded.destination),
      operatingCarrier: snapshot.seeded.carrier == null ? "" : String(snapshot.seeded.carrier),
      equipment,
    };
    if (!saving) {
      sendForm(res, auth, {
        source: "rn_rate",
        rateId,
        equipment,
        baseAmount: snapshot.baseAmount,
        seeded: snapshot.seeded,
        values: seededValues,
        errors: {},
      });
      return;
    }
    const currency = currencyCode(form.currency);
    const exponent = Object.prototype.hasOwnProperty.call(CURRENCIES, currency) ? CURRENCIES[currency] : null;
    let baseMinor = null;
    const parserErrors = {};
    if (exponent == null) {
      baseMinor = null;
    } else {
      baseMinor = wholeUnitsToMinor(snapshot.baseAmount, exponent);
      if (baseMinor == null) parserErrors.baseAmount = "Base price could not be converted for this currency.";
    }
    const built = draftFromForm(form, {
      source: "rn_rate",
      equipment,
      baseMinor,
      baseError: parserErrors.baseAmount || "",
    });
    const validated = validateDraft(built.input);
    const errors = combineErrors(validated.errors, built.errors, { hideServerBase: exponent == null || baseMinor != null });
    if (!validated.ok || Object.keys(built.errors).length > 0 || baseMinor == null) {
      sendForm(res, auth, {
        source: "rn_rate",
        rateId,
        equipment,
        baseAmount: snapshot.baseAmount,
        seeded: snapshot.seeded,
        values,
        errors,
      });
      return;
    }
    saveOffer(res, auth, {
      source: "rn_rate",
      terms: withBuyerPrice(validated.value),
      snapshot,
      sourceRecordId: rateId,
      overriddenFields: overrides(snapshot, validated.value),
    });
  }

  async function saveManual(res, auth, form, values) {
    const equipment = typeof form.equipment === "string" ? form.equipment.trim() : "";
    const built = draftFromForm(form, { source: "manual", equipment, baseMinor: null, baseError: "" });
    const validated = validateDraft(built.input);
    const errors = combineErrors(validated.errors, built.errors, { hideServerBase: false });
    if (!validated.ok || Object.keys(built.errors).length > 0) {
      sendForm(res, auth, { source: "manual", values, errors });
      return;
    }
    saveOffer(res, auth, {
      source: "manual",
      terms: withBuyerPrice(validated.value),
      snapshot: null,
      sourceRecordId: null,
      overriddenFields: [],
    });
  }

  function saveOffer(res, auth, fields) {
    let buyerMinor;
    try {
      buyerMinor = fields.terms.buyerMinor;
      if (!Number.isSafeInteger(buyerMinor)) throw new Error("buyer_price");
    } catch {
      sendForm(res, auth, {
        source: fields.source,
        values: {},
        errors: { markup: "Buyer price is too large to store as a whole number of minor units." },
      });
      return;
    }
    const offer = deps.records.createOffer(auth.identity, fields);
    deps.redirect(res, `/offers/${offer.id}?result=saved_draft`, auth.cookies);
  }

  async function sendPreview(res, auth, offer, statusError, status = 200, resultCode = "") {
    const today = todayUtc();
    const version = currentVersion(offer) || {};
    const warning = await loadWarning(auth.session, version);
    const buyer = buyerView({
      ...(version.terms || {}),
      capacityStatus: version.capacityStatus,
    });
    const effective = deps.records.effectiveState(offer, today);
    const transitions = effective === "expired"
      ? []
      : CAPACITY_STATUSES.filter((to) => canChangeCapacityStatus(version.capacityStatus, to));
    deps.sendHtml(res, status, views.renderPreview({
      offer,
      buyer,
      warning,
      csrf: auth.session.csrf,
      transitions,
      statusError,
      effectiveState: effective,
      stateMoves: stateMoves(offer.state, effective),
      savedMessage: saveBanner(resultCode, offer),
    }), auth.cookies);
  }

  async function loadChooser(session) {
    const access = await accessTokenFor(session);
    if (!access.ok) {
      return { ok: false, errorMessage: partnerErrorMessage(access.error, access.detail), rates: [], sailings: [], retrievedAt: "", truncated: false };
    }
    let rates;
    try {
      rates = await deps.rn.listAllRates(deps.fetchImpl, deps.config, access.token);
    } catch {
      rates = { ok: false, error: "network_error" };
    }
    if (!rates.ok) {
      if (rates.error === "unauthorized") deps.forgetAccessToken(session.sid);
      return {
        ok: false,
        errorMessage: partnerErrorMessage(rates.error, rates.detail),
        rates: [],
        sailings: [],
        retrievedAt: "",
        truncated: false,
      };
    }
    let sailings;
    try {
      sailings = await deps.rn.listSailings(deps.fetchImpl, deps.config, access.token, { page: 1, pageSize: 100 });
    } catch {
      sailings = { ok: false, error: "network_error" };
    }
    if (!sailings.ok) {
      if (sailings.error === "unauthorized") deps.forgetAccessToken(session.sid);
      return {
        ok: false,
        errorMessage: partnerErrorMessage(sailings.error, sailings.detail),
        rates: Array.isArray(rates.data) ? rates.data : [],
        sailings: [],
        retrievedAt: rates.retrievedAt || "",
        truncated: Boolean(rates.truncated),
      };
    }
    return {
      ok: true,
      errorMessage: "",
      rates: Array.isArray(rates.data) ? rates.data : [],
      sailings: Array.isArray(sailings.data) ? sailings.data : [],
      retrievedAt: rates.retrievedAt || "",
      truncated: Boolean(rates.truncated),
    };
  }

  async function fetchRate(session, rateId) {
    if (!RATE_ID.test(rateId)) return { ok: false, error: "not_found" };
    const access = await accessTokenFor(session);
    if (!access.ok) return access;
    try {
      const result = await deps.rn.getRate(deps.fetchImpl, deps.config, access.token, rateId);
      if (result && result.ok === false && result.error === "unauthorized") deps.forgetAccessToken(session.sid);
      return result;
    } catch {
      return { ok: false, error: "network_error" };
    }
  }

  async function accessTokenFor(session) {
    let ready;
    try {
      ready = await deps.endpoints();
    } catch {
      return { ok: false, error: "network_error" };
    }
    if (!ready) return { ok: false, error: "network_error" };
    try {
      const access = await deps.ensureAccessToken(session.sid, ready);
      if (!access.ok) return { ok: false, error: access.disconnect ? "unauthorized" : "network_error" };
      return { ok: true, token: access.accessToken };
    } catch {
      return { ok: false, error: "network_error" };
    }
  }

  async function loadWarning(session, version) {
    if (!version || version.source !== "rn_rate" || !version.snapshot) return { note: "", codes: [], text: WARNING_TEXT };
    if (!RATE_ID.test(version.sourceRecordId || "")) {
      return { note: "", codes: ["source_missing"], text: WARNING_TEXT };
    }
    const fetched = await fetchRate(session, version.sourceRecordId);
    if (!fetched.ok) {
      if (fetched.error === "not_found") {
        try {
          return { note: "", codes: sourceWarnings(version.snapshot, null, todayUtc()), text: WARNING_TEXT };
        } catch {
          return { note: "Could not check the Rate Ninja rate right now", codes: [], text: WARNING_TEXT };
        }
      }
      return { note: "Could not check the Rate Ninja rate right now", codes: [], text: WARNING_TEXT };
    }
    try {
      return { note: "", codes: sourceWarnings(version.snapshot, fetched.data, todayUtc()), text: WARNING_TEXT };
    } catch {
      return { note: "Could not check the Rate Ninja rate right now", codes: [], text: WARNING_TEXT };
    }
  }
}

function pathId(match) {
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function formValues(form) {
  const values = {};
  for (const name of FORM_FIELDS) values[name] = typeof form[name] === "string" ? form[name] : "";
  return values;
}

function currencyCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function partnerErrorMessage(error, detail) {
  if (error === "unauthorized") return "Your Rate Ninja connection needs to be renewed. Reconnect and try again.";
  if (error === "rate_limited") return "Rate Ninja is limiting requests. Try again in a minute.";
  if (error === "forbidden" && detail === "partner_oauth_disabled") return "Partner access is off at Rate Ninja.";
  if (error === "not_found") return "That rate was not found.";
  return "Could not reach Rate Ninja";
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

const SAVE_BANNERS = {
  saved_draft: "Saved as a draft (version 1)",
};

function saveBanner(code, offer) {
  if (code === "saved_draft") {
    if (offer && offer.state === "draft" && !offer.publishedAt && offer.currentVersion === 1) {
      return SAVE_BANNERS.saved_draft;
    }
    return "";
  }
  if (code === "saved_version") {
    const version = offer && offer.currentVersion;
    if (offer && offer.publishedAt && Number.isInteger(version) && version >= 1) {
      return `Saved as version ${version}`;
    }
    return "";
  }
  return "";
}

function chooserQuery(url) {
  const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const equipment = params.get("equipment") || "";
  return {
    origin: params.get("origin") || "",
    destination: params.get("destination") || "",
    carrier: params.get("carrier") || "",
    equipment: equipment === "20D" || equipment === "40D" || equipment === "40HC" ? equipment : "",
    showExpired: params.get("showExpired") === "1",
  };
}

const EQUIPMENT_COLUMNS = {
  "20D": "rate20D",
  "40D": "rate40D",
  "40HC": "rate40HC",
};

function filterChooserRates(rates, query, today) {
  const list = Array.isArray(rates) ? rates : [];
  const origin = String(query.origin || "").trim().toLowerCase();
  const destination = String(query.destination || "").trim().toLowerCase();
  const carrier = String(query.carrier || "").trim().toLowerCase();
  const equipment = query.equipment || "";
  const decorated = list.map((rate) => {
    const expiration = calendarDate(rate && rate.rateExpirationDate);
    return { rate, expiration, unreadable: expiration == null };
  });
  const filtered = decorated.filter((item) => {
    const rate = item.rate || {};
    if (origin && !String(rate.originPort || "").toLowerCase().includes(origin)) return false;
    if (destination && !String(rate.destinationPort || "").toLowerCase().includes(destination)) return false;
    if (carrier && !String(rate.carrier || "").toLowerCase().includes(carrier)) return false;
    if (equipment && !equipmentPriced(rate, equipment)) return false;
    if (!query.showExpired && item.expiration && item.expiration < today) return false;
    return true;
  });
  filtered.sort((left, right) => {
    if (left.unreadable !== right.unreadable) return left.unreadable ? 1 : -1;
    if (!left.expiration && right.expiration) return 1;
    if (left.expiration && !right.expiration) return -1;
    if (left.expiration === right.expiration) return 0;
    return left.expiration < right.expiration ? -1 : 1;
  });
  return filtered;
}

function equipmentPriced(rate, equipment) {
  const column = EQUIPMENT_COLUMNS[equipment];
  if (!column) return false;
  const amount = rate[column];
  return typeof amount === "number" && Number.isInteger(amount) && amount >= 1;
}

function calendarDate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match[1].split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[1];
}

function stateMoves(stored, effective) {
  if (effective === "expired") return [];
  if (stored === "draft") return [{ to: "published", label: "Publish" }];
  if (stored === "published") return [{ to: "paused", label: "Pause" }];
  if (stored === "paused") return [{ to: "published", label: "Resume" }];
  return [];
}

function formatMinorText(minor, currency) {
  const exponent = Object.prototype.hasOwnProperty.call(CURRENCIES, currency) ? CURRENCIES[currency] : null;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || exponent == null) return "";
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const body = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  return `${body} ${currency}`;
}

function minorToInput(minor, currency) {
  const exponent = Object.prototype.hasOwnProperty.call(CURRENCIES, currency) ? CURRENCIES[currency] : null;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || exponent == null) return "";
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  if (exponent === 0) return digits;
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

function markupToInput(markup, currency) {
  if (!markup || typeof markup !== "object") return "";
  if (markup.type === "percent" && Number.isSafeInteger(markup.bps)) {
    const whole = Math.trunc(markup.bps / 100);
    const frac = Math.abs(markup.bps % 100);
    if (frac === 0) return String(whole);
    const fracText = String(frac).padStart(2, "0").replace(/0$/, "");
    return `${whole}.${fracText}`;
  }
  if (markup.type === "absolute") return minorToInput(markup.minor, currency);
  return "";
}

function valuesFromVersion(version) {
  const terms = version && version.terms ? version.terms : {};
  const sameDay = terms.sailingStart && terms.sailingStart === terms.sailingEnd;
  return {
    origin: terms.origin || "",
    destination: terms.destination || "",
    equipment: terms.equipment || "",
    quantity: terms.quantity == null ? "" : String(terms.quantity),
    unit: terms.unit || "",
    sailingDate: sameDay ? terms.sailingStart : "",
    sailingStart: sameDay ? "" : (terms.sailingStart || ""),
    sailingEnd: sameDay ? "" : (terms.sailingEnd || ""),
    cutoffDate: terms.cutoffDate || "",
    validityDeadline: terms.validityDeadline || "",
    currency: terms.currency || "",
    baseAmount: minorToInput(terms.baseMinor, terms.currency),
    markupType: terms.markup && terms.markup.type ? terms.markup.type : "",
    markupValue: markupToInput(terms.markup, terms.currency),
    codeShareName: terms.codeShareName || "",
    operatingCarrier: terms.operatingCarrier || "",
    serviceTerms: terms.serviceTerms || "",
  };
}

function draftFromVersion(form, version) {
  const source = version && version.source === "rn_rate" ? "rn_rate" : "manual";
  const terms = version && version.terms ? version.terms : {};
  if (source === "rn_rate") {
    return draftFromForm(form, {
      source,
      equipment: terms.equipment,
      baseMinor: terms.baseMinor,
      baseError: "",
    });
  }
  const equipment = typeof form.equipment === "string" ? form.equipment.trim() : "";
  return draftFromForm(form, { source, equipment, baseMinor: null, baseError: "" });
}

function parsePercentToBps(text) {
  if (typeof text !== "string") return { ok: false, error: "Enter a percentage." };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Enter a percentage." };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: "Enter a percentage using digits and an optional decimal point." };
  }
  const parts = trimmed.split(".");
  const whole = parts[0];
  const frac = parts[1] || "";
  if (frac.length > 2) return { ok: false, error: "Use at most two decimal places for a percentage." };
  const digits = `${whole}${(frac + "00").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const bps = Number(digits);
  if (!Number.isSafeInteger(bps)) return { ok: false, error: "That percentage is too large." };
  return { ok: true, bps };
}

function parseQuantity(text) {
  if (typeof text !== "string") return { ok: false };
  const trimmed = text.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return { ok: false };
  const quantity = Number(trimmed);
  if (!Number.isSafeInteger(quantity) || quantity < 1) return { ok: false };
  return { ok: true, quantity };
}

function wholeUnitsToMinor(amount, exponent) {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) return null;
  if (!Number.isSafeInteger(exponent) || exponent < 0) return null;
  const digits = `${amount}${"0".repeat(exponent)}`;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor < 1) return null;
  return minor;
}

function draftFromForm(form, { source, equipment, baseMinor, baseError }) {
  const errors = {};
  const quantity = parseQuantity(form.quantity);
  if (!quantity.ok) errors.quantity = "Claimed quantity must be a positive whole number.";

  const code = currencyCode(form.currency);
  const exponent = Object.prototype.hasOwnProperty.call(CURRENCIES, code) ? CURRENCIES[code] : null;
  let markup = {};
  const markupType = typeof form.markupType === "string" ? form.markupType.trim() : "";
  if (markupType === "absolute") {
    if (exponent == null) {
      errors.markup = "Choose a currency before the markup amount.";
    } else {
      const parsed = parseDecimalToMinor(form.markupValue, exponent);
      if (!parsed.ok) errors.markup = parsed.error;
      else markup = { type: "absolute", minor: parsed.minor };
    }
  } else if (markupType === "percent") {
    const parsed = parsePercentToBps(form.markupValue);
    if (!parsed.ok) errors.markup = parsed.error;
    else markup = { type: "percent", bps: parsed.bps };
  } else {
    errors.markup = "Markup must be an absolute amount or a percentage.";
  }

  let resolvedBase = baseMinor;
  if (source === "manual") {
    if (exponent == null) {
      errors.baseAmount = "Choose a currency from the list.";
      resolvedBase = null;
    } else {
      const parsed = parseDecimalToMinor(form.baseAmount, exponent);
      if (!parsed.ok) {
        errors.baseAmount = parsed.error;
        resolvedBase = null;
      } else if (parsed.minor < 1) {
        errors.baseAmount = "Base price must be greater than zero.";
        resolvedBase = null;
      } else {
        resolvedBase = parsed.minor;
      }
    }
  } else if (baseError) {
    errors.baseAmount = baseError;
  }

  const input = {
    source,
    origin: form.origin ?? "",
    destination: form.destination ?? "",
    equipment,
    quantity: quantity.ok ? quantity.quantity : form.quantity,
    unit: form.unit ?? "",
    currency: form.currency ?? "",
    baseMinor: resolvedBase == null ? 0 : resolvedBase,
    markup,
    codeShareName: form.codeShareName ?? "",
    operatingCarrier: form.operatingCarrier ?? "",
    serviceTerms: form.serviceTerms ?? "",
  };
  assignDate(input, "sailingDate", form.sailingDate);
  assignDate(input, "sailingStart", form.sailingStart);
  assignDate(input, "sailingEnd", form.sailingEnd);
  assignDate(input, "cutoffDate", form.cutoffDate);
  assignDate(input, "validityDeadline", form.validityDeadline);
  return { input, errors };
}

function assignDate(input, key, value) {
  if (typeof value !== "string") return;
  input[key] = value;
}

function combineErrors(validatedErrors, parserErrors, { hideServerBase }) {
  const errors = { ...(validatedErrors || {}), ...(parserErrors || {}) };
  if (hideServerBase) delete errors.baseMinor;
  if (errors.baseMinor && !errors.baseAmount) errors.baseAmount = errors.baseMinor;
  return errors;
}

function withBuyerPrice(value) {
  return { ...value, buyerMinor: priceBuyer({ baseMinor: value.baseMinor, markup: value.markup }) };
}

function overrides(snapshot, terms) {
  const seeded = snapshot.seeded || {};
  const pairs = [
    ["origin", terms.origin, seeded.origin],
    ["destination", terms.destination, seeded.destination],
    ["operatingCarrier", terms.operatingCarrier, seeded.carrier],
  ];
  return pairs
    .filter(([, typed, seed]) => textOf(typed) !== textOf(seed))
    .map(([name]) => name);
}

function textOf(value) {
  if (value == null) return "";
  return String(value).trim();
}

module.exports = { register };
