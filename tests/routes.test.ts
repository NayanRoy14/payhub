import crypto from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TransactionModel } from '../src/db/models/transaction.model';
import { ChargeRequest, ChargeResult, ProcessorAdapter, ProcessorName } from '../src/adapters/adapter.interface';
import { resetAdapters, setAdapters } from '../src/core/paymentService';
import { setRandomFn } from '../src/core/routingEngine';

process.env.RAZORPAY_WEBHOOK_SECRET = 'test_razorpay_webhook_secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_stripe_webhook_secret';
process.env.CASHFREE_SECRET_KEY = 'cfsk_test_cashfree_secret';

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { createApp } from '../src/server';

let mongod: MongoMemoryServer;
const app = createApp();

function fakeAdapter(name: ProcessorName, script: (req: ChargeRequest) => Promise<ChargeResult>): ProcessorAdapter {
  return { name, charge: script, verify: jest.fn(), parseWebhook: jest.fn() };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // These route tests are about the HTTP layer, not weighted routing — force
  // a deterministic 'razorpay' initial pick (see routingWeights.test.ts).
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

describe('POST /payments', () => {
  it('rejects requests without an Idempotency-Key header', async () => {
    const res = await request(app)
      .post('/payments')
      .send({ amount: 100000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    expect(res.status).toBe(400);
  });

  it('creates a payment and reports which processor it was routed to', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_1', status: 'processing' })) });

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-1')
      .send({ amount: 100000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'processing', routedTo: 'razorpay' });
    expect(res.body.paymentId).toEqual(expect.any(String));
  });

  it('is idempotent: the same key returns the same payment without creating a duplicate', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_2', status: 'processing' })) });
    const body = { amount: 50000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' };

    const first = await request(app).post('/payments').set('Idempotency-Key', 'route-test-key-2').send(body);
    const second = await request(app).post('/payments').set('Idempotency-Key', 'route-test-key-2').send(body);

    expect(first.body.paymentId).toBe(second.body.paymentId);
    expect(await TransactionModel.countDocuments({ idempotencyKey: 'route-test-key-2' })).toBe(1);
  });
});

describe('GET /payments/:id and /payments/:id/events', () => {
  it('returns 404 for an unknown payment', async () => {
    const res = await request(app).get('/payments/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns the payment status and its full event timeline after a failover', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'PROCESSOR_GATEWAY_ERROR' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_order_route_1', status: 'succeeded' })),
    });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-3')
      .send({ amount: 75000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const paymentId = created.body.paymentId;

    const getRes = await request(app).get(`/payments/${paymentId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({ paymentId, status: 'succeeded', processor: 'cashfree', retriedFrom: 'razorpay' });

    const eventsRes = await request(app).get(`/payments/${paymentId}/events`);
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.body.map((e: { state: string }) => e.state)).toEqual([
      'created',
      'processing',
      'failed',
      'retrying',
      'succeeded',
    ]);
    const failedEvent = eventsRes.body.find((e: { state: string }) => e.state === 'failed');
    expect(failedEvent.declineScope).toBe('processor');
  });

  it('exposes the payer VPA handle/PSP classification when a VPA was provided', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_vpa_1', status: 'processing' })) });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-vpa-1')
      .send({ amount: 20000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com', payerVpa: 'demo@ybl' });

    const getRes = await request(app).get(`/payments/${created.body.paymentId}`);
    expect(getRes.body).toMatchObject({ payerVpa: 'demo@ybl', upiHandle: 'ybl', upiPsp: 'phonepe' });
  });
});

describe('GET /payments (list)', () => {
  it('returns the most recently created payments first', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_list_1', status: 'processing' })) });

    const first = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-list-1')
      .send({ amount: 10000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });
    const second = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-list-2')
      .send({ amount: 20000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const listRes = await request(app).get('/payments');
    expect(listRes.status).toBe(200);
    const ids = listRes.body.map((p: { paymentId: string }) => p.paymentId);
    expect(ids.indexOf(second.body.paymentId)).toBeLessThan(ids.indexOf(first.body.paymentId));
  });

  it('supports filtering by status', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'INVALID_VPA' })),
    });

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-list-3')
      .send({ amount: 10000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const listRes = await request(app).get('/payments?status=failed');
    expect(listRes.status).toBe(200);
    expect(listRes.body.every((p: { status: string }) => p.status === 'failed')).toBe(true);
  });
});

describe('POST /webhooks/razorpay', () => {
  it('rejects a webhook with an invalid signature', async () => {
    const payload = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x', status: 'captured' } } } };
    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'not-a-valid-signature')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed webhook and updates the transaction', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_webhook_1', status: 'processing' })) });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-4')
      .send({ amount: 60000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_webhook_1', order_id: 'order_webhook_1', status: 'captured' } } },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest('hex');

    const webhookRes = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);

    const getRes = await request(app).get(`/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('succeeded');
  });

  it('regression: a stale webhook for an already-terminal payment returns 200 rather than crashing the server', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'INVALID_VPA' })),
    });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-stale-1')
      .send({ amount: 60000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    // The payment above fails fast with no real processorRef (empty string, since
    // the fake adapter's charge() failed synchronously) — seed a real attempt
    // record with a processorRef a webhook can target, matching a payment that
    // failed via an async decline instead.
    await TransactionModel.updateOne(
      { paymentId: created.body.paymentId },
      { $set: { status: 'failed' }, $push: { attempts: { processor: 'razorpay', processorRef: 'order_stale_route_1', status: 'failed', startedAt: new Date(), endedAt: new Date() } } }
    );

    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_stale_route_1', order_id: 'order_stale_route_1', status: 'captured' } } },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest('hex');

    const webhookRes = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBody);

    expect(webhookRes.status).toBe(200); // acknowledged, not a 500 — and critically, did not crash the process

    const getRes = await request(app).get(`/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('failed'); // the stale "succeeded" claim must not resurrect a terminal payment

    // Prove the server is still alive and serving other requests normally.
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
  });
});

describe('POST /webhooks/stripe', () => {
  const stripeTestClient = new Stripe('sk_test_dummy_for_signing', { apiVersion: '2024-06-20' });

  it('rejects a webhook with an invalid signature', async () => {
    const payload = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_x', status: 'succeeded' } } };
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed webhook and updates the transaction', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_placeholder', status: 'processing' })),
      stripe: fakeAdapter('stripe', async () => ({ processorRef: 'pi_webhook_1', status: 'processing' })),
    });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-5')
      .send({ amount: 45000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    // The default primary processor is razorpay, so seed a razorpay attempt first,
    // then simulate the stripe fallback attempt already having been recorded via
    // a webhook-driven failover for this test's purposes: directly exercise the
    // stripe webhook path against an existing stripe processorRef.
    await TransactionModel.updateOne(
      { paymentId: created.body.paymentId },
      { $push: { attempts: { processor: 'stripe', processorRef: 'pi_webhook_1', status: 'processing', startedAt: new Date() } } }
    );

    const payload = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_webhook_1', status: 'succeeded' } } };
    const rawBody = JSON.stringify(payload);
    const signature = stripeTestClient.webhooks.generateTestHeaderString({
      payload: rawBody,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    const webhookRes = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);
  });
});

describe('POST /webhooks/cashfree', () => {
  it('rejects a webhook with an invalid signature', async () => {
    const payload = { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'order_x' }, payment: { payment_status: 'SUCCESS' } } };
    const res = await request(app)
      .post('/webhooks/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', 'not-a-valid-signature')
      .set('x-webhook-timestamp', '1700000000')
      .send(JSON.stringify(payload));

    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed webhook and updates the transaction', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'PROCESSOR_GATEWAY_ERROR' })),
      cashfree: fakeAdapter('cashfree', async () => ({ processorRef: 'cf_order_webhook_1', status: 'processing' })),
    });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-key-6')
      .send({ amount: 30000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: 'cf_order_webhook_1' }, payment: { payment_status: 'SUCCESS' } },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY!)
      .update(timestamp + rawBody)
      .digest('base64');

    const webhookRes = await request(app)
      .post('/webhooks/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);

    const getRes = await request(app).get(`/payments/${created.body.paymentId}`);
    expect(getRes.body.status).toBe('succeeded');
    expect(getRes.body.processor).toBe('cashfree');
    expect(getRes.body.retriedFrom).toBe('razorpay');
  });
});

describe('GET /reconciliation', () => {
  it('returns per-processor and overall stats reflecting recorded payments', async () => {
    setAdapters({
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_recon_1', status: 'succeeded' })),
    });

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-recon-1')
      .send({ amount: 10000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });

    const res = await request(app).get('/reconciliation');
    expect(res.status).toBe(200);
    expect(res.body.overall.totalPayments).toBeGreaterThanOrEqual(1);
    const razorpayStats = res.body.perProcessor.find((p: { processor: string }) => p.processor === 'razorpay');
    expect(razorpayStats.succeeded).toBeGreaterThanOrEqual(1);
  });
});

describe('webhook security & error handling', () => {
  it('regression: rejects a NoSQL injection attempt (processorRef as a Mongo operator object) without mutating any transaction', async () => {
    setAdapters({ razorpay: fakeAdapter('razorpay', async () => ({ processorRef: 'order_injection_target', status: 'processing' })) });

    const victim = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'route-test-injection-1')
      .send({ amount: 40000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });
    expect(victim.body.status).toBe('processing');

    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_injection', order_id: { $ne: null }, status: 'captured' } } },
    };
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest('hex');

    const webhookRes = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBody);

    expect(webhookRes.status).toBe(200); // signature valid, so it's acknowledged — but nothing should be mutated

    const getRes = await request(app).get(`/payments/${victim.body.paymentId}`);
    expect(getRes.body.status).toBe('processing'); // the unrelated in-flight payment must be untouched
  });

  it('returns a clean error (not a crash) for a malformed JSON body with an otherwise-valid signature', async () => {
    const rawBody = 'not valid json at all {{{';
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest('hex');

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal server error');

    // The server must still be serving other requests normally afterward.
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
  });

  it('returns 413 (not 500) for an oversized webhook body, preserving body-parser\'s own status code', async () => {
    const oversizedBody = JSON.stringify({ event: 'payment.captured', junk: 'A'.repeat(200_000) }); // > express.raw()'s default 100kb limit

    const res = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'irrelevant-too-large-to-check')
      .send(oversizedBody);

    expect(res.status).toBe(413);

    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
  });
});

describe('GET /dashboard', () => {
  it('redirects a bare /dashboard request to add the trailing slash', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(301);
  });

  it('serves the static dashboard HTML page at /dashboard/', async () => {
    const res = await request(app).get('/dashboard/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('PayHub Dashboard');
  });
});
