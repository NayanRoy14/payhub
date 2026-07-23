import { PayHubClient, PayHubError, PayHubNetworkError, PayHubTimeoutError } from '../sdk/payhubClient';

function mockFetchOnce(status: number, body: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  (global as any).fetch = jest.fn();
});

describe('PayHubClient.createPayment', () => {
  it('sends amount/currency/customerEmail with paymentMethod fixed to upi', async () => {
    mockFetchOnce(201, { paymentId: 'p1', status: 'processing', routedTo: 'razorpay' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    const result = await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com' });

    expect(result).toEqual({ paymentId: 'p1', status: 'processing', routedTo: 'razorpay' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ amount: 100000, currency: 'INR', paymentMethod: 'upi', customerEmail: 'a@b.com' });
  });

  it('auto-generates an Idempotency-Key when none is supplied', async () => {
    mockFetchOnce(201, { paymentId: 'p1', status: 'processing', routedTo: 'razorpay' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(init.headers['Idempotency-Key'].length).toBeGreaterThan(10);
  });

  it('uses a caller-supplied idempotencyKey verbatim', async () => {
    mockFetchOnce(201, { paymentId: 'p1', status: 'processing', routedTo: 'razorpay' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com', idempotencyKey: 'my-key-1' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('my-key-1');
  });

  it('includes payerVpa only when provided', async () => {
    mockFetchOnce(201, { paymentId: 'p1', status: 'processing', routedTo: 'razorpay' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com', payerVpa: 'name@ybl' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).payerVpa).toBe('name@ybl');
  });

  it('throws PayHubError with the status and body on a non-2xx response', async () => {
    mockFetchOnce(400, { error: 'amount, currency, paymentMethod, customerEmail are required' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    try {
      await client.createPayment({ amount: 0, currency: 'INR', customerEmail: 'a@b.com' });
      fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayHubError);
      expect((err as PayHubError).status).toBe(400);
      expect((err as PayHubError).message).toBe('amount, currency, paymentMethod, customerEmail are required');
    }
  });

  it('throws PayHubError (not a silent undefined) when a 2xx response body is not valid JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token in JSON');
      },
    });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    try {
      await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com' });
      fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayHubError);
      expect((err as PayHubError).status).toBe(200);
      expect((err as PayHubError).message).toContain('non-JSON response');
    }
  });

  it('throws PayHubNetworkError (not a raw fetch TypeError) when the request never reaches the server', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = new PayHubClient({ baseUrl: 'http://localhost:1' });

    try {
      await client.createPayment({ amount: 100000, currency: 'INR', customerEmail: 'a@b.com' });
      fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayHubNetworkError);
      expect(err).not.toBeInstanceOf(PayHubError);
      expect((err as PayHubNetworkError).message).toContain('Could not reach PayHub');
      expect((err as PayHubNetworkError).cause).toBeInstanceOf(TypeError);
    }
  });
});

describe('PayHubClient.getPayment / getPaymentEvents', () => {
  it('GETs the right URL and returns the parsed body', async () => {
    mockFetchOnce(200, { paymentId: 'p1', status: 'succeeded', processor: 'cashfree', amount: 100000, currency: 'INR' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000/' }); // trailing slash should be stripped

    const result = await client.getPayment('p1');

    expect(result.status).toBe('succeeded');
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments/p1');
  });

  it('fetches the event timeline', async () => {
    mockFetchOnce(200, [{ state: 'created', timestamp: '2026-01-01T00:00:00Z' }]);
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    const events = await client.getPaymentEvents('p1');
    expect(events).toHaveLength(1);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments/p1/events');
  });
});

describe('PayHubClient.listPayments', () => {
  it('builds the query string from limit/status', async () => {
    mockFetchOnce(200, []);
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.listPayments({ limit: 10, status: 'failed' });

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments?limit=10&status=failed');
  });

  it('omits the query string entirely when no options are given', async () => {
    mockFetchOnce(200, []);
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.listPayments();

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments');
  });

  it('sends an explicit limit of 0 rather than silently dropping it (0 is falsy but still a real value)', async () => {
    mockFetchOnce(200, []);
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await client.listPayments({ limit: 0 });

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:3000/payments?limit=0');
  });
});

describe('PayHubClient.getReconciliation', () => {
  it('fetches the reconciliation report', async () => {
    mockFetchOnce(200, { perProcessor: [], overall: { totalPayments: 0, succeeded: 0, failed: 0, inFlight: 0, successRate: null } });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    const report = await client.getReconciliation();
    expect(report.overall.totalPayments).toBe(0);
  });
});

describe('PayHubClient.waitForTerminalStatus', () => {
  it('returns immediately if the payment is already terminal', async () => {
    mockFetchOnce(200, { paymentId: 'p1', status: 'succeeded', amount: 100000, currency: 'INR' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    const result = await client.waitForTerminalStatus('p1');
    expect(result.status).toBe('succeeded');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('polls until a terminal status is reached', async () => {
    mockFetchOnce(200, { paymentId: 'p1', status: 'processing', amount: 100000, currency: 'INR' });
    mockFetchOnce(200, { paymentId: 'p1', status: 'retrying', amount: 100000, currency: 'INR' });
    mockFetchOnce(200, { paymentId: 'p1', status: 'succeeded', amount: 100000, currency: 'INR' });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    const result = await client.waitForTerminalStatus('p1', { pollIntervalMs: 1 });
    expect(result.status).toBe('succeeded');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws PayHubTimeoutError if the timeout elapses before a terminal status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ paymentId: 'p1', status: 'processing', amount: 100000, currency: 'INR' }),
    });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    await expect(client.waitForTerminalStatus('p1', { timeoutMs: 5, pollIntervalMs: 3 })).rejects.toThrow(PayHubTimeoutError);
  });

  it('clamps a too-small pollIntervalMs to a sane floor instead of hammering the server in a tight loop', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ paymentId: 'p1', status: 'processing', amount: 100000, currency: 'INR' }),
    });
    const client = new PayHubClient({ baseUrl: 'http://localhost:3000' });

    // pollIntervalMs: 0 previously fired ~19 requests in 500ms with no clamp.
    const promise = client.waitForTerminalStatus('p1', { timeoutMs: 500, pollIntervalMs: 0 }).catch(() => undefined);
    await promise;

    expect((global.fetch as jest.Mock).mock.calls.length).toBeLessThan(5);
  });
});
