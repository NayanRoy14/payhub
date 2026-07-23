import { Schema, model, Document } from 'mongoose';
import { PaymentState } from '../../core/stateMachine';
import { ProcessorName } from '../../adapters/adapter.interface';
import { DeclineScope } from '../../core/declineTaxonomy';
import { UpiPsp } from '../../core/upiHandles';

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
    processor: { type: String, required: true },
    processorRef: { type: String },
    status: { type: String, required: true },
    declineCode: { type: String },
    declineScope: { type: String },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date },
  },
  { _id: false }
);

const EventSchema = new Schema<EventRecord>(
  {
    state: { type: String, required: true },
    processor: { type: String },
    reason: { type: String },
    declineScope: { type: String },
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
    status: { type: String, required: true, default: 'created' },
    currentProcessor: { type: String },
    retriedFrom: { type: String },
    attempts: { type: [AttemptSchema], default: [] },
    events: { type: [EventSchema], default: [] },
  },
  { timestamps: true }
);

export const TransactionModel = model<TransactionDocument>('Transaction', TransactionSchema);
