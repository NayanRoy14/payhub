import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TransactionModel } from '../src/db/models/transaction.model';
import { ChargeRequest, ChargeResult, ProcessorAdapter } from '../src/adapters/adapter.interface';
import { createPayment, getPayment, handleWebhookEvent, resetAdapters, setAdapters } from '../src/core/paymentService';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
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
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'BANK_SERVER_DOWN' })),
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
      declineCode: 'BANK_SERVER_DOWN',
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
