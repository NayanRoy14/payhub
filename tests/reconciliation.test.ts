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

  it('rounds successRate correctly for succeeded/closed ratios that hit floating-point double-rounding errors', () => {
    // 23/160 = 0.14375 exactly in decimal, but as a JS double it evaluates to
    // 14.374999999999998 (not 14.375) — naively doing
    // Math.round(((succeeded/closed)*100)*100)/100 rounds that down to 14.37
    // instead of the mathematically correct 14.38. Found by brute-force
    // search over succeeded<=300, closed<=500; this is the smallest example.
    const transactions = Array.from({ length: 160 }, (_, i) => ({
      status: i < 23 ? ('succeeded' as const) : ('failed' as const),
      attempts: [attempt('razorpay', i < 23 ? 'succeeded' : 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')],
    }));

    const report = buildReconciliationReport(transactions);
    expect(report.perProcessor[0].successRate).toBe(14.38);
  });

  it('excludes negative durations (clock skew across app servers) from averageTimeToSuccessMs instead of letting them silently pollute the average', () => {
    // startedAt is set by whichever server initiates the charge; endedAt is
    // set to `new Date()` by whichever server later processes the webhook —
    // in a horizontally-scaled deployment those are different clocks, and
    // skew between them can make endedAt appear to precede startedAt. Left
    // unfiltered, one -10s outlier averaged with a real +20s duration reads
    // as a perfectly plausible "5s average", hiding that anything is wrong.
    const transactions = [
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:10Z', '2026-01-01T00:00:00Z')] }, // -10s (skew)
      { status: 'succeeded', attempts: [attempt('razorpay', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:20Z')] }, // +20s (real)
    ];

    const report = buildReconciliationReport(transactions);
    // Only the real +20s duration should count — not an average of -10s and +20s.
    expect(report.perProcessor[0].averageTimeToSuccessMs).toBe(20000);
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
