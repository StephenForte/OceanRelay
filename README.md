# OceanRelay

OceanRelay connects a contract-owner Rate Ninja account. The Rate Ninja OAuth client may still be named Capacity Exchange.

`npm start` runs the HTTP service on `0.0.0.0:$PORT`. `GET /health` returns `{"status":"ok"}`.

## Environment variables

Set these on the server. Do not commit the values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | yes | Listen port. Render sets this. |
| `RATE_NINJA_CLIENT_ID` | yes | OAuth client id from the Rate Ninja admin screen. |
| `RATE_NINJA_CLIENT_SECRET` | yes | Confidential client secret. Stays on the server. |
| `OCEANRELAY_REDIRECT_URI` | yes | Registered callback. Production value: `https://oceanrelay.onrender.com/oauth/callback`. Local callbacks may be `http://localhost` or `http://127.0.0.1`. |
| `SESSION_SECRET` | yes | Signs the OceanRelay session cookie. |
| `TOKEN_ENCRYPTION_KEY` | yes | Encrypts refresh tokens at rest. |
| `RATE_NINJA_BASE_URL` | no | Defaults to `https://rateninja.co`. |
| `OCEANRELAY_STORE_PATH` | no | Encrypted token store. Defaults to `data/oceanrelay-store.json`. On Render, point this at a persistent disk because the service filesystem is ephemeral. |

`GET /config` reports which of these are missing or invalid. It does not return secret values.

The browser session cookie is `oceanrelay_session`. It does not contain the Rate Ninja access token, refresh token, or client secret. Access tokens stay in server memory. Refresh tokens are encrypted in the store. Disconnect calls Rate Ninja `POST /oauth/revoke`.

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Only a contract-owner Rate Ninja account can approve. Customer accounts are denied.

## Rate Ninja admin

On the OAuth client, save the redirect `https://oceanrelay.onrender.com/oauth/callback`. After that redirect is saved, set `PARTNER_OAUTH_ENABLED=true` on Rate Ninja. Until that flag is on, authorize and token calls return `partner_oauth_disabled`.
