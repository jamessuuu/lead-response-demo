import { describe, expect, it } from 'vitest';
import { redactDeep } from '../src/index.ts';

// Real bug, real fixture: the first attempt at redacting execution.json
// only caught the E.164 form ("+15125550134"), which "Normalize Lead"
// produces — but the RAW webhook payload, one node earlier in the same
// execution, carries the pre-normalization NANP form ("(512) 555-0134"),
// and that copy of the number sat unmasked in a committed recording for
// one capture cycle. Every case below is a shape that has actually
// appeared in this repo's own captured data, not a hypothetical.

describe('redactDeep — phone masking', () => {
  it('masks an E.164 phone anywhere in a string', () => {
    expect(redactDeep('call +15125550134 now')).toBe('call +1512•••0134 now');
  });

  it('masks the NANP display form the raw webhook payload actually sends', () => {
    expect(redactDeep('(512) 555-0134')).toBe('+1512•••0134');
  });

  it('masks dashed, dotted, and spaced NANP forms the same way', () => {
    expect(redactDeep('512-555-0134')).toBe('+1512•••0134');
    expect(redactDeep('512.555.0134')).toBe('+1512•••0134');
    expect(redactDeep('512 555 0134')).toBe('+1512•••0134');
  });

  it('masks both the E.164 and NANP copies of the same number in one document', () => {
    const raw = { webhookInput: { phone: '(512) 555-0134' }, normalized: { phone: '+15125550134' } };
    expect(redactDeep(raw)).toEqual({ webhookInput: { phone: '+1512•••0134' }, normalized: { phone: '+1512•••0134' } });
  });

  it('recurses through nested objects and arrays', () => {
    const raw = { a: [{ b: 'phone: +15125550134' }, '(512) 555-0134'] };
    expect(redactDeep(raw)).toEqual({ a: [{ b: 'phone: +1512•••0134' }, '+1512•••0134'] });
  });

  it('leaves non-phone-shaped digit runs alone — ISO timestamps, versions, ids', () => {
    const safe = {
      startedAt: '2026-08-29T03:01:41.228+08:00',
      n8nVersion: '2.36.8',
      executionId: '1',
      workflowSha256: '0'.repeat(64),
      unixMs: 1787941556527,
    };
    expect(redactDeep(safe)).toEqual(safe);
  });

  it('passes non-string, non-object values through untouched', () => {
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(true)).toBe(true);
  });
});
