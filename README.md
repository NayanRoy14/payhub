# PayHub

A UPI-first payment orchestration layer that sits between a merchant backend and
multiple UPI-capable payment processors (Razorpay and Cashfree, both in test/sandbox
mode). It exposes one unified API for creating payments, automatically retries and
fails over to a different processor when one fails, and normalizes webhook events
from different processors into one consistent internal schema.

> **Note on processor choice:** the original spec for this project called for
> Razorpay + Stripe. New Stripe accounts in India are currently invite-only, so
> real sandbox credentials aren't obtainable — Cashfree Payments (self-serve India
> signup, native UPI sandbox support) is used as the live second processor instead.
> `StripeAdapter` is still fully implemented and tested; see "Known limitations".

## What this is — and isn't

**This is a learning / portfolio-scale reimplementation of real payment
orchestration patterns.** General-purpose payment orchestration already exists at
production scale (Hyperswitch, Orchestra, Kill Bill, and others) — PayHub does not
claim to invent orchestration as a category, and it does not compete with those
production systems.

PayHub is **not a payment gateway or a bank**. It holds no banking licenses, does
not connect directly to card networks or NPCI, and never touches raw card/UPI
credentials. It is an orchestration layer that sits in front of real, licensed
processors and adds routing intelligence on top of them.

Its differentiation is narrow and specific: most orchestrators treat UPI as one
payment method among hundreds, bolted onto a global-first routing engine. PayHub is
UPI-first — routing decisions are driven by a real decline-code taxonomy grounded in
NPCI's UPI response categories, not generic timeouts, and by *where* a decline
actually happened. A decline can be scoped to the **processor**'s own infra
(Razorpay/Cashfree — failover plausibly helps), **NPCI's shared network** (different
processors may route via different NPCI sponsor-bank paths — failover may help), or
the **customer's own bank/VPA** (insufficient funds, invalid VPA, wrong MPIN —
switching processor changes nothing, since every processor reaches the exact same
issuing bank via NPCI). Only the first two scopes trigger failover; the third fails
fast with an explanation, because retrying can never succeed and only degrades the
customer's experience. See `src/core/declineTaxonomy.ts`.

## Architecture

```
Merchant Backend
      |
      v
+--------------------------------+
|           PayHub Core           |
|                                  |
|  Routing Engine                  |
|  (decline-code-aware rules)      |
|         |                        |
|  Adapter Layer                   |
|  (processor-agnostic interface)  |
|      |            |              |
|  Razorpay       Cashfree         |
|  Adapter        Adapter          |
|      |            |              |
|  Webhook Normalizer               |
|  -> internal event schema         |
|         |                        |
|  Transaction Store                |
|  + Idempotency Keys               |
+--------------------------------+
      |               |
      v               v
  Razorpay         Cashfree
  (test mode)     (test mode)
```

The **Adapter Layer** implements the Strategy/Adapter pattern: every processor
adapter exposes the same interface — `charge()`, `verify()`, `parseWebhook()` — so
PayHub Core never contains processor-specific `if (processor === 'razorpay')`
branching outside the `adapters/` and `webhooks/` folders. This is the single most
important architectural decision in the codebase.

## Project structure

```
src/
├── core/
│   ├── declineTaxonomy.ts      # Canonical decline codes + scope (processor/npci_network/bank_or_vpa/customer_action)
│   ├── upiHandles.ts           # VPA handle -> UPI PSP classification (e.g. @ybl -> PhonePe)
│   ├── routingEngine.ts        # isRetryable()/decideNextStep() (failover) + primaryProcessor() (initial pick)
│   ├── routingWeights.ts       # Weighted initial-processor selection (e.g. 70/30 razorpay/cashfree)
│   ├── stateMachine.ts         # Payment state transitions
│   ├── paymentService.ts       # Orchestrates: create -> charge -> failover -> persist
│   └── reconciliation.ts       # Per-processor success-rate / time-to-success aggregation
├── adapters/
│   ├── adapter.interface.ts    # Shared interface: charge / verify / parseWebhook
│   ├── razorpay.adapter.ts
│   ├── cashfree.adapter.ts     # Active fallback processor (Stripe substitute — see note above)
│   └── stripe.adapter.ts       # Implemented + tested but not in the active routing order
├── webhooks/
│   ├── normalizer.ts           # Maps processor payloads -> internal schema
│   └── verifySignature.ts      # HMAC (Razorpay/Cashfree) / native signing (Stripe)
├── routes/
│   ├── payments.routes.ts
│   ├── webhooks.routes.ts
│   └── reconciliation.routes.ts
├── db/
│   ├── models/transaction.model.ts
│   └── connection.ts
├── queue/
│   └── retryQueue.ts           # BullMQ safety-net: polls a processor if its webhook never arrives
└── server.ts
public/
└── dashboard.html               # Read-only demo dashboard (vanilla JS, no build step)
tests/
```

