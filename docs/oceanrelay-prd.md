# OceanRelay PRD

**Status:** Follow the phases in order. Phase 1 is done. Phase 2’s live Connect is done. Phases 3–6 have not started.
**Product:** OceanRelay, a forwarder-to-forwarder code-share for carrier-backed capacity claims
**Service:** https://oceanrelay.ai and https://oceanrelay.onrender.com
**Identity and rates:** https://rateninja.co
**Chain, when that phase starts:** ForteL2 Sepolia, chain ID 852

This is the product sequence for OceanRelay, including the Rate Ninja contract that is already delivered. Requirements come from the blockchain features spec, the Rate Ninja partner PRD, the Capacity Exchange handoff, and the OceanRelay connect brief.

## Product

A freight forwarder connects with a Rate Ninja account and publishes a service under a code-share name it chooses. Another forwarder can request that service. Buyers see it as “XYZ, operated by ABC”: XYZ is the seller’s code-share name, and ABC is the named operating carrier. The name is the seller’s label. It is not carrier endorsement.

Rate Ninja supplies identity and, when the account has them, contract rates and sailings. A rate is a price. It is not a quantity of space, a right to transfer space, or a booking. OceanRelay stores the seller’s capacity claim, the source, the code-share name, and what the other party accepted. The record says who claimed what. It does not prove the space exists. A carrier can still roll, change, or cancel a booking after confirmation, and the product says so.

OceanRelay keeps private commercial data in its own records. A later phase writes a short lifecycle proof to ForteL2 Sepolia. The prototype does not hold money, pay anyone, or book with a carrier.

## Who it is for

- **Seller.** A Rate Ninja contract owner. They publish an offer from a Rate Ninja rate, or by typing the offer themselves.
- **Buyer.** A Rate Ninja contract owner. They find an offer and request some of the listed quantity.
- **Rate Ninja administrator.** Manages Rate Ninja users and the OAuth client. They are not a party to an offer.
- **Prototype operator.** Reviews test records and operational exceptions. They cannot quietly change terms the parties already accepted.

Company type decides access. A **Contract Owner** may connect OceanRelay. A **Freight Forwarder/Customer** company may not. A contract owner with no rates may still connect and enter an offer by hand. The user belongs to a company in Rate Ninja. OceanRelay trusts that company from the Rate Ninja grant, never from a value the browser sends. OceanRelay never asks for a Rate Ninja password.

## Standing rules

These hold in every phase.

- Partner scopes are `profile:read`, `rates:read`, and `sailings:read`.
- Authorization code with PKCE S256. The code lasts 60 seconds and works once. The access token lasts 10 minutes. The refresh token lasts 30 days, rotates on each use, and reuse of an old refresh token revokes that family. Revocation takes effect on the next partner call.
- The client secret and refresh token stay on the OceanRelay server. The browser session does not hold them.
- Rate and sailing reads return that contract owner’s base records, not Rate Ninja’s customer-margin prices. Currency and source-updated time are null. OceanRelay stores its own retrieval time and asks the seller to confirm currency before anything is published.
- Empty rate and sailing lists are a valid connected account. They are the path to manual entry.
- There is no Rate Ninja allocation or capacity API. Quantity, code-share name, operating carrier, and marketplace status are OceanRelay data.
- The demo API (`/api/v1/*` with the global Rate Ninja API key) is not used for a signed-in user.
- Buyer-facing price is the seller’s price: a Rate Ninja rate or a manually entered price, plus an absolute markup or a percentage markup. Auction, bid/ask, reservation fee, and take-or-pay appear only as later possibilities in the capacity-marketplace notes. They are not part of this prototype.

## Not in this work

- Deleting Rate Ninja rates whose effective date is already past. That cleanup is separate from OceanRelay.
- Cross-border payment, deposits, conditional settlement, escrow, stablecoins, freight financing, hedging, agent profit sharing, and electronic trade documents. The pilot decides later whether any of them are worth a separate product.
- Carrier booking, inventory reservation, or a claim that a blockchain record creates a right the carrier must honor.
- A public marketplace that people can use without a Rate Ninja account.
- Replacing Rate Ninja’s rate engine.

---

## Phase 1 — Rate Ninja partner contract

**State:** Done

