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
 * Razorpay webhook envelope shape (test-mode payloads match this structure):
 * { event: 'payment.captured' | 'payment.failed' | ..., payload: { payment: { entity: {...} } } }
 */
export function normalizeRazorpayEvent(payload: any): NormalizedWebhookEvent {
  const entity = payload?.payload?.payment?.entity ?? payload?.payload?.order?.entity ?? {};
  const eventName: string = payload?.event ?? '';

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (eventName === 'payment.captured' || entity.status === 'captured') {
    status = 'succeeded';
  } else if (eventName === 'payment.failed' || entity.status === 'failed') {
    status = 'failed';
    const reason: string = entity.error_reason ?? entity.error_code ?? 'unknown';
    declineCode = RAZORPAY_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
  }

  return {
    processor: 'razorpay',
    processorRef: entity.order_id ?? entity.id,
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

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (intent.status === 'succeeded') {
    status = 'succeeded';
  } else if (intent.status === 'canceled' || intent.status === 'requires_payment_method') {
    status = 'failed';
    const code: string = intent.last_payment_error?.code ?? 'unknown';
    declineCode = STRIPE_DECLINE_CODE_MAP[code] ?? code.toUpperCase();
  }

  return {
    processor: 'stripe',
    processorRef: intent.id,
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
  const eventType: string = payload?.type ?? '';

  let status: NormalizedWebhookEvent['status'] = 'processing';
  let declineCode: string | undefined;

  if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || payment.payment_status === 'SUCCESS') {
    status = 'succeeded';
  } else if (
    eventType === 'PAYMENT_FAILED_WEBHOOK' ||
    eventType === 'PAYMENT_USER_DROPPED_WEBHOOK' ||
    ['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(payment.payment_status)
  ) {
    status = 'failed';
    const reason: string = payment.error_details?.error_code ?? payment.error_details?.error_reason ?? 'unknown';
    declineCode = CASHFREE_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
  }

  return {
    processor: 'cashfree',
    processorRef: order.order_id,
    status,
    declineCode,
    raw: payload,
  };
}
