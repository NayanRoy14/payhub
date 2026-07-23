import Razorpay from 'razorpay';
import { ChargeRequest, ChargeResult, NormalizedWebhookEvent, ProcessorAdapter } from './adapter.interface';
import { normalizeRazorpayEvent } from '../webhooks/normalizer';

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

/** Errors thrown by orders.create() -> internal decline-code vocabulary. */
const RAZORPAY_CHARGE_ERROR_MAP: Record<string, string> = {
  BAD_REQUEST_ERROR: 'INVALID_VPA',
  GATEWAY_ERROR: 'BANK_SERVER_DOWN',
  SERVER_ERROR: 'PROCESSOR_UNAVAILABLE',
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
        notes: { idempotencyKey: request.idempotencyKey, paymentMethod: request.paymentMethod },
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
      declineCode = (payment.error_reason ?? payment.error_code ?? 'UNKNOWN').toUpperCase();
    }

    return { processorRef, status, declineCode, raw: payment };
  }

  parseWebhook(rawBody: Buffer): NormalizedWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    return normalizeRazorpayEvent(payload);
  }
}
