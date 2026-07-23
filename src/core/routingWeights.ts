import { ProcessorName } from '../adapters/adapter.interface';

/**
 * Weighted *initial* processor selection: instead of always starting every
 * new payment on the same primary processor, split traffic across processors
 * by weight. This is a real production pattern (gradually shifting volume
 * onto a newer processor, canary-testing a route, balancing cost/success-rate
 * tradeoffs) — distinct from *failover* (routingEngine.ts's decideNextStep),
 * which stays strictly decline-code-driven once a payment is already in
 * flight. Weights only affect which processor a brand-new payment starts on.
 */
export type RoutingWeights = Partial<Record<ProcessorName, number>>;

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
  razorpay: 70,
  cashfree: 30,
};

/**
 * Picks a processor proportionally to its weight. `random` is injectable
 * (defaults to Math.random) so callers can force deterministic outcomes in
 * tests instead of relying on statistical sampling over many runs.
 */
export function selectWeightedProcessor(
  weights: RoutingWeights = DEFAULT_ROUTING_WEIGHTS,
  random: () => number = Math.random
): ProcessorName {
  const entries = Object.entries(weights).filter(([, weight]) => (weight ?? 0) > 0) as [ProcessorName, number][];
  if (entries.length === 0) {
    throw new Error('At least one processor must have a positive routing weight');
  }

  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [processor, weight] of entries) {
    if (roll < weight) return processor;
    roll -= weight;
  }
  // Floating-point safety net (e.g. random() returns exactly 1): fall back to the last entry.
  return entries[entries.length - 1][0];
}
