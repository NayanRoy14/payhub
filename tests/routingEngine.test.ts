import { decideNextStep, fallbackProcessor, isRetryable, primaryProcessor, resetRandomFn, setRandomFn } from '../src/core/routingEngine';

describe('isRetryable', () => {
  it('returns true for processor-scoped decline codes (failover plausibly helps)', () => {
    expect(isRetryable('PROCESSOR_GATEWAY_ERROR')).toBe(true);
    expect(isRetryable('PSP_THROTTLED')).toBe(true);
    expect(isRetryable('GATEWAY_TIMEOUT')).toBe(true);
    expect(isRetryable('PROCESSOR_UNAVAILABLE')).toBe(true);
  });

  it('returns true for NPCI-network-scoped decline codes (different processors may route via different NPCI paths)', () => {
    expect(isRetryable('NPCI_NETWORK_CONGESTION')).toBe(true);
    expect(isRetryable('NPCI_TIMEOUT')).toBe(true);
  });

  it('returns false for bank/VPA-scoped decline codes: the customer\'s own bank is the same regardless of processor', () => {
    expect(isRetryable('ISSUING_BANK_UNAVAILABLE')).toBe(false);
    expect(isRetryable('INVALID_VPA')).toBe(false);
    expect(isRetryable('TXN_LIMIT_EXCEEDED')).toBe(false);
    expect(isRetryable('DAILY_LIMIT_EXCEEDED')).toBe(false);
    expect(isRetryable('INSUFFICIENT_FUNDS')).toBe(false);
    expect(isRetryable('INVALID_AMOUNT')).toBe(false);
    expect(isRetryable('INVALID_MPIN')).toBe(false);
    expect(isRetryable('FRAUD_SUSPECTED')).toBe(false);
    expect(isRetryable('DUPLICATE_TRANSACTION')).toBe(false);
    expect(isRetryable('ACCOUNT_BLOCKED')).toBe(false);
  });

  it('returns false for customer-action decline codes', () => {
    expect(isRetryable('CUSTOMER_CANCELLED')).toBe(false);
    expect(isRetryable('USER_DROPPED')).toBe(false);
  });

  it('defaults unknown decline codes to non-retryable (fail fast is the safe default)', () => {
    expect(isRetryable('SOME_NEW_CODE_NOT_YET_MAPPED')).toBe(false);
  });

  it('treats an absent decline code as non-retryable', () => {
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('primaryProcessor / fallbackProcessor', () => {
  afterEach(() => resetRandomFn());

  it('is weighted 70/30 razorpay/cashfree by default: a low roll picks razorpay, a high roll picks cashfree', () => {
    setRandomFn(() => 0);
    expect(primaryProcessor()).toBe('razorpay');

    setRandomFn(() => 0.99);
    expect(primaryProcessor()).toBe('cashfree');
  });

  it('respects a custom weight table', () => {
    setRandomFn(() => 0.5);
    expect(primaryProcessor({ razorpay: 0, cashfree: 100 })).toBe('cashfree');
    expect(primaryProcessor({ razorpay: 100, cashfree: 0 })).toBe('razorpay');
  });

  it('returns the other processor as fallback', () => {
    expect(fallbackProcessor('razorpay')).toBe('cashfree');
    expect(fallbackProcessor('cashfree')).toBe('razorpay');
  });
});

describe('decideNextStep', () => {
  it('fails over to the untried processor on a processor-scoped decline code', () => {
    const decision = decideNextStep('razorpay', 'PROCESSOR_GATEWAY_ERROR', ['razorpay']);
    expect(decision).toEqual({ action: 'failover', to: 'cashfree', scope: 'processor' });
  });

  it('fails over on an NPCI-network-scoped decline code', () => {
    const decision = decideNextStep('razorpay', 'NPCI_NETWORK_CONGESTION', ['razorpay']);
    expect(decision).toEqual({ action: 'failover', to: 'cashfree', scope: 'npci_network' });
  });

  it('fails fast (no failover) on a bank/VPA-scoped decline code, carrying the scope for explainability', () => {
    const decision = decideNextStep('razorpay', 'INVALID_VPA', ['razorpay']);
    expect(decision).toEqual({ action: 'fail', reason: 'non_retryable:INVALID_VPA', scope: 'bank_or_vpa' });
  });

  it('fails fast on a decline scoped to the issuing bank specifically, not the processor', () => {
    const decision = decideNextStep('razorpay', 'ISSUING_BANK_UNAVAILABLE', ['razorpay']);
    expect(decision).toEqual({ action: 'fail', reason: 'non_retryable:ISSUING_BANK_UNAVAILABLE', scope: 'bank_or_vpa' });
  });

  it('fails once every processor has already been tried, even if retryable', () => {
    const decision = decideNextStep('cashfree', 'PROCESSOR_GATEWAY_ERROR', ['razorpay', 'cashfree']);
    expect(decision).toEqual({ action: 'fail', reason: 'processors_exhausted', scope: 'processor' });
  });

  it('fails with unknown_failure reason and no scope when no decline code is present', () => {
    const decision = decideNextStep('razorpay', undefined, ['razorpay']);
    expect(decision).toEqual({ action: 'fail', reason: 'unknown_failure', scope: undefined });
  });
});
