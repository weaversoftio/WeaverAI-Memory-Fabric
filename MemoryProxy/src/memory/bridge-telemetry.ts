/**
 * Bridge-side tool-call telemetry helper (shared by memory-bridge + skill-bridge).
 *
 * Design: every time an upstream fetch completes (success or failure) emit one kind='bridge_call'.
 *      The caller is responsible for redacting body to <= 512 bytes (this function no longer sanitizes), it only passes it through.
 *
 * Hard constraints (section 7.-1):
 *   - return void synchronously
 *   - sink exceptions are silently swallowed
 *   - body/sub are already prepared by the caller; never read the session store additionally
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

export interface BridgeCallTelemetryInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" | "unknown" -- derived back from the sessionKey prefix */
  agentSource: string;
  /** "memory-bridge" | "skill-bridge" | "knowledge-bridge" */
  bridgeSource: string;
  /** Concrete sub string ("atomic/search" / "skill/get" etc.) */
  executedEndpoint: string;
  /** Redacted and truncated outbound body (<= 512 bytes) */
  requestBody: string;
  /** upstream HTTP status (pass 0 or 502 on network failure) */
  upstreamStatus: number;
  /** upstream latency in milliseconds */
  elapsedMs: number;
  /**
   * Reason for a pre-check failure. Empty / unset = the request reached the upstream (success or 4xx/5xx).
   * Non-empty = the proxy returned early at the pre-check stage and never reached the fetcher. See the clickhouse.ts ToolCallLogInput comment.
   */
  rejectReason?: string;
}

/**
 * Emit one bridge_call telemetry entry. The sink defaults to clickhouse.writeToolCallRow.
 * Swallows exceptions internally and never throws.
 */
export function emitBridgeToolCallTelemetry(
  input: BridgeCallTelemetryInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    const row: ToolCallLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      teamId: input.teamId,
      agentId: input.agentId,
      agentSource: input.agentSource,
      kind: "bridge_call",
      bridgeSource: input.bridgeSource,
      initiatedTool: "",
      executedEndpoint: input.executedEndpoint,
      requestBody: input.requestBody,
      upstreamStatus: input.upstreamStatus,
      elapsedMs: input.elapsedMs,
      rejectReason: input.rejectReason,
    };
    try {
      sink(row);
    } catch {
      // sink threw -> telemetry must never block business logic
    }
  } catch {
    // Exceptions constructing the input are swallowed too
  }
}

/**
 * Derive agentSource back from the proxy session-key.
 *   "claude-code:conv-abc" → "claude-code"
 *   "codebuddy:conv-abc"   → "codebuddy"
 *   "conv-abc" (no prefix)    -> "unknown"
 */
export function agentSourceFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return "unknown";
  return sessionKey.slice(0, idx);
}

/**
 * Pre-check failure telemetry helper -- the proxy layer rejected the request and it never reached the upstream fetcher.
 *
 * Most early pre-check exits have not even parsed the session ids yet (missing header / bad content-type /
 * invalid json ...), so the stable fields available are limited. The remaining fields are passed through as optional.
 *
 * Wraps emitBridgeToolCallTelemetry internally, kind is still 'bridge_call', distinguished by rejectReason
 * being non-empty. Old dashboards with all-kind='bridge_call' SQL keep running untouched,
 * and the new dimension is looked up with `WHERE reject_reason != ''`.
 *
 * Hard constraints: return void synchronously, telemetry must never block business logic; sessionKey may be an empty string.
 */
export interface BridgeRejectTelemetryInput {
  /** Fill in if it could be derived; at the pre-check stage (missing header) it cannot be derived, so fill "" */
  sessionKey: string;
  bridgeSource: "memory-bridge" | "skill-bridge" | "knowledge-bridge";
  /** Stable enum value, for GROUP BY -- see the tool_call_logs.reject_reason comment for details */
  rejectReason: string;
  /** HTTP status the proxy returned to the client (401/415/400/...); stored in the upstream_status column */
  httpStatus: number;
  /** Fill in the subpath if it can already be computed, else "" */
  executedEndpoint?: string;
  /** Fill in the body if already parsed (the caller is responsible for <=512 truncation), else "" */
  requestBody?: string;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
}

export function emitBridgeRejectTelemetry(input: BridgeRejectTelemetryInput): void {
  emitBridgeToolCallTelemetry({
    sessionKey: input.sessionKey,
    spaceId: input.spaceId,
    userId: input.userId,
    teamId: input.teamId,
    agentId: input.agentId,
    agentSource: input.agentSource
      ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    bridgeSource: input.bridgeSource,
    executedEndpoint: input.executedEndpoint ?? "",
    requestBody: input.requestBody ?? "",
    upstreamStatus: input.httpStatus,
    elapsedMs: 0,
    rejectReason: input.rejectReason,
  });
}
