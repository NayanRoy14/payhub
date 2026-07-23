import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.RAZORPAY_WEBHOOK_SECRET = 'test_razorpay_webhook_secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_stripe_webhook_secret';
process.env.CASHFREE_SECRET_KEY = 'cfsk_test_cashfree_secret';

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { createApp } from '../src/server';

let mongod: MongoMemoryServer;
const app = createApp();

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(() => {
  delete process.env.DASHBOARD_USERNAME;
  delete process.env.DASHBOARD_PASSWORD;
});

describe('dashboard auth', () => {
  it('is open by default when DASHBOARD_USERNAME/PASSWORD are unset', async () => {
    const res = await request(app).get('/dashboard/');
    expect(res.status).toBe(200);
  });

  it('rejects with 401 and a WWW-Authenticate header when credentials are configured but not supplied', async () => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD = 'super-secret';

    const res = await request(app).get('/dashboard/');

    expect(res.status).toBe(401);
    expect(res.header['www-authenticate']).toBe('Basic realm="PayHub dashboard"');
  });

  it('accepts correct Basic credentials', async () => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD = 'super-secret';

    const res = await request(app).get('/dashboard/').set('Authorization', basicAuthHeader('admin', 'super-secret'));

    expect(res.status).toBe(200);
  });

  it('rejects wrong credentials', async () => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD = 'super-secret';

    const res = await request(app).get('/dashboard/').set('Authorization', basicAuthHeader('admin', 'wrong-password'));

    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header without throwing', async () => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD = 'super-secret';

    const res = await request(app).get('/dashboard/').set('Authorization', 'Basic not-valid-base64-or-missing-colon');

    expect(res.status).toBe(401);
  });

  it('does not gate the read API the dashboard depends on, even when dashboard credentials are set', async () => {
    process.env.DASHBOARD_USERNAME = 'admin';
    process.env.DASHBOARD_PASSWORD = 'super-secret';

    const payments = await request(app).get('/payments');
    expect(payments.status).toBe(200);

    const reconciliation = await request(app).get('/reconciliation');
    expect(reconciliation.status).toBe(200);
  });
});
