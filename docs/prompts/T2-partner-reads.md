# T2 — Rate Ninja partner reads client

You are implementing one task in the OceanRelay repository (a zero-dependency Node web
service). Other agents are working in parallel; file scope is strict.

**Read first:** `docs/plan.md` (§1 "Rate Ninja facts", §2 contract applies in full),
`docs/decisions.md` (D-5, D-6, D-7, C-3), `docs/oceanrelay-prd.md` (Standing rules).
Then `lib/rate-ninja.js` and `test/mock-rate-ninja.js` on current `main`. **Verify claims
in this prompt against the code before relying on them.**

**Branch:** `task/T2-partner-reads` from current `main`.

## Why this exists

The PRD says Phase 1 lets OceanRelay read the owner's rates and sailings. That is true of
Rate Ninja. OceanRelay has no code that calls those endpoints: `lib/rate-ninja.js` only
implements OAuth, revoke, and userinfo. Phase 3 needs rate reads to build offers.

## What to build (C-3)

Add to `lib/rate-ninja.js`, without changing existing exports' behaviour:

- `listRates(fetchImpl, config, accessToken, { page, pageSize })`,
  `getRate(fetchImpl, config, accessToken, rateId)`,
  `listSailings(...)`, `getSailing(..., sailingId)`.
  URLs: `${config.issuer}/api/partner/v1/me/rates`, `/rates/{id}`, `/sailings`,
  `/sailings/{id}`. `rateId` and `sailingId` must be URL-path-encoded.
- Success: `{ ok: true, data, meta, retrievedAt }`. `retrievedAt` is OceanRelay's own ISO
  timestamp taken when the response arrived. Rate Ninja's `updatedAt` and `currency` are
  null and must be passed through unchanged, not filled in.
- Failure: `{ ok: false, status, error }` with `error` one of `unauthorized` (401),
  `forbidden` (403, including a body error of `partner_oauth_disabled`, which you also
  expose as `detail`), `not_found` (404), `rate_limited` (429), `network_error`,
  `bad_response` (non-JSON, or `data` missing or the wrong type). No retries.
- `listAllRates(fetchImpl, config, accessToken)`: walks pages at `pageSize=100` up to 10
  pages. Returns `{ ok, data, retrievedAt, truncated }`. Stops early when a page returns
  fewer than `pageSize` rows or when `meta.total` is reached. Any page failing fails the
  whole call (a partial rate list presented as complete would mislead the seller).
- Every request: `Authorization: Bearer <token>`, `Accept: application/json`,
  `redirect: "error"`, and a timeout (`AbortSignal.timeout(10000)`).

## The trap

**Empty is success.** A contract owner with no rates gets HTTP 200 with `data: []`. That
must return `{ ok: true, data: [] }`, never an error; it is the path to manual entry
(PRD Standing rules). Similarly `listAllRates` on an empty account makes exactly one
request. Assert the request count.

The second trap: **amounts of `0` are "no price", not free** (D-6). This client does not
reinterpret them; it returns the DTO as sent. Do not "clean up" zeros to null here. T3
and T4 handle the meaning. Add a test that a `rate40D: 0` passes through as `0`.

## Must not change

- `discoverEndpoints`, `authorizeUrl`, `exchangeCode`, `refreshToken`, `revokeToken`,
  `fetchUserInfo`: same signatures and behaviour.
- No API key, `x-api-key`, or `/api/v1/` call anywhere (PRD: demo API not used for a
  signed-in user). Add a test that inspects the mock's recorded calls and headers.

## File scope

- **Owned:** `lib/rate-ninja.js` (add functions and exports only), `test/partner-reads.test.js` (new).
- **Shared, additive only:** `test/mock-rate-ninja.js`. Add a `rates` and `sailings`
  option to `createMockRateNinja` (default empty arrays), handlers for the four partner
  paths with bearer-token checking against the mock's issued access tokens, paging via
  `page`/`pageSize`, and a switch to make the next response 401/403/429/500 or non-JSON.
  Record request headers so tests can assert no API key is sent. T1 is adding a userinfo
  option to the same file at the same time; keep your code in its own block and do not
  reorder existing code. Use fixture rows shaped exactly like the DTOs in `docs/plan.md` §1.
- **Off-limits:** `server.js`, `lib/routes/*`, `lib/records.js`, `lib/config.js`,
  `package.json` (T1 owns these), `lib/offer-domain.js` (T3), all of `docs/`.

No route, page, or UI in this task. If you need one to test, you don't; test the client
directly against the mock. If you need to change an off-limits file, stop and report.

## Tests that must exist

- Empty account: `listRates` and `listSailings` return ok with `[]`; `listAllRates` makes
  one request.
- 230 rates: `listAllRates` returns 230 in 3 requests, `truncated: false`.
- 1,050 rates: 10 requests, `truncated: true`.
- A failure on page 2 fails the whole `listAllRates`.
- Each error mapping: 401, 403 with `partner_oauth_disabled`, 404, 429, network error,
  non-JSON body.
- `getRate` with an id containing `/` is encoded and does not hit a different path.
- `currency`, `updatedAt` stay `null`; `rate40D: 0` stays `0`; `retrievedAt` is set.
- No request carries an API key header or goes to `/api/v1/`.

## Gate

Per `docs/plan.md` §2. Until T1 merges, `npm test` only runs `test/connect.test.js`; run
`node --test "test/*.test.js"` and report that count.

## Disagree if needed

If the C-3 shape is wrong for how Phase 3 will use it, say so and argue it in the handoff.

## Hand back

The block in `docs/prompts/HANDOFF.md`. Contract: C-3. Migration: none.
