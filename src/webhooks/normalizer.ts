import { NormalizedWebhookEvent } from '../adapters/adapter.interface';

/**
 * Maps each processor's native error/reason code to PayHub's internal decline-code
 * vocabulary. Unknown codes are upper-cased and passed through as-is so isRetryable()
 * (core/routingEngine.ts) can still apply its safe "unknown -> fail fast" default.
 */
const RAZORPAY_DECLINE_CODE_MAP: Record<string, string> = {
  bad_request_error: 'INVALID_VPA',
  gateway_error: 'BANK_SERVER_DOWN',
  server_error: 'PROCESSOR_UNAVAILABLE',
};

const STRIPE_DECLINE_CODE_MAP: Record<string, string> = {
  authentication_required: 'INVALID_VPA',
  card_declined: 'TXN_LIMIT_EXCEEDED',
  processing_error: 'BANK_SERVER_DOWN',
};

const CASHFREE_DECLINE_CODE_MAP: Record<string, string> = {
  transaction_declined: 'INVALID_VPA',
  gateway_error: 'BANK_SERVER_DOWN',
  npci_error: 'NPCI_UNAVAILABLE',
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
