const http = require("node:http");
const crypto = require("node:crypto");

function createMockRateNinja({ clientId, clientSecret }) {
  const codes = new Map();
  const refreshTokens = new Map();
  const calls = [];

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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(profile()));
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
    refreshTokens.set(refresh, true);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 600,
      refresh_token: refresh,
      scope: "profile:read rates:read sailings:read",
    };
  }

  return {
    server,
    calls,
    refreshTokens,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
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

module.exports = { createMockRateNinja };
