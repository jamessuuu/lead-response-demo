import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PORTED_FROM_JSCODE_SHA256, jsCodeOf, normalizeLead } from '../src/index.ts';
import { topology } from './fixtures.ts';

const NOW = '2026-08-29T02:04:17.006Z';

describe('normalizeLead (port of the Normalize Lead code node)', () => {
  it('is pinned to the jsCode in content/workflow.json by hash', () => {
    const source = jsCodeOf(topology, 'Normalize Lead');
    const hash = createHash('sha256').update(source, 'utf8').digest('hex');
    expect(hash).toBe(PORTED_FROM_JSCODE_SHA256);
  });

  it('handles the runbook curl payload exactly', () => {
    const out = normalizeLead(
      { full_name: 'Test Lead', email: 'test@example.com', phone: '(512) 555-0142', service: 'botox', source: 'runbook-test' },
      NOW,
    );
    expect(out).toEqual({
      firstName: 'Test',
      lastName: 'Lead',
      email: 'test@example.com',
      phone: '+15125550142',
      source: 'runbook-test',
      interest: 'botox',
      receivedAt: NOW,
    });
  });

  it('reads the webhook body wrapper when present', () => {
    const out = normalizeLead({ headers: {}, body: { firstName: 'Ada', email: 'ADA@EXAMPLE.COM' } }, NOW);
    expect(out.firstName).toBe('Ada');
    expect(out.email).toBe('ada@example.com');
  });

  it('prefers explicit first/last names over a split full name', () => {
    const out = normalizeLead({ first_name: 'Ada', last_name: 'Lovelace', name: 'Someone Else' }, NOW);
    expect(out.firstName).toBe('Ada');
    expect(out.lastName).toBe('Lovelace');
  });

  it('splits a multi-word full name into first + rest', () => {
    const out = normalizeLead({ name: 'Mary Anne  Smith' }, NOW);
    expect(out.firstName).toBe('Mary');
    expect(out.lastName).toBe('Anne Smith');
  });

  it('normalizes phones the way the node does', () => {
    expect(normalizeLead({ phone: '512-555-0142' }, NOW).phone).toBe('+15125550142');
    expect(normalizeLead({ phone: '1 (512) 555-0142' }, NOW).phone).toBe('+15125550142');
    expect(normalizeLead({ phone: '+44 20 7946 0958' }, NOW).phone).toBe('+442079460958');
    expect(normalizeLead({ mobile: '5550142' }, NOW).phone).toBe('5550142');
    expect(normalizeLead({}, NOW).phone).toBe('');
  });

  it('falls back to the node defaults', () => {
    const out = normalizeLead({}, NOW);
    expect(out.firstName).toBe('there');
    expect(out.lastName).toBe('');
    expect(out.source).toBe('website-form');
    expect(out.interest).toBe('a treatment');
    expect(out.email).toBe('');
  });

  it('treats blank strings as missing, and trims', () => {
    const out = normalizeLead({ first_name: '   ', name: '  Grace Hopper ', email: ' g@example.com ' }, NOW);
    expect(out.firstName).toBe('Grace');
    expect(out.email).toBe('g@example.com');
  });

  it('coerces non-string scalars like the node (String(...))', () => {
    const out = normalizeLead({ phone: 5125550142, service: 0 }, NOW);
    expect(out.phone).toBe('+15125550142');
    expect(out.interest).toBe('0');
  });
});
