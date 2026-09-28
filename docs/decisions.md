# OceanRelay decisions

Numbered and append-only. Cite by number (`D-7`) instead of re-deciding. Never renumber.
To change a decision, add a new one and mark the old one **Superseded by D-n (date, reason)**
in place. The planner owns this file; workers propose changes in their handoff.

Interface contracts are numbered separately (`C-n`) in the second half of this file.

---

## Decisions

### D-1 — Offers belong to a Rate Ninja company, not a browser session (2026-09-28)

Today `lib/store.js` keys connections by the OceanRelay session id (`sid`). That is fine for
tokens but wrong for business records: the same person in two browsers is two connections.
Every offer, request, and audit row is keyed by the Rate Ninja identity captured at connect
time: `companyId` owns the record, `sub` is the actor. Authorization checks compare the
record's `companyId` with the connected session's `profile.companyId`, server-side. No
company or user id is ever read from a form field or query string (PRD: "OceanRelay trusts
that company from the Rate Ninja grant, never from a value the browser sends").

### D-2 — A connection without a usable identity is not a connection (2026-09-28)

Verified in `server.js` `handleCallback`: when `/oauth/userinfo` fails, the connection is
saved anyway with an empty profile (`sub: ""`, `companyId: ""`). That produces a
"connected" session with no identity, which D-1 cannot authorize. From T1 onward the
callback refuses the connection (and revokes the just-issued refresh token) when userinfo
fails, `sub` or `companyId` is empty, `active` is false, or `companyType` is not exactly
`"Contract Owner"` (Rate Ninja's constant, `rateninja/lib/constants.js`). Rate Ninja already
refuses customer companies; this is defence in depth, not a replacement.

### D-3 — Business records live in a separate JSON store with synchronous mutations (2026-09-28)

Options considered: extend `lib/store.js`; `node:sqlite`; a new JSON records file.
Chosen: a new module `lib/records.js` persisting to its own file (default
`data/oceanrelay-records.json`, env `OCEANRELAY_RECORDS_PATH`; on Render the same persistent
disk as the token store).

Reasons: `lib/store.js` holds token ciphertext and its loader **silently drops unknown
top-level keys** (`openStore` rebuilds `data` from `pending` and `connections` only), so
mixing offers into it is a data-loss trap. `node:sqlite` is still flagged experimental on
Node 22 and adds a runtime-version dependency on Render we have not verified. Pilot volume
is dozens of offers.

The concurrency rule that makes this safe: **every mutation that checks-then-writes
(availability, version, status) runs synchronously, with no `await` between the check and
the persist.** Node's single thread then makes it atomic. Render persistent disks limit the
service to one instance, so in-process atomicity is sufficient. If the service is ever
scaled past one instance, this decision must be superseded first.

### D-4 — The records file carries a schema version and numbered migrations (2026-09-28)

`schemaVersion` is an integer at the top of the records file. Migrations are numbered
`M-1`, `M-2`, … and pre-assigned in the plan. The loader refuses to start on a
`schemaVersion` newer than it knows, rather than dropping fields.

### D-5 — Money is integer minor units; currency is seller-confirmed from an allowlist (2026-09-28)

Rate Ninja returns whole-number amounts (`baseRateAmount` rounds with `Math.round`) and
`currency: null`. OceanRelay stores every amount as an integer in minor units plus an ISO
4217 code chosen by the seller from an allowlist with known exponents (initially USD, EUR,
GBP, CNY, HKD, SGD at exponent 2; JPY, KRW at exponent 0). Percentage markup is stored in
basis points. Buyer price = base + markup, rounded half-up to the minor unit, computed once
at save and stored (not recomputed on read).

### D-6 — Rate Ninja equipment is a column choice, and 0 means "no price" (2026-09-28)

Verified in `rateninja/lib/visibility.js` `partnerRateDto`: a rate has `rate20D`, `rate40D`,
`rate40HC`, not an equipment field, and a missing source value becomes `0`, not `null`. An
offer from a rate therefore picks one equipment column, and a column whose value is `0` is
shown as "no price on this rate for this equipment" and cannot seed an offer price.

### D-7 — Rate Ninja snapshot is the whole partner DTO, frozen at retrieval (2026-09-28)

When a seller builds an offer from a rate, OceanRelay stores the full rate DTO as returned
(`data` of `GET /api/partner/v1/me/rates/{id}`), OceanRelay's own `retrievedAt`, and the
field names the seller overrode. The snapshot is never updated. A later read that differs
or shows the rate expired produces a warning to the owner, never an edit (PRD Phase 3).

### D-8 — Capacity status never derives from Rate Ninja data (2026-09-28)

New offers are `seller_asserted`. The only way to `carrier_pending` or `carrier_confirmed`
is an explicit seller action recorded with actor and time. No code path maps any Rate Ninja
field to a capacity status. `allocationEvidence: false` and `capacityQuantity: null` from
Rate Ninja are ignored for status.

### D-9 — Server-rendered HTML, no client framework, no new runtime dependencies (2026-09-28)

The service has zero npm dependencies today. Phases 3–4 stay server-rendered with
POST-redirect-GET forms and the existing CSRF token. Adding any runtime dependency needs a
new decision. Phase 5 (wallet signatures, chain calls) will need one; that is decided when
Phase 5 is planned.

### D-10 — Phase 3 code starts before Phase 2's deployed checks finish (2026-09-28)

The PRD says Phase 3 starts after Phase 2 is done, and Phase 2's own "Left" defers the
refused-company, empty-rate, and revoke checks. Code work for Phase 3 does not depend on
those checks, so it starts now. **Phase 3 is not accepted** until operator checks O-1 and
O-2 (disconnect, revoke) pass on the deployed service, because Phase 3 is the first phase
that relies on refresh after the 10-minute access token expires.

---

## Interface contracts

A contract is the surface other tasks build on. The task named as owner publishes it; later
tasks consume it without changing it. Changing a published contract is a new contract
number.

### C-1 — Route module interface (owner: T1)

`lib/routes/<area>.js` exports `register(router, deps)`. `router.get(path, handler)` and
`router.post(path, handler)` register exact-path handlers; `router.pattern(method, regex,
handler)` handles ids in the path. `deps` includes `{ config, store, records, rn, render,
requireIdentity }`. `server.js` builds the router and calls each area's `register`; adding
an area is one line in `server.js`'s area list and nothing else.

`requireIdentity(req, res)` returns `{ session, identity }` where `identity` is
`{ sub, companyId, companyName, name }` from the stored connection, or sends the
not-connected response and returns `null`. POST handlers must also verify the CSRF token
(existing `safeEqual` pattern).

### C-2 — Records store (owner: T1)

`openRecords(filePath)` returns an object whose mutating methods are synchronous (D-3).
T1 ships the file format (`{ schemaVersion: 1, offers: {}, audit: [] }`, migration M-1),
atomic write (tmp + rename, mode 0600), `schemaVersion` check (D-4), and a generic
`transact(fn)` that runs `fn(data)` synchronously and persists once. Domain methods for
offers are added by T4 in `lib/records.js` on top of `transact`.

### C-3 — Rate Ninja partner reads (owner: T2)

In `lib/rate-ninja.js`: `listRates(fetchImpl, config, accessToken, { page, pageSize })`,
`getRate(..., rateId)`, `listSailings(...)`, `getSailing(..., sailingId)`. Each returns
`{ ok: true, data, meta, retrievedAt }` or `{ ok: false, error }` with `error` one of
`unauthorized` (401), `forbidden` (403, including `partner_oauth_disabled`), `not_found`,
`rate_limited` (429), `network_error`, `bad_response`. No retries inside the client. Never
sends any API key header. Plus `listAllRates` that walks pages up to a cap of 10 pages ×
100 and reports `truncated: true` beyond it.

### C-4 — Offer domain (owner: T3)

Pure module `lib/offer-domain.js`, no I/O. Exports:
`validateDraft(input) → { ok, value, errors }`, `priceBuyer({ baseMinor, markup }) →
buyerMinor`, `snapshotFromRate(rateDto, equipment, retrievedAt)`, `canonicalTerms(offerVersion)
→ string` (stable key order, versioned with `"v": 1`), `termsHash(canonical) → hex sha256`,
`buyerView(offer)` (projection that omits base price, markup, snapshot, and private notes),
`CAPACITY_STATUSES`, `canChangeCapacityStatus(from, to)`, `CURRENCIES`.
The salted on-chain commitment (Phase 5) is a separate function added later; `termsHash`
here is unsalted and never leaves the server.

*Amended 2026-09-28 (planner documentation error, no behaviour change):* the T3 prompt
also required `sourceWarnings` and the shared caveat strings, which this list omitted.
As merged in T3, C-4 also exports `sourceWarnings`, `SELLER_CLAIM_CAVEAT`,
`CARRIER_CONFIRMED_CAVEAT`, `CAPACITY_CAVEATS`, `LIMITS`, `SOURCES`, `EQUIPMENT`, `UNITS`.
The field set hashed by `canonicalTerms` v1 is listed in the comment above that function in
`lib/offer-domain.js`. Whether acceptances use it is open (plan §6, F-3).
