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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
    const durationsMs = succeeded
      .filter((a) => a.endedAt)
      .map((a) => new Date(a.endedAt as Date).getTime() - new Date(a.startedAt).getTime())
      .filter((ms) => Number.isFinite(ms));
    const averageTimeToSuccessMs =
      durationsMs.length > 0 ? Math.round(durationsMs.reduce((sum, d) => sum + d, 0) / durationsMs.length) : null;

    return {
      processor,
      totalAttempts: attempts.length,
      succeeded: succeeded.length,
      failed: failed.length,
      successRate: closed > 0 ? round2((succeeded.length / closed) * 100) : null,
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
      successRate: closedPayments > 0 ? round2((succeededPayments / closedPayments) * 100) : null,
    },
  };
}
