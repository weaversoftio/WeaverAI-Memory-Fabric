/**
 * Instance (service) ids arrive in the `x-wamf-service-id` / `x-instance-id` headers
 * and in destroy bodies, and become path segments (dataDir/instances/<id>/...,
 * per-instance metadata databases). Anything outside this shape could climb out of
 * the data directory, so it is rejected before routing.
 */
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isSafeInstanceId(id: string): boolean {
  return INSTANCE_ID_RE.test(id) && !id.includes("..");
}
