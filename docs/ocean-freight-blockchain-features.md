# OceanRelay — Freight Forwarder Code-Share Prototype PRD

**Status:** Prototype PRD; OceanRelay build remains to be done; RN partner integration is implemented but production-disabled pending activation  
**Product name:** OceanRelay  
**Primary analogy:** A digital co-loader / forwarder-to-forwarder “code-share” for carrier-backed capacity  
**Chain:** ForteL2 Sepolia testnet, chain ID 852; the exchange integrates with the existing network configuration  
**Scope:** A working end-to-end prototype, with lifecycle records on ForteL2 and no real-money custody or promise of guaranteed carrier space.

## 1. Product summary

Build a web application where freight forwarders authenticate with their RateNinja (RN) account and create, publish, discover, and request access to ocean-freight capacity. A forwarder with RN rate data can select a contract rate and turn it into a code-share offer by adding available quantity, shipment details, a customer-facing code-share name, and a margin. A contract-owner forwarder without RN rate data can enter an offer manually after authenticating through RN. RN customer accounts cannot authorize OceanRelay.

The product should feel like a digital co-loader exchange: one forwarder presents a service to its own customer using a chosen code-share name while another forwarder supplies the underlying rate and/or capacity. Show the offer like an airline codeshare—“XYZ, operated by ABC”—with the seller-facing code-share brand distinct from the named underlying carrier. Carrier capacity has no universal proof source in this model. The platform records who made each claim, its source, and its history; it does not certify that an allocation exists or can be transferred. Even a carrier-confirmed booking may later be rolled, changed, or cancelled under carrier operations and terms.

The application uses RN for identity and, when available, carrier rate/contract data. It uses ForteL2 Sepolia to record verifiable offer and transaction lifecycle events. The SaaS database remains the source for private data and operational workflow. The prototype will not custody funds, issue real bookings, or claim an on-chain record itself proves or creates transferable rights. ForteL2 documentation describes chain 852 as a Sepolia learning/test deployment and states there is no uptime commitment; the prototype must tolerate RPC or sequencer downtime.

## 2. Problem and opportunity

Forwarders sometimes have access to carrier pricing or contracted allocations they cannot fully use, while other forwarders need a lane, equipment type, or sailing window they cannot source as easily. Today, discovering an appropriate partner, confirming what is actually available, agreeing price and responsibility, and keeping a shared audit trail can require fragmented email and messaging workflows.

RN already manages rates and provides user-specific rate access. A capacity code-share workflow can extend that existing relationship into partner discovery and a structured transaction record. The prototype tests whether forwarders will publish and request offers, and whether RN-linked rate provenance plus an L2 event history improves trust and coordination.

## 3. Goals

- Reuse RateNinja identity so users have one RN account and can connect without sharing their RN password with the exchange.
- Let eligible RN users select an accessible carrier rate and create a capacity offer with a margin and customer-facing code-share name.
- Let RN users without usable RN rates create a manual offer after signing in to RN.
- Support a complete prototype journey: publish, discover, request, accept or decline, record carrier confirmation status, and close or cancel an offer.
- Write minimally identifying offer and lifecycle proofs to the RateNinja L2; keep private commercial terms and sensitive data off-chain.
- Make the status and responsibility for each offer explicit so seller-asserted capacity is not mistaken for carrier-confirmed availability.
- Define a RateNinja API and MCP integration contract that can be implemented alongside the exchange.

## 4. Non-goals for the prototype

- A regulated or exchange-traded freight futures market.
- Real-money stablecoin payment, escrow, lending, credit underwriting, or financing.
- Automated carrier booking or inventory reservation unless a carrier API is separately integrated and authorized.
- A claim that an RN rate row by itself proves an allocation or available container quantity.
- Publicly exposing carrier buy rates, forwarder margins, customer identities, contract documents, or personal data on-chain.
- Replacing RN's rate engine or changing its rate-ingestion and customer-tier workflow.
- Broad public access without an RN account.

## 5. Users and roles

- **Capacity provider / seller:** an RN-authenticated forwarder that creates and maintains an offer. It may use an RN rate or enter terms manually.
- **Code-share forwarder / buyer:** an RN-authenticated forwarder that discovers offers and submits a request for some or all of the available quantity.
- **Offer owner:** the seller's authorized user who can edit, pause, accept requests, mark confirmation state, or cancel according to offer state.
- **RN administrator:** manages RN users and integration configuration; does not automatically become a marketplace counterparty.
- **Prototype operator:** can review test records and operational exceptions, but cannot silently alter accepted commercial terms.

