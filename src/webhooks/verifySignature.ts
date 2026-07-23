import crypto from 'crypto';
import Stripe from 'stripe';

/**
 * Razorpay signs webhooks with HMAC-SHA256 over the raw request body, using the
 * webhook secret configured in the Razorpay dashboard. Reference:
 * https://razorpay.com/docs/webhooks/validate-test/
 */
export function verifyRazorpaySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret || rawBody.length === 0) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export type StripeWebhooksClient = Pick<Stripe, 'webhooks'>;

/**
 * Stripe verifies + parses in a single SDK call (its "native signing scheme").
 * We only need the boolean verification result here — parsing/normalizing happens
 * separately in StripeAdapter.parseWebhook once the route trusts the payload.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  stripeClient: StripeWebhooksClient
): boolean {
  if (!signatureHeader || !secret || rawBody.length === 0) return false;

  try {
    stripeClient.webhooks.constructEvent(rawBody, signatureHeader, secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cashfree signs webhooks with HMAC-SHA256 over `timestamp + rawBody`, base64-encoded,
 * using the same secret key issued for API access (Cashfree has no separate
 * webhook-only secret, unlike Razorpay/Stripe). Reference:
 * https://www.cashfree.com/docs/payments/online/webhooks/verify-webhook-signature
 */
export function verifyCashfreeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !timestampHeader || !secret || rawBody.length === 0) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestampHeader + rawBody.toString('utf8'))
    .digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
