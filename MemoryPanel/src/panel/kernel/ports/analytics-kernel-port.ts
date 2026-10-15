import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';

/**
 * Port for the transparent proxy to the kernel /v3/analytics/* query plane.
 *
 * Same shape as MetaKernelPort, but internally picks GET / POST by action:
 * the kernel declares config and spaces as GET; the rest are POST.
 */
export interface AnalyticsKernelPort {
  invoke(
    action: string,
    body: Record<string, unknown>,
    ctx: MetaCallContext,
  ): Promise<MetaEnvelope>;
}