Only RN contract-owner accounts can authorize OceanRelay; RN customer accounts are denied. Contract owners with no rate records can still use manual entry. User access and company boundaries come from RN-authenticated identity and server-side authorization; client-supplied company IDs or role flags are never trusted.

## 6. Core terminology and capacity status

- **Rate:** carrier pricing terms, potentially imported from RN. A rate does not imply that container space is allocated.
- **Allocation:** a quantity of capacity that a forwarder claims to have access to under an agreement. Its transferability may be subject to the carrier contract.
- **Offer:** a forwarder's listing of rate, lane, equipment, dates, quantity, terms, and code-share name.
- **Code-share name:** seller-selected commercial label shown to an eligible buyer/customer; it must not imply carrier endorsement.
- **Seller-asserted:** entered by the seller and not independently confirmed by a carrier integration.
- **Carrier-pending:** the seller has requested carrier confirmation and the response is outstanding.
- **Carrier-confirmed:** supported by an authorized carrier response or an explicitly recorded confirmation artifact reviewed under the prototype process.
- **Unavailable / cancelled / expired:** no longer requestable.

Every screen, API response, and on-chain event must preserve the difference between these states and show the actor/source for the claim. Imported RN rate or contract pricing must not silently set capacity status to carrier-confirmed. No single technology or platform-level process is represented as solving the industry-wide lack of universal proof.

## 7. Primary user journeys

### 7.1 Sign in and connect RateNinja

1. User selects **Continue with RateNinja**.
2. The exchange redirects to RN's authorization flow. The user signs into RN and approves the exchange's requested scopes.
3. RN returns the user to the exchange with a short-lived authorization code. The exchange server exchanges it for a scoped token and creates its own session.
4. The user chooses an available RN rate (if any) or selects manual entry.
5. At any time, the user can disconnect the exchange and revoke the grant through RN.

The exchange must never ask the user to type an RN password into the exchange, store it, or pass it through a browser to the exchange API. A user without an RN contract-owner account must first obtain an eligible RN account; RN customer accounts cannot use OceanRelay.

### 7.2 Create an offer from an RN rate

1. User selects a rate visible to their RN account.
2. Exchange shows the chosen code-share name and underlying carrier in “XYZ, operated by ABC” format, lane, equipment/rate fields available, effective and expiration dates, and source label.
3. User enters the claimed/confirmed allocation quantity, sailing window or date range, cutoff if known, code-share name, markup, currency, and terms.
4. The app displays the derived offer price and a clear explanation of which values came from RN and which were entered by the user.
5. User previews what buyers can see versus private terms, then publishes.
6. Offer and terms are saved off-chain; an on-chain listing event records an opaque offer identifier and cryptographic commitment to the published version. The event proves that a version was recorded, not that its allocation claim is true.

### 7.3 Create a manual offer

1. User signs in through RN as above.
2. User selects manual entry and completes the same required offer fields, including carrier/rate provenance label, quantity, availability dates, price, margin if used, code-share name, and service terms.
3. User attests that they have authority to offer the described service and chooses the correct confirmation status.
4. The app marks the source as **Manual** and defaults capacity to **Seller-asserted** unless supporting confirmation is provided.
5. Publishing creates the same off-chain record and on-chain proof as an RN-linked offer.

### 7.4 Discover, request, and accept

1. Buyer filters available offers by origin, destination, carrier, equipment, sailing/date window, price, and status.
2. Buyer opens a public-to-marketplace offer view that does not reveal the seller's private buy rate or margin.
3. Buyer requests quantity and provides shipment/contact details needed by the seller.
4. Seller accepts, declines, or proposes revised terms. A revision creates a new version and requires buyer re-acceptance.
5. On acceptance, the platform records both parties' acceptance and updates the remaining quantity transactionally to prevent over-allocation within the prototype.
6. Seller or operator records carrier-pending, carrier-confirmed, rejected, rolled, completed, or cancelled status. These changes update the audit history and on-chain event state.

### 7.5 Close, expire, or cancel

Offers can be paused, expire at a set time, be cancelled by the seller before requests are accepted, or move to a cancellation/dispute state after acceptance. Any accepted request must retain its immutable terms and status history. Prototype policy for cancelling accepted requests must be explicit and agreed by both parties or marked as an unresolved dispute; no automatic penalty or fund transfer occurs.

## 8. Functional requirements and acceptance criteria

### A. Identity, account linking, and permissions

