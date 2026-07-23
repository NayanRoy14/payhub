import { Router, Request, Response } from 'express';
import { createPayment, getPayment } from '../core/paymentService';

const router = Router();

router.post('/payments', async (req: Request, res: Response) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Idempotency-Key header is required' });
    return;
  }

  const { amount, currency, paymentMethod, customerEmail } = req.body ?? {};
  if (!amount || !currency || !paymentMethod || !customerEmail) {
    res.status(400).json({ error: 'amount, currency, paymentMethod, customerEmail are required' });
    return;
  }
  if (paymentMethod !== 'upi') {
    res.status(400).json({ error: 'only paymentMethod "upi" is supported in v1' });
    return;
  }

  try {
    const tx = await createPayment({ amount, currency, paymentMethod, customerEmail, idempotencyKey });
    res.status(201).json({
      paymentId: tx.paymentId,
      status: tx.status,
      routedTo: tx.currentProcessor,
    });
  } catch (err) {
    res.status(502).json({ error: 'payment creation failed', detail: (err as Error).message });
  }
});

router.get('/payments/:id', async (req: Request, res: Response) => {
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
  });
});

router.get('/payments/:id/events', async (req: Request, res: Response) => {
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
      timestamp: e.timestamp,
    }))
  );
});

export default router;
