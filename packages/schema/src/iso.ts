/**
 * ISO-8601 timestamps with millisecond precision and an explicit offset
 * (`Z` or `+HH:MM`). Stored absolute; offsets and durations are computed.
 */
export const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Epoch milliseconds of an ISO timestamp (offset respected). */
export function epochMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp: ${iso}`);
  return ms;
}

/** The UTC offset carried by an ISO timestamp, in minutes. `Z` => 0. */
export function offsetMinutes(iso: string): number {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Format epoch milliseconds as an ISO timestamp that keeps the given offset. */
export function formatIso(ms: number, offsetMin: number): string {
  const shifted = new Date(ms + offsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1, 2);
  const d = pad(shifted.getUTCDate(), 2);
  const h = pad(shifted.getUTCHours(), 2);
  const mi = pad(shifted.getUTCMinutes(), 2);
  const s = pad(shifted.getUTCSeconds(), 2);
  const mss = pad(shifted.getUTCMilliseconds(), 3);
  if (offsetMin === 0) return `${y}-${mo}-${d}T${h}:${mi}:${s}.${mss}Z`;
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${mss}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

/** Wall-clock time of day (HH:MM:SS.mmm) in the timestamp's own offset. */
export function wallClock(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(iso);
  if (!m) throw new Error(`Invalid ISO timestamp: ${iso}`);
  return m[1] as string;
}

/** Human form of an offset: `UTC-05:00`. */
export function offsetLabel(iso: string): string {
  const min = offsetMinutes(iso);
  if (min === 0) return 'UTC';
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `UTC${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}
