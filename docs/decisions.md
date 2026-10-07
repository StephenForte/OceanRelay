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

### D-16 — Operators are named by an environment variable for the pilot (2026-09-29, operator decision on O-8)

`OCEANRELAY_OPERATOR_SUBS` is a comma-separated list of Rate Ninja user ids (`sub`). A
signed-in user whose `sub` is on the list may use operator screens. Everyone else gets
the same 404 as an unknown page. Rules:
- The list is read from the environment at startup.
- It is checked server-side on every operator route.
- It is never editable from inside OceanRelay.
- `/config` shows only a count of configured operators, never the ids.

Adding or removing an operator means editing the setting in Render, which restarts the
service.

Why: no in-app path can grant operator rights, and there is no bootstrap problem. It is
enough for the handful of operators in an invite-only pilot. It keeps no history of who
was an operator when, beyond Render's own event log.

Revisit if operators change often or number more than a few. The next step would be
records-backed roles with a grant screen and audit entries, keeping this variable only
to name the first admin.

T8 must show the signed-in user their Rate Ninja `sub` on the home page, so the value
can be copied into the setting.

### D-17 — The marketplace is a separate, signed-in read path (2026-09-29)

Other companies read offers only through `/market` and `/market/:id`. Those routes are
built solely from `buyerView` of the offer's current version.
- **Who can see it:** any connected contract owner (`requireIdentity`). There is no public
  or anonymous view (PRD: no marketplace without a Rate Ninja account).
- **What is listed:** an offer appears only when its stored state is `published`, it is
  not derived-expired (D-14), and its current version is `frozen`.
- **Everything else is 404:** draft, paused, expired and unknown ids get the same 404 body.
- **Seller routes are unchanged:** `/offers/:id` stays seller-only (D-12).
- **Seller identity:** the seller's company name and user are not shown to buyers in T9.
  Whether buyers see the seller's company is left to T6, where both identities are
  recorded on acceptance.

### D-18 — Request lifecycle and availability (2026-09-30)

- **Who can request.** A buyer requests a quantity of the offer's **current published
  version**. The request pins that version number. A company cannot request its own
  offer.
- **What "available" means.** Available quantity = the current version's quantity minus
  the sum of **accepted** quantities on that offer, across all versions. Pending and
  countered requests do not reserve anything.
  - The check happens at request time (quantity ≤ available) and again, authoritatively,
    at acceptance, inside one synchronous `transact` (D-3). Two acceptances that together
    exceed the available quantity cannot both succeed.
- **States.** `pending`, `countered`, `accepted`, `declined`, `withdrawn`.
  - The seller accepts, declines or counters a `pending` request.
  - The buyer accepts or declines a `countered` request.
  - The buyer may withdraw while `pending` or `countered`.
  - `accepted`, `declined` and `withdrawn` are final.
- **Superseded is derived, like expiry.** A pending or countered request whose pinned
  version is no longer the offer's current version reads as `superseded` and cannot be
  accepted (PRD: "pending acceptance of the old version does not carry over").
- **Acceptance needs a live offer.** The offer must be published, not expired, and its
  current version must equal the pinned version.
- **A counter is a request-scoped new version.** The PRD says "A counter is a new
  version, and the buyer accepts that version afresh". A counter is a seller-proposed
  `{ quantity, unitBuyerMinor, serviceTerms }` attached to the request, numbered from 1.
  It does not create a public offer version. A buyer's acceptance of a counter uses the
  counter's terms.
- **What an acceptance records** (PRD Phase 4):
  - offer id and version, counter number or none;
  - quantity, unit buyer price, currency and total;
  - both Rate Ninja identities (seller and buyer `companyId` and `sub`);
  - acceptance time and actor;
  - the D-13 buyer-terms hash (C-10).
- **Copy on every request and acceptance screen:**
  - "Accepted in OceanRelay means a marketplace agreement. It is not a carrier booking."
  - "This quantity limit applies only inside OceanRelay. It does not hold carrier space
    or stop the seller promising the same space elsewhere."
- **Out of T6:** post-acceptance carrier statuses and cancellation (T7), audit (T8).

### D-19 — Seller and buyer names are revealed on acceptance (2026-09-30, operator confirmed the planner default)

The seller's and buyer's Rate Ninja company names are hidden from each other while
browsing, requesting and negotiating. The buyer sees the code-share line, and the seller
sees "a contract owner". Once a request is accepted, both company names show on that
request for both parties, because they now have an agreement to perform.

Reason: the code-share name is the seller's chosen public label, and neither side needs
the other's identity until there is a deal.

Confirmed by the operator on 2026-09-30.

### D-20 — After acceptance: carrier statuses, mutual cancellation and disputes (2026-10-01)

