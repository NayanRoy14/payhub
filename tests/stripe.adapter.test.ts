import { StripeAdapter, StripeClient } from '../src/adapters/stripe.adapter';

function makeAdapter(overrides: Partial<StripeClient> = {}): { adapter: StripeAdapter; client: StripeClient } {
  const client: StripeClient = {
    paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
    ...overrides,
  } as StripeClient;
  return { adapter: new StripeAdapter(client), client };
}

describe('StripeAdapter.charge', () => {
  it('creates a payment intent with the merchant idempotency key and returns processing', async () => {
    const { adapter, client } = makeAdapter();
    (client.paymentIntents.create as jest.Mock).mockResolvedValue({ id: 'pi_123', status: 'processing' });

    const result = await adapter.charge({
      paymentId: 'p1',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result).toEqual({ processorRef: 'pi_123', status: 'processing', raw: { id: 'pi_123', status: 'processing' } });
    expect(client.paymentIntents.create).toHaveBeenCalledWith(expect.any(Object), { idempotencyKey: 'idem-1' });
  });

  it('maps a thrown processing_error to a processor-scoped (retryable) failure', async () => {
    const { adapter, client } = makeAdapter();
    (client.paymentIntents.create as jest.Mock).mockRejectedValue({ code: 'processing_error' });

    const result = await adapter.charge({
      paymentId: 'p1',
      idempotencyKey: 'idem-1',
      amount: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      customerEmail: 'a@b.com',
    });

    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('PROCESSOR_GATEWAY_ERROR');
  });
});

describe('StripeAdapter.verify', () => {
  it('reports succeeded for a succeeded intent', async () => {
    const { adapter, client } = makeAdapter();
    (client.paymentIntents.retrieve as jest.Mock).mockResolvedValue({ id: 'pi_1', status: 'succeeded' });

    const result = await adapter.verify('pi_1');
    expect(result.status).toBe('succeeded');
  });

  it('reports failed with a mapped decline code for requires_payment_method', async () => {
    const { adapter, client } = makeAdapter();
    (client.paymentIntents.retrieve as jest.Mock).mockResolvedValue({
      id: 'pi_2',
      status: 'requires_payment_method',
      last_payment_error: { code: 'card_declined' },
    });

    const result = await adapter.verify('pi_2');
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('TXN_LIMIT_EXCEEDED');
  });
});

describe('StripeAdapter.parseWebhook', () => {
  it('parses a raw webhook body into a normalized event', () => {
    const { adapter } = makeAdapter();
    const payload = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', status: 'succeeded' } } };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = adapter.parseWebhook(rawBody);
    expect(result).toEqual({
      processor: 'stripe',
      processorRef: 'pi_1',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });
});
