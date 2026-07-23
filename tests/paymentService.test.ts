import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TransactionModel } from '../src/db/models/transaction.model';
import { ChargeRequest, ChargeResult, ProcessorAdapter } from '../src/adapters/adapter.interface';
import { createPayment, getPayment, handleWebhookEvent, resetAdapters, setAdapters } from '../src/core/paymentService';
import { setRandomFn } from '../src/core/routingEngine';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // These tests are about failover/idempotency/etc., not weighted routing —
  // force a deterministic 'razorpay' initial pick (see routingWeights.test.ts
  // for weighted-selection coverage).
  setRandomFn(() => 0);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await TransactionModel.deleteMany({});
  resetAdapters();
});

/** A scriptable fake ProcessorAdapter so tests can force success/failure/timeout deterministically. */
function fakeAdapter(
  name: 'razorpay' | 'cashfree',
  script: (req: ChargeRequest) => Promise<ChargeResult>
): ProcessorAdapter {
  return {
    name,
    charge: script,
    verify: jest.fn(),
    parseWebhook: jest.fn(),
  };
}

const basePaymentInput = {
  amount: 100000,
  currency: 'INR',
  paymentMethod: 'upi' as const,
  customerEmail: 'customer@example.com',
};

describe('createPayment idempotency', () => {
  it('creates only one transaction when the same Idempotency-Key is used twice', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_1', status: 'succeeded' })),
    });

    const idempotencyKey = 'idem-fixed-key';
    const first = await createPayment({ ...basePaymentInput, idempotencyKey });
    const second = await createPayment({ ...basePaymentInput, idempotencyKey });

    expect(first.paymentId).toBe(second.paymentId);

    const count = await TransactionModel.countDocuments({ idempotencyKey });
    expect(count).toBe(1);
  });
});

describe('failover demo: primary times out, fallback succeeds', () => {
  it('completes on the fallback processor and the event timeline tells the full failover story', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => {
        throw new Error('simulated network timeout talking to Razorpay');
      }),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_order_1', status: 'succeeded' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-failover-1' });

    expect(tx.status).toBe('succeeded');
    expect(tx.currentProcessor).toBe('cashfree');
    expect(tx.retriedFrom).toBe('razorpay');

    const states = tx.events.map((e) => ({ state: e.state, processor: e.processor }));
    expect(states).toEqual([
      { state: 'created', processor: undefined },
      { state: 'processing', processor: 'razorpay' },
      { state: 'failed', processor: 'razorpay' },
      { state: 'retrying', processor: 'cashfree' },
      { state: 'succeeded', processor: 'cashfree' },
    ]);

    const failedEvent = tx.events.find((e) => e.state === 'failed');
    expect(failedEvent?.reason).toBe('declineCode:GATEWAY_TIMEOUT');
  });
});

describe('fail-fast on non-retryable decline code', () => {
  it('never attempts the fallback processor for an invalid VPA', async () => {
    const cashfreeCharge = jest.fn();
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'INVALID_VPA' })),
      cashfree: fakeAdapter('cashfree', cashfreeCharge),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-failfast-1' });

    expect(tx.status).toBe('failed');
    expect(tx.attempts).toHaveLength(1);
    expect(cashfreeCharge).not.toHaveBeenCalled();

    const states = tx.events.map((e) => e.state);
    expect(states).toEqual(['created', 'processing', 'failed']);
  });
});

describe('processor exhaustion', () => {
  it('fails permanently once every processor has been tried and all failed retryably', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'PROCESSOR_GATEWAY_ERROR' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: '', status: 'failed', declineCode: 'PSP_THROTTLED' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-exhausted-1' });

    expect(tx.status).toBe('failed');
    expect(tx.retriedFrom).toBe('razorpay');
    expect(tx.attempts).toHaveLength(2);
  });
});