## Payment state machine

```
created -> processing -> succeeded
                       -> failed -> retrying -> succeeded
                                             -> failed (exhausted)
                       -> failed (no retry — non-retryable decline code)
```

The "fail fast vs. failover" decision is an explicit, independently testable
function: `isRetryable(declineCode: string): boolean` in `src/core/routingEngine.ts`,
backed by `declineTaxonomy.ts`'s scope classification.

## API

### `POST /payments`

Headers: `Idempotency-Key: <string>`, `Content-Type: application/json`

```json
{ "amount": 100000, "currency": "INR", "paymentMethod": "upi", "customerEmail": "customer@example.com", "payerVpa": "name@ybl" }
```

`payerVpa` is optional. When provided, its handle is classified to a UPI PSP
(`src/core/upiHandles.ts`) and stored on the transaction — this is what makes a
`bank_or_vpa`-scoped decline explainable ("this is about the customer's PhonePe
account specifically, not about Razorpay or Cashfree").

Response `201`:

```json
{ "paymentId": "internal-uuid", "status": "processing", "routedTo": "razorpay" }
```

`routedTo` is picked by weighted selection (`src/core/routingWeights.ts`, default
70% Razorpay / 30% Cashfree) — not always the same processor. Failover, once a
payment is in flight, is unaffected by weights and stays strictly decline-code-driven.

### `GET /payments`

Query params: `limit` (default 100), `status` (filter by payment state). Most
recent first — powers the dashboard's payment list.

```json
[{ "paymentId": "...", "status": "succeeded", "processor": "cashfree", "retriedFrom": "razorpay", "amount": 100000, "currency": "INR", "upiPsp": "phonepe", "createdAt": "...", "updatedAt": "..." }]
```

### `GET /payments/:id`

```json
{ "paymentId": "internal-uuid", "status": "succeeded", "processor": "cashfree", "retriedFrom": "razorpay", "amount": 100000, "currency": "INR", "payerVpa": "name@ybl", "upiHandle": "ybl", "upiPsp": "phonepe" }
```

`payerVpa`/`upiHandle`/`upiPsp` are only present when a VPA was supplied at creation.

### `GET /payments/:id/events`

Full state timeline:

```json
[
  { "state": "created", "timestamp": "..." },
  { "state": "processing", "processor": "razorpay", "timestamp": "..." },
  { "state": "failed", "processor": "razorpay", "reason": "declineCode:ISSUING_BANK_UNAVAILABLE", "declineScope": "bank_or_vpa", "timestamp": "..." },
  { "state": "retrying", "processor": "cashfree", "timestamp": "..." },
  { "state": "succeeded", "processor": "cashfree", "timestamp": "..." }
]
```

`declineScope` appears on `failed` events and makes the routing engine's reasoning
visible: `processor`/`npci_network` scopes are why a failover happened;
`bank_or_vpa`/`customer_action` scopes are why one didn't.

### `GET /reconciliation`

Per-processor attempt counts, success rate, and average time-to-success, plus
overall payment-level stats — the numbers behind "why orchestration matters,"
not just the architecture story:

```json
{
  "perProcessor": [
    { "processor": "razorpay", "totalAttempts": 10, "succeeded": 2, "failed": 4, "successRate": 33.33, "averageTimeToSuccessMs": 137600 },
    { "processor": "cashfree", "totalAttempts": 4, "succeeded": 2, "failed": 1, "successRate": 66.67, "averageTimeToSuccessMs": 15100 }
  ],
  "overall": { "totalPayments": 11, "succeeded": 4, "failed": 2, "inFlight": 5, "successRate": 66.67 }
}
```

### `GET /dashboard/`

Read-only demo dashboard (static HTML + vanilla JS, no build step, no auth) —
payment list with filtering, click-to-expand event timelines, and the
reconciliation table above, all hitting PayHub's own API. See "Known limitations."

### `POST /webhooks/razorpay` / `POST /webhooks/cashfree` / `POST /webhooks/stripe`

Verifies the signature, normalizes the payload, updates the transaction state.
Unverified webhooks are rejected with `401`. The Stripe route exists and works
(`StripeAdapter` is fully implemented) but won't receive real traffic unless you
have Stripe test credentials and flip `routingEngine`'s `PROCESSOR_ORDER` back.

## Decline-code taxonomy & handle-aware routing

`src/core/declineTaxonomy.ts` groups every decline code into one of four scopes:

| Scope | Meaning | Failover helps? |
|---|---|---|
| `processor` | The processor's (Razorpay/Cashfree) own API/gateway infra | Yes |
| `npci_network` | NPCI's shared switch (e.g. peak-time congestion) — processors may route via different NPCI sponsor-bank paths | Maybe — worth trying |
| `bank_or_vpa` | The customer's own issuing bank or VPA state (insufficient funds, invalid VPA, wrong MPIN, fraud hold, limits) | **No** — every processor reaches the same bank via NPCI |
| `customer_action` | A deliberate customer action (cancelled, dropped) rather than a technical failure | No |

This is the concrete fix for a naive "gateway error -> just retry" model: a
decline meaning "the customer's bank is down" and a decline meaning "Razorpay's
API hiccuped" look superficially similar but call for opposite responses.
Razorpay's own docs, for instance, describe their `GATEWAY_ERROR` code as
originating "at the bank or wallet provider's end" — so PayHub maps it to
`bank_or_vpa` (fail fast), while Razorpay's `SERVER_ERROR` (their own infra) maps
to `processor` (failover). See the mapping tables and reasoning in
`webhooks/normalizer.ts` and each adapter.

`src/core/upiHandles.ts` classifies a customer's VPA handle (`@okhdfcbank` ->
Google Pay, `@ybl` -> PhonePe, `@paytm` -> Paytm, etc. — publicly documented,
well-known mappings) to surface *which* PSP a `bank_or_vpa` decline is really
about. **This is reasoning, not control**: PayHub cannot programmatically switch
a customer from PhonePe to Google Pay mid-transaction — the customer's own UPI
app handles their side of the transaction, always has, and no merchant-side
backend can change that. What handle classification enables is an honest,
specific explanation ("this decline is about the customer's PhonePe account,
not about our processor choice") instead of a generic failure.

## Weighted routing

`src/core/routingWeights.ts` splits *initial* processor selection across
Razorpay/Cashfree by weight (70/30 by default) rather than always starting new
payments on the same processor — a real production pattern for gradually
shifting volume, canary-testing a route, or balancing cost/success-rate
tradeoffs. This is deliberately separate from *failover*: once a payment is in
flight, `decideNextStep()` stays strictly decline-code-driven — weights never
influence whether/where a failed payment retries, only which processor a
brand-new payment starts on. `routingEngine.ts` exposes `setRandomFn()` for
deterministic testing instead of relying on statistical sampling.

## Peak-time routing & settlement-time transparency (not built)

Two further ideas from the original UPI-first differentiation research, kept
here as documented "if I had more time" directions rather than built:

- **Peak-time routing weight shifts**: known high-failure windows (month-end
  salary days, festival sale traffic) could shift `routingWeights.ts`'s weights
  automatically — e.g. favor whichever processor's NPCI sponsor-bank path
  empirically holds up better during that window, using `reconciliation.ts`'s
  own success-rate data as the signal.
- **Per-PSP settlement-time transparency**: surfacing how long each processor
  actually takes to settle funds to the merchant's bank account (distinct from
  the customer-facing "succeeded" latency `reconciliation.ts` already tracks),
  which is a real, underexposed pain point for merchants choosing between PSPs.

