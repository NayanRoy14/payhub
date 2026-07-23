import Stripe from 'stripe';
import { ChargeRequest, ChargeResult, NormalizedWebhookEvent, ProcessorAdapter } from './adapter.interface';
import { normalizeStripeEvent, STRIPE_DECLINE_CODE_MAP } from '../webhooks/normalizer';

/** Minimal slice of the Stripe SDK surface this adapter depends on — lets tests
 * inject a fake client instead of hitting the real API. */
export interface StripeClient {
  paymentIntents: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<any>;
    retrieve(id: string): Promise<any>;
  };
}

export class StripeAdapter implements ProcessorAdapter {
  readonly name = 'stripe' as const;
  private readonly client: StripeClient;

  constructor(client?: StripeClient) {
    this.client =
      client ??
      (new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
        apiVersion: '2024-06-20',
      }) as unknown as StripeClient);
  }

  /**
   * Creates a PaymentIntent scoped to the 'upi' payment method type. Stripe's
   * India UPI support requires the customer to approve the collect request in
   * their UPI app, so the outcome is 'processing' until a webhook resolves it.
   * The processor's own idempotency-key support is used so a retried request
   * with the same key never double-charges.
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await this.client.paymentIntents.create(
        {
          amount: request.amount,
          currency: request.currency.toLowerCase(),
          payment_method_types: ['upi'],
          receipt_email: request.customerEmail,
          metadata: { paymentId: request.paymentId, ...(request.payerVpa ? { payerVpa: request.payerVpa } : {}) },
        },
        { idempotencyKey: request.idempotencyKey }
      );
      return { processorRef: intent.id, status: this.mapStatus(intent.status), raw: intent };
    } catch (err: any) {
      const code: string = err?.code ?? 'processing_error';
      return {
        processorRef: '',
        status: 'failed',
        declineCode: STRIPE_DECLINE_CODE_MAP[code] ?? 'PROCESSOR_UNAVAILABLE',
        raw: err,
      };
    }
  }

  async verify(processorRef: string): Promise<ChargeResult> {
    const intent = await this.client.paymentIntents.retrieve(processorRef);
    return this.toResult(intent);
  }

  parseWebhook(rawBody: Buffer): NormalizedWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    return normalizeStripeEvent(payload);
  }

  private toResult(intent: any): ChargeResult {
    const status = this.mapStatus(intent.status);
    let declineCode: string | undefined;
    if (status === 'failed') {
      const code: string = intent.last_payment_error?.code ?? 'unknown';
      declineCode = STRIPE_DECLINE_CODE_MAP[code] ?? code.toUpperCase();
    }
    return { processorRef: intent.id, status, declineCode, raw: intent };
  }

  private mapStatus(stripeStatus: string): ChargeResult['status'] {
    if (stripeStatus === 'succeeded') return 'succeeded';
    if (stripeStatus === 'canceled' || stripeStatus === 'requires_payment_method') return 'failed';
    return 'processing';
  }
}
