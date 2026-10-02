const http = require("node:http");
const crypto = require("node:crypto");

function createMockRateNinja({ clientId, clientSecret, userinfo, rates, sailings, accessTtl } = {}) {
  const codes = new Map();
  const refreshTokens = new Map();
  const calls = [];
  // T2 partner reads. `calls` stays a method+path string list for existing tests.
  const requests = [];
  const accessTokens = new Set();
  const issued = [];
  const rateRows = Array.isArray(rates) ? rates : [];
  const sailingRows = Array.isArray(sailings) ? sailings : [];
  let nextPartnerFault = null;

  function profile() {
    return {
      sub: "user-owner",
      name: "SteveF",
      companyId: "kings",
      companyName: "Kings",
      companyType: "Contract Owner",
      active: true,
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    calls.push(`${req.method} ${url.pathname}`);
    requests.push({
      method: req.method,
      url: req.url || "",
      pathname: url.pathname,
      headers: Object.assign({}, req.headers),
    });
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const body = JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        userinfo_endpoint: `${origin}/oauth/userinfo`,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["profile:read", "rates:read", "sailings:read"],
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      const html = `<!DOCTYPE html><html><body><h1>Rate Ninja</h1>
        <form method="post" action="/oauth/decision">
          <input type="hidden" name="state" value="${url.searchParams.get("state") || ""}">
          <input type="hidden" name="redirect_uri" value="${url.searchParams.get("redirect_uri") || ""}">
          <input type="hidden" name="code_challenge" value="${url.searchParams.get("code_challenge") || ""}">
          <button type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="customer">Deny customer</button>
        </form></body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/decision") {
      const text = await readBody(req);
      const form = new URLSearchParams(text);
      const location = new URL(form.get("redirect_uri"));
      location.searchParams.set("state", form.get("state") || "");
      if (form.get("decision") === "customer") {
        location.searchParams.set("error", "access_denied");
        location.searchParams.set("error_description", "only_contract_owner");
      } else if (form.get("mode") === "disabled") {
        location.searchParams.set("error", "partner_oauth_disabled");
      } else {
        const code = `rnc_${crypto.randomBytes(8).toString("base64url")}`;
        codes.set(code, { challenge: form.get("code_challenge") });
        location.searchParams.set("code", code);
      }
      res.writeHead(302, { location: location.href });
      res.end();
      return;
    }
    if (req.method === "POST" && (url.pathname === "/oauth/token" || url.pathname === "/oauth/revoke")) {
      const body = JSON.parse(await readBody(req));
      if (body.client_id !== clientId || body.client_secret !== clientSecret) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      if (url.pathname === "/oauth/revoke") {
        refreshTokens.delete(body.token);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (body.grant_type === "authorization_code") {
        if (body.mode === "disabled") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "partner_oauth_disabled" }));
          return;
        }
        const row = codes.get(body.code);
        const challenge = crypto.createHash("sha256").update(body.code_verifier).digest("base64url");
        if (!row || row.challenge !== challenge) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        codes.delete(body.code);
        const issued = issue();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(issued));
        return;
      }
      if (body.grant_type === "refresh_token") {
        if (!refreshTokens.has(body.refresh_token)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        refreshTokens.delete(body.refresh_token);
        const issued = issue();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(issued));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/userinfo") {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token.startsWith("access-")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      // T1 additive block: userinfo failure status or profile override.
      // When `userinfo` is omitted, the default profile response below is unchanged.
      const userinfoOverride = resolveMockUserinfo(userinfo, profile);
      if (userinfoOverride) {
        res.writeHead(userinfoOverride.status, { "content-type": "application/json" });
        res.end(JSON.stringify(userinfoOverride.body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(profile()));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/partner/v1/me/")) {
      handlePartnerRead(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/v1/")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "demo_api_called" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  function issue() {
    const access = `access-${crypto.randomBytes(8).toString("base64url")}`;
    const refresh = `refresh-${crypto.randomBytes(8).toString("base64url")}`;
    accessTokens.add(access);
    refreshTokens.set(refresh, true);
    issued.push({ access_token: access, refresh_token: refresh });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Number.isFinite(accessTtl) && accessTtl >= 0 ? accessTtl : 600,
      refresh_token: refresh,
      scope: "profile:read rates:read sailings:read",
    };
  }

  function handlePartnerRead(req, res, url) {
    if (nextPartnerFault != null) {
      const fault = nextPartnerFault;
      nextPartnerFault = null;
      sendPartnerFault(res, fault);
      return;
    }
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const token = match ? match[1] : "";
    if (!accessTokens.has(token)) {
      writeJson(res, 401, { error: "invalid_token" });
      return;
    }
    if (url.pathname === "/api/partner/v1/me/rates") {
      writeJson(res, 200, partnerPage(rateRows, url.searchParams));
      return;
    }
    if (url.pathname === "/api/partner/v1/me/sailings") {
      writeJson(res, 200, partnerPage(sailingRows, url.searchParams));
      return;
    }
    const rateMatch = url.pathname.match(/^\/api\/partner\/v1\/me\/rates\/([^/]+)$/);
    if (rateMatch) {
      writePartnerItem(res, rateRows, rateMatch[1], "Rate not found.");
      return;
    }
    const sailingMatch = url.pathname.match(/^\/api\/partner\/v1\/me\/sailings\/([^/]+)$/);
    if (sailingMatch) {
      writePartnerItem(res, sailingRows, sailingMatch[1], "Sailing not found.");
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  }

  return {
    server,
    calls,
    refreshTokens,
    requests,
    issued,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
    issueAccessToken() {
      return issue().access_token;
    },
    failNextPartner(fault) {
      nextPartnerFault = fault;
    },
    updateRate(id, patch) {
      const row = rateRows.find((item) => item && item.id === id);
      if (!row || !patch || typeof patch !== "object") return false;
      Object.assign(row, patch);
      return true;
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// T1: optional userinfo failure status or profile override for createMockRateNinja.
function resolveMockUserinfo(userinfo, profileFn) {
  if (!userinfo || typeof userinfo !== "object") return null;
  if (Number.isInteger(userinfo.status) && userinfo.status !== 200) {
    const body = userinfo.body && typeof userinfo.body === "object"
      ? userinfo.body
      : { error: "server_error" };
    return { status: userinfo.status, body };
  }
  if (userinfo.profile && typeof userinfo.profile === "object") {
    return { status: 200, body: { ...profileFn(), ...userinfo.profile } };
  }
  return null;
}

// T2: partner list paging and fault injection.
const PARTNER_NOTICE = "Rate and sailing records are not evidence of allocatable or transferable capacity.";

function parsePartnerPageNumber(value, fallback, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function partnerPage(rows, searchParams) {
  const page = parsePartnerPageNumber(searchParams.get("page"), 1, 10000);
  const pageSize = parsePartnerPageNumber(searchParams.get("pageSize"), 50, 100);
  const start = (page - 1) * pageSize;
  const data = rows.slice(start, start + pageSize);
  return {
    data,
    meta: {
      total: rows.length,
      page,
      pageSize,
      returned: data.length,
      notice: PARTNER_NOTICE,
    },
  };
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writePartnerItem(res, rows, segment, missingDescription) {
  let id = segment;
  try {
    id = decodeURIComponent(segment);
  } catch {
    id = segment;
  }
  const row = rows.find((item) => item && item.id === id);
  if (!row) {
    writeJson(res, 404, { error: "not_found", error_description: missingDescription });
    return;
  }
  writeJson(res, 200, { data: row, meta: { notice: PARTNER_NOTICE } });
}

function sendPartnerFault(res, fault) {
  if (fault === "non-json") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not-json");
    return;
  }
  if (typeof fault === "number") {
    const errors = {
      401: "invalid_token",
      403: "partner_oauth_disabled",
      429: "rate_limited",
      500: "server_error",
    };
    writeJson(res, fault, {
      error: errors[fault] || "error",
      error_description: errors[fault] || "error",
    });
    return;
  }
  if (fault && fault.raw != null) {
    res.writeHead(fault.status || 200, { "content-type": fault.contentType || "text/plain" });
    res.end(String(fault.raw));
    return;
  }
  if (fault && Object.prototype.hasOwnProperty.call(fault, "json")) {
    writeJson(res, fault.status || 200, fault.json);
    return;
  }
  writeJson(res, 500, { error: "server_error" });
}

module.exports = { createMockRateNinja };