## Setup (free sandbox / test-mode credentials only)

1. **Install dependencies**

   ```
   npm install
   ```

2. **MongoDB** — run locally (`mongod`) or use a free-tier [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) cluster.

3. **Redis** — required only for the BullMQ verification-safety-net queue. Run
   locally or use a free-tier hosted Redis instance.

4. **Razorpay test mode** — sign up at [razorpay.com](https://razorpay.com), switch
   the dashboard to **Test Mode**, and grab your Test API Key ID/Secret and a
   webhook secret from Settings -> Webhooks. Razorpay's test mode is free and never
   touches real money.

5. **Cashfree test mode** — sign up at [merchant.cashfree.com](https://merchant.cashfree.com)
   (self-serve, no invite required), switch to **Test Mode**, and grab your App ID
   and Secret Key from Developers -> API Keys. Cashfree signs webhooks with that
   same secret key (no separate webhook secret to configure).

   (Optional) **Stripe test mode** — only needed if you have Stripe test-mode
   access (e.g. a non-India account) and want to exercise `StripeAdapter` instead:
   sign up at [stripe.com](https://stripe.com), use your **Test mode** secret key
   and a webhook signing secret from the Stripe CLI or Dashboard.

6. Copy `.env.example` to `.env` and fill in the values from steps 2-5.

7. **Run tests**

   ```
   npm test
   ```

8. **Run the server**

   ```
   npm run dev
   ```

   Then open **http://localhost:3000/dashboard/** for the read-only demo dashboard
   (payment list, filtering, event timelines, per-processor reconciliation).

## Postman collection

`PayHub.postman_collection.json` covers every endpoint — the happy path, both
error paths (400/401/404), and signed webhook requests for all three processors
(Razorpay HMAC, Cashfree timestamp+body HMAC, Stripe's `t=...,v1=...` scheme).
Import it into Postman, set `baseUrl` and the `*WebhookSecret`/`*SecretKey`
variables to match your `.env`, then run "Create Payment" first — its test
script captures `paymentId` for the other requests. The collection's own
description (visible in Postman) has the full walkthrough, including how to
get the real Razorpay/Cashfree order IDs the webhook requests need.

## Testing

- Unit tests: routing engine decisions, `isRetryable()`, decline-code scope
  classification (`declineTaxonomy.ts`), VPA handle classification
  (`upiHandles.ts`), weighted processor selection (`routingWeights.ts`),
  reconciliation aggregation (`reconciliation.ts`), state machine transitions,
  webhook normalization, signature verification (Razorpay HMAC, Stripe's native
  scheme, Cashfree's timestamp+body HMAC).
- Adapter tests: Razorpay/Cashfree/Stripe adapters against injected fake SDK/HTTP
  clients (no network calls, fully deterministic).
- Integration tests: `paymentService` and the HTTP routes against a real, in-memory
  MongoDB (`mongodb-memory-server`) — including the idempotency guarantee (same
  `Idempotency-Key` twice creates exactly one transaction), a scripted failover
  demo (primary processor times out, fallback succeeds, and the event timeline
  shows the complete failover story), and handle-aware fail-fast (a `bank_or_vpa`
  decline never triggers failover even when a healthy fallback processor exists).
- The dashboard (`public/dashboard.html`) was manually verified in a real browser
  against the live dev server — payment list, status filtering, click-to-expand
  event timelines, and the reconciliation table all confirmed working with real
  Razorpay/Cashfree sandbox data and zero console errors.

## Known limitations

- **No refunds, disputes, or chargebacks.** Out of scope for v1.
- **No subscriptions or recurring billing.**
- **No real card network or NPCI connectivity.** This project sits in front of
  Razorpay/Cashfree test mode only; it never talks to NPCI or card networks directly.
- **Single currency path exercised (INR/UPI).** Multi-currency is out of scope.
- **The dashboard is read-only and has no authentication.** Fine for local/demo
  use since it only ever calls PayHub's own read endpoints, but don't expose it
  publicly as-is.
- **Weighted routing affects only the initial processor pick, not mid-flight
  rebalancing.** No ML-based or success-rate-based *adaptive* routing — weights
  are a fixed, manually-set table (`routingWeights.ts`), not learned from
  `reconciliation.ts`'s own data (see "Peak-time routing" above for that idea).
- **The BullMQ verification queue is a safety net, not the primary failover path.**
  The actual decline-code-aware failover happens synchronously/immediately in
  `paymentService`; the queue only guards against a dropped/late webhook.
- **Decline-code mappings are illustrative.** The Razorpay/Cashfree/Stripe
  error-code -> internal decline-code tables in `webhooks/normalizer.ts` and the
  adapters cover common cases but are not an exhaustive mapping of every
  real-world error code any processor can return.
- **Stripe substituted with Cashfree as the active fallback processor.** New
  Stripe accounts in India are currently invite-only, so real sandbox credentials
  aren't obtainable. `StripeAdapter` is fully implemented and unit-tested against
  a fake client, and the `/webhooks/stripe` route is live — but `routingEngine`'s
  `PROCESSOR_ORDER` currently routes to Cashfree, not Stripe, so Stripe never
  receives real traffic in this deployment.
- **Cashfree's Create Order API requires a customer phone number** that PayHub's
  unified `/payments` contract doesn't collect in v1 (only amount/currency/
  paymentMethod/customerEmail). `CashfreeAdapter` sends a fixed sandbox
  placeholder phone number — fine for test-mode demonstration, but would need a
  real customer phone field before this adapter could be used in production.
- **No PCI-DSS compliance claim.** PayHub's security posture comes entirely from
  never touching raw card/UPI credentials — all sensitive input goes through each
  processor's own hosted fields/SDK — not from any compliance certification.
- **Handle-aware routing is reasoning, not control.** PayHub cannot
  programmatically move a customer from one UPI app to another — see "Decline-code
  taxonomy & handle-aware routing" above for what this feature actually does and why.
- **Peak-time routing weight shifts and per-PSP settlement-time transparency**
  remain documented future directions, not built — see that section above.

###### with ❤️ from `Nayan`