**Goal.** OceanRelay can identify a Rate Ninja contract owner and read that owner’s rates and sailings, without ever handling the Rate Ninja password or the owner’s customer prices.

**In scope.**

- Login, Argon2id password hashes, email password reset, optional TOTP, and CSRF protection on browser actions that change state.
- A company on the user, with company type Contract Owner or Freight Forwarder/Customer.
- Many-to-many margins kept inside Rate Ninja, and withheld from the partner rate payload.
- OAuth 2.0 authorization code with PKCE, consent, token refresh, revoke, and discovery.
- Scoped REST reads for profile, rates, and sailings, plus the same reads on the in-process MCP endpoint.
- An admin screen for OAuth clients.
- Automated tests for this surface.

**Already done.** All of the above is merged and live at rateninja.co. A contract owner can sign in on Rate Ninja and grant a client. A Freight Forwarder/Customer company is refused. A contract owner with no rows still authorizes, and rate and sailing calls return an empty HTTP 200 list. Responses are base contract records, are not cached (`Cache-Control: no-store`), and leave currency and source-updated time null. MCP exposes the same user and scopes: profile, list and get rates, list and get sailings. Accounts that lost a legacy plaintext password are recovered with an administrator-set password or the email reset, not by replaying the old value.

**Left.** Nothing in this PRD.

**How you know it’s done.** OceanRelay’s later phases call this live contract as it stands: contract-owner only, scoped rates and sailings, no customer margins, no allocation resource, no demo API key. They do not add Rate Ninja features.

---

## Phase 2 — Connect OceanRelay to Rate Ninja

**State:** Live Connect completed. Stephen connected OceanRelay to Rate Ninja on 2026-09-28.

**Goal.** A contract owner connects the deployed OceanRelay service to Rate Ninja, gets an OceanRelay session, and can disconnect. The Rate Ninja password stays on Rate Ninja.

**In scope.**

- Connect from OceanRelay, using authorization code and PKCE S256, with the scopes in the standing rules.
- Return URL `https://oceanrelay.ai/oauth/callback`.
- An OceanRelay session cookie. The access token, refresh token, and client secret remain on the server.
- Encrypted storage of those tokens on the service disk.
- A connected state and a disconnected state. Disconnect revokes the grant at Rate Ninja.
- The connected user’s profile. Freight Forwarder/Customer companies remain refused.
- A configuration check that lists missing settings and does not reveal secret values.

**Already done.** OceanRelay is a Node web service on Render at https://oceanrelay.ai and https://oceanrelay.onrender.com. The callback is `https://oceanrelay.ai/oauth/callback`. Encrypted tokens are stored at `/var/data/oceanrelay-store.json` on a persistent disk. On 2026-09-28 a contract owner completed Connect: Rate Ninja sign-in, approval, and a connected OceanRelay session. Rate Ninja’s side of the handshake is Phase 1.

**Left.** The live Connect is done: a contract owner signed in at Rate Ninja, approved OceanRelay, and returned to a connected session. Disconnect is the remaining check in this phase’s goal. The refused-company, empty-rate, and revoke checks can wait until they come up in use.

**How you know it’s done.** One person has seen all of this on the deployed service:

- A contract owner signs in at Rate Ninja, approves OceanRelay, and returns to a connected OceanRelay session.
- A Freight Forwarder/Customer company cannot complete authorization.
- A contract owner with no rates still connects. Rate and sailing reads return empty lists, which is a valid account.
- When rates are returned, they are that owner’s base rates. Margin prices are absent. Currency is still unknown.
- After disconnect, or after revoke in Rate Ninja, refresh and the next partner read fail.
- The browser does not receive the client secret, access token, or refresh token.
- OceanRelay does not send the demo API key.

This phase ends at a connected session. Creating an offer is Phase 3.

---

## Phase 3 — Off-chain offers

**State:** Not started. Start after Phase 2 is done.

**Goal.** A connected contract owner saves a code-share offer from a Rate Ninja rate, or saves one by manual entry. The offer is a seller claim with a clear source. It is not a statement that Rate Ninja confirmed space.

**In scope.**

