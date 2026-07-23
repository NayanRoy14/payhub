import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { verifyRazorpaySignature, verifyStripeSignature, verifyCashfreeSignature } from '../webhooks/verifySignature';
import { RazorpayAdapter } from '../adapters/razorpay.adapter';
import { StripeAdapter } from '../adapters/stripe.adapter';
import { CashfreeAdapter } from '../adapters/cashfree.adapter';
import { handleWebhookEvent } from '../core/paymentService';

const router = Router();
const razorpayAdapter = new RazorpayAdapter();
const stripeAdapter = new StripeAdapter();
const cashfreeAdapter = new CashfreeAdapter();
const stripeWebhookClient = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

router.post('/webhooks/razorpay', async (req: Request, res: Response) => {
  const signature = req.header('x-razorpay-signature');
  const rawBody = req.body as Buffer;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

  if (!verifyRazorpaySignature(rawBody, signature, secret)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const event = razorpayAdapter.parseWebhook(rawBody);
  await handleWebhookEvent(event);
  res.status(200).json({ received: true });
});

router.post('/webhooks/stripe', async (req: Request, res: Response) => {
  const signature = req.header('stripe-signature');
  const rawBody = req.body as Buffer;
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  if (!verifyStripeSignature(rawBody, signature, secret, stripeWebhookClient)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const event = stripeAdapter.parseWebhook(rawBody);
  await handleWebhookEvent(event);
  res.status(200).json({ received: true });
});

router.post('/webhooks/cashfree', async (req: Request, res: Response) => {
  const signature = req.header('x-webhook-signature');
  const timestamp = req.header('x-webhook-timestamp');
  const rawBody = req.body as Buffer;
  const secret = process.env.CASHFREE_SECRET_KEY ?? '';

  if (!verifyCashfreeSignature(rawBody, signature, timestamp, secret)) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const event = cashfreeAdapter.parseWebhook(rawBody);
  await handleWebhookEvent(event);
  res.status(200).json({ received: true });
});

export default router;
