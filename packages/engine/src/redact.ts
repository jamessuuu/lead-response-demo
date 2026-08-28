import { maskPhone } from '@lrd/schema';

/** E.164-shaped digit runs. Timestamp offsets (`+05:00`) are too short to match. */
const E164_RE = /\+\d{7,15}/g;

/** Mask every phone-shaped string anywhere in a value tree. Redaction happens before writing, never at render. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return value.replace(E164_RE, (m) => maskPhone(m)) as unknown as T;
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
