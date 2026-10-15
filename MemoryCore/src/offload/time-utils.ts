/**
 * Time utilities — ISO 8601 timestamps in UTC (offset 0).
 */

/**
 * Get the current time as an ISO 8601 string in UTC.
 * Format: "2026-03-25T16:53:51.178Z"
 */
export function nowUtcISO(): string {
  return toUtcISO(new Date());
}

/**
 * Convert any Date object to an ISO 8601 string in UTC.
 */
export function toUtcISO(date: Date): string {
  return date.toISOString();
}
