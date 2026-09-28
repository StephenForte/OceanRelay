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
  let fallback;
  try {
    fallback = defaultEndpoints(issuer);
  } catch {
    return null;
  }
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
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
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

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 10;

function failure(status, error, extra) {
  return extra ? { ok: false, status, error, ...extra } : { ok: false, status, error };
}

function partnerCollectionUrl(issuer, collection, query) {
  const url = new URL(`/api/partner/v1/me/${collection}`, issuer);
  if (query && query.page != null) url.searchParams.set("page", String(query.page));
  if (query && query.pageSize != null) url.searchParams.set("pageSize", String(query.pageSize));
  return url;
}

function partnerItemUrl(issuer, collection, id) {
  const encoded = encodeURIComponent(String(id));
  return new URL(`/api/partner/v1/me/${collection}/${encoded}`, issuer);
}

function dataShapeOk(data, kind) {
  if (kind === "list") return Array.isArray(data);
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

function listedTotal(meta) {
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.total !== "number" || !Number.isFinite(meta.total)) return null;
  return meta.total;
}

async function partnerGet(fetchImpl, url, accessToken, kind) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return failure(0, "network_error");
  }

  const retrievedAt = new Date().toISOString();
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    if (err && err.name === "SyntaxError") return failure(response.status, "bad_response");
    return failure(0, "network_error");
  }

  if (!response.ok) {
    if (response.status === 403 && payload && payload.error === "partner_oauth_disabled") {
      return failure(403, "forbidden", { detail: "partner_oauth_disabled" });
    }
    const mapped = {
      401: "unauthorized",
      403: "forbidden",
      404: "not_found",
      429: "rate_limited",
    };
    return failure(response.status, mapped[response.status] || "bad_response");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !dataShapeOk(payload.data, kind)) {
    return failure(response.status, "bad_response");
  }

  return {
    ok: true,
    data: payload.data,
    meta: payload.meta,
    retrievedAt,
  };
}

async function listRates(fetchImpl, config, accessToken, query) {
  let url;
  try {
    url = partnerCollectionUrl(config.issuer, "rates", query);
  } catch {
    return failure(0, "network_error");
  }
  return partnerGet(fetchImpl, url, accessToken, "list");
}

async function getRate(fetchImpl, config, accessToken, rateId) {
  let url;
  try {
    url = partnerItemUrl(config.issuer, "rates", rateId);
  } catch {
    return failure(0, "network_error");
  }
  return partnerGet(fetchImpl, url, accessToken, "item");
}

async function listSailings(fetchImpl, config, accessToken, query) {
  let url;
  try {
    url = partnerCollectionUrl(config.issuer, "sailings", query);
  } catch {
    return failure(0, "network_error");
  }
  return partnerGet(fetchImpl, url, accessToken, "list");
}

async function getSailing(fetchImpl, config, accessToken, sailingId) {
  let url;
  try {
    url = partnerItemUrl(config.issuer, "sailings", sailingId);
  } catch {
    return failure(0, "network_error");
  }
  return partnerGet(fetchImpl, url, accessToken, "item");
}

async function listAllRates(fetchImpl, config, accessToken) {
  const data = [];
  let retrievedAt;
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const result = await listRates(fetchImpl, config, accessToken, {
      page,
      pageSize: LIST_PAGE_SIZE,
    });
    if (!result.ok) return result;
    retrievedAt = result.retrievedAt;
    for (const row of result.data) data.push(row);
    const total = listedTotal(result.meta);
    const reachedEnd = result.data.length < LIST_PAGE_SIZE || (total !== null && data.length >= total);
    if (reachedEnd) return { ok: true, data, retrievedAt, truncated: false };
  }
  return { ok: true, data, retrievedAt, truncated: true };
}

module.exports = {
  discoverEndpoints,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  revokeToken,
  fetchUserInfo,
  listRates,
  getRate,
  listSailings,
  getSailing,
  listAllRates,
};
