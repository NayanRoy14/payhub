import { Schema, model, Document } from 'mongoose';
import { PaymentState } from '../../core/stateMachine';
import { ProcessorName } from '../../adapters/adapter.interface';
import { DeclineScope } from '../../core/declineTaxonomy';
import { UpiPsp } from '../../core/upiHandles';

// TypeScript's ProcessorName/PaymentState/DeclineScope unions are compile-time
// only — nothing stopped a bad value (a typo, a casing mismatch like
// "Razorpay" vs "razorpay", a future adapter registered under the wrong key)
// from being persisted, since these fields were plain `String` with no
// runtime check. Confirmed via reconciliation.ts's aggregation: a
// "Razorpay"/"razorpay" casing split silently produced two separate
// per-processor buckets instead of one, and a typo'd transaction status
// silently landed in the "inFlight" bucket forever instead of erroring.
// Enforcing the enum at the schema level makes bad data fail loudly at
// write time instead of corrupting reports read time.
const PROCESSOR_NAMES: ProcessorName[] = ['razorpay', 'stripe', 'cashfree'];
const PAYMENT_STATES: PaymentState[] = ['created', 'processing', 'retrying', 'succeeded', 'failed'];
const DECLINE_SCOPES: DeclineScope[] = ['processor', 'npci_network', 'bank_or_vpa', 'customer_action'];

export interface AttemptRecord {
  processor: ProcessorName;
  processorRef?: string;
  status: 'processing' | 'succeeded' | 'failed';
  declineCode?: string;
  declineScope?: DeclineScope;
  startedAt: Date;
  endedAt?: Date;
}

export interface EventRecord {
  state: PaymentState;
  processor?: ProcessorName;
  reason?: string;
  declineScope?: DeclineScope;
  timestamp: Date;
}

export interface TransactionDocument extends Document {
  paymentId: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  customerEmail: string;
  payerVpa?: string;
  upiHandle?: string;
  upiPsp?: UpiPsp;
  status: PaymentState;
  currentProcessor?: ProcessorName;
  retriedFrom?: ProcessorName;
  attempts: AttemptRecord[];
  events: EventRecord[];
  createdAt: Date;
  updatedAt: Date;
}

const AttemptSchema = new Schema<AttemptRecord>(
  {
    processor: { type: String, required: true, enum: PROCESSOR_NAMES },
    processorRef: { type: String },
    status: { type: String, required: true, enum: ['processing', 'succeeded', 'failed'] },
    declineCode: { type: String },
    declineScope: { type: String, enum: DECLINE_SCOPES },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
  },
  { _id: false }
);

const EventSchema = new Schema<EventRecord>(
  {
    state: { type: String, required: true, enum: PAYMENT_STATES },
    processor: { type: String, enum: PROCESSOR_NAMES },
    reason: { type: String },
    declineScope: { type: String, enum: DECLINE_SCOPES },
    timestamp: { type: Date, required: true },
  },
  { _id: false }
);

const TransactionSchema = new Schema<TransactionDocument>(
  {
    paymentId: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    paymentMethod: { type: String, required: true },
    customerEmail: { type: String, required: true },
    payerVpa: { type: String },
    upiHandle: { type: String },
    upiPsp: { type: String },
    status: { type: String, required: true, default: 'created', enum: PAYMENT_STATES },
    currentProcessor: { type: String, enum: PROCESSOR_NAMES },
    retriedFrom: { type: String, enum: PROCESSOR_NAMES },
    attempts: { type: [AttemptSchema], default: [] },
    events: { type: [EventSchema], default: [] },
  },
  {
    timestamps: true,
    // Two webhooks can legitimately arrive for the same transaction at
    // effectively the same instant (at-least-once delivery, retries). Without
    // this, two concurrent request handlers each load their own in-memory
    // copy, mutate independently, and whichever calls save() second silently
    // overwrites the first's changes — a real lost-update race that corrupts
    // the event timeline (observed: a stale "failed" event reappearing after
    // a later "retrying" event). optimisticConcurrency makes save() include
    // the document's version in its filter, so the loser's save() throws a
    // VersionError instead of clobbering the winner's write — see
    // paymentService.ts's handleWebhookEvent for how that's handled.
    optimisticConcurrency: true,
  }
);

export const TransactionModel = model<TransactionDocument>('Transaction', TransactionSchema);
