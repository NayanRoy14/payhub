import { ProcessorName } from '../adapters/adapter.interface';
import { AttemptRecord } from '../db/models/transaction.model';

export interface ProcessorStats {
  processor: ProcessorName;
  totalAttempts: number;
  succeeded: number;
  failed: number;
  /** Percentage (0-100), rounded to 2dp. null if no attempt has reached a terminal state yet. */
  successRate: number | null;
  /** Average wall-clock time from attempt start to success, in ms. null if no successes yet. */
  averageTimeToSuccessMs: number | null;
}

export interface ReconciliationReport {
  perProcessor: ProcessorStats[];
  overall: {
    totalPayments: number;
    succeeded: number;
    failed: number;
    inFlight: number;
    successRate: number | null;
  };
}

interface TransactionLike {
  status: string;
  attempts: AttemptRecord[];
}

/**
 * Percentage rounded to 2dp, computed from the raw numerator/denominator
 * rather than a pre-divided float. `Math.round(((n/d)*100)*100)/100` looks
 * equivalent but isn't: n/d can already be a double that's a hair below the
 * "true" value (e.g. 23/160 evaluates to 14.374999999999998, not 14.375),
 * and that error survives the *100 step, so Math.round silently rounds down
 * (14.37 instead of 14.38) for real, reachable succeeded/closed counts —
 * confirmed by brute-force search over succeeded<=300, closed<=500. Scaling
 * by 10000 first and dividing once keeps this to a single floating-point
 * operation, which avoids the accumulated error.
 */
function percentage(numerator: number, denominator: number): number {
  return Math.round((numerator * 10000) / denominator) / 100;
}

/**
 * Pure aggregation over transaction documents — no DB access here, so it's
 * independently testable with plain fixtures. The route (reconciliation.routes.ts)
 * just fetches transactions and hands them to this function.
 */
export function buildReconciliationReport(transactions: TransactionLike[]): ReconciliationReport {
  const attemptsByProcessor = new Map<ProcessorName, AttemptRecord[]>();

  for (const tx of transactions) {
    for (const attempt of tx.attempts) {
      const list = attemptsByProcessor.get(attempt.processor) ?? [];
      list.push(attempt);
      attemptsByProcessor.set(attempt.processor, list);
    }
  }

  const perProcessor: ProcessorStats[] = Array.from(attemptsByProcessor.entries()).map(([processor, attempts]) => {
    const succeeded = attempts.filter((a) => a.status === 'succeeded');
    const failed = attempts.filter((a) => a.status === 'failed');
    const closed = succeeded.length + failed.length;

    // Filter out NaN explicitly (e.g. from a corrupted/malformed startedAt or
    // endedAt) rather than relying on JSON.stringify's implicit NaN -> null
    // coercion — that would silently make "we have no timing data" and "the
    // timing data we have is corrupted" indistinguishable in the response.
    // Also filter out negative durations: endedAt is set to `new Date()` at
    // webhook-processing time on the app server that handles the webhook,
    // while startedAt was set by whichever app server initiated the charge —
    // in a horizontally-scaled deployment those are two different clocks,
    // and clock skew between them can make endedAt appear to precede
    // startedAt. A negative outlier silently drags the average down (and can
    // make it land on an entirely plausible-looking number, e.g. averaging
    // -10s with +20s reads as "5s average" with no sign anything was wrong)
    // rather than producing an obviously-bogus value worth investigating.
    const durationsMs = succeeded
      .filter((a) => a.endedAt)
      .map((a) => new Date(a.endedAt as Date).getTime() - new Date(a.startedAt).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    const averageTimeToSuccessMs =
      durationsMs.length > 0 ? Math.round(durationsMs.reduce((sum, d) => sum + d, 0) / durationsMs.length) : null;

    return {
      processor,
      totalAttempts: attempts.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: closed > 0 ? percentage(succeeded.length, closed) : null,
      averageTimeToSuccessMs,
    };
  });

  const succeededPayments = transactions.filter((t) => t.status === 'succeeded').length;
  const failedPayments = transactions.filter((t) => t.status === 'failed').length;
  const closedPayments = succeededPayments + failedPayments;

  return {
    perProcessor,
    overall: {
      totalPayments: transactions.length,
      succeeded: succeededPayments,
      failed: failedPayments,
      inFlight: transactions.length - closedPayments,
      successRate: closedPayments > 0 ? percentage(succeededPayments, closedPayments) : null,
    },
  };
}
