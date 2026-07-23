import crypto from 'crypto';
import {
  buildPayload,
  notifyMerchant,
  resetFetchImpl,
  resetSleepFn,
  setFetchImpl,
  setSleepFn,
  signPayload,
} from '../src/webhooks/merchantNotifier';

function fakeDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    paymentId: 'pay_123',
    amount: 100000,
    currency: 'INR',
    upiPsp: 'phonepe',
    retriedFrom: undefined,
    attempts: [{ processor: 'cashfree', status: 'succeeded', declineCode: undefined, declineScope: undefined }],
    ...overrides,
  } as any;
}

function fakeResponse(ok: boolean, status = ok ? 200 : 500): Response {
  return { ok, status } as Response;
}

describe('merchantNotifier', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetFetchImpl();
    resetSleepFn();
    jest.clearAllMocks();
  });

  describe('buildPayload', () => {
    it('builds a payment.succeeded payload from the last attempt, without decline fields', () => {
      const doc = fakeDoc();
      const payload = buildPayload(doc, 'payment.succeeded');

      expect(payload).toMatchObject({
        event: 'payment.succeeded',
        paymentId: 'pay_123',
        status: 'succeeded',
        processor: 'cashfree',
        amount: 100000,
        currency: 'INR',
        upiPsp: 'phonepe',
      });
      expect(payload.declineCode).toBeUndefined();
      expect(payload.declineScope).toBeUndefined();
      expect(typeof payload.timestamp).toBe('string');
    });

    it('builds a payment.failed payload carrying the last attempt\'s decline info', () => {
      const doc = fakeDoc({
        retriedFrom: 'razorpay',
        attempts: [
          { processor: 'razorpay', status: 'failed', declineCode: 'SERVER_ERROR', declineScope: 'processor' },
          { processor: 'cashfree', status: 'failed', declineCode: 'GATEWAY_TIMEOUT', declineScope: 'processor' },
        ],
      });
      const payload = buildPayload(doc, 'payment.failed');

      expect(payload.status).toBe('failed');
      expect(payload.processor).toBe('cashfree'); // last attempt, not currentProcessor
      expect(payload.retriedFrom).toBe('razorpay');
      expect(payload.declineCode).toBe('GATEWAY_TIMEOUT');
      expect(payload.declineScope).toBe('processor');
    });
  });

  describe('signPayload', () => {
    it('produces an HMAC-SHA256 hex digest matching a manual computation', () => {
      const body = '{"a":1}';
      const secret = 'shh';
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      expect(signPayload(body, secret)).toBe(expected);
    });
  });

  describe('notifyMerchant', () => {
    beforeEach(() => {
      process.env.MERCHANT_WEBHOOK_URL = 'https://merchant.example.com/webhook';
      process.env.MERCHANT_WEBHOOK_SECRET = 'test-secret';
      setSleepFn(async () => {}); // collapse backoff to instant
    });

    it('does nothing when MERCHANT_WEBHOOK_URL is not configured', async () => {
      delete process.env.MERCHANT_WEBHOOK_URL;
      const fetchMock = jest.fn();
      setFetchImpl(fetchMock as any);

      await notifyMerchant(fakeDoc(), 'payment.succeeded');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('delivers a signed POST on the first attempt when the endpoint responds 2xx', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeResponse(true));
      setFetchImpl(fetchMock as any);

      await notifyMerchant(fakeDoc(), 'payment.succeeded');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://merchant.example.com/webhook');
      expect(init.method).toBe('POST');
      expect(init.headers['X-PayHub-Event']).toBe('payment.succeeded');
      expect(init.headers['X-PayHub-Signature']).toBe(signPayload(init.body, 'test-secret'));
    });

    it('retries on failure and succeeds once the endpoint recovers', async () => {
      const fetchMock = jest
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(fakeResponse(false, 500))
        .mockResolvedValueOnce(fakeResponse(true));
      setFetchImpl(fetchMock as any);

      await notifyMerchant(fakeDoc(), 'payment.failed');

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting all retry attempts', async () => {
      const fetchMock = jest.fn().mockResolvedValue(fakeResponse(false, 503));
      setFetchImpl(fetchMock as any);

      await expect(notifyMerchant(fakeDoc(), 'payment.failed')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(4); // MAX_ATTEMPTS
    });
  });
});
