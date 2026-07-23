import crypto from 'crypto';
import { verifyCashfreeSignature, verifyRazorpaySignature, verifyStripeSignature } from '../src/webhooks/verifySignature';

describe('verifyRazorpaySignature', () => {
  const secret = 'test_webhook_secret';
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));

  it('accepts a correctly signed body', () => {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyRazorpaySignature(body, signature, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'payment.failed' }));
    expect(verifyRazorpaySignature(tamperedBody, signature, secret)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = crypto.createHmac('sha256', 'wrong_secret').update(body).digest('hex');
    expect(verifyRazorpaySignature(body, signature, secret)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyRazorpaySignature(body, undefined, secret)).toBe(false);
  });

  it('rejects when no secret is configured', () => {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyRazorpaySignature(body, signature, '')).toBe(false);
  });
});

describe('verifyStripeSignature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'payment_intent.succeeded' }));

  it('accepts when the Stripe SDK verifies the event', () => {
    const fakeStripeClient = { webhooks: { constructEvent: jest.fn().mockReturnValue({ id: 'evt_1' }) } };
    expect(verifyStripeSignature(body, 'valid-sig', 'whsec_test', fakeStripeClient as any)).toBe(true);
    expect(fakeStripeClient.webhooks.constructEvent).toHaveBeenCalledWith(body, 'valid-sig', 'whsec_test');
  });

  it('rejects when the Stripe SDK throws (invalid signature)', () => {
    const fakeStripeClient = {
      webhooks: {
        constructEvent: jest.fn().mockImplementation(() => {
          throw new Error('signature mismatch');
        }),
      },
    };
    expect(verifyStripeSignature(body, 'bad-sig', 'whsec_test', fakeStripeClient as any)).toBe(false);
  });

  it('rejects a missing signature header without calling the SDK', () => {
    const fakeStripeClient = { webhooks: { constructEvent: jest.fn() } };
    expect(verifyStripeSignature(body, undefined, 'whsec_test', fakeStripeClient as any)).toBe(false);
    expect(fakeStripeClient.webhooks.constructEvent).not.toHaveBeenCalled();
  });
});

describe('verifyCashfreeSignature', () => {
  const secret = 'cfsk_test_secret';
  const body = Buffer.from(JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK' }));
  const timestamp = '1700000000';

  function sign(ts: string, rawBody: Buffer, key: string): string {
    return crypto.createHmac('sha256', key).update(ts + rawBody.toString('utf8')).digest('base64');
  }

  it('accepts a correctly signed body', () => {
    const signature = sign(timestamp, body, secret);
    expect(verifyCashfreeSignature(body, signature, timestamp, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = sign(timestamp, body, secret);
    const tamperedBody = Buffer.from(JSON.stringify({ type: 'PAYMENT_FAILED_WEBHOOK' }));
    expect(verifyCashfreeSignature(tamperedBody, signature, timestamp, secret)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const signature = sign(timestamp, body, 'wrong_secret');
    expect(verifyCashfreeSignature(body, signature, timestamp, secret)).toBe(false);
  });

  it('rejects a signature computed with a different timestamp (replay protection)', () => {
    const signature = sign('1700000001', body, secret);
    expect(verifyCashfreeSignature(body, signature, timestamp, secret)).toBe(false);
  });

  it('rejects a missing signature or timestamp header', () => {
    const signature = sign(timestamp, body, secret);
    expect(verifyCashfreeSignature(body, undefined, timestamp, secret)).toBe(false);
    expect(verifyCashfreeSignature(body, signature, undefined, secret)).toBe(false);
  });

  it('rejects when no secret is configured', () => {
    const signature = sign(timestamp, body, secret);
    expect(verifyCashfreeSignature(body, signature, timestamp, '')).toBe(false);
  });
});
