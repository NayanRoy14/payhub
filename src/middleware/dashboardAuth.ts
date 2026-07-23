import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Gates the read-only demo dashboard (public/dashboard.html) behind HTTP
 * Basic Auth. Deliberately scoped to /dashboard only — the GET endpoints it
 * calls (/payments, /payments/:id, /payments/:id/events, /reconciliation)
 * stay open, since those are also the SDK's read methods
 * (listPayments/getPayment/getPaymentEvents/getReconciliation/
 * waitForTerminalStatus) and gating them would be a breaking change for any
 * integrator polling PayHub today. See README "Known limitations" for what
 * that tradeoff means in practice.
 *
 * Opt-in: DASHBOARD_USERNAME/DASHBOARD_PASSWORD are read from process.env on
 * every request (not captured at startup), so the dashboard stays open by
 * default — matches MERCHANT_WEBHOOK_URL's "absent = feature disabled"
 * precedent and keeps local `npm run dev` friction-free. Setting both env
 * vars turns this on; a live/public deployment should set them.
 */

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;

  if (!username || !password) {
    next();
    return;
  }

  const header = req.header('authorization');
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex !== -1) {
      const suppliedUser = decoded.slice(0, separatorIndex);
      const suppliedPass = decoded.slice(separatorIndex + 1);
      if (timingSafeEqualStrings(suppliedUser, username) && timingSafeEqualStrings(suppliedPass, password)) {
        next();
        return;
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="PayHub dashboard"');
  res.status(401).send('Authentication required');
}