Implements PRD Phase 4: "After acceptance, the seller, buyer, or operator can record
carrier-pending, carrier-confirmed, rejected, rolled, completed, or cancelled", and
"After acceptance, cancellation stands when both parties agree. Otherwise the request is
an unresolved dispute."

**Carrier statuses.**
- An accepted request carries a fulfilment status, which starts at `accepted`.
- Either party (the seller's or the buyer's company) may record a carrier status. Each
  entry records the actor's `sub`, `companyId` and role, the time, and an optional note.
- Recording by the operator comes with the operator screens (T8).
- The allowed moves:

  | From | To |
  | --- | --- |
  | `accepted` | `carrier_pending`, `carrier_confirmed` |
  | `carrier_pending` | `carrier_confirmed`, `rejected` |
  | `carrier_confirmed` | `rolled`, `completed`, `rejected` |
  | `rolled` | `carrier_pending`, `carrier_confirmed` |

- `rejected` and `completed` take no further carrier status. Any other move is refused.

**Cancellation after acceptance needs both parties.**
- Either party may propose cancelling, with an optional reason. The other party then
  agrees, which makes the status `cancelled` (final), or refuses, which opens an
  unresolved dispute.
- The proposer may withdraw an unanswered proposal.
- While a dispute is open, either party may propose again. Agreement then cancels.
- Cancellation is possible from any status except `completed` and `cancelled`.
- Carrier statuses may still be recorded while a proposal or a dispute is open, because
  they are facts about the carrier, not about the agreement.
- No fee and no payment moves (PRD).

**Before acceptance, the seller may cancel.** This amends D-18: the seller may now
decline a `countered` request as well as a `pending` one. The buyer's existing actions do
not change.

**Availability (amends D-18).** A `cancelled` agreement stops counting against the
offer's available quantity. Every other status keeps counting, including `rejected` and
an open dispute. OceanRelay cannot know that the space came back, and only the two
parties agreeing releases it.
- Planner default, open to the operator: should a carrier rejection release the
  quantity?

**Accepted terms never change.** `acceptance` and its `termsHash` are written once. No
fulfilment or cancellation action may modify them (PRD: terms cannot be silently
rewritten).

**Copy.**
- `accepted` and `carrier_pending` read as a marketplace agreement, not a carrier
  booking.
- `carrier_confirmed`, `rolled` and `completed` say the carrier status was *recorded by*
  a named party on a date, that OceanRelay has not checked it with the carrier, and that
  a carrier can still roll, change or cancel a booking.
- No screen calls anything "booked" without "recorded by".
- An open dispute reads: "Unresolved dispute. No fee and no payment moves in
  OceanRelay."

**Marketplace availability (F-13, operator decision 2026-10-01).**
- Every marketplace row shows "N of M available in OceanRelay".
- An offer at 0 stays listed: greyed out, marked fully taken, and sorted after every
  offer that still has quantity. The order among the others is unchanged.
- The detail page shows no request form at 0, as today, and labels the listed figure
  "Listed quantity".

### D-21 — The audit log and the operator screens (2026-10-01)

Implements the PRD Phase 4 requirements:
- "Authentication, grant and revoke, publish, revision, decisions, status changes, and
  operator actions are audited. Passwords and tokens are not written in those logs."
- "The operator can review company, source, status history, and inconsistencies, and
  cannot silently rewrite accepted terms."
- The seller, buyer **or operator** may record carrier statuses.

**Where the log lives.** It lives in the records file's existing top-level `audit`
array, which has been there since M-1 and has been empty until now. No migration is
needed: the schema stays at 4.

**Writing rules:**
- An entry is appended **inside the same `transact`** as the change it records, and only
  when that change succeeds.
- A refused action writes nothing. That keeps every existing "refusal leaves the file
  byte-identical" guarantee.
- Reads, including the operator's own screens, never write.
- Authentication events (connected, refused, disconnected, connection dropped after a
  failed refresh or a revoked grant) are not records changes. Each one is appended in a
  transact of its own.

**Amended 2026-10-02 (T8 review; planner error).** Nobody may be able to grow the log
without first authenticating at Rate Ninja.
- `auth.refused` is written only after a **successful code exchange**, when Rate Ninja
  has authenticated a real user whom OceanRelay then refuses (for example
  `only_contract_owner` or `identity_unavailable`).
- Callback failures before that point write nothing: no session, bad `state`, an
  `error=` redirect, or a failed exchange. Anyone can trigger them without an account.
- Measured on T8's first round: 600 unauthenticated GETs of `/oauth/callback` wrote 600
  entries and grew the file from 56 bytes to 100 KB.
- Every other event already requires a stored connection or an identity.

