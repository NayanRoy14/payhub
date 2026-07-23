# Integrating with PayHub

This guide is for merchant backends that want to accept UPI payments through
PayHub. It covers the official SDK client, a full worked example, and the raw
HTTP contract for merchants not using Node.js.

> Reminder of what PayHub is: an orchestration layer in front of real,
> licensed processors (Razorpay/Cashfree test mode). It is not a payment
> gateway and never touches raw card/UPI credentials — see the main
> [README](./README.md) for the full positioning statement.

## Install the SDK

The SDK is a single dependency-free file: `sdk/payhubClient.ts` (Node.js 18+,
uses the built-in `fetch`). Until this is published as its own package, copy
it directly into your project:

```
curl -o payhubClient.ts https://raw.githubusercontent.com/NayanRoy14/payhub/main/sdk/payhubClient.ts
```

Or, if you're working inside a clone of this repo, `npm run build:sdk` compiles
it to `sdk/dist/payhubClient.js` + `.d.ts` for plain JavaScript projects.

## Quick start

```ts
import { PayHubClient } from './payhubClient';

const payhub = new PayHubClient({ baseUrl: 'https://your-payhub-deployment.example.com' });

// 1. Create the payment
const { paymentId, routedTo } = await payhub.createPayment({
  amount: 149900, // ₹1,499.00 — smallest currency unit (paise), same convention as Razorpay/Stripe
  currency: 'INR',
  customerEmail: 'customer@example.com',
  payerVpa: 'customer@okhdfcbank', // optional, but enables handle-aware decline reasoning
});
console.log(`Payment ${paymentId} routed to ${routedTo}`);

// 2. UPI collect is asynchronous (the customer approves in their own UPI app),
//    so wait for it to resolve. PayHub already retries/fails over internally —
//    you just wait for the final outcome.
const result = await payhub.waitForTerminalStatus(paymentId, { timeoutMs: 120_000 });

if (result.status === 'succeeded') {
  console.log(`Paid via ${result.processor}` + (result.retriedFrom ? ` (after ${result.retriedFrom} failed)` : ''));
} else {
  console.log('Payment failed — check the event timeline for why:', await payhub.getPaymentEvents(paymentId));
}
```

## Full example: an Express checkout route

```ts
import express from 'express';
import { PayHubClient, PayHubError } from './payhubClient';

const app = express();
app.use(express.json());
const payhub = new PayHubClient({ baseUrl: process.env.PAYHUB_URL! });

app.post('/checkout', async (req, res) => {
  const { amountInRupees, customerEmail, upiVpa } = req.body;

  try {
    const { paymentId } = await payhub.createPayment({
      amount: Math.round(amountInRupees * 100), // rupees -> paise
      currency: 'INR',
      customerEmail,
      payerVpa: upiVpa,
    });

    // Return the paymentId to your frontend immediately — don't block the
    // HTTP response on waitForTerminalStatus, since UPI approval can take a
    // while. Have your frontend poll GET /order-status/:paymentId (below).
    res.status(202).json({ paymentId });
  } catch (err) {
    if (err instanceof PayHubError && err.status === 400) {
      res.status(400).json({ error: 'Invalid payment request', detail: err.message });
      return;
    }
    console.error('PayHub payment creation failed', err);
    res.status(502).json({ error: 'Payment could not be initiated, please try again' });
  }
});

// Your frontend polls this while showing a "waiting for UPI approval" spinner.
app.get('/order-status/:paymentId', async (req, res) => {
  const payment = await payhub.getPayment(req.params.paymentId);
  res.json({ status: payment.status, processor: payment.processor });
});
```

## Understanding a decline

When a payment fails, `getPaymentEvents()` tells you *why*, not just *that* it
failed:

```ts
const events = await payhub.getPaymentEvents(paymentId);
const failure = events.find((e) => e.state === 'failed');

if (failure?.declineScope === 'bank_or_vpa') {
  // The customer's own bank/VPA is the problem (insufficient funds, invalid
  // VPA, wrong MPIN, limit exceeded, fraud hold). PayHub already knew retrying
  // via a different processor couldn't fix this, so it failed fast instead of
  // wasting time. Tell the customer to check their account or try a different VPA.
} else if (failure?.declineScope === 'processor' || failure?.declineScope === 'npci_network') {
  // PayHub already tried failing over internally and still couldn't complete
  // it — this is a genuine, if rare, both-processors-down scenario.
} else {
  // 'customer_action' — they cancelled or abandoned the collect request.
}
```

See the main README's "Decline-code taxonomy & handle-aware routing" section
for the full scope model.

## Reference: SDK methods

| Method | Maps to | Notes |
|---|---|---|
| `createPayment(input)` | `POST /payments` | Auto-generates an `Idempotency-Key` if you don't supply one |
| `getPayment(paymentId)` | `GET /payments/:id` | |
| `getPaymentEvents(paymentId)` | `GET /payments/:id/events` | |
| `listPayments(options?)` | `GET /payments` | `{ limit?, status? }` |
| `getReconciliation()` | `GET /reconciliation` | Per-processor success rate / time-to-success |
| `waitForTerminalStatus(paymentId, options?)` | polls `getPayment()` | `{ timeoutMs?, pollIntervalMs? }`; throws `PayHubTimeoutError` |

Errors from any HTTP-backed method throw `PayHubError` with `.status` (HTTP
status code) and `.body` (the parsed JSON error response) properties.

## Not using Node.js? Raw HTTP contract

The SDK is a thin wrapper — any language can integrate directly:

```bash
# Create a payment
curl -X POST https://your-payhub-deployment.example.com/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"amount":149900,"currency":"INR","paymentMethod":"upi","customerEmail":"customer@example.com","payerVpa":"customer@okhdfcbank"}'

# Poll for status
curl https://your-payhub-deployment.example.com/payments/<paymentId>
```

Full request/response shapes are documented in the main [README](./README.md#api)
and in `PayHub.postman_collection.json` (importable into Postman for interactive testing).

## Known limitations for integrators

- **No outbound webhooks yet.** PayHub receives webhooks *from* Razorpay/Cashfree
  but doesn't yet forward payment status changes *to* your backend — you must
  poll (`waitForTerminalStatus()` handles this for you) rather than register a
  callback URL. This is the top candidate for the SDK's next iteration.
- **`Idempotency-Key` is required on every `createPayment()` call.** The SDK
  generates one for you by default; pass your own if *you* might retry the
  call yourself (e.g. after your own network timeout), so a retry on your end
  can never double-charge the customer.
- **`payerVpa` is optional but one-way.** Supplying it enables handle-aware
  decline explanations; PayHub does not yet target that specific VPA for the
  actual UPI collect request (see the main README's "Known Limitations" for
  why — it would require each adapter to use a different, more specific API).
