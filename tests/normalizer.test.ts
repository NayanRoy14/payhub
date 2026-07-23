import { normalizeCashfreeEvent, normalizeRazorpayEvent, normalizeStripeEvent } from '../src/webhooks/normalizer';

describe('normalizeRazorpayEvent', () => {
  it('normalizes a payment.captured event to succeeded', () => {
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_123', order_id: 'order_abc', status: 'captured' },
        },
      },
    };

    const result = normalizeRazorpayEvent(payload);
    expect(result).toEqual({
      processor: 'razorpay',
      processorRef: 'order_abc',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });

  it('normalizes a payment.failed event with a mapped decline code', () => {
    const payload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_456', order_id: 'order_def', status: 'failed', error_reason: 'gateway_error' },
        },
      },
    };

    const result = normalizeRazorpayEvent(payload);
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('BANK_SERVER_DOWN');
    expect(result.processorRef).toBe('order_def');
  });

  it('passes through an unmapped error reason, upper-cased', () => {
    const payload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_789', order_id: 'order_ghi', status: 'failed', error_reason: 'some_unmapped_reason' },
        },
      },
    };

    const result = normalizeRazorpayEvent(payload);
    expect(result.declineCode).toBe('SOME_UNMAPPED_REASON');
  });

  it('treats an unrecognized event as processing', () => {
    const payload = {
      event: 'order.created',
      payload: { order: { entity: { id: 'order_jkl', status: 'created' } } },
    };

    const result = normalizeRazorpayEvent(payload);
    expect(result.status).toBe('processing');
  });
});

describe('normalizeStripeEvent', () => {
  it('normalizes a succeeded PaymentIntent', () => {
    const payload = {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', status: 'succeeded' } },
    };

    const result = normalizeStripeEvent(payload);
    expect(result).toEqual({
      processor: 'stripe',
      processorRef: 'pi_123',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });

  it('normalizes a failed PaymentIntent with a mapped decline code', () => {
    const payload = {
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_456',
          status: 'requires_payment_method',
          last_payment_error: { code: 'processing_error' },
        },
      },
    };

    const result = normalizeStripeEvent(payload);
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('BANK_SERVER_DOWN');
  });

  it('treats a still-processing PaymentIntent as processing', () => {
    const payload = {
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_789', status: 'processing' } },
    };

    const result = normalizeStripeEvent(payload);
    expect(result.status).toBe('processing');
  });
});

describe('normalizeCashfreeEvent', () => {
  it('normalizes a PAYMENT_SUCCESS_WEBHOOK event', () => {
    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: 'order_1' }, payment: { payment_status: 'SUCCESS' } },
    };

    const result = normalizeCashfreeEvent(payload);
    expect(result).toEqual({
      processor: 'cashfree',
      processorRef: 'order_1',
      status: 'succeeded',
      declineCode: undefined,
      raw: payload,
    });
  });

  it('normalizes a PAYMENT_FAILED_WEBHOOK event with a mapped decline code', () => {
    const payload = {
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: {
        order: { order_id: 'order_2' },
        payment: { payment_status: 'FAILED', error_details: { error_code: 'gateway_error' } },
      },
    };

    const result = normalizeCashfreeEvent(payload);
    expect(result.status).toBe('failed');
    expect(result.declineCode).toBe('BANK_SERVER_DOWN');
    expect(result.processorRef).toBe('order_2');
  });

  it('treats PAYMENT_USER_DROPPED_WEBHOOK as failed', () => {
    const payload = {
      type: 'PAYMENT_USER_DROPPED_WEBHOOK',
      data: { order: { order_id: 'order_3' }, payment: { payment_status: 'USER_DROPPED' } },
    };

    const result = normalizeCashfreeEvent(payload);
    expect(result.status).toBe('failed');
  });

  it('passes through an unmapped error code, upper-cased', () => {
    const payload = {
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: {
        order: { order_id: 'order_4' },
        payment: { payment_status: 'FAILED', error_details: { error_code: 'some_unmapped_code' } },
      },
    };

    const result = normalizeCashfreeEvent(payload);
    expect(result.declineCode).toBe('SOME_UNMAPPED_CODE');
  });

  it('treats an unrecognized event as processing', () => {
    const payload = {
      type: 'ORDER_ACTIVE_WEBHOOK',
      data: { order: { order_id: 'order_5' }, payment: {} },
    };

    const result = normalizeCashfreeEvent(payload);
    expect(result.status).toBe('processing');
  });
});
