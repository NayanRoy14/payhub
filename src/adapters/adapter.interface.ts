export type ProcessorName = 'razorpay' | 'stripe' | 'cashfree';

export type ChargeStatus = 'processing' | 'succeeded' | 'failed';

export interface ChargeRequest {
  paymentId: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  paymentMethod: 'upi';
  customerEmail: string;
}

export interface ChargeResult {
  processorRef: string;
  status: ChargeStatus;
  declineCode?: string;
  raw?: unknown;
}

export interface NormalizedWebhookEvent {
  processor: ProcessorName;
  processorRef: string;
  status: ChargeStatus;
  declineCode?: string;
  raw: unknown;
}

/**
 * Every processor adapter exposes this exact shape. PayHub Core (routing engine,
 * state machine, payment service) must only ever talk to processors through this
 * interface — no processor-specific branching outside the adapters/ and webhooks/
 * folders.
 */
export interface ProcessorAdapter {
  readonly name: ProcessorName;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  verify(processorRef: string): Promise<ChargeResult>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedWebhookEvent;
}
