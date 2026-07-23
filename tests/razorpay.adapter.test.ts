import { RazorpayAdapter, RazorpayClient } from '../src/adapters/razorpay.adapter';

function makeAdapter(overrides: Partial<RazorpayClient> = {}): { adapter: RazorpayAdapter; client: RazorpayClient } {
  const client: RazorpayClient = {
    orders: { create: jest.fn() },
    payments: { fetch: jest.fn() },
    ...overrides,
  } as RazorpayClient;
  return { adapter: new RazorpayAdapter(client), client };
}

describe('RazorpayAdapter.charge', () => {
  it('returns a processing result with the order id when order creation succeeds', async () => {
    const { adapter, client } = makeAdapter();
    (client.orders.create as jest.Mock).mockResolvedValue({ id: 'order_abc', status: 'created' });

    const result = await adapter.charge({
      paymentId: 'p1',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result).toEqual({ processorRef: 'order_abc', status: 'processing', raw: { id: 'order_abc', status: 'created' } });
  });

  it('maps a thrown gateway error to a retryable BANK_SERVER_DOWN failure', async () => {
    const { adapter, client } = makeAdapter();
    (client.orders.create as jest.Mock).mockRejectedValue({ error: { code: 'GATEWAY_ERROR' } });

    const result = await adapter.charge({
      paymentId: 'p1',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('BANK_SERVER_DOWN');
  });

  it('maps an unrecognized thrown error to PROCESSOR_UNAVAILABLE', async () => {
    const { adapter, client } = makeAdapter();
    (client.orders.create as jest.Mock).mockRejectedValue(new Error('boom'));

    const result = await adapter.charge({
      paymentId: 'p1',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('PROCESSOR_UNAVAILABLE');
  });
});

describe('RazorpayAdapter.verify', () => {
  it('reports succeeded for a captured payment', async () => {
    const { adapter, client } = makeAdapter();
    (client.payments.fetch as jest.Mock).mockResolvedValue({ id: 'pay_1', status: 'captured' });

    const result = await adapter.verify('pay_1');
    expect(result.status).toBe('succeeded');
  });

  it('reports failed with a decline code for a failed payment', async () => {
    const { adapter, client } = makeAdapter();
    (client.payments.fetch as jest.Mock).mockResolvedValue({ id: 'pay_2', status: 'failed', error_reason: 'gateway_error' });

    const result = await adapter.verify('pay_2');
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('GATEWAY_ERROR');
  });
});

describe('RazorpayAdapter.parseWebhook', () => {
  it('parses a raw webhook body into a normalized event', () => {
    const { adapter } = makeAdapter();
    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', status: 'captured' } } },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = adapter.parseWebhook(rawBody);
    expect(result).toEqual({
      processor: 'razorpay',
      processorRef: 'order_1',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });
});
