import crypto from 'crypto';
import { TransactionDocument } from '../db/models/transaction.model';
import { DeclineScope } from '../core/declineTaxonomy';
import { ProcessorName } from '../adapters/adapter.interface';

/**
 * Outbound notifications to a merchant's own backend when a payment reaches a
 * terminal state. This is the counterpart to src/webhooks/*.ts (which verify
 * inbound webhooks *from* Razorpay/Cashfree/Stripe) — same HMAC-SHA256 hex
 * signing scheme, applied in the other direction.
 *
 * PayHub is single-tenant (see MERCHANT_WEBHOOK_URL in .env.example): one
 * deployment, one merchant, one webhook endpoint — consistent with how
 * Razorpay/Cashfree credentials are configured elsewhere in this project.
 */

export type MerchantWebhookEvent = 'payment.succeeded' | 'payment.failed';

export interface MerchantWebhookPayload {
  event: MerchantWebhookEvent;
  paymentId: string;
  status: 'succeeded' | 'failed';
  processor?: ProcessorName;
  retriedFrom?: ProcessorName;
  declineCode?: string;
  declineScope?: DeclineScope;
  amount: number;
  currency: string;
  upiPsp?: string;
  timestamp: string;
}

const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
const REQUEST_TIMEOUT_MS = 5_000;

type FetchFn = typeof fetch;

let fetchImpl: FetchFn = fetch;
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only seam: inject a fake fetch instead of making real network calls. */
export function setFetchImpl(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetFetchImpl(): void {
  fetchImpl = fetch;
}

/** Test-only seam: collapse retry backoff to run instantly instead of waiting on real timers. */
export function setSleepFn(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

export function resetSleepFn(): void {
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the payload for a terminal-state notification. `processor` and
 * decline info come from the *last* attempt rather than doc.currentProcessor:
 * paymentService.ts only reassigns currentProcessor on a processing/succeeded
 * outcome, so it goes stale after a terminal failure that followed a failover
 * (e.g. razorpay fails, cashfree also fails — currentProcessor is left at
 * 'razorpay'). attempts.at(-1) always reflects what actually happened last.
 */
export function buildPayload(doc: TransactionDocument, event: MerchantWebhookEvent): MerchantWebhookPayload {
  const lastAttempt = doc.attempts[doc.attempts.length - 1];
  return {
    event,
    paymentId: doc.paymentId,
    status: event === 'payment.succeeded' ? 'succeeded' : 'failed',
    processor: lastAttempt?.processor,
    retriedFrom: doc.retriedFrom,
    ...(event === 'payment.failed'
      ? { declineCode: lastAttempt?.declineCode, declineScope: lastAttempt?.declineScope }
      : {}),
    amount: doc.amount,
    currency: doc.currency,
    upiPsp: doc.upiPsp,
    timestamp: new Date().toISOString(),
  };
}

/** HMAC-SHA256 hex digest over the raw body — same scheme as verifyRazorpaySignature in verifySignature.ts. */
export function signPayload(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Delivers a terminal payment-state notification to the merchant's own
 * webhook endpoint, if one is configured. No-ops (resolves immediately)
 * when MERCHANT_WEBHOOK_URL isn't set — the common local/demo case.
 *
 * Best-effort: up to MAX_ATTEMPTS delivery attempts with backoff, entirely
 * in-process (not backed by a persistent queue like the BullMQ verification
 * safety-net in src/queue/retryQueue.ts) — a process restart mid-retry drops
 * a pending delivery. See README "Known limitations".
 *
 * Callers must not await this on their own request/response path — it's
 * meant to be fired without blocking the HTTP response to Razorpay/Cashfree
 * or to the merchant's original create-payment call. See
 * core/paymentService.ts's maybeNotifyMerchant.
 */
export async function notifyMerchant(doc: TransactionDocument, event: MerchantWebhookEvent): Promise<void> {
  const url = process.env.MERCHANT_WEBHOOK_URL;
  if (!url) return;

  const secret = process.env.MERCHANT_WEBHOOK_SECRET ?? '';
  const payload = buildPayload(doc, event);
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody, secret);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-PayHub-Event': event,
            'X-PayHub-Signature': signature,
          },
          body: rawBody,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return;
      lastError = new Error(`merchant webhook endpoint returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleepFn(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
