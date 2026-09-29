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

### D-11 — A rate-based offer's base price comes from Rate Ninja and cannot be typed over (2026-09-28)

For `source: rn_rate`, `baseMinor` is the chosen equipment column from a rate OceanRelay
fetched **server-side at save time**, converted to minor units with the seller-confirmed
currency's exponent (D-5; for example 1500 USD becomes 150000). The form never carries the
base price or the snapshot as trusted input. The seller may override origin, destination,
and operating carrier; each override is recorded in `overriddenFields` so the preview can
show "from Rate Ninja" versus "typed by seller". A seller who wants a different base price
uses a manual offer. This keeps the label "from Rate Ninja" true.

### D-12 — Offer ids are random and other companies' offers are "not found" (2026-09-28)

Offer ids are `crypto.randomUUID()`. A request for an offer that belongs to another
company returns the same 404 as an id that does not exist, so ids cannot be probed for
existence. This applies to every offer route until Phase 4 introduces published,
buyer-visible offers (T5), which get their own read path through `buyerView`.

### D-13 — Acceptances hash only the terms the buyer saw (2026-09-29, operator decision on F-3)

The terms hash an acceptance records (Phase 4) and the commitment written on chain
(Phase 5) cover **buyer-visible terms only**: the fields `buyerView` exposes. They exclude
the seller's `baseMinor`, `markup`, snapshot and source record id. `canonicalTerms` v1
(C-4) stays as it is and stays server-side. T6 adds a separate buyer-terms canonical form
under a new contract number. Reason: the buyer agreed to what they saw, and an unsalted
hash over the buy rate and markup could be reversed by enumeration.

### D-14 — Expiry is computed when an offer is read, not stored (2026-09-29)

A published or paused offer whose current version's validity deadline is before today
(UTC) reads as `expired`. No background job flips the stored state. Stored states are
`draft`, `published` and `paused`. `expired` is derived, and an expired offer cannot be
published, resumed or requested.

### D-15 — Offer versions: frozen at first publish, edits and status changes append (2026-09-29)

An offer has an ordered list of versions. Until the offer is first published, its only
version may be edited in place, because nobody else has seen it. Publishing freezes that
version. After that, every change a buyer could see appends a new version and makes it
current: an edit, or a capacity-status change. That keeps every published version
immutable, which T6 relies on ("an edit is a new version"). An edit keeps the version's
Rate Ninja snapshot and `baseMinor` (D-11). Repricing from a changed rate means creating
a new offer; T5 adds no refresh-from-Rate-Ninja action.

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

### C-5 — Offer record (owner: T4) — *superseded by C-7 (2026-09-29, versions added in T5)*

Stored in `records.offers[id]` (schema v1, no migration: `offers` already exists).

```
{
  id, companyId, createdBy (sub), createdAt (ISO),
  state: "draft",
  source: "rn_rate" | "manual",
  terms: <validateDraft value, plus buyerMinor>,
  snapshot: <snapshotFromRate result> | null,
  sourceRecordId: <rate id> | null,
  overriddenFields: [..],
  capacityStatus: "seller_asserted" | "carrier_pending" | "carrier_confirmed",
  statusHistory: [{ from, to, actor (sub), at (ISO) }]
}
```

`lib/records.js` methods added by T4, all synchronous through `transact`:
`createOffer(identity, fields)`, `listCompanyOffers(companyId)`,
`getCompanyOffer(companyId, id)` (null for another company's offer),
`setCapacityStatus(companyId, id, to, actorSub)` (checks `canChangeCapacityStatus`
inside the transaction). T5 adds versions (migration M-2) on top of this shape.

### C-6 — Records read path (owner: T5)

`records.view(fn)` runs `fn` over a deep copy of the current data, synchronously, and
never persists. It throws on an async `fn`, just as `transact` does. All read-only record
methods use `view`; `transact` is only for changes. Closes F-6.

### C-7 — Versioned offer record, schema v2 (owner: T5; supersedes C-5)

Records file `schemaVersion: 2`, produced from v1 by migration **M-2**.

```
{
  id, companyId, createdBy, createdAt,
  state: "draft" | "published" | "paused",   // "expired" is derived (D-14)
  publishedAt: ISO | null,
  currentVersion: <n>,
  versions: [
    { n, createdAt, createdBy, source, terms, snapshot, sourceRecordId,
      overriddenFields, capacityStatus, frozen: bool }
  ],
  statusHistory: [{ from, to, actor, at, version }],   // capacity status, all versions
  stateHistory:  [{ from, to, actor, at }]             // draft/published/paused
}
```

M-2 turns each v1 offer into one with `state: "draft"`, `publishedAt: null`,
`currentVersion: 1`, and a single unfrozen version 1 carrying the v1 `source`, `terms`,
`snapshot`, `sourceRecordId`, `overriddenFields`, `capacityStatus`, `createdAt` and
`createdBy`. The v1 `statusHistory` entries gain `version: 1`, and `stateHistory` starts
empty.

Before the first write, M-2 copies the v1 file byte-for-byte to `<path>.pre-m2.bak`
(mode 0600, never overwritten if it already exists). Unknown top-level keys are kept.
`schemaVersion` above 2 throws.
