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
UPI-first — routing decisions are driven by NPCI-style decline codes rather than
generic timeouts. Some decline reasons (bank server down, PSP throttling) trigger an
instant failover to another processor; others (invalid VPA, transaction limit
exceeded) fail fast with no retry, because retrying them can never succeed and only
degrades the customer's experience.

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
│   ├── routingEngine.ts        # Decline-code-aware routing + failover rules, isRetryable()
│   ├── stateMachine.ts         # Payment state transitions
│   └── paymentService.ts       # Orchestrates: create -> charge -> failover -> persist
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
│   └── webhooks.routes.ts
├── db/
│   ├── models/transaction.model.ts
│   └── connection.ts
├── queue/
│   └── retryQueue.ts           # BullMQ safety-net: polls a processor if its webhook never arrives
└── server.ts
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
function: `isRetryable(declineCode: string): boolean` in `src/core/routingEngine.ts`.

## API

### `POST /payments`

Headers: `Idempotency-Key: <string>`, `Content-Type: application/json`

```json
{ "amount": 100000, "currency": "INR", "paymentMethod": "upi", "customerEmail": "customer@example.com" }
```

Response `201`:

```json
{ "paymentId": "internal-uuid", "status": "processing", "routedTo": "razorpay" }
```

### `GET /payments/:id`

```json
{ "paymentId": "internal-uuid", "status": "succeeded", "processor": "cashfree", "retriedFrom": "razorpay", "amount": 100000, "currency": "INR" }
```

### `GET /payments/:id/events`

Full state timeline:

```json
[
  { "state": "created", "timestamp": "..." },
  { "state": "processing", "processor": "razorpay", "timestamp": "..." },
  { "state": "failed", "processor": "razorpay", "reason": "declineCode:BANK_SERVER_DOWN", "timestamp": "..." },
  { "state": "retrying", "processor": "cashfree", "timestamp": "..." },
  { "state": "succeeded", "processor": "cashfree", "timestamp": "..." }
]
```

### `POST /webhooks/razorpay` / `POST /webhooks/cashfree` / `POST /webhooks/stripe`

Verifies the signature, normalizes the payload, updates the transaction state.
Unverified webhooks are rejected with `401`. The Stripe route exists and works
(`StripeAdapter` is fully implemented) but won't receive real traffic unless you
have Stripe test credentials and flip `routingEngine`'s `PROCESSOR_ORDER` back.

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

## Testing

- Unit tests: routing engine decisions, `isRetryable()`, state machine transitions,
  webhook normalization, signature verification (Razorpay HMAC, Stripe's native
  scheme, Cashfree's timestamp+body HMAC).
- Adapter tests: Razorpay/Cashfree/Stripe adapters against injected fake SDK/HTTP
  clients (no network calls, fully deterministic).
- Integration tests: `paymentService` and the HTTP routes against a real, in-memory
  MongoDB (`mongodb-memory-server`) — including the idempotency guarantee (same
  `Idempotency-Key` twice creates exactly one transaction) and a scripted failover
  demo (primary processor times out, fallback succeeds, and the event timeline
  shows the complete failover story).

## Known limitations

- **No refunds, disputes, or chargebacks.** Out of scope for v1.
- **No subscriptions or recurring billing.**
- **No real card network or NPCI connectivity.** This project sits in front of
  Razorpay/Cashfree test mode only; it never talks to NPCI or card networks directly.
- **Single currency path exercised (INR/UPI).** Multi-currency is out of scope.
- **No admin dashboard.** Use the API directly, curl, or a Postman collection.
- **No ML-based or success-rate-based routing, and no percentage/weighted
  routing.** Routing is purely decline-code-driven with a fixed primary/fallback
  order (Razorpay -> Cashfree).
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
- **PSP-level UPI-handle failover, peak-time routing-weight shifts, and a minimal
  dashboard** are noted as possible future directions but are explicitly not built
  in v1.
