import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import { connectDb } from './db/connection';
import paymentsRouter from './routes/payments.routes';
import webhooksRouter from './routes/webhooks.routes';
import reconciliationRouter from './routes/reconciliation.routes';

dotenv.config();

export function createApp(): Express {
  const app = express();

  // Webhook routes need the raw request body for HMAC/signature verification,
  // so express.raw() must run before the JSON body parser and only on that path.
  app.use('/webhooks', express.raw({ type: '*/*' }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(paymentsRouter);
  app.use(webhooksRouter);
  app.use(reconciliationRouter);

  // Read-only demo dashboard — no auth, hits PayHub's own API. See README
  // "Known Limitations": local/demo use only.
  app.use('/dashboard', express.static(path.join(__dirname, '..', 'public'), { index: 'dashboard.html' }));

  // Last-resort safety net: asyncHandler forwards any error a route handler
  // throws/rejects with here instead of letting it become an unhandled
  // rejection (which would otherwise crash the whole process — see
  // core/paymentService.ts's applyOutcome() comment for the incident this
  // guards against). One bad request should never take down every other
  // in-flight request. Body-parser middleware (e.g. a 413 "payload too
  // large") also routes its errors here, before any route handler runs —
  // those already carry the correct HTTP status, so honor it instead of
  // flattening every error to a generic 500.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[server] unhandled route error', err);
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: status === 500 ? 'internal server error' : err.message });
  });

  return app;
}

async function main(): Promise<void> {
  const port = process.env.PORT ?? 3000;
  await connectDb(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/payhub');
  const app = createApp();
  app.listen(port, () => {
    console.log(`PayHub listening on port ${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start PayHub', err);
    process.exit(1);
  });
}
