import { ChargeRequest, ChargeResult, NormalizedWebhookEvent, ProcessorAdapter } from './adapter.interface';
import { normalizeCashfreeEvent, CASHFREE_DECLINE_CODE_MAP } from '../webhooks/normalizer';

/**
 * Minimal client surface this adapter depends on — lets tests inject a fake
 * client instead of hitting the real API. Cashfree has no official first-party
 * Node SDK in this project's dependency list, and REST is simple enough that a
 * thin fetch-based client (below) is used instead of adding a new dependency.
 */
export interface CashfreeClient {
  createOrder(params: Record<string, unknown>): Promise<any>;
  getOrderPayments(orderId: string): Promise<any[]>;
}

/**
 * Errors thrown by createOrder() -> internal decline-code vocabulary (see
 * core/declineTaxonomy.ts). `gateway_error` is treated conservatively as
 * bank/VPA-scoped (ambiguous whether it's Cashfree's own infra or the bank's —
 * see webhooks/normalizer.ts for the same reasoning applied to webhook declines).
 */
const CASHFREE_CHARGE_ERROR_MAP: Record<string, string> = {
  invalid_request_error: 'INVALID_VPA',
  gateway_error: 'ISSUING_BANK_UNAVAILABLE',
  internal_error: 'PROCESSOR_UNAVAILABLE',
};

const CASHFREE_API_VERSION = '2023-08-01';

class HttpCashfreeClient implements CashfreeClient {
  constructor(
    private readonly appId: string,
    private readonly secretKey: string,
    private readonly baseUrl: string
  ) {}

  private async request(path: string, method: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': this.appId,
        'x-client-secret': this.secretKey,
        'x-api-version': CASHFREE_API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(payload?.message ?? `Cashfree API error (${res.status})`);
      err.code = payload?.code ?? payload?.type ?? 'internal_error';
      err.raw = payload;
      throw err;
    }
    return payload;
  }

  createOrder(params: Record<string, unknown>): Promise<any> {
    return this.request('/orders', 'POST', params);
  }

  getOrderPayments(orderId: string): Promise<any[]> {
    return this.request(`/orders/${orderId}/payments`, 'GET');
  }
}

export class CashfreeAdapter implements ProcessorAdapter {
  readonly name = 'cashfree' as const;
  private readonly injectedClient?: CashfreeClient;
  private lazyClient?: CashfreeClient;

  constructor(client?: CashfreeClient) {
    this.injectedClient = client;
  }

  /** Lazily constructed so importing this module never requires CASHFREE_* env vars to be set. */
  private get client(): CashfreeClient {
    if (this.injectedClient) return this.injectedClient;
    if (!this.lazyClient) {
      const baseUrl =
        process.env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
      this.lazyClient = new HttpCashfreeClient(
        process.env.CASHFREE_APP_ID ?? '',
        process.env.CASHFREE_SECRET_KEY ?? '',
        baseUrl
      );
    }
    return this.lazyClient;
  }

  /**
   * Creates a Cashfree Order representing the UPI collect request. As with
   * Razorpay/Stripe, real UPI collect requires the customer to approve in
   * their UPI app, so the outcome is 'processing' until a webhook (or a
   * verify() poll) resolves it.
   *
   * Cashfree's Create Order API requires a customer phone number, which
   * PayHub's unified /payments contract (amount/currency/paymentMethod/
   * customerEmail only) does not collect in v1 — a fixed sandbox placeholder
   * is used. See README "Known Limitations".
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const order = await this.client.createOrder({
        order_id: request.paymentId,
        order_amount: request.amount / 100, // Cashfree expects a decimal amount, not paise
        order_currency: request.currency,
        customer_details: {
          customer_id: request.paymentId,
          customer_email: request.customerEmail,
          customer_phone: '9999999999',
        },
        order_meta: {
          idempotencyKey: request.idempotencyKey,
          ...(request.payerVpa ? { payerVpa: request.payerVpa } : {}),
        },
      });
      return { processorRef: order.order_id, status: 'processing', raw: order };
    } catch (err: any) {
      const code: string = err?.code ?? 'internal_error';
      return {
        processorRef: '',
        status: 'failed',
        declineCode: CASHFREE_CHARGE_ERROR_MAP[code] ?? 'PROCESSOR_UNAVAILABLE',
        raw: err,
      };
    }
  }

  async verify(processorRef: string): Promise<ChargeResult> {
    const payments = await this.client.getOrderPayments(processorRef);
    const latest = payments?.[0]; // Cashfree returns most-recent-first
    return this.toResult(processorRef, latest);
  }

  parseWebhook(rawBody: Buffer): NormalizedWebhookEvent {
    const payload = JSON.parse(rawBody.toString('utf8'));
    return normalizeCashfreeEvent(payload);
  }

  private toResult(processorRef: string, payment: any): ChargeResult {
    if (!payment) {
      return { processorRef, status: 'processing' };
    }

    let status: ChargeResult['status'] = 'processing';
    let declineCode: string | undefined;
    if (payment.payment_status === 'SUCCESS') {
      status = 'succeeded';
    } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(payment.payment_status)) {
      status = 'failed';
      const reason: string = payment.error_details?.error_code ?? payment.error_details?.error_reason ?? 'unknown';
      declineCode = CASHFREE_DECLINE_CODE_MAP[reason] ?? reason.toUpperCase();
    }

    return { processorRef, status, declineCode, raw: payment };
  }
}