- Pick a rate the connected owner can read, or pick manual entry. Sailings can be shown as schedule context. A sailing is not a quantity.
- Show lane, equipment, effective and expiration dates, source, source record id, and the time OceanRelay retrieved the row. Show what came from Rate Ninja and what the seller typed.
- The seller confirms currency, because Rate Ninja sends null.
- The seller enters claimed quantity and unit, sailing window or dates, cutoff if they know it, a validity deadline, the code-share name, the operating carrier, an absolute or percentage markup, and the service terms.
- Display “XYZ, operated by ABC”, and label the code-share name as seller-provided.
- New offers start as seller-asserted. A Rate Ninja rate or sailing never sets carrier-confirmed. Carrier-pending and carrier-confirmed are available only when the seller records that status on purpose. Carrier-confirmed still says the carrier may roll, change, or cancel.
- A seller preview splits the private buy rate and markup from the price and terms a buyer will see.
- Save the draft off-chain, with an immutable snapshot of the Rate Ninja fields used at that moment. If the source rate later changes or expires, keep the snapshot and warn the owner. Published terms do not change by themselves.
- A contract owner with no rates completes the same draft by hand. The source is Manual, and the default status is seller-asserted.

**Already done.** No OceanRelay offer exists. Phase 1 can supply the rate once Phase 2 has connected the owner.

**Left.** Draft and preview for an owner who has a Rate Ninja rate, and draft and preview for a contract owner who has none.

**How you know it’s done.** On the deployed service, a connected contract owner saves and previews an offer built from one of their Rate Ninja rates, and a contract owner with no rates saves and previews a manual offer. Both previews say the quantity is the seller’s claim. A second user is not required yet.

---

## Phase 4 — Off-chain requests and acceptance

**State:** Not started. Start after Phase 3 is done.

**Goal.** A second contract owner finds a published offer, requests a quantity, and receives a recorded answer. OceanRelay will not accept the same listed quantity twice inside OceanRelay.

**In scope.**

- Publish, pause, and expire offers. Search and filter by origin, destination, carrier, equipment, sailing or date window, price, and status.
- The buyer sees the offered price and the terms meant for buyers. The buyer does not see the seller’s buy rate or markup.
- A request cannot exceed the quantity still listed. Two requests at the same time cannot accept more than that listed quantity inside OceanRelay. The screen says this limit is only inside OceanRelay: it does not hold carrier space, and it does not stop the seller from promising the same space somewhere else.
- The seller accepts, declines, or counters. A counter is a new version, and the buyer accepts that version afresh.
- After a request exists, that offer version does not change in place. An edit is a new version, and pending acceptance of the old version does not carry over.
- An acceptance records the offer version, quantity, both Rate Ninja identities, price, currency, and a hash of the terms.
- After acceptance, the seller, buyer, or operator can record carrier-pending, carrier-confirmed, rejected, rolled, completed, or cancelled, each with the actor and the time. An accepted request is a marketplace agreement. It is a carrier booking only when a carrier confirmation has been recorded.
- Before acceptance, the seller may cancel. After acceptance, cancellation stands when both parties agree. Otherwise the request is an unresolved dispute. No fee and no payment moves.
- The operator can review company, source, status history, and inconsistencies, and cannot silently rewrite accepted terms.
- Authentication, grant and revoke, publish, revision, decisions, status changes, and operator actions are audited. Passwords and tokens are not written in those logs.
- Empty, loading, failure, expired-session, and no-result states are part of the flow.

**Already done.** Nothing. Phase 3 produces the draft this phase publishes.

**Left.** The published marketplace flow in OceanRelay’s own records, for two contract owners.

**How you know it’s done.** Two contract-owner accounts publish an offer, request a quantity, and record a decision. A concurrent acceptance cannot take quantity that is no longer available. The buyer view hides the buy rate and markup. The status copy never treats a rate, or an accepted request alone, as a carrier booking.

**Open decision, left open.** The marketplace notes ask what cancellation and dispute terms participants will expect to live with. This phase does not answer that. Until they do, the only policy is the one above: both parties agree, or the request stays an unresolved dispute, and no money moves.

The operating carrier is visible to marketplace users in the code-share line. Whether the buyer’s shipper also sees that name is undecided. This phase has no shipper screen.

---

## Phase 5 — On-chain lifecycle record

**State:** Not started. Start after Phase 4 is done.

