import { ProcessorName } from '../adapters/adapter.interface';
import { DeclineScope, declineScope, isRetryableScope } from './declineTaxonomy';
import { DEFAULT_ROUTING_WEIGHTS, RoutingWeights, selectWeightedProcessor } from './routingWeights';

/**
 * Fixed order used for *failover* target selection only — once a payment has
 * failed, the fallback is deterministic ("the other processor"), not
 * randomized. Weighted selection (routingWeights.ts) applies only to a brand
 * new payment's *initial* processor; see primaryProcessor() below.
 *
 * Stripe is not in the active rotation: new Stripe accounts in India are
 * currently invite-only, so real test-mode credentials aren't obtainable.
 * Cashfree Payments (self-serve India signup, native UPI sandbox support) is
 * the live second processor instead. StripeAdapter is still implemented and
 * tested — swap it back in here if Stripe access becomes available.
 */
const PROCESSOR_ORDER: ProcessorName[] = ['razorpay', 'cashfree'];

/**
 * The core "fail fast vs failover" decision, isolated as an explicit,
 * independently testable function. Backed by declineTaxonomy.ts's scope
 * classification: only 'processor' and 'npci_network' scoped declines are
 * retryable via failover — a 'bank_or_vpa' decline means the customer's own
 * bank is the problem, and every processor reaches that same bank via NPCI.
 */
export function isRetryable(declineCode: string | undefined): boolean {
  return isRetryableScope(declineCode);
}

let randomFn: () => number = Math.random;

/** Test-only seam: force deterministic weighted-routing outcomes instead of relying on statistical sampling. */
export function setRandomFn(fn: () => number): void {
  randomFn = fn;
}

export function resetRandomFn(): void {
  randomFn = Math.random;
}

/**
 * Initial processor selection for a brand-new payment, weighted by
 * DEFAULT_ROUTING_WEIGHTS (see routingWeights.ts). Failover, once a payment
 * is in flight, is unaffected — that stays strictly decline-code-driven.
 */
export function primaryProcessor(weights: RoutingWeights = DEFAULT_ROUTING_WEIGHTS): ProcessorName {
  return selectWeightedProcessor(weights, randomFn);
}

export function fallbackProcessor(current: ProcessorName): ProcessorName | undefined {
  return PROCESSOR_ORDER.find((p) => p !== current);
}

export type RoutingDecision =
  | { action: 'failover'; to: ProcessorName; scope: DeclineScope }
  | { action: 'fail'; reason: string; scope?: DeclineScope };

/**
 * Given the processor that just failed, its decline code, and every processor
 * already attempted for this payment, decide whether to fail over to another
 * processor or fail the payment outright. The 'fail' decision always carries
 * the decline's scope when known, so callers (logging, API responses, the
 * dashboard) can explain *why* — e.g. "bank_or_vpa: switching processor can't
 * help, the customer's own bank is unavailable" rather than just "failed".
 */
export function decideNextStep(
  currentProcessor: ProcessorName,
  declineCode: string | undefined,
  alreadyTried: ProcessorName[]
): RoutingDecision {
  const scope = declineScope(declineCode);

  if (!isRetryableScope(declineCode)) {
    return {
      action: 'fail',
      reason: declineCode ? `non_retryable:${declineCode}` : 'unknown_failure',
      scope,
    };
  }

  const next = PROCESSOR_ORDER.find((p) => !alreadyTried.includes(p));
  if (!next) {
    return { action: 'fail', reason: 'processors_exhausted', scope };
  }

  // scope is guaranteed defined here: isRetryableScope only returns true for
  // codes with a known 'processor' or 'npci_network' scope.
  return { action: 'failover', to: next, scope: scope as DeclineScope };
}
