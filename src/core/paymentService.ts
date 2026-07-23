import { v4 as uuidv4 } from 'uuid';
import { TransactionModel, TransactionDocument } from '../db/models/transaction.model';
import { ChargeResult, NormalizedWebhookEvent, ProcessorAdapter, ProcessorName } from '../adapters/adapter.interface';
import { RazorpayAdapter } from '../adapters/razorpay.adapter';
import { StripeAdapter } from '../adapters/stripe.adapter';
import { CashfreeAdapter } from '../adapters/cashfree.adapter';
import { decideNextStep, primaryProcessor } from './routingEngine';
import { declineScope } from './declineTaxonomy';
import { classifyVpaHandle } from './upiHandles';
import { canTransition, PaymentState } from './stateMachine';

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  paymentMethod: 'upi';
  customerEmail: string;
  idempotencyKey: string;
  /** Optional customer VPA — enables handle-aware decline reasoning (see core/upiHandles.ts). */
  payerVpa?: string;
}

// 'stripe' stays registered (StripeAdapter is fully implemented and tested)
// even though routingEngine's PROCESSOR_ORDER no longer includes it — see the
// comment there for why Cashfree is the active fallback processor instead.
const defaultAdapters: Record<ProcessorName, ProcessorAdapter> = {
  razorpay: new RazorpayAdapter(),
  stripe: new StripeAdapter(),
  cashfree: new CashfreeAdapter(),
};

let adapters: Record<ProcessorName, ProcessorAdapter> = defaultAdapters;

/** Test-only seam: inject fake adapters instead of the real Razorpay/Stripe/Cashfree SDKs. */
export function setAdapters(overrides: Partial<Record<ProcessorName, ProcessorAdapter>>): void {
  adapters = { ...defaultAdapters, ...overrides };
}

export function resetAdapters(): void {
  adapters = defaultAdapters;
}

function transitionTo(doc: TransactionDocument, next: PaymentState): void {
  if (!canTransition(doc.status, next)) {
    throw new Error(`Invalid state transition: ${doc.status} -> ${next}`);
  }
  doc.status = next;
}

function logRoutingDecision(doc: TransactionDocument, from: ProcessorName, declineCode: string | undefined, decision: unknown): void {
  const handleContext = doc.upiHandle ? ` handle=${doc.upiHandle} psp=${doc.upiPsp}` : '';
  console.log(
    `[routing] payment=${doc.paymentId} processor=${from} declineCode=${declineCode ?? 'none'}${handleContext} decision=${JSON.stringify(decision)}`
  );
}

/**
 * Creates a payment and drives it through the first processor attempt. Idempotent:
 * a repeat request with an already-seen Idempotency-Key returns the existing
 * transaction instead of charging again.
 */
export async function createPayment(input: CreatePaymentInput): Promise<TransactionDocument> {
  const existing = await TransactionModel.findOne({ idempotencyKey: input.idempotencyKey });
  if (existing) {
    return existing;
  }

  const vpaClassification = classifyVpaHandle(input.payerVpa);

  const doc = new TransactionModel({
    paymentId: uuidv4(),
    idempotencyKey: input.idempotencyKey,
    amount: input.amount,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    customerEmail: input.customerEmail,
    payerVpa: input.payerVpa,
    upiHandle: vpaClassification?.handle,
    upiPsp: vpaClassification?.psp,
    status: 'created',
    events: [{ state: 'created', timestamp: new Date() }],
    attempts: [],
  });

  const processor = primaryProcessor();
  transitionTo(doc, 'processing');
  doc.currentProcessor = processor;
  doc.events.push({ state: 'processing', processor, timestamp: new Date() });

  // Persist before calling any processor: the idempotency key is claimed first,
  // so a crash mid-call can never result in a silent double-charge on retry.
  await doc.save();

  await attemptCharge(doc, processor);
  await doc.save();
  return doc;
}

