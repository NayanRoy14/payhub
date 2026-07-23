import { DEFAULT_ROUTING_WEIGHTS, selectWeightedProcessor } from '../src/core/routingWeights';

describe('selectWeightedProcessor', () => {
  it('picks the first processor whose cumulative weight the roll falls under', () => {
    // razorpay: 70, cashfree: 30 -> boundary is at roll=70 out of 100
    expect(selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, () => 0)).toBe('razorpay'); // roll 0
    expect(selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, () => 0.69)).toBe('razorpay'); // roll 69
    expect(selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, () => 0.7)).toBe('cashfree'); // roll 70
    expect(selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, () => 0.99)).toBe('cashfree'); // roll 99
  });

  it('handles a 100/0 split deterministically', () => {
    expect(selectWeightedProcessor({ razorpay: 100, cashfree: 0 }, () => 0.999)).toBe('razorpay');
  });

  it('ignores zero-weighted processors entirely', () => {
    for (let i = 0; i < 20; i++) {
      const roll = i / 20;
      expect(selectWeightedProcessor({ razorpay: 0, cashfree: 100 }, () => roll)).toBe('cashfree');
    }
  });

  it('falls back to the last entry on a floating-point edge case (random() returns exactly 1)', () => {
    expect(selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, () => 1)).toBe('cashfree');
  });

  it('throws if no processor has a positive weight', () => {
    expect(() => selectWeightedProcessor({ razorpay: 0, cashfree: 0 })).toThrow(
      'At least one processor must have a positive routing weight'
    );
  });

  it('distributes roughly according to weight over many samples (statistical sanity check)', () => {
    let razorpayCount = 0;
    const samples = 2000;
    for (let i = 0; i < samples; i++) {
      if (selectWeightedProcessor(DEFAULT_ROUTING_WEIGHTS, Math.random) === 'razorpay') {
        razorpayCount++;
      }
    }
    const ratio = razorpayCount / samples;
    // Expect roughly 70%, generous tolerance to avoid test flakiness.
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.8);
  });
});
