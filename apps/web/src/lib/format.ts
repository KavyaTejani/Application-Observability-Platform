/** Display conventions: local time zone (labelled in the UI), and units that are always explicit. */

export const timeZoneLabel = (() => {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${zone} (UTC${sign}${hours}:${minutes})`;
})();

export const formatClock = (ms: number, withSeconds = false) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(new Date(ms));

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
    new Date(iso),
  );

/** Log timestamps with milliseconds, which helps when ordering bursts of entries. */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  const base = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function formatRelative(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const formatNumber = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);

export const formatPercent = (ratio: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: ratio < 0.1 ? 2 : 1 }).format(ratio * 100)}%`;

export const formatMs = (ms: number) =>
  ms >= 1000 ? `${formatNumber(ms / 1000)} s` : `${Math.round(ms)} ms`;
