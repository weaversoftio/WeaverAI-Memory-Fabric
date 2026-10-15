import type { MetaEnvelope } from '../envelope.js';
import type { KernelCredentials } from '../types.js';

export interface KernelHttpPort {
  /** POST a kernel path and return the full envelope (a business code != 0 does not throw, so the transparent proxy can pass it through). */
  postEnvelope<T>(path: string, body: unknown, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
  /** GET a kernel path and return the full envelope (read-only endpoints such as /v3/analytics/config and spaces). */
  getEnvelope<T>(path: string, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
}
