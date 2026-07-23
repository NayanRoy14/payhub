import { CashfreeAdapter, CashfreeClient } from '../src/adapters/cashfree.adapter';

function makeAdapter(overrides: Partial<CashfreeClient> = {}): { adapter: CashfreeAdapter; client: CashfreeClient } {
  const client: CashfreeClient = {
    createOrder: jest.fn(),
    getOrderPayments: jest.fn(),
    ...overrides,
  } as CashfreeClient;
  return { adapter: new CashfreeAdapter(client), client };
}

describe('CashfreeAdapter.charge', () => {
  it('returns a processing result with the order id when order creation succeeds', async () => {
    const { adapter, client } = makeAdapter();
    (client.createOrder as jest.Mock).mockResolvedValue({ order_id: 'order_abc', order_status: 'ACTIVE' });

    const result = await adapter.charge({
      paymentId: 'order_abc',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result).toEqual({
      processorRef: 'order_abc',
      status: 'processing',
      raw: { order_id: 'order_abc', order_status: 'ACTIVE' },
    });
  });

  it('converts paise to a decimal rupee amount for the Cashfree order_amount field', async () => {
    const { adapter, client } = makeAdapter();
    (client.createOrder as jest.Mock).mockResolvedValue({ order_id: 'order_abc' });

    await adapter.charge({
      paymentId: 'order_abc',
      idempotencyKey: 'idem-1',
      amount: 150050,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ order_amount: 1500.5 }));
  });

  it('maps a thrown gateway error to a retryable BANK_SERVER_DOWN failure', async () => {
    const { adapter, client } = makeAdapter();
    (client.createOrder as jest.Mock).mockRejectedValue({ code: 'gateway_error' });

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
    (client.createOrder as jest.Mock).mockRejectedValue(new Error('boom'));

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

describe('CashfreeAdapter.verify', () => {
  it('reports processing when no payment attempt exists yet', async () => {
    const { adapter, client } = makeAdapter();
    (client.getOrderPayments as jest.Mock).mockResolvedValue([]);

    const result = await adapter.verify('order_1');
    expect(result.status).toBe('processing');
  });

  it('reports succeeded for a SUCCESS payment', async () => {
    const { adapter, client } = makeAdapter();
    (client.getOrderPayments as jest.Mock).mockResolvedValue([{ payment_status: 'SUCCESS' }]);

    const result = await adapter.verify('order_2');
    expect(result.status).toBe('succeeded');
  });

  it('reports failed with a decline code for a FAILED payment', async () => {
    const { adapter, client } = makeAdapter();
    (client.getOrderPayments as jest.Mock).mockResolvedValue([
      { payment_status: 'FAILED', error_details: { error_code: 'gateway_error' } },
    ]);

    const result = await adapter.verify('order_3');
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('GATEWAY_ERROR');
  });

  it('treats USER_DROPPED as a failed attempt', async () => {
    const { adapter, client } = makeAdapter();
    (client.getOrderPayments as jest.Mock).mockResolvedValue([
      { payment_status: 'USER_DROPPED', error_details: { error_reason: 'customer_cancelled' } },
    ]);

    const result = await adapter.verify('order_4');
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('CUSTOMER_CANCELLED');
  });
});

describe('CashfreeAdapter.parseWebhook', () => {
  it('parses a raw webhook body into a normalized event', () => {
    const { adapter } = makeAdapter();
    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: 'order_1' }, payment: { payment_status: 'SUCCESS' } },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = adapter.parseWebhook(rawBody);
    expect(result).toEqual({
      processor: 'cashfree',
      processorRef: 'order_1',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });
});
