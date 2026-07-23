import { NormalizedWebhookEvent } from '../adapters/adapter.interface';

/**
 * Maps each processor's native error/reason code onto PayHub's internal
 * decline-code vocabulary (see core/declineTaxonomy.ts for the full taxonomy
 * and scope model). Unknown codes are upper-cased and passed through as-is so
 * isRetryable() can still apply its safe "unknown -> fail fast" default.
 *
 * Note the same raw string can map differently across processors when its
 * real-world meaning differs: Razorpay's docs describe `gateway_error` as
 * originating "at the bank or wallet provider's end" (bank_or_vpa scope,
 * failover can't help), whereas Razorpay's own `server_error` is unambiguously
 * Razorpay's own infra (processor scope, failover is worth trying). Where a
 * processor's error is genuinely ambiguous, the conservative choice is
 * bank_or_vpa (non-retryable) — the same safe-default philosophy as unknown
 * codes.
 */
export const RAZORPAY_DECLINE_CODE_MAP: Record<string, string> = {
  bad_request_error: 'INVALID_VPA',
  gateway_error: 'ISSUING_BANK_UNAVAILABLE',
  server_error: 'PROCESSOR_GATEWAY_ERROR',
  payment_declined: 'ISSUING_BANK_UNAVAILABLE',
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  invalid_vpa: 'INVALID_VPA',
  transaction_limit_exceeded: 'TXN_LIMIT_EXCEEDED',
  fraud_suspected: 'FRAUD_SUSPECTED',
};

/**
 * Stripe is dormant in the active routing rotation (see routingEngine.ts) —
 * it predates PayHub's UPI-first pivot to Cashfree, so this mapping is kept
 * minimal rather than tuned for UPI-specific nuance.
 */
export const STRIPE_DECLINE_CODE_MAP: Record<string, string> = {
  authentication_required: 'INVALID_MPIN',
  card_declined: 'TXN_LIMIT_EXCEEDED',
  processing_error: 'PROCESSOR_GATEWAY_ERROR',
};

export const CASHFREE_DECLINE_CODE_MAP: Record<string, string> = {
  transaction_declined: 'ISSUING_BANK_UNAVAILABLE',
  gateway_error: 'ISSUING_BANK_UNAVAILABLE',
  npci_error: 'NPCI_NETWORK_CONGESTION',
  npci_timeout: 'NPCI_TIMEOUT',
  invalid_vpa: 'INVALID_VPA',
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  internal_error: 'PROCESSOR_UNAVAILABLE',
};

/**
 * Webhook bodies are parsed, attacker-influenceable JSON — any field can be
 * any JSON type regardless of what a processor's docs promise, and downstream
 * code (Mongo queries, .toUpperCase() calls) assumes strings. This coerces
 * safely instead of trusting the input: non-strings become `fallback` rather
 * than propagating an object/array/number into code that expects text.
 */
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Same idea, but returns undefined (not a fallback string) for an optional field like processorRef. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Razorpay webhook envelope shape (test-mode payloads match this structure):
 * { event: 'payment.captured' | 'payment.failed' | ..., payload: { payment: { entity: {...} } } }
 */
export function normalizeRazorpayEvent(payload: any): NormalizedWebhookEvent {
  const entity = payload?.payload?.payment?.entity ?? payload?.payload?.order?.entity ?? {};
  const eventName = asString(payload?.event, '');
  const entityStatus = asString(entity?.status, '');

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (eventName === 'payment.captured' || entityStatus === 'captured') {
    status = 'succeeded';
  } else if (eventName === 'payment.failed' || entityStatus === 'failed') {
    status = 'failed';
    const reason = asString(entity?.error_reason, asString(entity?.error_code, 'unknown'));
    declineCode = RAZORPAY_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
  }

  return {
    processor: 'razorpay',
    processorRef: asOptionalString(entity?.order_id) ?? asOptionalString(entity?.id) ?? '',
    status,
    declineCode,
    raw: payload,
  };
}

/**
 * Stripe webhook envelope shape: { type: 'payment_intent.succeeded' | ..., data: { object: PaymentIntent } }
 */
export function normalizeStripeEvent(payload: any): NormalizedWebhookEvent {
  const intent = payload?.data?.object ?? {};
  const intentStatus = asString(intent?.status, '');

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (intentStatus === 'succeeded') {
    status = 'succeeded';
  } else if (intentStatus === 'canceled' || intentStatus === 'requires_payment_method') {
    status = 'failed';
    const code = asString(intent?.last_payment_error?.code, 'unknown');
    declineCode = STRIPE_DECLINE_CODE_MAP[code] ?? code.toUpperCase();
  }

  return {
    processor: 'stripe',
    processorRef: asOptionalString(intent?.id) ?? '',
    status,
    declineCode,
    raw: payload,
  };
}

/**
 * Cashfree webhook envelope shape (API version 2023-08-01):
 * { type: 'PAYMENT_SUCCESS_WEBHOOK' | 'PAYMENT_FAILED_WEBHOOK' | 'PAYMENT_USER_DROPPED_WEBHOOK' | ...,
 *   data: { order: { order_id: ... }, payment: { payment_status: ..., error_details: {...} } } }
 */
export function normalizeCashfreeEvent(payload: any): NormalizedWebhookEvent {
  const order = payload?.data?.order ?? {};
  const payment = payload?.data?.payment ?? {};
  const eventType = asString(payload?.type, '');
  const paymentStatus = asString(payment?.payment_status, '');

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || paymentStatus === 'SUCCESS') {
    status = 'succeeded';
  } else if (
    eventType === 'PAYMENT_FAILED_WEBHOOK' ||
    eventType === 'PAYMENT_USER_DROPPED_WEBHOOK' ||
    ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(paymentStatus)
  ) {
    status = 'failed';
    const reason = asString(payment?.error_details?.error_code, asString(payment?.error_details?.error_reason, 'unknown'));
    declineCode = CASHFREE_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
  }

  return {
    processor: 'cashfree',
    processorRef: asOptionalString(order?.order_id) ?? '',
    status,
    declineCode,
    raw: payload,
  };
}