**Goal.** Publish and acceptance leave a record on ForteL2 Sepolia that a third party can verify. The record commits to the off-chain terms. It does not contain them, and it does not prove the carrier has the space.

**In scope.**

- Use ForteL2 Sepolia, chain ID 852, with its published RPC settings. Leave ForteL2 and its L1 contracts as they are. The network is a test deployment with no uptime commitment, so a failed call stays pending and is retried and reconciled. It is not treated as a final rejection by itself.
- Deploy OceanRelay’s prototype application contract through the chain owner’s normal process. No mainnet, and no contract that moves real funds.
- A wallet signature shows control of an address and binds that address to the signed-in Rate Ninja user and company. Browsing and drafting work without a wallet. Publishing an on-chain offer, or accepting a request that is linked on-chain, requires the bound wallet.
- The contract stores an opaque offer id, the seller wallet, lifecycle state, version number, time or block references, and a salted hash of the full off-chain offer version. The salt stays in OceanRelay. The contract does not store rates, margins, company names, customer details, or documents.
- It records publish, a new version, a request and acceptance reference, status changes, and cancellation or expiry. It rejects a replay, a duplicate offer id, an illegal status change, and a signer who is not bound to that company.
- OceanRelay marks an action on-chain only after it has checked the transaction receipt and the chain id. The screen shows pending, confirmed, or failed.
- The operator can compare OceanRelay’s records with the chain and flag a mismatch. Repair is a new audited correction, not a quiet overwrite.
- No escrow and no stablecoin transfer.

**Already done.** No OceanRelay contract is in scope as delivered. Phase 4’s off-chain record is what the hash will commit to. ForteL2 Sepolia is the network this phase uses; this phase does not create that network.

**Left.** Wallet binding, the prototype contract, the lifecycle events above, and the comparison between OceanRelay’s records and the chain.

**How you know it’s done.** A publish and an acceptance from Phase 4 can be verified on chain ID 852. Price, margin, company, and customer cannot be read from the chain. The screen says the chain shows that this version was recorded. It does not say the capacity claim is true.

**Open decision, left open.** The parked payment and escrow ideas stay parked. Whether any shared settlement belongs on this chain is a decision after the pilot. This contract does not move funds.

---

## Phase 6 — Invite-only pilot

**State:** Not started. The decisions below come before the pilot. The pilot itself starts after Phase 5 is done.

**Goal.** A small group of contract owners uses the finished prototype on one lane. Their behavior decides whether any further product is justified.

**In scope.**

- Invited Rate Ninja contract owners only, on one lane or one family of routes.
- Record how many offers are created, how many requests arrive, how long a decision takes, how many complete, and how many are cancelled, rolled, or disputed. Note who participates again.
- A go or no-go, and an ordered list of what would be built after that.

**Already done.** Nothing in the field. Phases 1–5 are the prototype the pilot uses.

**Left.** Name the participants and the lane, run the pilot, and write down the results.

**How you know it’s done.** The pilot has a go or no-go and a ranked backlog. A go does not include payments, financing, a carrier booking connection, or a wider market. Each of those remains its own decision.

**Decisions required before the pilot starts.** These are unanswered in the source specs. Leave them unanswered until the participants are real.

1. Which forwarders are invited, and which lane has enough buyer and seller overlap to test.
2. Whether those participants need offer fields beyond the set Phase 3 requires. The prototype uses that set either way. Extra fields wait on this answer.
3. When, if ever, the operating carrier name is shown to the buyer’s shipper. Marketplace users already see it in Phase 4. A shipper-facing view waits on this answer.
4. Which cancellation and dispute terms the participants expect. Phase 4’s rule (mutual agreement, or an unresolved dispute, and no payment) stays in force until they adopt a written alternative. That alternative is not part of this prototype.

## Prototype complete

The prototype is complete when a contract owner connects without giving OceanRelay a Rate Ninja password, an owner with a rate publishes a code-share offer with a markup, an owner with no rate publishes a manual offer, a second owner requests quantity and gets a recorded decision, OceanRelay refuses a second acceptance of quantity it no longer has, and those lifecycle events can be checked on ForteL2 Sepolia with the private price left off the chain. Every decision screen still distinguishes a seller’s claim, a marketplace acceptance, and a carrier confirmation.
