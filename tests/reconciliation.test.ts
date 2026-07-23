import { buildReconciliationReport } from '../src/core/reconciliation';

function attempt(
  processor: 'razorpay' | 'cashfree',
  status: 'processing' | 'succeeded' | 'failed',
  startedAt: string,
  endedAt?: string
) {
  return { processor, status, startedAt: new Date(startedAt), endedAt: endedAt ? new Date(endedAt) : undefined } as any;
}

describe('buildReconciliationReport', () => {
  it('returns empty/null stats for no transactions', () => {
    const report = buildReconciliationReport([]);
    expect(report.perProcessor).toEqual([]);
    expect(report.overall).toEqual({ totalPayments: 0, succeeded: 0, failed: 0, inFlight: 0, successRate: null });
  });

  it('computes per-processor success rate from closed attempts only', () => {
    const transactions = [
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z')] },
      { status: 'failed', attempts: [attempt('razorpay', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z')] },
      {
        status: 'processing',
        attempts: [attempt('razorpay', 'processing', '2026-01-01T00:00:00Z')], // still in flight, not closed
      },
    ];

    const report = buildReconciliationReport(transactions);
    const razorpay = report.perProcessor.find((p) => p.processor === 'razorpay')!;

    expect(razorpay.totalAttempts).toBe(3);
    expect(razorpay.succeeded).toBe(1);
    expect(razorpay.failed).toBe(1);
    expect(razorpay.successRate).toBe(50); // 1 succeeded out of 2 closed attempts
  });

  it('computes average time-to-success in milliseconds', () => {
    const transactions = [
      { status: 'succeeded', attempts: [attempt('cashfree', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z')] }, // 10s
      { status: 'succeeded', attempts: [attempt('cashfree', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:20Z')] }, // 20s
    ];

    const report = buildReconciliationReport(transactions);
    const cashfree = report.perProcessor.find((p) => p.processor === 'cashfree')!;
    expect(cashfree.averageTimeToSuccessMs).toBe(15000); // average of 10s and 20s
  });

  it('reports null averageTimeToSuccessMs when there are no successes yet', () => {
    const transactions = [{ status: 'failed', attempts: [attempt('razorpay', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z')] }];
    const report = buildReconciliationReport(transactions);
    expect(report.perProcessor[0].averageTimeToSuccessMs).toBeNull();
  });

  it('reports null (not NaN) averageTimeToSuccessMs when startedAt/endedAt are corrupted/unparseable, and does not let it poison a real duration in the same average', () => {
    const corruptOnly = [
      { status: 'succeeded', attempts: [{ processor: 'razorpay', status: 'succeeded', startedAt: 'garbage-date', endedAt: 'also-garbage' } as any] },
    ];
    expect(buildReconciliationReport(corruptOnly).perProcessor[0].averageTimeToSuccessMs).toBeNull();

    const mixedWithOneGoodDuration = [
      { status: 'succeeded', attempts: [{ processor: 'razorpay', status: 'succeeded', startedAt: 'garbage-date', endedAt: 'also-garbage' } as any] },
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z')] },
    ];
    // The one real 10s duration must still come through as a real number,
    // not get averaged with (or replaced by) NaN from the corrupted entry.
    expect(buildReconciliationReport(mixedWithOneGoodDuration).perProcessor[0].averageTimeToSuccessMs).toBe(10000);
  });

  it('separates stats correctly across multiple processors, e.g. a failover payment', () => {
    const transactions = [
      {
        status: 'succeeded',
        attempts: [
          attempt('razorpay', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z'),
          attempt('cashfree', 'succeeded', '2026-01-01T00:00:03Z', '2026-01-01T00:00:08Z'),
        ],
      },
    ];

    const report = buildReconciliationReport(transactions);
    const razorpay = report.perProcessor.find((p) => p.processor === 'razorpay')!;
    const cashfree = report.perProcessor.find((p) => p.processor === 'cashfree')!;

    expect(razorpay.failed).toBe(1);
    expect(razorpay.succeeded).toBe(0);
    expect(razorpay.successRate).toBe(0);
    expect(cashfree.succeeded).toBe(1);
    expect(cashfree.successRate).toBe(100);
  });

  it('computes overall payment-level stats (not attempt-level)', () => {
    const transactions = [
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')] },
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')] },
      { status: 'failed', attempts: [attempt('razorpay', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')] },
      { status: 'processing', attempts: [attempt('razorpay', 'processing', '2026-01-01T00:00:00Z')] },
    ];

    const report = buildReconciliationReport(transactions);
    expect(report.overall).toEqual({
      totalPayments: 4,
      succeeded: 2,
      failed: 1,
      inFlight: 1,
      successRate: 66.67, // 2 succeeded out of 3 closed payments
    });
  });
});
