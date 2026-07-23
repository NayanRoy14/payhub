import { decideNextStep, fallbackProcessor, isRetryable, primaryProcessor } from '../src/core/routingEngine';

describe('isRetryable', () => {
  it('returns true for transient processor-side decline codes', () => {
    expect(isRetryable('BANK_SERVER_DOWN')).toBe(true);
    expect(isRetryable('PSP_THROTTLED')).toBe(true);
    expect(isRetryable('GATEWAY_TIMEOUT')).toBe(true);
    expect(isRetryable('PROCESSOR_UNAVAILABLE')).toBe(true);
    expect(isRetryable('NPCI_UNAVAILABLE')).toBe(true);
  });

  it('returns false for decline codes where retrying cannot help', () => {
    expect(isRetryable('INVALID_VPA')).toBe(false);
    expect(isRetryable('TXN_LIMIT_EXCEEDED')).toBe(false);
    expect(isRetryable('INSUFFICIENT_FUNDS')).toBe(false);
    expect(isRetryable('INVALID_AMOUNT')).toBe(false);
    expect(isRetryable('CUSTOMER_CANCELLED')).toBe(false);
    expect(isRetryable('ACCOUNT_BLOCKED')).toBe(false);
  });

  it('defaults unknown decline codes to non-retryable (fail fast is the safe default)', () => {
    expect(isRetryable('SOME_NEW_CODE_NOT_YET_MAPPED')).toBe(false);
  });

  it('treats an absent decline code as non-retryable', () => {
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('primaryProcessor / fallbackProcessor', () => {
  it('picks razorpay as the primary processor', () => {
    expect(primaryProcessor()).toBe('razorpay');
  });

  it('returns the other processor as fallback', () => {
    expect(fallbackProcessor('razorpay')).toBe('cashfree');
    expect(fallbackProcessor('cashfree')).toBe('razorpay');
  });
});

describe('decideNextStep', () => {
  it('fails over to the untried processor on a retryable decline code', () => {
    const decision = decideNextStep('razorpay', 'BANK_SERVER_DOWN', ['razorpay']);
    expect(decision).toEqual({ action: 'failover', to: 'cashfree' });
  });

  it('fails fast (no failover) on a non-retryable decline code', () => {
    const decision = decideNextStep('razorpay', 'INVALID_VPA', ['razorpay']);
    expect(decision).toEqual({ action: 'fail', reason: 'non_retryable:INVALID_VPA' });
  });

  it('fails once every processor has already been tried, even if retryable', () => {
    const decision = decideNextStep('cashfree', 'BANK_SERVER_DOWN', ['razorpay', 'cashfree']);
    expect(decision).toEqual({ action: 'fail', reason: 'processors_exhausted' });
  });

  it('fails with unknown_failure reason when no decline code is present', () => {
    const decision = decideNextStep('razorpay', undefined, ['razorpay']);
    expect(decision).toEqual({ action: 'fail', reason: 'unknown_failure' });
  });
});