**Never in the log:**
- passwords;
- access or refresh tokens, authorization codes, PKCE verifiers, OAuth `state`;
- the client secret, the session secret, cookies, CSRF tokens;
- base prices, markups and Rate Ninja snapshots.

The log records who, what and when, plus small identifying details such as states,
versions, quantities and counter numbers. The records themselves already hold the
commercial detail, for the operator screens to show.

**Operator access (D-16).** `OCEANRELAY_OPERATOR_SUBS` is parsed at startup. Every
`/operator` route checks the signed-in `sub` server-side. A non-operator, signed in or
not, gets a response byte-identical to an unknown page. `/config` shows only the count.
The home page shows the signed-in user their Rate Ninja `sub`.

**What the operator can do:**
- Read everything: companies, offers with source and versions, requests with their
  counter, state, fulfilment and cancellation history, and the audit log.
- Record a carrier status on an accepted request, using D-20's table. The role is
  `operator`, and a note is **required**, saying why the operator and not a party
  recorded it.
- Nothing else. The operator cannot cancel, cannot resolve a dispute, and cannot edit
  any offer, request or acceptance. A dispute stays unresolved until both parties agree
  (PRD). There is no operator route that writes anything except the carrier status.

**Inconsistencies are derived when read, never stored.** The operator screen lists:
- **over-committed offers:** the accepted, non-cancelled quantity exceeds the current
  version's quantity (for example, the seller edited the quantity down after
  acceptances);
- **open disputes**, and cancellation proposals awaiting a response;
- **acceptance integrity failures:** `totalMinor` ≠ `quantity` × `unitBuyerMinor`, a
  missing `termsHash`, or a request whose offer no longer exists;
- **accepted requests with no fulfilment object.** This should be impossible after M-4,
  and a sighting means a bug.

**Size.** The log is unbounded for the pilot. Revisit if the records file passes about
5 MB.

**F-14 (folded into T8).** The marketplace's fully taken row becomes a real grey, still at
least 4.5:1 contrast on white. Each row shows one quantity line: "N of M containers
available in OceanRelay — Seller's claim".

### D-22 — Pending OAuth rows in the token store are bounded (2026-10-02, F-15)

Before the Rate Ninja redirect, `POST /connect` saves one pending row (`state`, an
encrypted PKCE verifier, `createdAt`) per session. Any anonymous visitor can do that,
because the CSRF token comes from the public home page.

Before this decision, a row was removed only when its own callback took it, and
`PENDING_TTL_MS` (10 minutes) was checked only at take. Measured on `main` at `d1ba1ad`:
300 anonymous connects left 300 rows and grew the token store from 0 to 62,430 bytes.
A callback with no matching row also rewrote the file.

**Rules:**
- `savePending` first drops every row older than `PENDING_TTL_MS`. Those rows could
  never be taken anyway.
- Pending rows are capped at **1,000**, about 210 KB. Saving past the cap evicts the
  oldest rows by `createdAt`.
- `takePending` writes the file only when it actually removed a row.
- **The format does not change:** same keys, same row shape, same encryption.
  Connections are never touched by pruning, and an existing file loads as before.

**Trade-off, accepted for the pilot.** An attacker sending more than 1,000 connects
inside one user's authorize round trip (seconds) can evict that user's pending row. The
user then sees `invalid_state` and clicks Connect again. The alternative, refusing new
rows when full, would let the same attacker block every sign-in for 10 minutes.
Per-client rate limiting is out of scope; revisit if it is ever seen.

### D-23 — Marketplace look and shared layout (2026-10-05, operator decisions)

The operator wants the prototype to look and feel like a marketplace for demos, with
**the same functionality**. Decided on 2026-10-05:
- **Look:** modern navy and teal. That means a navy header bar, white cards on a light
  grey page, teal for primary actions, and a system sans-serif font stack.
- **Split:** one task (T11) for every screen.