- **A1.** An RN contract-owner user can authenticate through RN authorization code flow with PKCE. RN customer accounts are denied.
- **A2.** Exchange receives only scoped, revocable RN tokens; access and refresh tokens are stored server-side encrypted, never in local storage or public chain data.
- **A3.** RN grant can be revoked by user or RN administrator; exchange sessions and tokens become unusable promptly after revocation or expiry.
- **A4.** RN identity maps to a stable RN user ID and company/tenant context; exchange authorization is company-scoped and enforced server-side.
- **A5.** A contract-owner user with no RN rate/contract records can still access manual offer creation after RN authentication.
- **A6.** Invalid, expired, replayed, or cross-client authorization codes are rejected; login responses do not reveal whether a username exists.

### B. RN-linked rate import

- **B1.** User can request only rates accessible to their RN identity/RateView; no public demo key is used for per-user access.
- **B2.** Rate details show source, source record ID, OceanRelay retrieval timestamp, rate validity, and any fields omitted from the offer. RN currently returns no currency or source-updated timestamp, so the seller must confirm currency before publishing.
- **B3.** If source rate changes or expires, the published offer preserves the version used at creation and warns the owner; terms do not mutate silently.
- **B4.** RN rates can seed price fields, but allocation quantity and carrier confirmation are separately entered or confirmed.
- **B5.** API errors, no-rate accounts, and revoked authorization have clear recoverable states.

### C. Offer creation and privacy

- **C1.** An offer requires seller company, lane, equipment, quantity, quantity unit, availability/sailing window, currency, validity deadline, code-share name, named operating carrier, source type, and stated confirmation status.
- **C2.** RN-linked offers reference an RN rate record and snapshot the relevant terms; manual offers identify manual provenance.
- **C3.** Seller can set an absolute markup or percentage markup. The system displays source rate, markup, and buyer-facing price only to the seller; buyers see the offered price and relevant terms.
- **C4.** Offer preview clearly distinguishes seller assertion from recorded carrier confirmation, labels the code-share name as seller-provided, and warns that carrier-confirmed bookings remain subject to operational roll, cancellation, or change.
- **C5.** Offer version is immutable after requests begin; any edit creates a new version and invalidates pending buyer acceptance as appropriate.
- **C6.** No confidential fields or personal data are written in plaintext to the L2.

### D. Marketplace transactions

- **D1.** Buyers can search/filter open offers and view only buyer-authorized fields.
- **D2.** Buyers can request a quantity no greater than the currently available quantity; duplicate or concurrent requests cannot oversubscribe availability.
- **D3.** Seller can accept, decline, or counter; counterterms require fresh acceptance from the buyer.
- **D4.** Accepted request captures the exact offer version, quantity, buyer and seller RN identities, price, currency, and terms hash.
- **D5.** Parties can record operational milestones and cancellation reasons; status transitions are timestamped and auditable.
- **D6.** Prototype does not represent an accepted marketplace request as a carrier booking unless carrier confirmation is present.

### E. RateNinja integration status and OceanRelay requirements

RateNinja has implemented and deployed the partner integration on its service. It is currently feature-gated off in production: OAuth, partner API, and MCP return `partner_oauth_disabled` until OceanRelay's callback is registered, the RN security gates are accepted, and `PARTNER_OAUTH_ENABLED=true` is set on Render. The current operational origin is `https://rateninja.co`.

**Delivered by RN:** Argon2id password hashing (legacy plaintext is cleared at startup; accounts without a hash need an administrator-set password), password reset, optional two-factor authentication, CSRF protections, OAuth authorization code with PKCE S256, consent, client redirect allowlisting, short-lived access tokens, rotating refresh tokens, revocation/consent management, discovery metadata, and matching REST/MCP access. Only RN contract-owner accounts may authorize; customer accounts are denied. A contract owner with no rates can still connect and receive empty rate/sailing lists.

RN provides the account's base/contract rates and sailings, not customer-margin prices. Currency and source-updated time are `null`. RN has no allocation-quantity or carrier-confirmation API; an RN rate or sailing does not establish bookable or transferable capacity. OceanRelay must use manual capacity claims and keep the provenance/status visible.

