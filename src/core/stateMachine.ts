export type PaymentState = 'created' | 'processing' | 'retrying' | 'succeeded' | 'failed';

/**
 * 'failed' is not always terminal: it's the recorded event when a processor
 * attempt fails, and it's followed by 'retrying' if the routing engine decides
 * to fail over. Whether a given 'failed' is actually terminal is a routing-engine
 * decision (isRetryable + processors exhausted), not something the state machine
 * itself can know — it only validates that a *requested* transition is legal.
 *
 *   created -> processing -> succeeded
 *                          -> failed -> retrying -> succeeded
 *                                                 -> failed (exhausted)
 *                          -> failed (terminal, non-retryable decline code)
 */
const ALLOWED_TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  created: ['processing'],
  processing: ['succeeded', 'failed'],
  failed: ['retrying'],
  retrying: ['succeeded', 'failed'],
  succeeded: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