**What the redesign may and may not change:**
- **Unchanged:**
  - every route, method, form field name, redirect target and status code;
  - every records and store read or write;
  - CSRF, escaping, byte-identical 404s, and "reads never write";
  - every element `id`;
  - every copy sentence that a decision requires (D-18, D-19, D-20, D-21, F-14, the
    seller's-claim caveats, "recorded by", "Terms fingerprint").
- **Changes:**
  - markup structure, CSS, labels that no decision requires, and page composition;
  - a read-only signed-in dashboard on `/`.
- **The signed-out home page becomes a landing page** with a "Sign in with Rate Ninja"
  button. The settings list ("Configuration check") moves off it. `/config` already
  serves it as JSON. When `config.ok` is false, the landing page shows one plain notice
  ("Sign-in is not available right now") and lists no settings.
- **No external assets:** no web fonts, CDNs, images or scripts. The logo is inline SVG.
  The pages need no JavaScript, and there are no inline `<script>` tags, which leaves a
  later Content-Security-Policy easy.
- **Accessibility floor:**
  - text contrast at least 4.5:1, and at least 3:1 for large text and UI borders;
  - a visible focus ring;
  - a label on every input;
  - `header`, `nav` and `main` landmarks, plus a skip link;
  - status never shown by colour alone;
  - no horizontal scroll at 375 px wide;
  - `prefers-reduced-motion` respected.
- **One stylesheet,** served by OceanRelay at `/assets/oceanrelay.css` with a
  content-hash cache-buster. No page carries its own `<style>`.

### D-24 — Phase 5 architecture: OceanRelay relays, wallets sign, the operator deploys (2026-10-06, operator approved)

**Facts it rests on**, checked by the planner on 2026-10-06:
- **Users can't submit transactions:** the public sequencer RPC answers `eth_sendRawTransaction` with "method not allowed", and the write RPC is server-only behind Cloudflare Access. User wallets therefore cannot submit transactions.
- **The chain:** chain 852 executes `PUSH0`, `TLOAD` and `MCOPY`, and its block headers carry the Cancun fields, so contracts compile for `evm_version = cancun`. Gas price is about 0.001 gwei and the block gas limit is 60M.

**Model:**
- **Relaying:** OceanRelay's server holds one **relayer** key and submits every transaction through the write RPC.
- **Wallets:**
  - Users bind a wallet to their company once, by EIP-712 signature.
  - After that, each on-chain action carries the acting party's EIP-712 signature, which **the contract verifies** against the bound wallet.
  - A leaked **relayer** key alone can spam or grief, but cannot forge a company's action. The owner rotates the relayer.
  - Wallet bindings also need a signature from a separate **registrar** key, which never sends transactions. So the relayer key alone cannot bind an attacker's wallet to another company.
  - The honest boundary: a full compromise of the OceanRelay server (both keys) can create bindings, because OceanRelay is what vouches that a Rate Ninja user belongs to a company. The owner can revoke wallets and rotate the registrar.
  - Acceptances carry **both** companies' signatures over the same terms, so neither party, nor the relayer, can record an agreement alone.
  - Users need no test ETH.

**Keys:**

| Key | Holder | Where |
| --- | --- | --- |
| Owner / deployer | operator | offline, in the operator's lab, never on Render |
| Relayer | generated by the operator | Render secret `OCEANRELAY_RELAYER_KEY`, funded with test ETH on 852 |
| Registrar | generated by the operator | Render secret `OCEANRELAY_REGISTRAR_KEY`, unfunded; it signs bindings only, and must differ from the relayer |
| Operator wallets | operators | their own wallets, registered by the owner, for operator statuses (C-12) |
| User wallets | each company's users | their own wallets |

Neither the planner nor any worker handles a private key.

**Deployment:**
- A worker task writes the contract, the tests and a deploy script (T12).
- The **operator** runs the deploy against the write RPC.
- The address, deploy transaction, block and runtime-bytecode hash land in `deployments/fortel2-sepolia.json` through a PR.

**Startup checks (fail closed):**
- `eth_chainId` = 852;
- block 0 hash = `0xe242b1a3312b509e7df1496847f0bd0b115cb66676b1e973a355296c99e2386d`;
- `keccak256(eth_getCode(address))` = the recorded runtime-bytecode hash.

**Reads:** receipts and confirmations come from the **sequencer**. The replica is deliberately about 3 minutes behind, so it serves only as a later cross-check.

**Privacy on chain:**
- Offer, request and company identifiers on chain are opaque `bytes32` values, derived off-chain with salts that never leave OceanRelay.
- Commitments are salted hashes (PRD).
- No price, margin, quantity, company name or customer detail is on chain.

### D-25 — Amendments to D-9 and D-23 for Phase 5 (2026-10-06, operator approved)

- **D-9 amended:**
  - Two runtime dependencies are allowed: `@noble/curves` and `@noble/hashes`. They are audited, have no transitive dependencies, and are pinned to exact versions with lockfile integrity. They are used for secp256k1 signature recovery and relayer transaction signing. Node's built-in `keccak-256` may be used for hashing; Node 26 gives the correct value for `keccak256("")`.
  - Nothing else is added without a new decision.
- **Solidity tooling is build-time only:**
  - Foundry, in `contracts/`.
  - OpenZeppelin Contracts v5 and forge-std, installed through Foundry's Soldeer with a committed lockfile.
  - **No git submodules**, because Render's deploy clone is outside our control.
  - None of this ships in the Node service.
- **D-23 amended:** one first-party script is allowed, served from `/assets` and included **only on wallet pages**. It is plain JavaScript with no library, and it calls the browser wallet (EIP-1193 `eth_requestAccounts`, `eth_signTypedData_v4`). The marketplace and every other page stay script-free.

### D-26 — Chain client behaviour: fail closed on the chain, never on the marketplace (2026-10-07)

**Facts it rests on** (planner, 2026-10-07):
- Render builds OceanRelay with `npm install` and starts it with `npm start`, on its Python image with Node.
- Node is picked from `engines`: `>=20.12` resolved to 26.10.0 on 2026-10-06 and 26.11.0 on 2026-10-07. This closes O-5.
- The ledger is deployed (`deployments/fortel2-sepolia.json`).

**Rules:**
- **Pin Node:** `engines.node` becomes `"26.x"`, so Render stops floating to the newest major.
- **Hashing:** all Keccak hashing uses `@noble/hashes` `keccak_256`, not Node's built-in `keccak-256`. The built-in depends on the OpenSSL build. This supersedes the sentence in D-25 allowing the built-in. Both noble packages are pinned to exact versions, and `package-lock.json` is committed.
- **When the chain is enabled.** Chain features are on only when all four secrets are set: `OCEANRELAY_RELAYER_KEY`, `OCEANRELAY_REGISTRAR_KEY`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
  - None set: `disabled`.
  - Some set: `misconfigured`, with reason `incomplete`.
  - `FORTEL2_WRITE_RPC` and `FORTEL2_READ_RPC` default to the write endpoint and the sequencer. `OCEANRELAY_CHAIN_MAX_FEE_GWEI` defaults to 1.
- **Startup check, against the read RPC and `deployments/fortel2-sepolia.json`:**
  - `eth_chainId` = 852;
  - block 0 hash = the pinned genesis;
  - `keccak256(eth_getCode(address))` = `runtimeCodeHash`;
  - `relayer()` on the contract = the address of `OCEANRELAY_RELAYER_KEY`;
  - `registrar()` = the address of `OCEANRELAY_REGISTRAR_KEY`;
  - the contract is not paused.
- **Mismatch versus outage:**
  - A **mismatch** sets `misconfigured` for the life of the process, with the reason recorded.
  - An **outage** (timeouts, connection errors, 5xx) sets `degraded`, and the check is retried every 60 s until `ready`.
  - **Either way the marketplace keeps working.** Phase 4 features never depend on the chain being up. This amends D-24's "refuses to start": OceanRelay refuses to *use* a wrong or unreachable chain; it does not refuse to serve.
- **Where traffic goes:**
  - Reads (`eth_call`, receipts, nonce, fees, code and blocks) go only to the read RPC.
  - The write RPC receives only `eth_sendRawTransaction`.
  - The Cloudflare Access headers go only to the write host.
- **Secrets never appear** in logs, errors, `/config`, the audit log, or any response.
- **Submitting:**
  1. Simulate with `eth_call` from the relayer. A revert returns `refused`, with the decoded custom error, and sends nothing.
  2. Sign an EIP-1559 transaction for chain 852:
     - gas = estimate × 1.25;
     - `maxFeePerGas = min(cap, 2 × baseFee + priority)`.
  3. Send it, and poll the sequencer for the receipt for up to 30 s.
  4. The result is `confirmed` (status 1), `reverted` (status 0) or `pending`.
  - Nonces come from the sequencer's `pending` count, through one serialized queue, so concurrent submissions never share a nonce.
  - A `pending` result is not a failure. The caller reconciles later with `receipt(hash)` (PRD: retried and reconciled, never treated as a final rejection by itself).
- **Monitoring:** a relayer balance below 0.001 ETH shows as a warning in the chain status. `/config` shows the chain status with no secret.

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

### C-8 — Market query (owner: T9)

`lib/market.js`, pure, no I/O:
- `filterMarket(entries, query, today)` → the matching entries, sorted by sailing start and
  then by id.
- `entries` are `{ id, version: <n>, view: buyerView(currentVersion), companyId }`, built by
  `records.listPublishedOffers(today)` (a C-6 `view` read).
- `query` holds optional `origin`, `destination`, `carrier` (case-insensitive substring),
  `equipment`, `from` and `to` (the sailing window overlaps [from, to]), `maxPrice` with
  `currency` (compared in minor units, same currency only), and `capacityStatus`.
- Unknown query keys are ignored.
- `companyId` is used only to mark "your offer". It is never rendered.

*Amended 2026-09-30 (planner error, caught by the T9 worker):* the entry text above said
`view` is `buyerView(currentVersion)`. A C-7 version nests its commercial fields under
`terms`, and `buyerView` reads them from the top level, so that call would produce an
empty market. As built and reviewed, `view` is
`buyerView({ ...currentVersion.terms, capacityStatus: currentVersion.capacityStatus })`.
The `carrier` filter matches the operating carrier in the buyer view's code-share line:
a filter for the operating carrier matched, and a filter for the code-share name did not.
C-4's buyer view has no separate carrier field.

### C-9 — Request record, schema v3 (owner: T6)

Records file `schemaVersion: 3`, produced from v2 by migration **M-3**. M-3 adds a
top-level `requests: {}`, and nothing else changes. It follows the same rules as M-2:
copy to `<path>.pre-m3.bak` first (mode 0600, never overwritten), keep unknown keys, and
throw on a version above 3.

```
requests[id] = {
  id, offerId, version, createdAt,
  sellerCompanyId, buyerCompanyId, buyerSub,
  buyerCompanyName, sellerCompanyName,        // amended 2026-09-30, see below
  quantity,
  state: "pending" | "countered" | "accepted" | "declined" | "withdrawn",
  counters: [{ n, quantity, unitBuyerMinor, serviceTerms, at, by }],
  history: [{ from, to, actor, at, counter }],
  acceptance: null | {
    at, by, offerId, version, counter,          // counter: n or null
    quantity, unitBuyerMinor, currency, totalMinor,
    sellerCompanyId, sellerSub, buyerCompanyId, buyerSub,
    termsVersion: 1, termsHash
  }
}
```

`sellerSub` in the acceptance is the seller-side user who accepted, or, for an accepted
counter, the user who made the counter.

**Amended 2026-09-30, before merge (F-12, T6 review).** Company names are snapshotted
onto the request from the acting identity, so D-19 does not depend on live connection
rows, which are deleted on disconnect or revocation:
- `buyerCompanyName` is set at creation.
- `sellerCompanyName` is `null` until the seller's first counter or seller acceptance,
  and is set then.
- Both are rendered only once the request is `accepted`.
- Neither enters the C-10 hash.

### C-10 — Buyer-terms canonical form and hash (owner: T6; implements D-13)

`lib/terms-hash.js`, pure:
- `buyerTermsCanonical(fields)` produces a string with sorted keys and `"v": 1` first.
- `buyerTermsHash(canonical)` produces hex SHA-256.

The fields are exactly what the buyer agreed to:
- `offerId`, `version`, `counter`;
- `codeShareLine`, `origin`, `destination`, `equipment`, `unit`, `quantity`;
- `sailingStart`, `sailingEnd`, `cutoffDate`, `validityDeadline`;
- `currency`, `unitBuyerMinor`, `totalMinor`;
- `serviceTerms`, `capacityStatus`.

It never includes `baseMinor`, `markup`, the snapshot, the source id, or any `sub` or
`companyId`. The hash is computed once, at acceptance, and stored. It is unsalted
because it contains only terms both parties saw; Phase 5 adds the salted on-chain
commitment. C-4's `canonicalTerms` v1 is not used for acceptances (D-13).

### C-11 — Fulfilment record, schema v4 (owner: T7; implements D-20) — *extended by C-12 (operator role), 2026-10-01*

Records file `schemaVersion: 4`, produced from v3 by migration **M-4**.
- M-4 gives every request a `fulfilment` key:
  - `null` unless the request's `state` is `accepted`;
  - `{ status: "accepted", history: [], cancellation: null, cancellationEvents: [] }`
    if it is.
- Otherwise M-4 follows M-3's rules: copy to `<path>.pre-m4.bak` first (mode 0600,
  never overwritten), keep unknown keys, and throw on a version above 4.
