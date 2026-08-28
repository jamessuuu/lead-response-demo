import { describe, expect, it } from 'vitest';
import {
  MissingValueError,
  UnsupportedExpressionError,
  applyPlaceholders,
  evaluate,
  getPath,
  renderTemplate,
} from '../src/index.ts';

const ctx = {
  json: { contact: { id: 'c_1' }, conversations: [{ lastMessageDirection: 'outbound' }] },
  nodeOutput: (name: string) => {
    if (name === 'Normalize Lead') return { firstName: 'Ada', interest: 'lip filler', phone: '+15125550142' };
    throw new Error(`no output for ${name}`);
  },
};

describe('getPath', () => {
  it('walks dotted paths and indexes', () => {
    expect(getPath(ctx.json, 'contact.id')).toBe('c_1');
    expect(getPath(ctx.json, 'conversations[0].lastMessageDirection')).toBe('outbound');
    expect(getPath(ctx.json, 'missing.deep')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });
});

describe('evaluate', () => {
  it('resolves $json paths', () => {
    expect(evaluate('$json.contact.id', ctx)).toBe('c_1');
  });
  it("resolves $('Node').item.json paths", () => {
    expect(evaluate("$('Normalize Lead').item.json.firstName", ctx)).toBe('Ada');
  });
  it('refuses anything else instead of guessing', () => {
    expect(() => evaluate('$json.a ? 1 : 2', ctx)).toThrow(UnsupportedExpressionError);
    expect(() => evaluate('Date.now()', ctx)).toThrow(UnsupportedExpressionError);
    expect(() => evaluate('$node["x"].json.y', ctx)).toThrow(UnsupportedExpressionError);
  });
});

describe('renderTemplate', () => {
  it('leaves literal (non-=) parameters untouched, braces included', () => {
    expect(renderTemplate('SMS + email {{ not an expression }}', ctx)).toBe('SMS + email {{ not an expression }}');
  });
  it('interpolates every {{ }} in an expression parameter', () => {
    const out = renderTemplate("=Hi {{ $('Normalize Lead').item.json.firstName }} about {{ $('Normalize Lead').item.json.interest }} ({{ $json.contact.id }})", ctx);
    expect(out).toBe('Hi Ada about lip filler (c_1)');
  });
  it('renders the exact SMS template from workflow.json', () => {
    const tpl =
      '={\n  "type": "SMS",\n  "contactId": "{{ $json.contact.id }}",\n  "message": "Hi {{ $(\'Normalize Lead\').item.json.firstName }}, it\'s Mia at Radiant Aesthetics — thanks for asking about {{ $(\'Normalize Lead\').item.json.interest }}. I can get you booked this week: https://REPLACE_BOOKING_LINK.example — or just reply here and I\'ll sort it for you."\n}';
    const parsed = JSON.parse(applyPlaceholders(renderTemplate(tpl, ctx), { REPLACE_BOOKING_LINK: 'book.example-spa' })) as Record<string, string>;
    expect(parsed.type).toBe('SMS');
    expect(parsed.contactId).toBe('c_1');
    expect(parsed.message).toContain('https://book.example-spa.example');
    expect(parsed.message.startsWith("Hi Ada, it's Mia")).toBe(true);
  });
  it('fails loudly on an undefined value instead of rendering a blank', () => {
    expect(() => renderTemplate('={{ $json.nothing.here }}', ctx)).toThrow(MissingValueError);
  });
});

describe('applyPlaceholders', () => {
  it('replaces every REPLACE_* token and fails on unknown ones', () => {
    expect(applyPlaceholders('#REPLACE_LEADS_CHANNEL', { REPLACE_LEADS_CHANNEL: 'leads' })).toBe('#leads');
    expect(applyPlaceholders('hello@REPLACE_DOMAIN.example', { REPLACE_DOMAIN: 'spa' })).toBe('hello@spa.example');
    expect(() => applyPlaceholders('REPLACE_UNKNOWN', {})).toThrow(/No placeholder value/);
  });
});
