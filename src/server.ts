import path from 'path';
import express, { Express } from 'express';
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