- A v1, v2 or v3 file reaches v4 in one open, leaving each `.bak` it passes through.

```
requests[id].fulfilment = null | {
  status: "accepted" | "carrier_pending" | "carrier_confirmed" | "rejected"
        | "rolled" | "completed" | "cancelled",
  history: [{ from, to, actorSub, actorCompanyId, role, at, note }],
  cancellation: null | {
    state: "proposed" | "disputed",
    proposedByCompanyId, proposedBySub, proposedAt, reason,
    respondedByCompanyId, respondedBySub, respondedAt     // null while proposed
  },
  cancellationEvents: [{ event, byCompanyId, bySub, role, at, reason }]
}
```

- `role` is `"seller"` or `"buyer"`.
- `event` is `"proposed"`, `"withdrawn"`, `"agreed"` or `"refused"`.
- `history` records only carrier-status moves and the final move to `cancelled`.
- `note` and `reason` are strings of at most 500 characters (`""` when none).
- C-9's `state` stays `accepted` after acceptance. Fulfilment does not reuse it.
- Available quantity (D-18 as amended by D-20) is the current version's quantity minus
  the accepted quantity of every request whose `fulfilment.status` is not `cancelled`.

### C-12 — Audit entry and operator actions (owner: T8; implements D-21; extends C-11)

