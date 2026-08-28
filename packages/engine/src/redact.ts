import { maskPhone } from '@lrd/schema';

/** E.164-shaped digit runs. Timestamp offsets (`+05:00`) are too short to match. */
const E164_RE = /\+\d{7,15}/g;

/**
 * NANP-formatted 10-digit numbers as a real web form sends them, before
 * "Normalize Lead" converts to E.164 — e.g. the real webhook payload's own
 * `(512) 555-0134`, sitting in the SAME execution.json as the already-
 * masked E.164 form of the identical number, which E164_RE above never
 * sees (no leading `+`, punctuation instead of a plain digit run). Found
 * for real: the first attempt at redacting execution.json (E164_RE only)
 * left this pre-normalization copy of the number unmasked. Two groupings
 * only — `(512) 555-0134` and `512-555-0134`/`512.555.0134`/`512 555
 * 0134` — deliberately not a general phone validator, just wide enough
 * to catch every shape this repo's own capture data actually produces;
 * see packages/engine/test/redact.test.ts for the exact fixture.
 */
const NANP_RE = /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;

/** Mask every phone-shaped string anywhere in a value tree. Redaction happens before writing, never at render. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(E164_RE, (m) => maskPhone(m))
      .replace(NANP_RE, (m) => maskPhone(`+1${m.replace(/\D/g, '')}`)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export const PREVIEW_MAX = 160;

/** Truncate a preview string with an ellipsis so previews stay previews. */
export function preview(text: string, max = PREVIEW_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Plain text of a small HTML fragment: tags removed, whitespace collapsed, a few entities decoded. */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div|br|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
