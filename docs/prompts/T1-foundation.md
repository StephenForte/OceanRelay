# T1 — Router split, identity hardening, records store

You are implementing one task in the OceanRelay repository (a zero-dependency Node web
service). Other agents are working on other tasks in parallel, so file scope below is
strict.

**Read first:** `docs/plan.md` (sections 1–2, the commit-and-merge contract applies to you
in full), `docs/decisions.md` (D-1 to D-4, D-9, C-1, C-2), `docs/oceanrelay-prd.md`
(Standing rules, Phase 2, Phase 3). Then read `server.js`, `lib/store.js`, `lib/session.js`,
and `test/connect.test.js` on current `main`. **Verify every claim in this prompt against
the code before relying on it**, including the claims about defects; if one is wrong, say so.

**Branch:** `task/T1-foundation` from current `main`.

## Why this exists

Phase 3 and 4 add offers, requests, and an audit log. Four things on `main` would make
that work unsafe or collide:

1. `server.js` `handleCallback`: when `fetchUserInfo` fails, the code saves the connection
   anyway with `profile = { sub: "", companyId: "", ... active: false }` and redirects to
   `?result=connected`. The user looks connected but has no identity. Every business
   record is keyed by `companyId` and `sub` (D-1), so this state must not exist (D-2).
2. OceanRelay never checks `companyType` itself. Rate Ninja refuses customer companies
   today; OceanRelay should not rely on that alone (D-2).
3. `package.json` `"test": "node --test test/connect.test.js"`. New test files never run.
4. All routes are inline in `server.js`. Every later task would edit the same function.

## What to build

**a. Router and route modules (C-1).** Add `lib/router.js` with exact-path `get`/`post`
and `pattern(method, regex, handler)`. Move the existing handlers into
`lib/routes/connect.js` (`/`, `/connect`, `/oauth/callback`, `/disconnect`) and
`lib/routes/system.js` (`/health`, `/config`). `server.js` keeps `createServer`, the
shared helpers (`sendJson`, `sendHtml`, `redirect`, `readBody`, `formBody`, security
headers), token refresh, and an ordered area list. Export the helpers so route modules use
them rather than copying them. Provide `requireIdentity(req, res)` in `deps` as C-1
specifies. For a request with no connection, `requireIdentity` redirects GETs to `/` and
answers POSTs with 403 JSON `{ "error": "not_connected" }`. This is a behaviour-preserving
move for the existing routes: every current test must pass unchanged.

**b. Identity hardening (D-2).** In the callback, after the code exchange: if userinfo
fails, or `sub` or `companyId` is empty, or `active === false`, or `companyType !==
"Contract Owner"`, then call `revokeToken` with the refresh token just issued (ignore its
result), save nothing, and redirect with a new result code. Use `identity_unavailable` for
the userinfo/empty/inactive cases and the existing `only_contract_owner` for the company
type case. Add a message for `identity_unavailable` in `lib/page.js`. `requireIdentity`
applies the same checks to a stored connection, so connections saved before this change
with an empty profile are treated as not connected. Delete such a connection when found.

**c. Records store (C-2, D-3, D-4, migration M-1).** `lib/records.js`:
`openRecords(filePath)` with `filePath` null meaning memory-only (as `openStore` does).
File format `{ "schemaVersion": 1, "offers": {}, "audit": [] }`. Atomic write (tmp file,
rename, mode 0600, as `lib/store.js` does). On load: missing file → fresh v1; unparsable
file → **throw** (do not silently reset to empty; losing offers is worse than failing to
start); `schemaVersion` greater than 1 → throw. Expose `transact(fn)`, which runs `fn(data)`
synchronously, persists once if `fn` returns without throwing, and returns `fn`'s result.
Add config `OCEANRELAY_RECORDS_PATH` (default `data/oceanrelay-records.json`) to
`lib/config.js`, `publicConfig`, `README.md`, and `.env.example`. Wire `records` into
`deps`. Add no offer-specific methods; T4 adds them.

**d. Housekeeping.** `package.json` test script becomes `node --test "test/*.test.js"`.
`engines.node` becomes `>=20.12`.

## The trap

**`transact` must be synchronous end to end.** If `fn` returns a Promise, throw; do not
await it. D-3's concurrency guarantee (a later task will rely on it so two overlapping
requests cannot both take the last unit of quantity) depends on no `await` between reading
state and persisting it. An `async transact` looks harmless here and silently breaks the
Phase 4 oversubscription guarantee. Write a test asserting that `transact(async () => {})`
throws.

The second trap: **a failed load must not become an empty store.** `lib/store.js` resets
to empty on a parse error, which is acceptable for tokens (the user reconnects) and wrong
for offers. Do not copy that line.

## Must not change

- Token store format and AADs in `lib/store.js` (existing deployed data must still load).
- Session cookie format, CSRF checks, PKCE, scopes, security headers, `/health` and
  `/config` responses.
- Every existing assertion in `test/connect.test.js`. You may add tests there and move
  shared helpers, but not weaken one.

## File scope

- **Owned:** `server.js`, `lib/router.js` (new), `lib/routes/connect.js` (new),
  `lib/routes/system.js` (new), `lib/records.js` (new), `lib/config.js`, `lib/page.js`,
  `package.json`, `README.md`, `.env.example`, `test/connect.test.js`,
  `test/records.test.js` (new), `test/identity.test.js` (new).
- **Shared, additive only:** `test/mock-rate-ninja.js`. Add an option to
  `createMockRateNinja` for the userinfo response (profile override and a failure status).
  Keep the default profile identical. T2 is adding rate routes to the same file at the
  same time; add your code in a separate block and do not reorder existing code.
- **Off-limits:** `lib/rate-ninja.js` (T2 owns it), `lib/offer-domain.js` (T3),
  `lib/store.js` (deployed token format), all of `docs/`.

If you need to change an off-limits file, stop and report rather than widening scope.

## Out of scope

- Any offer route, form, or view (T4).
- Rate or sailing reads (T2).
- Per-user rather than per-session connections. D-1 keys records by identity; connections
  staying per-session is acceptable for the prototype.
- Audit writes. The `audit` array exists; T8 defines what goes in it.

## Tests that must exist

- Userinfo returns 500 → no connection stored, the refresh token was revoked at the mock,
  redirect to `?result=identity_unavailable`.
- Userinfo returns `companyType: "Freight Forwarder/Customer"` → no connection stored,
  revoked, `?result=only_contract_owner`.
- Userinfo returns empty `companyId` → same as the first case.
- A store pre-seeded with an empty-profile connection → `requireIdentity` treats it as not
  connected and deletes it.
- Records: fresh file is v1; `transact` persists and survives reopen; a throwing `fn`
  persists nothing; an async `fn` throws; a corrupt file throws on open; `schemaVersion: 2`
  throws on open; file mode is 0600.
- A route registered through `lib/routes/*` is reachable, and an unknown path is still a
  404 JSON.

## Gate

Per `docs/plan.md` §2. Expected: the 8 existing tests plus yours, all passing, 0 skipped.

## Disagree if needed

If you think any part of this is the wrong approach (for example, that `node:sqlite` is
worth it after all, or that revoking on identity failure is wrong), say so in the handoff
with evidence instead of implementing it half-heartedly.

## Hand back

The block in `docs/prompts/HANDOFF.md`. Contracts: C-1, C-2. Migration: M-1 (initial
records schema; verify on a missing file and on a file you wrote with `transact`).