The top-level `audit` array of the records file (schema 4, no migration). Each entry:

```
{ id, at, event,
  actor: null | { sub, companyId, role },   // role: "seller" | "buyer" | "operator" | "user"
  subject: { offerId?, requestId?, version? },
  detail: { ...small whitelisted fields } }
```

`event` is one of:
- `auth.connected`, `auth.refused`, `auth.disconnected`, `auth.dropped`;
- `offer.created`, `offer.edited`, `offer.state`, `offer.capacity_status`;
- `request.created`, `request.countered`, `request.accepted`, `request.declined`,
  `request.withdrawn`;
- `fulfilment.status`;
- `cancellation.proposed`, `cancellation.withdrawn`, `cancellation.agreed`,
  `cancellation.refused`.

What goes in `detail`:
- For transitions, `from` and `to`.
- For counters, `counter`.
- For requests, `quantity`.
- For `auth.refused`, a reason code; for `auth.dropped`, `reason` (for example
  `refresh_failed`, `identity_unusable`).
- Never a token, code, secret, cookie, password, price, markup or snapshot.

`id` is random, `at` is an ISO time, and entries are appended in order. Nothing ever
edits or deletes an entry.

**Extension to C-11:** a `fulfilment.history` entry's `role` may also be `"operator"`.
In that case:
- `actorCompanyId` is the operator's own company;
- `note` is non-empty.

