import { Router, Request, Response } from 'express';
import { createPayment, getPayment, listPayments } from '../core/paymentService';
import { PaymentState } from '../core/stateMachine';
import { asyncHandler } from './asyncHandler';

const router = Router();

router.post(
  '/payments',
  asyncHandler(async (req: Request, res: Response) => {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      res.status(400).json({ error: 'Idempotency-Key header is required' });
      return;
    }

    const { amount, currency, paymentMethod, customerEmail, payerVpa } = req.body ?? {};
    if (!amount || !currency || !paymentMethod || !customerEmail) {
      res.status(400).json({ error: 'amount, currency, paymentMethod, customerEmail are required' });
      return;
    }
    if (paymentMethod !== 'upi') {
      res.status(400).json({ error: 'only paymentMethod "upi" is supported in v1' });
      return;
    }
    // The truthiness check above rejects 0/''/null/undefined but not a wrong
    // *type* — a JSON body can put any type behind any key regardless of what
    // TypeScript declares, e.g. amount: {"$gt": 0} or amount: "abc". Validate
    // each field's actual type before it reaches the database, rather than
    // letting Mongoose's cast error (or a downstream crash) surface as a
    // confusing, internals-leaking 502.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number (smallest currency unit, e.g. paise)' });
      return;
    }
    if (typeof currency !== 'string' || currency.trim().length === 0) {
      res.status(400).json({ error: 'currency must be a non-empty string' });
      return;
    }
    if (typeof customerEmail !== 'string' || customerEmail.trim().length === 0) {
      res.status(400).json({ error: 'customerEmail must be a non-empty string' });
      return;
    }
    if (payerVpa !== undefined && typeof payerVpa !== 'string') {
      res.status(400).json({ error: 'payerVpa must be a string if provided' });
      return;
    }

    try {
      const tx = await createPayment({ amount, currency, paymentMethod, customerEmail, idempotencyKey, payerVpa });
      res.status(201).json({
        paymentId: tx.paymentId,
        status: tx.status,
        routedTo: tx.currentProcessor,
      });
    } catch (err) {
      res.status(502).json({ error: 'payment creation failed', detail: (err as Error).message });
    }
  })
);

router.get(
  '/payments',
  asyncHandler(async (req: Request, res: Response) => {
    // req.query.limit can be a string, an array (?limit=1&limit=2), or a
    // nested object (?limit[$gt]=0) depending on what the caller sends —
    // only accept the plain-string case; anything else falls back to the
    // default rather than producing NaN/an unvalidated value downstream.
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as PaymentState) : undefined;
    const txs = await listPayments({ limit, status });
    res.status(200).json(
      txs.map((tx) => ({
        paymentId: tx.paymentId,
        status: tx.status,
        processor: tx.currentProcessor,
        retriedFrom: tx.retriedFrom,
        amount: tx.amount,
        currency: tx.currency,
        upiPsp: tx.upiPsp,
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      }))
    );
  })
);

router.get(
  '/payments/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await getPayment(req.params.id);
    if (!tx) {
      res.status(404).json({ error: 'payment not found' });
      return;
    }
    res.status(200).json({
      paymentId: tx.paymentId,
      status: tx.status,
      processor: tx.currentProcessor,
      retriedFrom: tx.retriedFrom,
      amount: tx.amount,
      currency: tx.currency,
      ...(tx.payerVpa ? { payerVpa: tx.payerVpa, upiHandle: tx.upiHandle, upiPsp: tx.upiPsp } : {}),
    });
  })
);

router.get(
  '/payments/:id/events',
  asyncHandler(async (req: Request, res: Response) => {
    const tx = await getPayment(req.params.id);
    if (!tx) {
      res.status(404).json({ error: 'payment not found' });
      return;
    }
    res.status(200).json(
      tx.events.map((e) => ({
        state: e.state,
        ...(e.processor ? { processor: e.processor } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.declineScope ? { declineScope: e.declineScope } : {}),
        timestamp: e.timestamp,
      }))
    );
  })
);

export default router;
