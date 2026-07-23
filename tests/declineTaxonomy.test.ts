import { DECLINE_CODES, declineScope, getDeclineDefinition, isRetryableScope } from '../src/core/declineTaxonomy';

describe('DECLINE_CODES', () => {
  it('every defined code has a non-empty description and a valid scope', () => {
    const validScopes = new Set(['processor', 'npci_network', 'bank_or_vpa', 'customer_action']);
    for (const def of Object.values(DECLINE_CODES)) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(validScopes.has(def.scope)).toBe(true);
    }
  });
});

describe('getDeclineDefinition', () => {
  it('returns the definition for a known code', () => {
    expect(getDeclineDefinition('INVALID_VPA')).toEqual({
      code: 'INVALID_VPA',
      description: expect.any(String),
      scope: 'bank_or_vpa',
    });
  });

  it('returns undefined for an unknown code', () => {
    expect(getDeclineDefinition('NOT_A_REAL_CODE')).toBeUndefined();
  });

  it('returns undefined when no code is given', () => {
    expect(getDeclineDefinition(undefined)).toBeUndefined();
  });
});

describe('declineScope', () => {
  it('classifies processor-side issues as processor scope', () => {
    expect(declineScope('PROCESSOR_GATEWAY_ERROR')).toBe('processor');
    expect(declineScope('PROCESSOR_UNAVAILABLE')).toBe('processor');
    expect(declineScope('GATEWAY_TIMEOUT')).toBe('processor');
    expect(declineScope('PSP_THROTTLED')).toBe('processor');
  });

  it('classifies NPCI network issues as npci_network scope', () => {
    expect(declineScope('NPCI_NETWORK_CONGESTION')).toBe('npci_network');
    expect(declineScope('NPCI_TIMEOUT')).toBe('npci_network');
  });

  it('classifies customer bank/VPA state as bank_or_vpa scope', () => {
    expect(declineScope('ISSUING_BANK_UNAVAILABLE')).toBe('bank_or_vpa');
    expect(declineScope('INVALID_VPA')).toBe('bank_or_vpa');
    expect(declineScope('INSUFFICIENT_FUNDS')).toBe('bank_or_vpa');
    expect(declineScope('TXN_LIMIT_EXCEEDED')).toBe('bank_or_vpa');
    expect(declineScope('DAILY_LIMIT_EXCEEDED')).toBe('bank_or_vpa');
    expect(declineScope('INVALID_MPIN')).toBe('bank_or_vpa');
    expect(declineScope('FRAUD_SUSPECTED')).toBe('bank_or_vpa');
    expect(declineScope('DUPLICATE_TRANSACTION')).toBe('bank_or_vpa');
  });

  it('classifies deliberate customer actions as customer_action scope', () => {
    expect(declineScope('CUSTOMER_CANCELLED')).toBe('customer_action');
    expect(declineScope('USER_DROPPED')).toBe('customer_action');
  });

  it('returns undefined for unknown or absent codes', () => {
    expect(declineScope('UNKNOWN_CODE')).toBeUndefined();
    expect(declineScope(undefined)).toBeUndefined();
  });
});

describe('isRetryableScope', () => {
  it('is true only for processor and npci_network scopes', () => {
    expect(isRetryableScope('PROCESSOR_GATEWAY_ERROR')).toBe(true);
    expect(isRetryableScope('NPCI_NETWORK_CONGESTION')).toBe(true);
  });

  it('is false for bank_or_vpa and customer_action scopes', () => {
    expect(isRetryableScope('INVALID_VPA')).toBe(false);
    expect(isRetryableScope('CUSTOMER_CANCELLED')).toBe(false);
  });

  it('is false for unknown or absent codes (safe default)', () => {
    expect(isRetryableScope('NOT_A_REAL_CODE')).toBe(false);
    expect(isRetryableScope(undefined)).toBe(false);
  });
});