async function attemptCharge(doc: TransactionDocument, processor: ProcessorName): Promise<void> {
  const adapter = adapters[processor];
  let result: ChargeResult;
  try {
    result = await adapter.charge({
      paymentId: doc.paymentId,
      idempotencyKey: doc.idempotencyKey,
      amount: doc.amount,
      currency: doc.currency,
      paymentMethod: 'upi',
      customerEmail: doc.customerEmail,
      payerVpa: doc.payerVpa,
    });
  } catch (err) {
    // An adapter should map its own SDK errors to a ChargeResult; this is a
    // last-resort net for anything that still throws (e.g. a network timeout).
    result = { processorRef: '', status: 'failed', declineCode: 'GATEWAY_TIMEOUT', raw: (err as Error).message };
  }

  doc.attempts.push({
    processor,
    processorRef: result.processorRef || undefined,
    status: result.status,
    declineCode: result.declineCode,
    declineScope: declineScope(result.declineCode),
    startedAt: new Date(),
    endedAt: result.status === 'processing' ? undefined : new Date(),
  });

  await applyOutcome(doc, processor, result);
}

async function applyOutcome(
  doc: TransactionDocument,
  processor: ProcessorName,
  result: Pick<ChargeResult, 'status' | 'declineCode'>
): Promise<void> {
  if (result.status === 'succeeded') {
    transitionTo(doc, 'succeeded');
    doc.currentProcessor = processor;
    doc.events.push({ state: 'succeeded', processor, timestamp: new Date() });
    return;
  }

  if (result.status === 'processing') {
    doc.currentProcessor = processor;
    return;
  }

  // failed
  const scope = declineScope(result.declineCode);
  transitionTo(doc, 'failed');
  doc.events.push({
    state: 'failed',
    processor,
    reason: `declineCode:${result.declineCode ?? 'UNKNOWN'}`,
    declineScope: scope,
    timestamp: new Date(),
  });

  const alreadyTried = doc.attempts.map((a) => a.processor);
  const decision = decideNextStep(processor, result.declineCode, alreadyTried);
  logRoutingDecision(doc, processor, result.declineCode, decision);

  if (decision.action === 'fail') {
    return; // terminal — doc.status stays 'failed'
  }

  doc.retriedFrom = processor;
  transitionTo(doc, 'retrying');
  doc.events.push({ state: 'retrying', processor: decision.to, timestamp: new Date() });

  await attemptCharge(doc, decision.to);
}

export async function getPayment(paymentId: string): Promise<TransactionDocument | null> {
  return TransactionModel.findOne({ paymentId });
}

export interface ListPaymentsOptions {
  limit?: number;
  status?: PaymentState;
}

/** Most-recent-first, for the dashboard/reconciliation view. */
export async function listPayments(options: ListPaymentsOptions = {}): Promise<TransactionDocument[]> {
  const query = options.status ? { status: options.status } : {};
  return TransactionModel.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 100);
}

/**
 * Applies a normalized webhook event to whichever transaction its (processor,
 * processorRef) attempt belongs to. Late/duplicate webhooks after a payment has
 * already reached a terminal state are dropped rather than re-processed, since
 * webhook delivery is at-least-once and re-applying a terminal outcome would
 * attempt an invalid state transition.
 */
export async function handleWebhookEvent(event: NormalizedWebhookEvent): Promise<TransactionDocument | null> {
  const doc = await TransactionModel.findOne({
    attempts: { $elemMatch: { processor: event.processor, processorRef: event.processorRef } },
  });
  if (!doc) {
    return null;
  }

  if (doc.status === 'succeeded') {
    return doc;
  }

  const lastAttempt = doc.attempts[doc.attempts.length - 1];
  const isDuplicateTerminalFailure =
    doc.status === 'failed' &&
    lastAttempt?.processor === event.processor &&
    lastAttempt?.status === 'failed' &&
    event.status === 'failed';
  if (isDuplicateTerminalFailure) {
    return doc;
  }

  const attempt = [...doc.attempts].reverse().find((a) => a.processor === event.processor && a.processorRef === event.processorRef);
  if (attempt) {
    attempt.status = event.status;
    attempt.declineCode = event.declineCode;
    attempt.declineScope = declineScope(event.declineCode);
    attempt.endedAt = new Date();
  }

  await applyOutcome(doc, event.processor, { status: event.status, declineCode: event.declineCode });
  await doc.save();
  return doc;
}