describe('webhook-driven failover (async UPI collect flow)', () => {
  it('fails over based on a webhook decline and resolves via a second webhook', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_async_1', status: 'processing' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_order_async_1', status: 'processing' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-webhook-1' });
    expect(tx.status).toBe('processing');
    expect(tx.currentProcessor).toBe('razorpay');

    await handleWebhookEvent({
      processor: 'razorpay',
      processorRef: 'order_async_1',
      status: 'failed',
      declineCode: 'PROCESSOR_GATEWAY_ERROR',
      raw: {},
    });

    const afterFirstWebhook = await getPayment(tx.paymentId);
    expect(afterFirstWebhook?.status).toBe('retrying');
    expect(afterFirstWebhook?.currentProcessor).toBe('cashfree');

    await handleWebhookEvent({
      processor: 'cashfree',
      processorRef: 'cf_order_async_1',
      status: 'succeeded',
      raw: {},
    });

    const final = await getPayment(tx.paymentId);
    expect(final?.status).toBe('succeeded');
    expect(final?.retriedFrom).toBe('razorpay');

    const states = final?.events.map((e) => e.state);
    expect(states).toEqual(['created', 'processing', 'failed', 'retrying', 'succeeded']);
  });

  it('ignores a late duplicate webhook after the payment already succeeded', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_dup_1', status: 'processing' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-dup-1' });

    await handleWebhookEvent({ processor: 'razorpay', processorRef: 'order_dup_1', status: 'succeeded', raw: {} });
    const afterSuccess = await getPayment(tx.paymentId);
    expect(afterSuccess?.status).toBe('succeeded');

    // A duplicate delivery of the same webhook should not throw or change anything.
    await expect(
      handleWebhookEvent({ processor: 'razorpay', processorRef: 'order_dup_1', status: 'succeeded', raw: {} })
    ).resolves.not.toThrow();

    const finalTx = await getPayment(tx.paymentId);
    expect(finalTx?.status).toBe('succeeded');
    expect(finalTx?.events).toHaveLength(afterSuccess!.events.length);
  });

  it('ignores a duplicate terminal-failure webhook without throwing an invalid-transition error', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_dup_2', status: 'processing' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-dup-2' });

    await handleWebhookEvent({
      processor: 'razorpay',
      processorRef: 'order_dup_2',
      status: 'failed',
      declineCode: 'INVALID_VPA',
      raw: {},
    });
    const afterFailure = await getPayment(tx.paymentId);
    expect(afterFailure?.status).toBe('failed');

    await expect(
      handleWebhookEvent({
        processor: 'razorpay',
        processorRef: 'order_dup_2',
        status: 'failed',
        declineCode: 'INVALID_VPA',
        raw: {},
      })
    ).resolves.not.toThrow();
  });
});

describe('handle-aware routing', () => {
  it('classifies the payer VPA handle and stores it on the transaction', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_1', status: 'succeeded' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-vpa-1', payerVpa: 'nayan@ybl' });

    expect(tx.payerVpa).toBe('nayan@ybl');
    expect(tx.upiHandle).toBe('ybl');
    expect(tx.upiPsp).toBe('phonepe');
  });

  it('fails fast on a bank/VPA-scoped decline even though a fallback processor is available: switching processor can\'t fix the customer\'s own bank being down', async () => {
    const cashfreeCharge = jest.fn();
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({
        processorRef: '',
        status: 'failed',
        declineCode: 'ISSUING_BANK_UNAVAILABLE',
      })),
      cashfree: fakeAdapter('cashfree', cashfreeCharge),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-vpa-2', payerVpa: 'nayan@okhdfcbank' });

    expect(tx.status).toBe('failed');
    expect(tx.attempts).toHaveLength(1);
    expect(cashfreeCharge).not.toHaveBeenCalled();

    const failedEvent = tx.events.find((e) => e.state === 'failed');
    expect(failedEvent?.declineScope).toBe('bank_or_vpa');
    expect(tx.upiPsp).toBe('google_pay');
  });

  it('records declineScope on the attempt record for reconciliation/reporting', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({
        processorRef: '',
        status: 'failed',
        declineCode: 'INSUFFICIENT_FUNDS',
      })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-vpa-3', payerVpa: 'nayan@paytm' });

    expect(tx.attempts[0].declineScope).toBe('bank_or_vpa');
    expect(tx.upiPsp).toBe('paytm');
  });

  it('leaves upiHandle/upiPsp unset when no VPA is provided', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_1', status: 'succeeded' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-vpa-4' });

    expect(tx.payerVpa).toBeUndefined();
    expect(tx.upiHandle).toBeUndefined();
    expect(tx.upiPsp).toBeUndefined();
  });
});

