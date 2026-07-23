/**
 * Canonical UPI decline-code taxonomy.
 *
 * Real UPI failures fall into well-documented categories used consistently across
 * NPCI's UPI procedural guidelines and every PSP's integration docs (Razorpay,
 * Cashfree, PayU, etc. all map their own error codes onto the same underlying
 * concepts). PayHub's adapters/normalizer map each processor's native error
 * format onto this shared vocabulary, so the routing engine reasons about
 * declines in processor-agnostic, UPI-domain terms rather than ad-hoc strings.
 *
 * The key insight this taxonomy encodes — and the one a naive "is it a gateway
 * error -> retry" model misses — is *scope*: a decline can be about the
 * processor's own infra, NPCI's shared network, or the customer's own bank/VPA.
 * Failing over to a different processor only helps for the first two. If the
 * customer's issuing bank is down, Cashfree reaches the exact same bank via
 * NPCI that Razorpay does — switching processor changes nothing.
 */

export type DeclineScope =
  /** The processor's (Razorpay/Cashfree) own API/gateway infra. Failover plausibly helps. */
  | 'processor'
  /** NPCI's shared switch/network (e.g. peak-time congestion). Processors may
   *  route through different NPCI sponsor-bank paths, so failover may help. */
  | 'npci_network'
  /** The customer's own issuing bank or VPA state. Same bank regardless of
   *  processor — failover cannot help; only the customer can fix this
   *  (different VPA, more balance, correct MPIN, etc). */
  | 'bank_or_vpa'
  /** A deliberate customer action (cancelled, dropped) rather than a technical failure. */
  | 'customer_action';

export interface DeclineDefinition {
  code: string;
  description: string;
  scope: DeclineScope;
}

/**
 * NOTE ON FIDELITY: these reflect the real, well-known UPI decline categories
 * (bank-down, invalid VPA, limit exceeded, wrong MPIN, fraud hold, NPCI
 * congestion) that show up across NPCI's and every PSP's own documentation.
 * The string codes are PayHub's own internal vocabulary, not a verbatim
 * reproduction of NPCI's internal numeric RC table — see webhooks/normalizer.ts
 * for how each processor's actual error codes map onto these.
 */
export const DECLINE_CODES: Record<string, DeclineDefinition> = {
  PROCESSOR_GATEWAY_ERROR: {
    code: 'PROCESSOR_GATEWAY_ERROR',
    description: "The processor's own API/gateway failed or timed out.",
    scope: 'processor',
  },
  PROCESSOR_UNAVAILABLE: {
    code: 'PROCESSOR_UNAVAILABLE',
    description: 'The processor is throttling or temporarily unavailable.',
    scope: 'processor',
  },
  GATEWAY_TIMEOUT: {
    code: 'GATEWAY_TIMEOUT',
    description: 'The request to the processor timed out.',
    scope: 'processor',
  },
  PSP_THROTTLED: {
    code: 'PSP_THROTTLED',
    description: 'The processor is rate-limiting requests.',
    scope: 'processor',
  },
  NPCI_NETWORK_CONGESTION: {
    code: 'NPCI_NETWORK_CONGESTION',
    description: "NPCI's shared switch is congested (common during known peak windows, e.g. month-end salary days).",
    scope: 'npci_network',
  },
  NPCI_TIMEOUT: {
    code: 'NPCI_TIMEOUT',
    description: 'The request timed out at the NPCI switch rather than at the processor.',
    scope: 'npci_network',
  },
  ISSUING_BANK_UNAVAILABLE: {
    code: 'ISSUING_BANK_UNAVAILABLE',
    description: "The customer's own issuing bank/PSP is down. Every processor reaches the same bank via NPCI, so failover cannot help.",
    scope: 'bank_or_vpa',
  },
  INVALID_VPA: {
    code: 'INVALID_VPA',
    description: 'The VPA does not exist or is malformed.',
    scope: 'bank_or_vpa',
  },
  INSUFFICIENT_FUNDS: {
    code: 'INSUFFICIENT_FUNDS',
    description: "The customer's account balance is insufficient.",
    scope: 'bank_or_vpa',
  },
  TXN_LIMIT_EXCEEDED: {
    code: 'TXN_LIMIT_EXCEEDED',
    description: 'The per-transaction UPI limit was exceeded.',
    scope: 'bank_or_vpa',
  },
  DAILY_LIMIT_EXCEEDED: {
    code: 'DAILY_LIMIT_EXCEEDED',
    description: "The customer's daily UPI transaction limit was exceeded.",
    scope: 'bank_or_vpa',
  },
  INVALID_MPIN: {
    code: 'INVALID_MPIN',
    description: 'The customer entered an incorrect UPI PIN.',
    scope: 'bank_or_vpa',
  },
  FRAUD_SUSPECTED: {
    code: 'FRAUD_SUSPECTED',
    description: "The issuing bank's risk engine declined the transaction.",
    scope: 'bank_or_vpa',
  },
  DUPLICATE_TRANSACTION: {
    code: 'DUPLICATE_TRANSACTION',
    description: 'NPCI flagged this as a duplicate of a recent transaction.',
    scope: 'bank_or_vpa',
  },
  INVALID_AMOUNT: {
    code: 'INVALID_AMOUNT',
    description: 'The requested amount is invalid for this VPA/account.',
    scope: 'bank_or_vpa',
  },
  ACCOUNT_BLOCKED: {
    code: 'ACCOUNT_BLOCKED',
    description: "The customer's account is blocked or frozen.",
    scope: 'bank_or_vpa',
  },
  CUSTOMER_CANCELLED: {
    code: 'CUSTOMER_CANCELLED',
    description: 'The customer cancelled or dismissed the collect request.',
    scope: 'customer_action',
  },
  USER_DROPPED: {
    code: 'USER_DROPPED',
    description: 'The customer abandoned the payment flow before completing it.',
    scope: 'customer_action',
  },
};

const RETRYABLE_SCOPES: ReadonlySet<DeclineScope> = new Set(['processor', 'npci_network']);

export function getDeclineDefinition(code: string | undefined): DeclineDefinition | undefined {
  if (!code) return undefined;
  return DECLINE_CODES[code];
}

export function declineScope(code: string | undefined): DeclineScope | undefined {
  return getDeclineDefinition(code)?.scope;
}

/**
 * Whether failing over to a different PROCESSOR could plausibly resolve this
 * decline. Unknown codes default to false (fail fast) — a safe default, since
 * blindly retrying an unrecognized failure risks wasted attempts or worse.
 */
export function isRetryableScope(code: string | undefined): boolean {
  const scope = declineScope(code);
  if (!scope) return false;
  return RETRYABLE_SCOPES.has(scope);
}
