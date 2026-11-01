/** Kernel HTTP response envelope (consistent with /v3/meta/*). */

export interface MetaEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

/**
 * envelope.code -> HTTP status (§4.8.2):
 *   0                 -> 200
 *   400-599           -> same as code
 *   10000-59999       -> floor(code/100) when that is 400-599 (40901 -> 409, 50001 -> 500)
 *   anything else     -> 502
 */
export function mapHttpStatusFromEnvelopeCode(code: number): number {
  if (code >= 400 && code < 600) return code;
  if (code === 0) return 200;
  if (code >= 10_000 && code <= 59_999) {
    const http = Math.floor(code / 100);
    if (http >= 400 && http < 600) return http;
  }
  return 502;
}