describe('webhook robustness against stale/out-of-order events', () => {
  // Regression test for a real incident: a webhook claiming 'succeeded' arrived
  // for a payment that had already been driven to a terminal 'failed' state
  // (via a non-retryable decline). applyOutcome() used to throw on this
  // invalid state transition, which — because nothing caught it — crashed the
  // entire Node process via an unhandled rejection.
  it('does not throw when a "succeeded" webhook arrives after the payment already terminally failed', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_stale_1', status: 'failed', declineCode: 'INVALID_VPA' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-stale-1' });
    expect(tx.status).toBe('failed');

    await expect(
      handleWebhookEvent({ processor: 'razorpay', processorRef: 'order_stale_1', status: 'succeeded', raw: {} })
    ).resolves.not.toThrow();

    const afterStaleWebhook = await getPayment(tx.paymentId);
    expect(afterStaleWebhook?.status).toBe('failed'); // unchanged — the stale webhook must not resurrect a terminal payment
  });

  it('does not throw when a "failed" webhook arrives for a processor no longer in play after a failover succeeded', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_stale_2', status: 'failed', declineCode: 'PROCESSOR_GATEWAY_ERROR' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_stale_2', status: 'succeeded' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-stale-2' });
    expect(tx.status).toBe('succeeded');

    // A late/duplicate webhook for the original (already-superseded) razorpay attempt arrives.
    await expect(
      handleWebhookEvent({
        processor: 'razorpay',
        processorRef: 'order_stale_2',
        status: 'failed',
        declineCode: 'PROCESSOR_GATEWAY_ERROR',
        raw: {},
      })
    ).resolves.not.toThrow();

    const afterStaleWebhook = await getPayment(tx.paymentId);
    expect(afterStaleWebhook?.status).toBe('succeeded'); // unchanged
  });

  it('rejects a webhook whose processorRef is a Mongo query operator object instead of a string (NoSQL injection attempt)', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_injection_victim', status: 'processing' })),
    });

    const victim = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-injection-1' });
    expect(victim.status).toBe('processing');

    const result = await handleWebhookEvent({
      processor: 'razorpay',
      processorRef: { $ne: null } as unknown as string, // simulates a malicious/malformed webhook payload
      status: 'succeeded',
      raw: {},
    });

    expect(result).toBeNull(); // rejected before ever reaching the DB query

    const afterAttack = await getPayment(victim.paymentId);
    expect(afterAttack?.status).toBe('processing'); // the unrelated victim payment must be untouched
  });
});

describe('concurrent webhook delivery (race conditions)', () => {
  // Regression test for a real incident found via manual concurrent-request
  // testing: two webhooks for the same payment arriving at effectively the
  // same instant each loaded their own in-memory copy of the document,
  // mutated independently, and the second save() silently overwrote the
  // first's changes — corrupting the event timeline (a stale 'failed' event
  // reappeared after a later 'retrying' event). optimisticConcurrency on the
  // schema now makes the loser's save() throw a VersionError instead, which
  // handleWebhookEvent() catches and drops cleanly.
  it('does not corrupt the event timeline when the same webhook is delivered twice concurrently', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_concurrent_1', status: 'processing' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_concurrent_1', status: 'processing' })),
    });

    const tx = await createPayment({ ...basePaymentInput, idempotencyKey: 'idem-concurrent-1' });
    expect(tx.status).toBe('processing');

    const event = {
      processor: 'razorpay' as const,
      processorRef: 'order_concurrent_1',
      status: 'failed' as const,
      declineCode: 'PROCESSOR_GATEWAY_ERROR',
      raw: {},
    };

    // Fire the identical webhook twice concurrently, simulating at-least-once
    // delivery racing itself.
    const results = await Promise.allSettled([handleWebhookEvent(event), handleWebhookEvent(event)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // neither call should throw

    const final = await getPayment(tx.paymentId);
    expect(final?.status).toBe('retrying');
    // Exactly one failover attempt to cashfree — not two — regardless of which
    // concurrent delivery "won".
    expect(final?.attempts.filter((a) => a.processor === 'cashfree')).toHaveLength(1);

    // The event timeline must be a valid, non-corrupted sequence: no state
    // may appear after a later state that logically supersedes it.
    const states = final!.events.map((e) => e.state);
    expect(states).toEqual(['created', 'processing', 'failed', 'retrying']);
  });
});
