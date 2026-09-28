# T3 — Offer domain module

You are implementing one task in the OceanRelay repository (a zero-dependency Node web
service). Other agents are working in parallel; file scope is strict.

**Read first:** `docs/plan.md` (§1 "Rate Ninja facts", §2 contract applies in full),
`docs/decisions.md` (D-1, D-5 to D-8, C-4), `docs/oceanrelay-prd.md` (Product, Standing
rules, Phase 3, Phase 4 bullets on buyer view and versions). **Verify claims in this
prompt against those docs; if they contradict each other, say so.**

**Branch:** `task/T3-offer-domain` from current `main`.

## Why this exists

Phase 3 saves offers and Phase 4 shows them to buyers and hashes their terms. The rules
that matter most (what a buyer may see, how price is computed, that a rate never implies
confirmed capacity) should live in one pure module with thorough tests, not spread through
route handlers. This task has no I/O, no HTTP, and no storage.

## What to build (C-4): `lib/offer-domain.js`

- **`CURRENCIES`**: the allowlist and exponents from D-5.
- **`CAPACITY_STATUSES`**: `seller_asserted`, `carrier_pending`, `carrier_confirmed`.
  `canChangeCapacityStatus(from, to)`: seller may move asserted → pending → confirmed,
  asserted → confirmed, and back down to asserted. There is no input to this function
  from Rate Ninja data (D-8).
- **`validateDraft(input)`** → `{ ok, value, errors }`. `errors` is a map of field →
  message suitable for showing next to a form field. Required (PRD Phase 3, spec C1):
  `source` (`rn_rate` | `manual`), origin, destination, equipment (`20D` | `40D` |
  `40HC`), claimed quantity (positive integer) and unit (`container` initially),
  sailing window (start and end dates, or a single sailing date), validity deadline,
  currency (from `CURRENCIES`), base price (integer minor units > 0), markup (`{ type:
  "absolute", minor }` or `{ type: "percent", bps }`, non-negative), code-share name,
  operating carrier, service terms. Optional: cutoff date. Dates are `YYYY-MM-DD`; the
  validity deadline must not be after the sailing window end, and the window end not
  before its start. Strings are trimmed and length-limited (choose sensible limits and
  list them in the handoff). `value` is a normalized object; unknown input keys are
  dropped, never passed through.
  **Ownership fields (`companyId`, `sub`) are not inputs.** If `input` contains them,
  ignore them (D-1: identity comes from the grant, never the browser).
- **`priceBuyer({ baseMinor, markup })`** → integer. Percent markup rounds half-up to the
  minor unit (D-5). Test the boundaries: 0 bps, fractional result exactly .5, large values
  stay safe integers.
- **`snapshotFromRate(rateDto, equipment, retrievedAt)`** → frozen object holding the full
  DTO (D-7), the chosen equipment, the base amount for that equipment, and `retrievedAt`.
  If the equipment column is `0`, return `{ ok: false, error: "no_price_for_equipment" }`
  (D-6). The snapshot also records which draft fields it seeds (origin, destination,
  carrier, effective/expiration dates, base amount) so the UI can show "from Rate Ninja"
  versus "typed by seller".
- **`sourceWarnings(snapshot, currentRateDtoOrNull, today)`** → list of warnings:
  `source_changed` (any DTO field differs), `source_expired` (expiration date before
  today), `source_missing` (current is null). Never returns a modified snapshot.
  Rate Ninja passes its date fields through `normalizeValue` from spreadsheet-like
  records, so `YYYY-MM-DD` is not guaranteed. An unparseable expiration date produces a
  `source_date_unreadable` warning, never a silent "not expired".
- **`canonicalTerms(offerVersion)`** → string. Stable key ordering at every depth,
  `"v": 1` at the top, only the fields that define the commercial terms (not timestamps
  of when the row was saved, not the snapshot's `retrievedAt`). Document the included
  field list at the top of the function; Phase 4 acceptances will hash it, so it is a
  contract. **`termsHash(canonical)`** → hex SHA-256.
- **`buyerView(offer)`** → projection for a buyer. Includes: code-share line
  ("XYZ, operated by ABC"), a flag that the code-share name is seller-provided, lane,
  equipment, quantity and unit labelled as the seller's claim, dates, currency, buyer
  price, service terms, capacity status with its caveat text. Excludes: base price,
  markup, snapshot, source record id, private notes, the seller's `sub`.
- **Status copy.** Export the caveat strings the UI must show: seller claim ("Quantity is
  the seller's claim. OceanRelay has not confirmed the space."), carrier-confirmed
  ("A carrier confirmation was recorded. The carrier can still roll, change, or cancel.").
  Keep them in one place so every screen uses the same words.

## The trap

**`buyerView` must be an allowlist, not a denylist.** Build the output by copying named
fields, never by cloning the offer and deleting private ones. A denylist leaks every
private field added in a later phase (Phase 4 adds versions and request data; Phase 5 adds
a salt). Write a test that adds an unknown field (`offer.futurePrivateField = "x"`) and
asserts it is absent from `buyerView`, plus a test that serializes the view and asserts
the base price and markup values do not appear anywhere in the string.

## Must not change

Nothing existing. This is a new module.

## File scope

- **Owned:** `lib/offer-domain.js` (new), `test/offer-domain.test.js` (new).
- **Shared:** none.
- **Off-limits:** everything else, including `test/mock-rate-ninja.js` (T1 and T2 are
  editing it), `package.json` (T1), all of `docs/`.

If you need to change an off-limits file, stop and report.

## Out of scope

Storage, routes, HTML, versioning and requests (Phase 4), the salted on-chain hash
(Phase 5).

## Tests that must exist

Beyond the ones named above: a draft with `companyId` in input does not carry it into
`value`; every required field missing produces an error keyed to that field; each date
ordering rule; `snapshotFromRate` refuses a `0` column; `sourceWarnings` for each warning
and for no change; `canonicalTerms` is identical for two objects with the same content
built in different key orders, and differs when any included field changes; no Rate Ninja
field can change a capacity status.

## Gate

Per `docs/plan.md` §2. Until T1 merges, run `node --test "test/*.test.js"` and report that
count.

## Disagree if needed

If the C-4 surface is wrong (too much, too little, a rule the PRD contradicts), argue it
in the handoff rather than implementing it half-heartedly.

## Hand back

The block in `docs/prompts/HANDOFF.md`. Contract: C-4. Migration: none.
