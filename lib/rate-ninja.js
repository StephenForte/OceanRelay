const SCOPES = ["profile:read", "rates:read", "sailings:read"];

function sameOrigin(left, right) {
  return new URL(left).origin === new URL(right).origin;
}

function defaultEndpoints(issuer) {
  return {
    authorization: new URL("/oauth/authorize", issuer).href,
    token: new URL("/oauth/token", issuer).href,
    revocation: new URL("/oauth/revoke", issuer).href,
    userinfo: new URL("/oauth/userinfo", issuer).href,
  };
}

async function discoverEndpoints(issuer, fetchImpl) {
  const fallback = defaultEndpoints(issuer);
  try {
    const response = await fetchImpl(new URL("/.well-known/oauth-authorization-server", issuer), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return fallback;
    const metadata = await response.json();
    const endpoints = {
      authorization: metadata.authorization_endpoint,
      token: metadata.token_endpoint,
      revocation: metadata.revocation_endpoint,
      userinfo: metadata.userinfo_endpoint,
    };
    if (metadata.issuer && !sameOrigin(metadata.issuer, issuer)) return fallback;
    for (const value of Object.values(endpoints)) {
      if (typeof value !== "string" || !sameOrigin(value, issuer)) return fallback;
    }
    const expectedPaths = ["/oauth/authorize", "/oauth/token", "/oauth/revoke", "/oauth/userinfo"];
    const paths = Object.values(endpoints).map((value) => new URL(value).pathname);
    if (expectedPaths.some((path, index) => paths[index] !== path)) return fallback;
    return endpoints;
  } catch {
    return fallback;
  }
}

function authorizeUrl(endpoint, { clientId, redirectUri, state, challenge }) {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

async function postForm(fetchImpl, endpoint, body) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof payload.error === "string" ? payload.error : "token_endpoint_error",
    };
  }
  return { ok: true, status: response.status, body: payload };
}

function tokenRequest(config, extra) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...extra,
  };
}

async function exchangeCode(fetchImpl, endpoints, config, { code, verifier }) {
  const result = await postForm(fetchImpl, endpoints.token, tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  }));
  if (!result.ok) return result;
  if (typeof result.body.access_token !== "string" || typeof result.body.refresh_token !== "string") {
    return { ok: false, status: 502, error: "invalid_token_response" };
  }
  return result;
}

async function refreshToken(fetchImpl, endpoints, config, refreshTokenValue) {
  return postForm(fetchImpl, endpoints.token, tokenRequest(config, {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
  }));
}

async function revokeToken(fetchImpl, endpoints, config, token) {
  return postForm(fetchImpl, endpoints.revocation, tokenRequest(config, { token }));
}

async function fetchUserInfo(fetchImpl, endpoints, accessToken) {
  const response = await fetchImpl(endpoints.userinfo, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    return { ok: false, error: typeof payload.error === "string" ? payload.error : "userinfo_failed" };
  }
  return {
    ok: true,
    profile: {
      sub: payload.sub || "",
      name: payload.name || "",
      companyId: payload.companyId || "",
      companyName: payload.companyName || "",
      companyType: payload.companyType || "",
      active: payload.active !== false,
    },
  };
}

module.exports = {
  discoverEndpoints,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  revokeToken,
  fetchUserInfo,
};
