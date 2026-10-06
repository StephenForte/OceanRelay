"use strict";

const views = require("../views/operator");
const { viewerFor } = require("../views/layout");

function register(router, deps) {
  router.get("/operator", handleIndex);
  router.get("/operator/audit", handleAudit);
  router.pattern("GET", /^\/operator\/requests\/([^/]+)$/, handleRequest);
  router.pattern("POST", /^\/operator\/requests\/([^/]+)\/status$/, handleStatus);

  function gate(req, res) {
    const { session } = deps.sessionFromRequest(req);
    const connection = session ? deps.store.publicConnection(session.sid) : null;
    const profile = connection && connection.profile;
    const usable = profile && !deps.identityRefusal(profile, false);
    const sub = usable && typeof profile.sub === "string" ? profile.sub : "";
    const allowed = Boolean(sub && deps.config.operatorSubs && deps.config.operatorSubs.has(sub));
    if (!allowed) {
      deps.sendJson(res, 404, { error: "not found" });
      return null;
    }
    return {
      session,
      identity: {
        sub: profile.sub,
        companyId: profile.companyId,
        companyName: typeof profile.companyName === "string" ? profile.companyName : "",
        name: typeof profile.name === "string" ? profile.name : "",
      },
    };
  }

  function snapshot() {
    return deps.records.view((draft) => structuredClone(draft));
  }

  function handleIndex(req, res) {
    const auth = gate(req, res);
    if (!auth) return;
    deps.sendHtml(res, 200, views.renderIndex(snapshot(), viewerFor(deps, auth)));
  }

  function handleAudit(req, res, url) {
    const auth = gate(req, res);
    if (!auth) return;
    deps.sendHtml(res, 200, views.renderAudit(snapshot(), {
      requestId: url.searchParams.get("requestId") || "",
      offerId: url.searchParams.get("offerId") || "",
    }, viewerFor(deps, auth)));
  }

  function handleRequest(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const requestId = decodeURIComponent(match[1]);
    deps.sendHtml(res, 200, views.renderRequest(snapshot(), requestId, {
      csrf: auth.session.csrf,
      viewer: viewerFor(deps, auth),
    }));
  }

  async function handleStatus(req, res, url, match) {
    const auth = gate(req, res);
    if (!auth) return;
    const form = deps.formBody(await deps.readBody(req));
    if (!deps.safeEqual(form.csrf_token || "", auth.session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const requestId = decodeURIComponent(match[1]);
    const result = deps.records.operatorRecordCarrierStatus(auth.identity, requestId, form.to || "", form.note);
    if (result.ok) {
      deps.redirect(res, `/operator/requests/${encodeURIComponent(requestId)}`);
      return;
    }
    const message = result.error === "bad_note"
      ? "A note is required."
      : result.error === "illegal_transition" || result.error === "final"
        ? "That status change is not allowed."
        : "That request was not found.";
    const status = result.error === "not_found" ? 404 : 400;
    deps.sendHtml(res, status, views.renderRequest(snapshot(), requestId, {
      csrf: auth.session.csrf,
      error: message,
      viewer: viewerFor(deps, auth),
    }));
  }
}

module.exports = { register };
