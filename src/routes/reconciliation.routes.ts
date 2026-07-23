import { Router, Request, Response } from 'express';
import { TransactionModel } from '../db/models/transaction.model';
import { buildReconciliationReport } from '../core/reconciliation';
import { asyncHandler } from './asyncHandler';

const router = Router();

/**
 * Aggregated per-processor stats: transaction counts, success rate, and
 * average time-to-success — the "why orchestration matters" numbers, not
 * just the architecture story. Read-only, no auth (see README "Known Limitations").
 */
router.get(
  '/reconciliation',
  asyncHandler(async (_req: Request, res: Response) => {
    const transactions = await TransactionModel.find({}, { status: 1, attempts: 1 });
    const report = buildReconciliationReport(transactions);
    res.status(200).json(report);
  })
);

export default router;
