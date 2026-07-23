import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TransactionModel } from '../src/db/models/transaction.model';

/**
 * Regression tests for a reconciliation-math stress test: buildReconciliationReport()
 * trusted `processor`/`status` fields as-is, and nothing at the schema level stopped
 * a bad value from ever being written. Confirmed two real, silent failure modes:
 *  - a "Razorpay"/"razorpay" casing mismatch splintered one processor's stats into
 *    two separate per-processor buckets in the reconciliation report
 *  - a typo'd transaction status ("succeeeded") silently landed in the "inFlight"
 *    bucket forever instead of being flagged as succeeded, failed, or invalid
 * Fixed by adding `enum` constraints to the schema so Mongoose rejects these at
 * write time (validate()/save()) instead of letting them corrupt reports at read time.
 */
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
});

function baseDoc(overrides: Record<string, unknown> = {}) {
  return new TransactionModel({
    paymentId: 'p1',
    idempotencyKey: 'idem-1',
    amount: 100000,
    currency: 'INR',
    paymentMethod: 'upi',
    customerEmail: 'a@b.com',
    status: 'created',
    attempts: [],
    events: [],
    ...overrides,
  });
}

describe('TransactionModel schema enum enforcement', () => {
  it('rejects a processor value with the wrong casing on an attempt (the exact real casing-split bug)', async () => {
    const doc = baseDoc({
      attempts: [{ processor: 'Razorpay', status: 'succeeded', startedAt: new Date() }],
    });
    await expect(doc.validate()).rejects.toThrow(/processor/i);
  });

  it('rejects a typo in the top-level transaction status (the exact real "inFlight forever" bug)', async () => {
    const doc = baseDoc({ status: 'succeeeded' });
    await expect(doc.validate()).rejects.toThrow(/status/i);
  });

  it('rejects an unknown attempt status', async () => {
    const doc = baseDoc({
      attempts: [{ processor: 'razorpay', status: 'cancelled', startedAt: new Date() }],
    });
    await expect(doc.validate()).rejects.toThrow(/status/i);
  });

  it('rejects an unknown declineScope', async () => {
    const doc = baseDoc({
      attempts: [{ processor: 'razorpay', status: 'failed', startedAt: new Date(), declineScope: 'not_a_real_scope' }],
    });
    await expect(doc.validate()).rejects.toThrow(/declineScope/i);
  });

  it('accepts a document with all valid enum values', async () => {
    const doc = baseDoc({
      status: 'succeeded',
      currentProcessor: 'cashfree',
      retriedFrom: 'razorpay',
      attempts: [
        { processor: 'razorpay', status: 'failed', startedAt: new Date(), declineScope: 'processor' },
        { processor: 'cashfree', status: 'succeeded', startedAt: new Date(), endedAt: new Date() },
      ],
      events: [{ state: 'succeeded', processor: 'cashfree', declineScope: 'processor', timestamp: new Date() }],
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});
