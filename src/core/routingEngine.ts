import { ProcessorName } from '../adapters/adapter.interface';

/**
 * Fixed primary -> fallback order for v1. No weighted/percentage or success-rate-based
 * routing — that's explicitly out of scope (see project spec, section 3).
 *
 * Stripe is not in the active rotation: new Stripe accounts in India are
 * currently invite-only, so real test-mode credentials aren't obtainable.
 * Cashfree Payments (self-serve India signup, native UPI sandbox support) is
 * the live second processor instead. StripeAdapter is still implemented and
 * tested — swap it back in here if Stripe access becomes available.
 */
const PROCESSOR_ORDER: ProcessorName[] = ['razorpay', 'cashfree'];

/**
 * Decline codes where retrying (even on a different processor) cannot possibly
 * succeed — the problem is with the request itself, not the processor. Failing
 * fast avoids wasted latency and a confusing UX.
 */
const NON_RETRYABLE_DECLINE_CODES = new Set<string>([
  'INVALID_VPA',
  'TXN_LIMIT_EXCEEDED',
  'INSUFFICIENT_FUNDS',
  'INVALID_AMOUNT',
  'CUSTOMER_CANCELLED',
  'ACCOUNT_BLOCKED',
]);

/**
 * Decline codes that indicate a transient, processor-side problem — an instant
 * failover to another processor is likely to succeed.
 */
const RETRYABLE_DECLINE_CODES = new Set<string>([
  'BANK_SERVER_DOWN',
  'PSP_THROTTLED',
  'GATEWAY_TIMEOUT',
  'PROCESSOR_UNAVAILABLE',
  'NPCI_UNAVAILABLE',
]);

/**
 * The core "fail fast vs failover" decision, isolated as an explicit, independently
 * testable function. Unknown decline codes default to non-retryable: a safe default,
 * since blindly retrying an unrecognized failure risks duplicate/needless attempts.
 */
export function isRetryable(declineCode: string | undefined): boolean {
  if (!declineCode) return false;
  if (NON_RETRYABLE_DECLINE_CODES.has(declineCode)) return false;
  return RETRYABLE_DECLINE_CODES.has(declineCode);
}

export function primaryProcessor(): ProcessorName {
  return PROCESSOR_ORDER[0];
}

export function fallbackProcessor(current: ProcessorName): ProcessorName | undefined {
  return PROCESSOR_ORDER.find((p) => p !== current);
}

export type RoutingDecision = { action: 'failover'; to: ProcessorName } | { action: 'fail'; reason: string };

/**
 * Given the processor that just failed, its decline code, and every processor
 * already attempted for this payment, decide whether to fail over to another
 * processor or fail the payment outright.
 */
export function decideNextStep(
  currentProcessor: ProcessorName,
  declineCode: string | undefined,
  alreadyTried: ProcessorName[]
): RoutingDecision {
  if (!isRetryable(declineCode)) {
    return { action: 'fail', reason: declineCode ? `non_retryable:${declineCode}` : 'unknown_failure' };
  }

  const next = PROCESSOR_ORDER.find((p) => !alreadyTried.includes(p));
  if (!next) {
    return { action: 'fail', reason: 'processors_exhausted' };
  }

  return { action: 'failover', to: next };
}
