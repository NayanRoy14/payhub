/**
 * Classifies a UPI VPA (Virtual Payment Address, e.g. "name@okhdfcbank") by its
 * handle suffix to identify which UPI-enabled app/PSP issued it. These handle
 * -> PSP mappings are publicly documented and well known across the UPI
 * ecosystem (NPCI's own PSP directory, every UPI app's onboarding docs).
 *
 * This is informational, not something PayHub can act on to literally "switch"
 * a customer between apps — the customer's own UPI app handles their side of
 * the transaction. What it enables is *reasoning*: a decline scoped to
 * 'bank_or_vpa' (see declineTaxonomy.ts) is really about the specific bank
 * behind this handle, not about PayHub's processor choice, so the routing
 * engine and reporting can say *why* failover won't help instead of just
 * failing fast silently.
 */
export type UpiPsp = 'google_pay' | 'phonepe' | 'paytm' | 'amazon_pay' | 'bhim' | 'other';

const HANDLE_TO_PSP: Record<string, UpiPsp> = {
  // Google Pay's partner-bank handles
  okhdfcbank: 'google_pay',
  okaxis: 'google_pay',
  oksbi: 'google_pay',
  okicici: 'google_pay',
  // PhonePe's partner-bank handles
  ybl: 'phonepe',
  ibl: 'phonepe',
  axl: 'phonepe',
  // Paytm
  paytm: 'paytm',
  pty: 'paytm',
  // Amazon Pay
  apl: 'amazon_pay',
  // BHIM (NPCI's own reference app)
  upi: 'bhim',
};

export interface VpaClassification {
  handle: string;
  psp: UpiPsp;
}

export function classifyVpaHandle(vpa: string | undefined): VpaClassification | undefined {
  if (!vpa || !vpa.includes('@')) return undefined;
  const handle = vpa.split('@')[1]?.toLowerCase().trim();
  if (!handle) return undefined;
  return { handle, psp: HANDLE_TO_PSP[handle] ?? 'other' };
}
