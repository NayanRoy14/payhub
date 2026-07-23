import Razorpay from 'razorpay';
import { ChargeRequest, ChargeResult, NormalizedWebhookEvent, ProcessorAdapter } from './adapter.interface';
import { normalizeRazorpayEvent, RAZORPAY_DECLINE_CODE_MAP } from '../webhooks/normalizer';

/** Minimal slice of the Razorpay SDK surface this adapter depends on — lets tests
 * inject a fake client instead of hitting the real API. */
export interface RazorpayClient {
  orders: {
    create(params: Record<string, unknown>): Promise<any>;
  };
  payments: {
    fetch(id: string): Promise<any>;
  };
}

/**
 * Errors thrown by orders.create() -> internal decline-code vocabulary. These
 * are Razorpay's top-level exception codes (distinct from the more granular
 * error_reason strings a webhook/verify() call surfaces — see
 * webhooks/normalizer.ts's RAZORPAY_DECLINE_CODE_MAP for those). Per Razorpay's
 * own docs, GATEWAY_ERROR originates at the bank/wallet's end (bank_or_vpa
 * scope — failover can't help); SERVER_ERROR is Razorpay's own infra
 * (processor scope — failover is worth trying).
 */
const RAZORPAY_CHARGE_ERROR_MAP: Record<string, string> = {
  BAD_REQUEST_ERROR: 'INVALID_VPA',
  GATEWAY_ERROR: 'ISSUING_BANK_UNAVAILABLE',
  SERVER_ERROR: 'PROCESSOR_GATEWAY_ERROR',
};

export class RazorpayAdapter implements ProcessorAdapter {
  readonly name = 'razorpay' as const;
  private readonly injectedClient?: RazorpayClient;
  private lazyClient?: RazorpayClient;

  constructor(client?: RazorpayClient) {
    this.injectedClient = client;
  }

  /**
   * Lazily constructs the real Razorpay SDK client on first use rather than at
   * adapter construction time, so importing this module doesn't require
   * RAZORPAY_KEY_ID/SECRET to be set (e.g. when only the Stripe path is
   * exercised, or in tests that inject a fake client).
   */
  private get client(): RazorpayClient {
    if (this.injectedClient) return this.injectedClient;
    if (!this.lazyClient) {
      this.lazyClient = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID ?? '',
        key_secret: process.env.RAZORPAY_KEY_SECRET ?? '',
      }) as unknown as RazorpayClient;
    }
    return this.lazyClient;
  }

  /**
   * Creates a Razorpay Order representing the UPI collect request. Real UPI
   * collect requires the customer to approve in their UPI app, so the outcome
   * is 'processing' until a webhook (or a verify() poll) resolves it.
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const order = await this.client.orders.create({
        amount: request.amount,
        currency: request.currency,
        receipt: request.paymentId,
        notes: {
          idempotencyKey: request.idempotencyKey,
          paymentMethod: request.paymentMethod,
          ...(request.payerVpa ? { payerVpa: request.payerVpa } : {}),
        },
      });
      return { processorRef: order.id, status: 'processing', raw: order };
    } catch (err: any) {
      const code: string = err?.error?.code ?? err?.code ?? 'SERVER_ERROR';
      return {
        processorRef: '',
        status: 'failed',
        declineCode: RAZORPAY_CHARGE_ERROR_MAP[code] ?? 'PROCESSOR_UNAVAILABLE',
        raw: err,
      };
    }
  }

  async verify(processorRef: string): Promise<ChargeResult> {
    const payment = await this.client.payments.fetch(processorRef);

    let status: ChargeResult['status'] = 'processing';
    let declineCode: string | undefined;
    if (payment.status === 'captured') {
      status = 'succeeded';
    } else if (payment.status === 'failed') {
      status = 'failed';
      const reason: string = payment.error_reason ?? payment.error_code ?? 'unknown';
      declineCode = RAZORPAY_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
    }

    return { processorRef, status, declineCode, raw: payment };
  }

  parseWebhook(rawBody: Buffer): NormalizedWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    return normalizeRazorpayEvent(payload);
  }
}
