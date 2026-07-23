import { classifyVpaHandle } from '../src/core/upiHandles';

describe('classifyVpaHandle', () => {
  it('classifies Google Pay partner-bank handles', () => {
    expect(classifyVpaHandle('nayan@okhdfcbank')).toEqual({ handle: 'okhdfcbank', psp: 'google_pay' });
    expect(classifyVpaHandle('nayan@okaxis')).toEqual({ handle: 'okaxis', psp: 'google_pay' });
    expect(classifyVpaHandle('nayan@oksbi')).toEqual({ handle: 'oksbi', psp: 'google_pay' });
    expect(classifyVpaHandle('nayan@okicici')).toEqual({ handle: 'okicici', psp: 'google_pay' });
  });

  it('classifies PhonePe partner-bank handles', () => {
    expect(classifyVpaHandle('nayan@ybl')).toEqual({ handle: 'ybl', psp: 'phonepe' });
    expect(classifyVpaHandle('nayan@ibl')).toEqual({ handle: 'ibl', psp: 'phonepe' });
    expect(classifyVpaHandle('nayan@axl')).toEqual({ handle: 'axl', psp: 'phonepe' });
  });

  it('classifies Paytm handles', () => {
    expect(classifyVpaHandle('nayan@paytm')).toEqual({ handle: 'paytm', psp: 'paytm' });
  });

  it('classifies Amazon Pay handles', () => {
    expect(classifyVpaHandle('nayan@apl')).toEqual({ handle: 'apl', psp: 'amazon_pay' });
  });

  it('classifies BHIM handles', () => {
    expect(classifyVpaHandle('nayan@upi')).toEqual({ handle: 'upi', psp: 'bhim' });
  });

  it('is case-insensitive on the handle', () => {
    expect(classifyVpaHandle('nayan@OKHDFCBANK')).toEqual({ handle: 'okhdfcbank', psp: 'google_pay' });
  });

  it('classifies an unrecognized handle as other', () => {
    expect(classifyVpaHandle('nayan@somebank')).toEqual({ handle: 'somebank', psp: 'other' });
  });

  it('returns undefined for a malformed or absent VPA', () => {
    expect(classifyVpaHandle('not-a-vpa')).toBeUndefined();
    expect(classifyVpaHandle('')).toBeUndefined();
    expect(classifyVpaHandle(undefined)).toBeUndefined();
  });
});
