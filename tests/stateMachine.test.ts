import { assertTransition, canTransition } from '../src/core/stateMachine';

describe('canTransition', () => {
  it('allows the happy path: created -> processing -> succeeded', () => {
    expect(canTransition('created', 'processing')).toBe(true);
    expect(canTransition('processing', 'succeeded')).toBe(true);
  });

  it('allows the failover path: processing -> failed -> retrying -> succeeded', () => {
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('failed', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'succeeded')).toBe(true);
  });

  it('allows exhaustion: retrying -> failed', () => {
    expect(canTransition('retrying', 'failed')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition('created', 'succeeded')).toBe(false);
    expect(canTransition('created', 'failed')).toBe(false);
    expect(canTransition('created', 'retrying')).toBe(false);
  });

  it('rejects any transition out of a succeeded (terminal) state', () => {
    expect(canTransition('succeeded', 'processing')).toBe(false);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(canTransition('succeeded', 'retrying')).toBe(false);
  });

  it('rejects re-entering processing once already past it', () => {
    expect(canTransition('failed', 'processing')).toBe(false);
    expect(canTransition('retrying', 'processing')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('does not throw for a legal transition', () => {
    expect(() => assertTransition('processing', 'failed')).not.toThrow();
  });

  it('throws a descriptive error for an illegal transition', () => {
    expect(() => assertTransition('succeeded', 'retrying')).toThrow('Invalid state transition: succeeded -> retrying');
  });
});
