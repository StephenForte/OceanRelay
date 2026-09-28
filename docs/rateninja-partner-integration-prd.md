# RateNinja–OceanRelay Partner Integration PRD

**Status:** RN implementation deployed; OceanRelay production access is still disabled pending client setup and security-gate acceptance  
**RN service:** [rateninja.co](https://rateninja.co)  
**RN repository:** [StephenForte/RateNinja](https://github.com/StephenForte/RateNinja)  
**Consumer:** OceanRelay, a separate application and repository

## 1. Purpose

This PRD records the RateNinja work completed for OceanRelay and the remaining steps to activate the integration. RN is the identity and rate/sailing source. OceanRelay never receives an RN password and never uses RN's demo API key for an authenticated user's data.

## 2. What RateNinja has delivered

RN has implemented and deployed the partner authorization and data surfaces below. Production OAuth/API/MCP remain feature-gated off until OceanRelay's client callback is registered, the RN security gates are accepted, and `PARTNER_OAUTH_ENABLED=true` is set on the Render service. While the flag is off, these routes return `partner_oauth_disabled`.

### Account and password security

- Passwords use Argon2id hashes.
- Legacy plaintext password values are cleared on startup. Users without a password hash need an administrator-set password; RN does not silently migrate the old value.
- Password reset, optional two-factor authentication, and CSRF protection for state-changing browser requests are implemented/documented.

### OAuth-style RN sign-in

- Authorization code flow with PKCE `S256`; RN login and consent occur on the RN origin.
- Only contract-owner accounts can approve OceanRelay. Customer accounts are denied.
- Contract-owner accounts with no rates may still authorize, receive empty rate/sailing lists, and use manual entry in OceanRelay.
- Authorization code: 60 seconds, single use.
- Access token: 10 minutes, audience `rn:partner-api`.
- Refresh token: 30 days, rotated on each use. Reuse of an old token revokes that token family.
- Revocation is enforced on the next REST or MCP call.
- Exact callback allowlisting: `http://localhost` and `http://127.0.0.1` are allowed for local development; all other callbacks must use HTTPS and match the registered URL.
- Confidential clients send the client secret only from their backend. Public clients such as an individual MCP client do not send a secret.
- RN supports consent review/revocation and OAuth discovery metadata.

### Partner REST API and MCP

Scopes: `profile:read`, `rates:read`, and `sailings:read`.

| Endpoint/tool | Purpose |
|---|---|
| `GET /oauth/userinfo` | RN subject, display name, company, active status; requires `profile:read` |
| `GET /api/partner/v1/me/rates` | Authenticated contract owner's base/contract rates |
| `GET /api/partner/v1/me/rates/{rateId}` | One rate available to that owner |
| `GET /api/partner/v1/me/sailings` | Authenticated contract owner's sailing records |
| `GET /api/partner/v1/me/sailings/{sailingId}` | One sailing available to that owner |
| `POST /mcp` | MCP endpoint with the same user/scopes as REST |
| `rateninja_get_my_profile` | MCP profile/company/scopes |
| `rateninja_list_my_rates`, `rateninja_get_my_rate` | MCP rate reads |
| `rateninja_list_my_sailings`, `rateninja_get_my_sailing` | MCP sailing reads |

Other implemented account endpoints include `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/consents`, `DELETE /oauth/consents/{clientId}`, `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource`.

Rate and sailing responses are the authenticated owner's base/contract records, not customer-margin prices. Empty lists return HTTP 200. Responses use `Cache-Control: no-store`. Currency and source-updated time are currently `null`.

## 3. Important boundary: RN data is not capacity

RN provides rates, contract owners, and sailing records. It does **not** provide allocation quantities, transferable rights, carrier booking inventory, or carrier verification. An RN contract rate or sailing cannot be treated as evidence that a forwarder can book or transfer space.

OceanRelay owns manual capacity claims, quantity, the seller-selected code-share name, stated operating carrier, buyer requests, and transaction lifecycle. It records who made a claim and what counterparties accepted, without representing RN or the chain as proof of the claim. OceanRelay should ask sellers to confirm currency because RN currently returns `null`.

## 4. Remaining activation steps

1. Rename the first RN OAuth client from **Capacity Exchange** to **OceanRelay**.
2. Register OceanRelay's exact HTTPS callback URL on the RN client.
3. Create or rotate the confidential client secret. Store it only in OceanRelay's backend secret manager; it is shown once by RN.
4. Complete/accept the RN partner-integration security gates, including password recovery for accounts whose legacy plaintext value was cleared.
5. Configure OceanRelay to request only the required scopes and store tokens server-side; never put the client secret or refresh token in browser storage.
6. Set `PARTNER_OAUTH_ENABLED=true` on Render only after the above are complete.
7. Run the activation walkthrough below before inviting pilot users.

## 5. Activation acceptance checklist

- Contract-owner user can log into RN, review consent, and connect OceanRelay.
- RN customer account cannot authorize OceanRelay.
- Contract-owner account with no visible rates still connects; rate and sailing calls return empty HTTP 200 lists and OceanRelay offers manual entry.
- RN-linked rates and sailings are scoped to the signed-in owner; margin-adjusted customer prices are not returned.
- OceanRelay treats RN currency and source-updated time as unknown (`null`) and records its own retrieval timestamp.
- Revoke in RN, then confirm refresh and the next REST/MCP request are denied.
- RN's global `RATE_NINJA_API_KEY` is never sent to or used by OceanRelay.
- OAuth/API/MCP are unavailable while `PARTNER_OAUTH_ENABLED` is off and function only after the activation gate.

## 6. Ownership

- **RateNinja owns:** RN accounts and passwords, company type, source rates and sailings, OAuth clients/grants, partner REST API, and MCP tools.
- **OceanRelay owns:** the separate app/service, offer records, manual capacity claims, code-share names, operating-carrier labels, buyer requests, and marketplace lifecycle.
- **ForteL2 owns no RN data:** it records selected OceanRelay lifecycle commitments and does not certify capacity claims.