- **E1. Client activation:** rename RN's first registered client from `Capacity Exchange` to `OceanRelay`; register OceanRelay's exact HTTPS callback; keep the confidential client secret in OceanRelay's server-side secret store.
- **E2. Account eligibility:** only RN contract-owner accounts may authorize. Customer accounts are denied. Contract owners with no rates may continue to manual entry. OceanRelay never collects RN passwords.
- **E3. Rate and sailing import:** call `/api/partner/v1/me/rates` and `/api/partner/v1/me/sailings` under the user's grant, with `rates:read` and `sailings:read`. Do not call the demo `/api/v1/*` API for signed-in user data. Confirm currency with the seller when RN returns `null`; record OceanRelay's own retrieval timestamp.
- **E4. No RN allocation endpoint:** capacity quantity, seller claims, operating-carrier labels, and marketplace status remain OceanRelay data. Do not add or infer allocations from RN rates/sailings.
- **E5. OAuth lifecycle:** use the implemented consent, authorization-code + PKCE S256, token, refresh, revoke, and user-consent endpoints. Access tokens last 10 minutes; refresh tokens last 30 days and rotate. Reusing an old refresh token revokes its token family; revocation applies on the next API/MCP call.
- **E6. MCP:** use RN's existing `POST /mcp` endpoint and `rateninja_get_my_profile`, `rateninja_list_my_rates`, `rateninja_get_my_rate`, `rateninja_list_my_sailings`, and `rateninja_get_my_sailing` tools. It uses the same user/scopes as REST and is subject to the same production feature gate.
- **E7. Production gate:** complete the RN partner-integration security review, rename the client, register callback, configure the client secret, enable the flag, and verify the acceptance walkthrough before pilot use.

See the separate [RateNinja–OceanRelay integration PRD](rateninja-partner-integration-prd.md) for the completed RN work and remaining activation steps.

### F. L2 integration

- **F1.** OceanRelay connects to ForteL2 through configured RPC and chain ID; wallet signature proves control of an address and binds it to the authenticated RN account/company.
- **F2.** Target the existing ForteL2 Sepolia testnet, chain ID 852, using its published RPC/access configuration. Do not redeploy ForteL2 or change its L1 contracts for this prototype. Deploy only the prototype application contract through the chain owner's normal process; no mainnet or real-funds deployment.
- **F3.** Contract records offer ID, seller wallet, lifecycle state, version number, timestamps/block references, and a hash of the complete off-chain offer version. The contract must not store carrier rates, margins, company names, customer details, or documents.
- **F4.** Contract supports publishing, versioned amendment, request/acceptance references, status updates, cancellation/expiry, and authorized role checks. Avoid putting full booking/customer info in event arguments.
- **F5.** Backend verifies transaction receipt and chain ID before marking an action on-chain; UI shows pending, confirmed, or failed transaction state.
- **F6.** Replayed actions, duplicate offer IDs, invalid state transitions, and unauthorized signers are rejected.
- **F7.** No real-money escrow or stablecoin transfers are enabled in this prototype.

### G. Operations and audit

- **G1.** Admin can review user/company, offer source, status history, chain transaction, and event discrepancies without editing terms silently.
- **G2.** System logs authentication, grant/revocation, offer publication/revisions, request decisions, confirmation updates, and admin actions without logging passwords or tokens.
- **G3.** Reconciliation job or admin action can compare database offer state with L2 events and flag mismatch; repair requires an auditable correction event.
- **G4.** Empty, loading, failure, expired-token, failed-transaction, and no-result states are implemented.

## 9. Data model (prototype minimum)

### RN-side

- `oauth_clients`: client ID, hashed secret if confidential client, allowed redirects, status, scopes.
- `oauth_grants`: RN user ID, client ID, approved scopes, created/revoked timestamps.
- `oauth_tokens`: hashed refresh-token identifiers, expiry/rotation/revocation metadata; access tokens short-lived.
- RN has no allocation table/API for this integration; OceanRelay stores seller-entered capacity claims and their stated source/status.

### Exchange-side

- `users`: stable RN subject ID, company/tenant ID, display name, wallet binding, status.
- `offers`: seller, source kind (`rn_rate`, `manual`), RN source IDs and snapshot, route/equipment/date scope, quantity/available quantity, currency, buyer-facing price, private source price and markup, code-share name, status, provenance/confirmation status, expiration.
- `offer_versions`: immutable terms snapshot, canonical terms hash, author, timestamps.
- `requests`: buyer, offer/version, requested quantity, state, counter terms, accepted terms snapshot/hash, timestamps.
- `operational_events`: carrier confirmation evidence reference, booking reference if any, milestone, actor, timestamp, notes/document hash.
- `chain_transactions`: chain ID, transaction hash, contract address, event/offer reference, finality status.
- `audit_events`: actor, action, entity/version, timestamp, request correlation ID.

Token material, credentials, and sensitive commercial fields are never stored on public chain. Encrypt OAuth credentials at rest; enforce tenant isolation in every query.

## 10. Proposed API surface