### C-13 — Page layout and stylesheet (owner: T11; implements D-23)

`lib/views/layout.js` exports `renderLayout({ title, nav, body, flash })`. It returns a
complete HTML document:
- the header: the logo, the nav links, and the company name plus Disconnect when signed
  in;
- a skip link;
- `<main id="main">` containing `body`;
- a footer.

`nav` is `{ active, signedIn, isOperator, companyName, csrf }`.
- `active` is one of `market`, `offers`, `requests`, `operator`, `home`.
- `companyName` is escaped inside the layout.

Every HTML page goes through `renderLayout`, except the JSON responses and the router's
JSON 404.

`lib/views/styles.js` exports the stylesheet text and its version hash. `GET
/assets/oceanrelay.css` serves it with:
- `Content-Type: text/css; charset=utf-8`;
- `Cache-Control: public, max-age=31536000, immutable`.

Pages link it as `/assets/oceanrelay.css?v=<hash>`.

**Amended 2026-10-06 (T11 review):** not-found HTML pages use a static signed-in nav with no `companyName`, no Disconnect `csrf` and no operator link, so their 404 bodies stay byte-identical across viewers.

Later pages, Phase 5 included, are added through `renderLayout` and the shared
component classes: card, pill, button, form row, table and banner. They are not added
with their own markup scaffolding.

### C-14 — OceanRelayLedger contract and EIP-712 messages (owner: T12; implements D-24) — *revised before dispatch on 2026-10-06: registrar co-signs bindings; acceptance needs both companies*

Solidity 0.8.28, `evm_version = cancun`. OpenZeppelin v5: `Ownable2Step`, `Pausable`, `EIP712`, `ECDSA`.
- **No funds:** no payable function, no `receive` and no `fallback`, so ETH sent to it reverts.
- **Who may call:** every record function is `onlyRelayer` and `whenNotPaused`.
- **Owner functions:**
  - `setRelayer(address)`;
  - `setRegistrar(address)` (must differ from the relayer);
  - `setOperator(address, bool)`;
  - `revokeWallet(address)`;
  - `pause()` / `unpause()`.

**EIP-712 domain:** `name = "OceanRelay"`, `version = "1"`, `chainId = block.chainid`, `verifyingContract = this`.

**Rules for every signature:**
- recovered with `ECDSA.tryRecover`, which rejects malleable and invalid signatures;
- `deadline >= block.timestamp`;
- the digest is recorded in `usedDigests`, and a reused digest reverts.

**Message types** (exact strings, which the Node side must match):

    Binding(bytes32 companyKey,address wallet,uint64 deadline)
    Publish(bytes32 offerId,bytes32 commitment,uint64 expiresAt,uint64 deadline)
    Version(bytes32 offerId,uint32 version,bytes32 commitment,uint64 expiresAt,uint64 deadline)
    OfferState(bytes32 offerId,uint8 state,uint32 seq,uint64 deadline)
    Request(bytes32 requestId,bytes32 offerId,uint32 version,uint64 deadline)
    Acceptance(bytes32 requestId,uint32 counter,bytes32 termsCommitment,uint64 deadline)
    Status(bytes32 requestId,uint8 status,uint32 seq,uint64 deadline)
    Cancellation(bytes32 requestId,uint64 deadline)

**Enums:**
- `OfferState`: 0 None, 1 Published, 2 Paused, 3 Withdrawn, 4 Expired.
- `Fulfilment`: 0 None, 1 Requested, 2 Accepted, 3 CarrierPending, 4 CarrierConfirmed, 5 Rejected, 6 Rolled, 7 Completed, 8 Cancelled.

