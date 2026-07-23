/**
 * PayHub SDK client — a small, dependency-free wrapper around PayHub's REST API
 * for merchant backends integrating payments.
 *
 * This file is intentionally self-contained (no imports from src/) so it can be
 * copied directly into a merchant's own codebase. In a more mature setup this
 * would ship as its own published package (e.g. `@payhub/sdk`); for now, copy
 * this single file into your project and import it directly.
 *
 * Requires Node.js 18+ (uses the built-in `fetch`). No dependencies.
 */

export type PaymentState = 'created' | 'processing' | 'retrying' | 'succeeded' | 'failed';
export type ProcessorName = 'razorpay' | 'stripe' | 'cashfree';

export interface CreatePaymentInput {
  /** Amount in the smallest currency unit (e.g. paise for INR: 100000 = ₹1,000). */
  amount: number;
  currency: string;
  customerEmail: string;
  /** Optional customer VPA (e.g. "name@okhdfcbank") — enables handle-aware decline reasoning. */
  payerVpa?: string;
  /**
   * Idempotency key for this payment request. If you omit it, the SDK generates
   * one for you — but if *you* might retry this exact call yourself (e.g. after
   * a network timeout on your end), pass your own stable key so a retry can
   * never double-charge the customer.
   */
  idempotencyKey?: string;
}

export interface CreatePaymentResult {
  paymentId: string;
  status: PaymentState;
  routedTo: ProcessorName;
}

export interface PaymentDetails {
  paymentId: string;
  status: PaymentState;
  processor?: ProcessorName;
  retriedFrom?: ProcessorName;
  amount: number;
  currency: string;
  payerVpa?: string;
  upiHandle?: string;
  upiPsp?: string;
}

export interface PaymentEvent {
  state: PaymentState;
  processor?: ProcessorName;
  reason?: string;
  declineScope?: 'processor' | 'npci_network' | 'bank_or_vpa' | 'customer_action';
  timestamp: string;
}

export interface PaymentSummary {
  paymentId: string;
  status: PaymentState;
  processor?: ProcessorName;
  retriedFrom?: ProcessorName;
  amount: number;
  currency: string;
  upiPsp?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentsOptions {
  limit?: number;
  status?: PaymentState;
}

export interface ProcessorStats {
  processor: ProcessorName;
  totalAttempts: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  averageTimeToSuccessMs: number | null;
}

export interface ReconciliationReport {
  perProcessor: ProcessorStats[];
  overall: {
    totalPayments: number;
    succeeded: number;
    failed: number;
    inFlight: number;
    successRate: number | null;
  };
}

export interface WaitForTerminalStatusOptions {
  /** Give up and throw after this many milliseconds. Default 60000 (1 minute). */
  timeoutMs?: number;
  /** How often to poll. Default 2000ms. */
  pollIntervalMs?: number;
}

/** Thrown for any non-2xx response. `status` and `body` let you branch on the specific error. */
export class PayHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = 'PayHubError';
  }
}

/** Thrown by waitForTerminalStatus() if the timeout elapses before the payment reaches succeeded/failed. */
export class PayHubTimeoutError extends Error {
  constructor(public readonly paymentId: string) {
    super(`Timed out waiting for payment ${paymentId} to reach a terminal status`);
    this.name = 'PayHubTimeoutError';
  }
}

function isTerminal(status: PaymentState): boolean {
  return status === 'succeeded' || status === 'failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple UUID v4 generator (no dependency) — used only as a fallback when no idempotencyKey is supplied. */
function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface PayHubClientOptions {
  /** Base URL of your PayHub deployment, e.g. "https://payhub.example.com" or "http://localhost:3000". */
  baseUrl: string;
}

export class PayHubClient {
  private readonly baseUrl: string;

  constructor(options: PayHubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  /**
   * Creates a payment and returns immediately once the primary processor
   * attempt has been initiated. Since UPI collect requires the customer to
   * approve in their own UPI app, the returned status is usually 'processing'
   * — use waitForTerminalStatus() or your own polling/webhook handling to
   * learn the final outcome.
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();
    return this.request<CreatePaymentResult>('POST', '/payments', {
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        amount: input.amount,
        currency: input.currency,
        paymentMethod: 'upi',
        customerEmail: input.customerEmail,
        ...(input.payerVpa ? { payerVpa: input.payerVpa } : {}),
      },
    });
  }

  async getPayment(paymentId: string): Promise<PaymentDetails> {
    return this.request<PaymentDetails>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  async getPaymentEvents(paymentId: string): Promise<PaymentEvent[]> {
    return this.request<PaymentEvent[]>('GET', `/payments/${encodeURIComponent(paymentId)}/events`);
  }

  async listPayments(options: ListPaymentsOptions = {}): Promise<PaymentSummary[]> {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.status) params.set('status', options.status);
    const query = params.toString();
    return this.request<PaymentSummary[]>('GET', `/payments${query ? `?${query}` : ''}`);
  }

  async getReconciliation(): Promise<ReconciliationReport> {
    return this.request<ReconciliationReport>('GET', '/reconciliation');
  }

  /**
   * Polls getPayment() until the payment reaches 'succeeded' or 'failed'
   * (or the timeout elapses). UPI collect is asynchronous — the customer has
   * to approve in their UPI app — so this is the simplest way to wait for a
   * result without setting up your own webhook receiver.
   *
   * For production traffic at scale, prefer having your backend listen for
   * PayHub's own webhook (not built yet — see the SDK/integration docs'
   * "Known limitations": PayHub currently only receives webhooks from
   * Razorpay/Cashfree, it doesn't yet forward status changes to merchants).
   */
  async waitForTerminalStatus(paymentId: string, options: WaitForTerminalStatusOptions = {}): Promise<PaymentDetails> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const payment = await this.getPayment(paymentId);
      if (isTerminal(payment.status)) {
        return payment;
      }
      if (Date.now() >= deadline) {
        throw new PayHubTimeoutError(paymentId);
      }
      await sleep(pollIntervalMs);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: unknown } = {}
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const payload = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message = (payload as { error?: string } | undefined)?.error ?? `PayHub API error (${res.status})`;
      throw new PayHubError(message, res.status, payload);
    }
    return payload as T;
  }
}
