import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * Regression tests for a real stored-XSS incident: a validly-signed webhook
 * with error_reason set to an HTML tag got rendered as a genuine injected DOM
 * element in the dashboard (public/dashboard.html), because event.reason (and
 * other API-sourced fields) were interpolated into innerHTML unescaped.
 *
 * dashboard.html is a static asset outside the TypeScript/Jest pipeline, so
 * these tests (a) extract and directly exercise the escapeHtml() function's
 * behavior, and (b) statically assert that every known risky field is
 * actually wrapped in an escapeHtml() call in the source, so a future edit
 * that accidentally removes the wrapper fails CI instead of silently
 * reintroducing the vulnerability.
 */
const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

function loadEscapeHtml(): (value: unknown) => string {
  const match = dashboardSource.match(/function escapeHtml\(value\) \{[\s\S]*?\n\s*\}/);
  if (!match) throw new Error('escapeHtml function not found in dashboard.html — did it get renamed/removed?');
  const context: { escapeHtml?: (value: unknown) => string } = {};
  vm.createContext(context);
  vm.runInContext(`${match[0]}`, context);
  return context.escapeHtml!;
}

describe('dashboard.html escapeHtml()', () => {
  const escapeHtml = loadEscapeHtml();

  it('escapes the exact payload from the real incident (an HTML tag in a decline reason)', () => {
    const payload = '<b style=color:red id=xss-marker>injected-xss-marker</b>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<b');
    expect(escaped).toBe('&lt;b style=color:red id=xss-marker&gt;injected-xss-marker&lt;/b&gt;');
  });

  it('escapes script tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes (so it is also safe inside an HTML attribute context)', () => {
    expect(escapeHtml(`"onmouseover="alert(1)`)).toBe('&quot;onmouseover=&quot;alert(1)');
    expect(escapeHtml(`'onmouseover='alert(1)`)).toBe('&#39;onmouseover=&#39;alert(1)');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('returns an empty string for null/undefined rather than the literal text "null"/"undefined"', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('passes plain, safe text through unchanged', () => {
    expect(escapeHtml('razorpay')).toBe('razorpay');
    expect(escapeHtml('BANK_SERVER_DOWN')).toBe('BANK_SERVER_DOWN');
  });
});

describe('dashboard.html source: every API-sourced field must be escaped before rendering', () => {
  // These are the exact fields that come from PayHub's own API responses
  // (as opposed to labels/literals the dashboard authors wrote themselves).
  // If any of these ever appears interpolated as `${x.field}` without an
  // escapeHtml(...) wrapper, that's the same class of bug as the incident.
  const riskyInterpolations = [
    'p.paymentId',
    'p.status',
    'p.processor',
    'p.retriedFrom',
    'p.upiPsp',
    'e.state',
    'e.processor',
    'e.reason',
    'e.declineScope',
  ];

  it.each(riskyInterpolations)('%s is passed through escapeHtml() somewhere in the source', (field) => {
    // Positive assertion (escapeHtml(field) appears) rather than trying to
    // prove a negative with a regex — a field can legitimately appear as a
    // bare `${field}` inside a ternary *condition* (e.g. `${e.reason ? ... :
    // ''}`), which isn't itself an unescaped render; what matters is that the
    // actual rendered value is wrapped.
    expect(dashboardSource).toContain(`escapeHtml(${field})`);
  });
});