Exact paths may follow RN conventions, but the contract should cover:

**RateNinja authorization and data**

- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/revoke`
- `GET /oauth/userinfo` or equivalent authenticated profile endpoint
- `GET /api/v2/me/rates`
- `GET /api/v2/me/rates/{rateId}`
- `GET /api/v2/me/allocations`
- `GET /api/v2/me/allocations/{allocationId}`

**Exchange service**

- `POST /api/offers`, `GET /api/offers`, `GET /api/offers/{id}`, `PATCH /api/offers/{id}` for owner-only changes
- `POST /api/offers/{id}/requests`, `POST /api/requests/{id}/accept`, `/decline`, `/counter`
- `POST /api/requests/{id}/events` for allowed operational milestones
- `POST /api/wallet/nonce`, `POST /api/wallet/verify` for wallet binding

The RN MCP tools should call the same scoped RN data services as REST. The exchange's marketplace actions should remain in its normal API; MCP should not bypass offer authorization or transaction-state rules.

## 11. Blockchain design constraints

- Maintain a chain adapter with ForteL2 Sepolia chain ID 852 and configured read/write RPCs and contract address. ForteL2 may be unavailable during operator downtime; use retries, clear pending states, and reconciliation rather than treating RPC failure as transaction failure.
- Use wallet signatures for user-authorized chain actions, with server-side verification that the signer is bound to the RN-authenticated user/company.
- Store canonical private offer JSON off-chain; calculate a stable, versioned hash for on-chain commitment.
- Use opaque IDs and avoid guessable hashes of low-entropy/private price records; include a random salt in commitments and retain it off-chain.
- Treat chain events as tamper-evident evidence of a recorded action, not proof that the carrier's real-world capacity claim is true.
- Plan for confirmations/reorg handling, duplicate submissions, RPC outages, contract pause/admin procedures, and transaction retries.

## 12. Security, privacy, and trust requirements

- RN password never leaves RN authentication screens and endpoints; exchange only receives scoped tokens.
- RN has implemented Argon2id password hashing and clears legacy plaintext values on startup. Accounts without a password hash need an administrator-set password; confirm account recovery and RN partner security gates before enabling production access.
- All endpoints enforce authorization server-side; tenant and company isolation is tested.
- OAuth state/PKCE, redirect allowlists, token rotation/revocation, CSRF controls, request throttles, secure headers, and audit trails are required.
- Do not place personal data, customer data, contract documents, base rates, margins, or readable company identifiers on a public L2.
- Wallet connection is optional for browse/create-draft, but required to publish on-chain or accept an on-chain-linked transaction.
- User sees source and confirmation status at every transaction decision.
- Prototype uses test data and no real payment or escrow contracts.

## 13. Success measures for prototype

- A user can authenticate through RN without providing credentials to the exchange.
- An RN-linked user can import an authorized rate and publish a code-share offer with markup.
- An RN contract-owner with no rate can create a manual offer.
- A second RN-authenticated user can discover the offer, request quantity, and receive a recorded decision.
- Concurrent requests cannot oversubscribe the available quantity in the exchange database.
- Relevant lifecycle actions produce a verifiable L2 record, while private price and margin remain undisclosed on-chain.
- The UI never implies that a rate is confirmed capacity or that accepted marketplace terms equal a carrier booking.
- Demo walkthrough completes with seeded RN accounts and test L2 deployment; account linking, rate retrieval, offer/request lifecycle, and chain confirmation are observable.

## 14. Delivery phases

The OceanRelay service is already deployed on Render. Start by making that deployment capable of completing the RN callback; do not wait for the marketplace UI or ForteL2 integration. Register the production callback in RN only after its route is implemented and reachable.

### Phase 0 — OceanRelay service and OAuth callback foundation

- Establish the separate OceanRelay repository and service as the source for the existing Render deployment. Confirm the production hostname, deployment process, and HTTPS behavior.
- Add a health endpoint and a configuration check that reports missing required settings without exposing secret values.
- Implement the exact RN callback route and a minimal **Connect RateNinja** entry point. The callback must validate OAuth state, use PKCE S256, exchange the short-lived code server-side, and establish an OceanRelay session.
- Add server-side secret configuration for RN client credentials and encrypted, server-side token storage. Do not put the client secret or refresh token in browser storage.
- Once the deployed callback route is reachable, register its exact HTTPS URL on RN's OceanRelay client. Complete RN's security gates and enable `PARTNER_OAUTH_ENABLED=true` only when the integration is ready for an end-to-end test.

**Exit:** RN redirects to the deployed OceanRelay callback and OceanRelay can complete the code exchange without exposing credentials or tokens to the browser.

### Phase 1 — RN login and data vertical slice

- Finish connect, consent, token refresh/rotation, disconnect, revocation, session expiry, and recoverable error handling.
- Fetch the authenticated RN profile, rates, and sailings using only the granted scopes. Enforce contract-owner eligibility; RN customer accounts remain denied.
- Display imported rate provenance and clearly distinguish rates/sailings from capacity. Treat missing currency and source-updated time as unknown and request seller confirmation where needed.
- Test a contract owner with data, a contract owner with empty rate/sailing lists, and an RN customer account. Empty owner lists must lead to manual entry, not a broken account state.

**Exit:** deployed OceanRelay login works for eligible RN owners, allowed rates/sailings display, customer accounts are denied, and owners with no RN records can proceed to manual entry.

### Phase 2 — Manual and RN-linked offer drafts

- Build offer creation using either an RN rate as a source or manual entry.
- Capture the seller-claimed quantity, lane, equipment, sailing/window, currency, validity, code-share name, stated operating carrier, price/markup, terms, source, and capacity status.
- Display the code-share as “XYZ, operated by ABC” and label capacity as seller-asserted unless an explicitly documented confirmation process supports another status.
- Preview seller-private fields separately from buyer-visible terms; save drafts and immutable snapshots of imported RN rate fields.

**Exit:** an RN-linked owner and a no-rate contract owner can each save and preview an offer draft without implying that RN verified capacity.

### Phase 3 — Marketplace workflow

- Publish, pause, expire, and search offers; filter by lane, equipment, carrier, sailing/window, price, and status.
- Implement request, accept, decline, and counter flows. Counterterms require renewed acceptance.
- Prevent oversubscription inside OceanRelay with transactional availability accounting; state clearly that this does not control capacity offered or consumed outside OceanRelay.
- Preserve immutable offer versions, both parties' acceptance, audit history, and carrier-pending/confirmed/rolled/cancelled operational updates.

**Exit:** a seeded two-party exchange completes end-to-end in OceanRelay's database, with tenant isolation, privacy, and in-app oversell prevention.

### Phase 4 — ForteL2 lifecycle record

- Configure the chain adapter for ForteL2 Sepolia, chain ID 852, and deploy the prototype contract through the chain owner's normal process. Do not change ForteL2's L1 deployment.
- Bind authenticated user/company identities to wallet addresses and record offer publication/version and accepted transaction/status events using opaque identifiers and salted commitments.
- Keep private prices, margins, company/customer data, and documents off-chain. Add pending/confirmed/failed UI states, retries, and database-to-chain reconciliation for downtime.

**Exit:** selected offer and acceptance lifecycle actions can be verified on L2 without exposing private commercial fields or implying proof of carrier capacity.

### Phase 5 — Invite-only pilot

- Pilot with a small group on one lane or route family.
- Measure offer creation, buyer requests, response time, completion, cancellations/rollovers, disputes, and repeat participation.
- Use observed demand to decide whether carrier integration, conditional payment, embedded financing, or broader marketplace coverage should follow.

**Exit:** evidence-based go/no-go and prioritized production backlog. Payments, financing, and capacity guarantees remain separate decisions.

## 15. Phase 0 decisions and current state

1. **RN login:** users sign in through RN's OAuth-style authorization. OceanRelay never receives RN passwords. The integration is implemented but production-disabled pending OceanRelay client setup and security-gate acceptance.
2. **Eligible RN accounts:** only contract-owner accounts can approve OceanRelay. RN customer accounts are denied. A contract owner with no rates may authorize and use manual entry.
3. **RN data:** rates and sailings are available through scoped REST/MCP. Currency and source-updated time are null. RN does not provide capacity quantities.
4. **Capacity evidence:** no universal proof is available. OceanRelay records the seller's claim, source, status, and counterparties' acceptance without representing blockchain or RN as proof.
5. **Codeshare display:** show “XYZ, operated by ABC,” where XYZ is the seller's code-share name and ABC the stated operating carrier. The seller's label is not carrier endorsement.
6. **Chain:** use ForteL2 Sepolia testnet, chain ID 852, with retry/reconciliation for outages.
7. **Repository boundary:** OceanRelay is a separate app/service. RN has completed the initial account linking, auth, partner API, and MCP implementation; activation and OceanRelay's own client setup remain.

## 16. Reference implementation context

The reviewed [StephenForte/RateNinja](https://github.com/StephenForte/RateNinja) repository now contains password hashing, RN partner OAuth, scoped rate/sailing REST APIs, and matching MCP tools. The production partner integration is deployed but disabled pending OceanRelay client setup and security-gate acceptance. The current handoff is authoritative for connection details; see the separate [RateNinja account linking and partner API/MCP PRD](rateninja-partner-integration-prd.md). ForteL2’s [README](https://github.com/StephenForte/ForteL2) identifies Sepolia chain ID 852 and describes the deployment as a learning/test phase without an uptime commitment; the prototype must use that testnet with appropriate retry and reconciliation behavior.

---

# Blockchain features for an ocean freight rate engine

## Starting point

The existing SaaS product ingests carrier rates, lets freight forwarders add margin, assign rates to customer tiers, and provide customer access. The rate engine remains the commercial source of truth. Blockchain is most relevant when independent parties need to move money, coordinate commitments, or verify a shared transaction.

## Feature ideas to park

1. **Cross-border freight payments.** Let a customer pay an accepted quote and let the forwarder pay carriers or overseas agents. Payment partners can use stablecoin settlement behind the scenes where it improves a corridor, with conventional fiat collection and payout options.
2. **Deposits and conditional settlement.** Hold booking funds and release them against agreed booking or shipment milestones, with defined cancellation and dispute processes.
3. **Verifiable accepted quotes.** Preserve the precise accepted terms and amendments, with a tamper-evident proof. Keep confidential carrier buy rates and margins private.
4. **Forwarder capacity code-share.** Let one forwarder present a seller-asserted service under its code-share name while another forwarder supplies the underlying rate and claimed capacity, with the operating carrier identified. Explore in depth below.
5. **Embedded freight financing.** Offer financing against a specific booking, carrier payable, or receivable through a funding partner, using verified quote, booking, invoice, and payment history.
6. **Freight-rate hedging.** Help users identify price exposure and connect them to existing freight-derivatives venues or providers. Financial hedges protect against benchmark movements; they do not secure vessel space.
7. **Agent settlement and profit sharing.** Reconcile and distribute agreed amounts among origin agents, destination agents, forwarders, and other participants after shipment-level adjustments.
8. **Electronic trade documents.** Integrate with eBL and shipment-document providers. Blockchain is optional; standards-based interoperability matters more than putting the document itself on-chain.

## Deep dive: committed capacity marketplace

### The product in one sentence

A marketplace where one forwarder can offer a service under its own code-share name using another forwarder’s rate and claimed capacity, while recording the parties, terms, source, and status. The platform does not independently prove that the allocation exists or can be transferred.

### Why this is not the same as futures

A capacity offer describes an intended operational service: container quantity and type, lane, sailing or shipment window, price, and stated conditions. The parties may believe the seller has an allocation, but the marketplace has no universal proof source. A freight future is different: it is financial exposure to a market benchmark and does not provide a booking or container space.

The marketplace could eventually include both physical capacity agreements and financial hedges, but they should be separate products with different contracts, participants, settlement, and risk controls.

### What exactly is being transferred?

Do not start by tokenizing a generic “container slot.” The product records what the seller says is available and any supporting source the seller chooses to provide. It cannot independently establish whether an allocation exists, whether it is transferable, or whether a carrier will honor it. When available, supporting sources may include:

- A carrier-confirmed allocation or block-space agreement that permits assignment or substitution.
- A forwarder’s contractual right to book some quantity under defined terms.
- A bilateral capacity commitment created specifically between marketplace participants, subject to carrier acceptance.

A token or on-chain entry can show that the seller made an offer and that counterparties accepted stated terms. It cannot create carrier recognition, prove the underlying claim, override an allocation contract, or force a vessel operator to accept a booking. Forwarder-to-forwarder obligations and remedies must be stated in their agreement.

### Example transaction

A forwarder says it has 40 FEUs available from Shanghai to Los Angeles across a November window and lists 12 under its “XYZ” code-share name, with the named carrier shown as “operated by ABC.” It provides the rate, equipment, cutoff, documentation requirements, validity, and cancellation terms. The listing clearly says the capacity claim is seller-asserted.

Another forwarder requests 6 FEUs and the seller accepts. The platform records the offer version, requested quantity, and both parties’ acceptance; it prevents the same listed quantity from being accepted twice within the marketplace. This does not prove the seller has 12 FEUs or prevent the seller from committing space through another channel. The parties then arrange the actual booking with the carrier or seller under their own process. If they later receive a carrier confirmation, they can record it. A carrier can still roll, change, or cancel the booking, and the app displays that operational risk.

### Participant roles

- **Carrier:** originates the allocation, confirms bookings, and defines permitted transfers and service rules.
- **Capacity holder:** commonly a forwarder or NVOCC with contractual rights to some allocation.
- **Buyer:** another forwarder seeking space for a shipment or customer commitment.
- **Marketplace operator:** verifies participants and terms, matches offers, manages records and workflow, and coordinates payment or escrow providers.
- **Funding/payment partner:** handles deposits, settlement, or financing where needed.

Carrier participation can improve operational visibility, but it does not eliminate rollovers or cancellations. A forwarder-to-forwarder pilot can still test discovery, offer terms, and partner workflow while disclosing that capacity claims are not independently verified.

### Pricing structures to support

- Fixed price per FEU or TEU.
- Original carrier buy rate plus an agreed transfer premium.
- Auction or bid/ask price, subject to a reservation price.
- Capacity reservation fee plus a separate freight charge.
- Take-or-pay or minimum-use terms, if those already exist in the underlying allocation agreement.

Keep carrier buy rates, forwarder margins, and customer-specific prices private. Participants should see only the information needed to evaluate and complete a transaction.

### Useful blockchain functions

Blockchain may help when multiple firms need a common, auditable record of offers, acceptances, assignments, deposits, and settlement states, or when programmable funds need to move under agreed conditions. It is not required for rate ingestion, search, matching, private pricing logic, or ordinary booking operations. Those can remain in the SaaS application.

A practical architecture would keep commercial documents and personal or confidential data off-chain. The chain could hold minimal identifiers, state changes, signatures, and document hashes. Access control, identity checks, cancellation handling, and operational integrations remain essential regardless of chain choice.

### Main product and market risks

- **No universal proof:** the marketplace cannot establish whether a seller actually holds the claimed quantity or may offer it to another forwarder.
- **Carrier service changes:** a carrier may reject, roll, change, or cancel a booking even after confirmation.
- **Double sale:** the same claimed allocation may be offered to multiple buyers or consumed in another system; marketplace controls only prevent duplicate acceptance inside this app.
- **Specification mismatch:** equipment, sailing, cutoff, origin/destination, or surcharge terms differ from the buyer’s needs.
- **Operational failure:** rollover, blank sailing, late documentation, or no-show triggers disputes.
- **Uneven liquidity:** offers are fragmented across lane, date, equipment, carrier, and terms; the market may not have enough compatible buyers and sellers.
- **Confidentiality:** public or poorly permissioned records expose carrier terms or forwarder margins.
- **Regulatory perimeter:** running a marketplace, holding funds, arranging financing, or offering derivatives may trigger distinct legal and regulatory obligations depending on the structure and jurisdictions.

### A sensible MVP sequence

**Phase 1: Seller-entered capacity claims.** Let an RN-authenticated forwarder manually describe a claimed allocation, link an RN rate when available, name the code-share brand and operating carrier, and mark source/status. No carrier verification or token is implied.

**Phase 2: Invite-only forwarder code-share workflow.** On one lane, support discovery, requests, acceptance, clear seller/buyer terms, status updates, and an audit trail. Marketplace quantity controls prevent duplicate acceptance inside the app, but do not imply control of carrier inventory. No real payment is needed to validate the workflow.

**Phase 3: Record claims and transaction history on ForteL2.** Commit offer versions and acceptance/status events while leaving terms private. Optionally record carrier evidence when participants provide it, with its source and date. Do not make the chain or marketplace claim to validate truth or guarantee delivery.

**Phase 4: Financing and broader marketplace.** Use transaction history to support a financing partner and expand lane coverage. Consider on-chain records or programmable escrow only if participants need a shared state or automated settlement that the existing platform and payment rails cannot provide efficiently.

### Pilot questions that remain open

1. Which forwarders will participate in the first invite-only lane pilot, and which lane has enough buyer/seller overlap?
2. What minimum fields and terms do participants need to decide whether to request a code-share offer?
3. At what point should the operating carrier name be visible to marketplace users and to the buyer’s shipper customer?
4. What bilateral cancellation and dispute terms do participants expect, given that the marketplace cannot guarantee carrier performance?

### Initial thesis

Treat this first as a **forwarder code-share marketplace**, not a futures exchange or a capacity certification system. Start with seller-entered claims, explicit provenance/status, invite-only offers and requests, and an auditable transaction record. Payments, deposits, financing, or carrier booking integration can be considered later if participants demand them. ForteL2 can provide a shared record of what the parties stated and accepted; it cannot establish the truth of the capacity claim.
