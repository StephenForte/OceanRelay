function register(router, deps) {
  router.get("/", handleHome);
  router.post("/connect", handleConnect);
  router.get("/oauth/callback", handleCallback);
  router.post("/disconnect", handleDisconnect);

  async function handleHome(req, res, url) {
    const { session } = deps.sessionFromRequest(req);
    if (session) {
      const existing = deps.store.publicConnection(session.sid);
      if (existing && deps.identityRefusal(existing.profile, false)) {
        const secrets = deps.store.connectionSecrets(session.sid);
        deps.store.deleteConnection(session.sid);
        deps.forgetAccessToken(session.sid);
        try {
          const ready = await deps.endpoints();
          await deps.revokeRefreshToken(ready, secrets && secrets.refreshToken);
        } catch {
          // The row is already gone. A failed revoke still leaves the page disconnected.
        }
      } else if (existing) {
        try {
          const ready = await deps.endpoints();
          if (ready) {
            const access = await deps.ensureAccessToken(session.sid, ready);
            if (!access.ok && access.disconnect) deps.store.deleteConnection(session.sid);
          }
        } catch {
          console.error("connection_refresh_failed");
        }
      }
    }
    const connection = session ? deps.store.publicConnection(session.sid) : null;
    const html = deps.render({
      configView: deps.publicConfig(deps.config),
      connection,
      csrf: session ? session.csrf : "",
      result: url.searchParams.get("result") || "",
    });
    deps.sendHtml(res, 200, html, deps.cookieFor(req, session));
  }

  async function handleConnect(req, res) {
    const { session } = deps.sessionFromRequest(req);
    const cookies = deps.cookieFor(req, session);
    const form = deps.formBody(await deps.readBody(req));
    if (!deps.config.ok || !session) {
      deps.redirect(res, "/?result=config_incomplete", cookies);
      return;
    }
    if (!deps.safeEqual(form.csrf_token || "", session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const pkce = deps.createPkce();
    deps.store.savePending(session.sid, { state: pkce.state, verifier: pkce.verifier, createdAt: Date.now() });
    const ready = await deps.endpoints();
    deps.redirect(res, deps.rn.authorizeUrl(ready.authorization, {
      clientId: deps.config.clientId,
      redirectUri: deps.config.redirectUri,
      state: pkce.state,
      challenge: pkce.challenge,
    }), cookies);
  }

  async function handleCallback(req, res, url) {
    const { session } = deps.sessionFromRequest(req);
    const cookies = deps.cookieFor(req, session);
    if (!deps.config.ok || !session) {
      deps.redirect(res, "/?result=config_incomplete", cookies);
      return;
    }
    const oauthError = url.searchParams.get("error");
    const description = url.searchParams.get("error_description") || "";
    if (oauthError) {
      deps.store.takePending(session.sid, url.searchParams.get("state") || "");
      if (oauthError === "access_denied" && description === "only_contract_owner") {
        deps.redirect(res, "/?result=only_contract_owner", cookies);
        return;
      }
      if (oauthError === "access_denied") {
        deps.redirect(res, "/?result=access_denied", cookies);
        return;
      }
      deps.redirect(res, `/?result=${encodeURIComponent(oauthError === "partner_oauth_disabled" ? oauthError : "token_exchange_failed")}`, cookies);
      return;
    }
    const pending = deps.store.takePending(session.sid, url.searchParams.get("state") || "");
    const code = url.searchParams.get("code") || "";
    if (!pending || !code) {
      deps.redirect(res, "/?result=invalid_state", cookies);
      return;
    }
    const ready = await deps.endpoints();
    const exchanged = await deps.rn.exchangeCode(deps.fetchImpl, ready, deps.config, { code, verifier: pending.verifier });
    if (!exchanged.ok) {
      const result = exchanged.error === "partner_oauth_disabled" ? "partner_oauth_disabled" : "token_exchange_failed";
      deps.redirect(res, `/?result=${result}`, cookies);
      return;
    }
    let profileResult;
    try {
      profileResult = await deps.rn.fetchUserInfo(deps.fetchImpl, ready, exchanged.body.access_token);
    } catch {
      profileResult = { ok: false };
    }
    const profile = profileResult.ok ? profileResult.profile : null;
    const refusal = deps.identityRefusal(profile, !profileResult.ok);
    if (refusal) {
      await deps.revokeRefreshToken(ready, exchanged.body.refresh_token);
      deps.redirect(res, `/?result=${refusal}`, cookies);
      return;
    }
    const scopes = typeof exchanged.body.scope === "string" && exchanged.body.scope.trim()
      ? exchanged.body.scope.trim().split(/\s+/)
      : deps.config.scopes;
    deps.store.saveConnection(session.sid, {
      refreshToken: exchanged.body.refresh_token,
      scopes,
      profile,
    });
    deps.rememberAccessToken(session.sid, exchanged.body.access_token, exchanged.body.expires_in);
    deps.redirect(res, "/?result=connected", cookies);
  }

  async function handleDisconnect(req, res) {
    const { session } = deps.sessionFromRequest(req);
    const cookies = deps.cookieFor(req, session);
    const form = deps.formBody(await deps.readBody(req));
    if (!session || !deps.safeEqual(form.csrf_token || "", session.csrf)) {
      deps.sendJson(res, 403, { error: "invalid_csrf" });
      return;
    }
    const stored = deps.store.connectionSecrets(session.sid);
    if (!stored) {
      if (deps.store.publicConnection(session.sid)) deps.store.deleteConnection(session.sid);
      deps.forgetAccessToken(session.sid);
      deps.redirect(res, "/?result=disconnected", cookies);
      return;
    }
    let ready;
    try {
      ready = await deps.endpoints();
    } catch {
      ready = null;
    }
    if (!ready) {
      deps.redirect(res, "/?result=revoke_failed", cookies);
      return;
    }
    const revoked = await deps.rn.revokeToken(deps.fetchImpl, ready, deps.config, stored.refreshToken);
    if (!revoked.ok && revoked.error !== "partner_oauth_disabled") {
      deps.redirect(res, "/?result=revoke_failed", cookies);
      return;
    }
    deps.store.deleteConnection(session.sid);
    deps.forgetAccessToken(session.sid);
    deps.redirect(res, "/?result=disconnected", cookies);
  }
}

module.exports = { register };
