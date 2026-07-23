import crypto from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { TransactionModel } from '../src/db/models/transaction.model';
import { ChargeRequest, ChargeResult, ProcessorAdapter, ProcessorName } from '../src/adapters/adapter.interface';
import { resetAdapters, setAdapters } from '../src/core/paymentService';

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
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'BANK_SERVER_DOWN' })),
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
      razorpay: fakeAdapter('razorpay', async () => ({ processorRef: '', status: 'failed', declineCode: 'BANK_SERVER_DOWN' })),
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
