import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";

export type AdminAuthResult = "ok" | "missing" | "invalid" | "disabled";

/**
 * Shared Bearer authentication for proxy administration endpoints.
 * No admin.apiKey configured = the endpoints are refused, never open.
 */
export function checkAdminAuth(c: Context, expected: string): AdminAuthResult {
  if (!expected) return "disabled";

  const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return "missing";

  const provided = header.slice("Bearer ".length).trim();
  if (!provided) return "missing";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "ok" : "invalid";
}

export function adminAuthError(c: Context, result: Exclude<AdminAuthResult, "ok">): Response {
  if (result === "disabled") {
    return c.json({ code: 403, message: "Forbidden: admin endpoints are disabled (admin.apiKey is not set)" }, 403);
  }
  const message = result === "missing"
    ? "Unauthorized: missing Bearer token"
    : "Unauthorized: invalid token";
  return c.json({ code: 401, message }, 401);
}