**Functions.** Each reverts with a named custom error on every refusal, and emits one event on success.

- `bindWallet(companyKey, wallet, deadline, walletSig, registrarSig)`:
  - two signatures over the same `Binding` digest: one by `wallet` and one by the current registrar;
  - `companyKey` must be non-zero;
  - a wallet already bound to a **different** company reverts;
  - re-binding to the same company is a no-op revert.
- `publishOffer(offerId, commitment, expiresAt, deadline, sig)`:
  - the signer must be bound;
  - `offerId` must be new (no duplicates) and non-zero, and `commitment` non-zero;
  - `expiresAt` must be later than `block.timestamp`;
  - the result is version 1, `Published`, owned by the signer's company.
- `publishVersion(offerId, version, commitment, expiresAt, deadline, sig)`:
  - the signer's company must own the offer;
  - the state must be `Published` or `Paused`;
  - `version` must equal current + 1.
- `setOfferState(offerId, state, seq, deadline, sig)`:
  - the signer's company must own the offer;
  - `seq` must equal the offer's state-change count;
  - allowed moves: Published↔Paused, and Published or Paused→Withdrawn (final).
- `markExpired(offerId)`:
  - relayer only, with no user signature;
  - requires `block.timestamp > expiresAt` and a state of Published or Paused;
  - moves to `Expired` (final).
- `recordRequest(requestId, offerId, version, deadline, sig)`:
  - the signer must be bound to a company **other than** the offer's;
  - the offer must be `Published`;
  - `version` must equal the offer's current version;
  - `requestId` must be new;
  - the request becomes `Requested`.
- `recordAcceptance(requestId, counter, termsCommitment, deadline, sigA, sigB)`:
  - two signatures over the same `Acceptance` digest: one by a wallet bound to the offer's (seller) company and one by a wallet bound to the request's buyer company, in either order;
  - off-chain, the first party signs when they request (counter 0) or counter (counter n), and the second when they accept;
  - the offer must still be `Published`, at the request's pinned version;
  - the request must be `Requested`; it becomes `Accepted`.
- `recordStatus(requestId, status, seq, deadline, sig)`:
  - the signer must be bound to the buyer or seller company, **or** be a registered operator;
  - `seq` must equal the request's status-change count;
  - only D-20's moves are allowed: Accepted→CarrierPending or CarrierConfirmed; CarrierPending→CarrierConfirmed or Rejected; CarrierConfirmed→Rolled, Completed or Rejected; Rolled→CarrierPending or CarrierConfirmed.
- `recordCancellation(requestId, deadline, sigA, sigB)`:
  - one signature from a wallet bound to the seller company and one from a wallet bound to the buyer company, in either order;
  - allowed from Accepted, CarrierPending, CarrierConfirmed, Rejected or Rolled;
  - the request becomes `Cancelled` (final).
  - Disputes stay off-chain.

**Events** carry only `bytes32` ids, `companyKey`, signer address, version or sequence numbers, states, and commitments. They carry no prices, quantities or names.

### C-15 — Chain client module (owner: T13; implements D-24, D-26; consumed by T14–T16)

`lib/chain/index.js` exports `createChain({ config, deployment, fetchImpl, now })`. The returned object has:

- **`status()`:** returns `{ state, reason, chainId, address, relayer, registrar, relayerBalanceWei, lowBalance }`.
  - `state` is `disabled`, `checking`, `ready`, `degraded` or `misconfigured`.
  - It never includes a secret.
- **`typed.digest(type, message)`:** returns the 0x-hex EIP-712 digest for one of the eight C-14 types, using the deployed domain.
- **`typed.recover(type, message, signature)`:** returns the signer's address, or `null`. It follows OpenZeppelin `tryRecover`'s rules: a 65-byte signature, `v` of 27 or 28, low `s`, and a non-zero result.
- **`registrarSign(message)`:** signs a `Binding` message with the registrar key. It is the only signing the registrar does.
- **`submit(fn, args)`:** `fn` is one of the nine C-14 record functions, with positional arguments in C-14 order (signatures as 0x-hex).
  - It resolves to `{ state, hash?, nonce?, error?: { name, args } }`.
  - `state` is `refused`, `pending`, `confirmed` or `reverted`, per D-26.
- **`receipt(hash)`:** resolves to `{ state, blockNumber? }`, with `state` = `pending`, `confirmed` or `reverted`.
- **`call(fn, args)`:** a decoded read of the contract's view functions.

`contracts/abi/OceanRelayLedger.json` holds the committed ABI, generated from `forge build`. The ABI-encoding and error-decoding modules use it.
