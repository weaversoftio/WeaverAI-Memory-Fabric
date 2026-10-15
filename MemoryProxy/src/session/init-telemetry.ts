/**
 * Session-init telemetry decorator (internal-use telemetry, section 7.2 Chunk 2 A/B).
 *
 * Design: do not touch the 30+ `store.set(status:"initialized")` sites inside handleSessionInit;
 *      instead read the state once **before and once after the top-level entry**, and emit a telemetry entry only when
 *      `prev !== "initialized" && after === "initialized"`.
 *
 * Hard constraints (section 7.-1):
 *   - return void synchronously, never throw
 *   - exceptions inside the sink are silently swallowed
 *   - no state / state unchanged / pending -> pending cases are no-ops
 */
import type { SessionInitStatus } from "./types.js";
import type { SessionStore } from "./store.js";
import { writeSessionInitRow, type SessionInitLogInput } from "../clickhouse.js";

/** Telemetry decorator input. The sink defaults to the real writeSessionInitRow and can be injected for tests. */
export interface EmitSessionInitTelemetryArgs {
  store: SessionStore;
  compositeKey: string;
  /** store.get(...)?.status when handleSessionInit was entered (pass "uninitialized" if undefined) */
  prevStatus: SessionInitStatus;
  /** "claude-code" | "codebuddy" */
  agentSource: string;
  /** First sentence of the original text captured from the log when taking the bypass branch (optional) */
  bypassReason?: string;
  /** Test injection point; by default calls clickhouse.writeSessionInitRow */
  sink?: (input: SessionInitLogInput) => void;
}

/**
 * If the state just moved from non-initialized to initialized, emit one session_init telemetry entry.
 * Every other case is a no-op.
 */
export function emitSessionInitTelemetryIfCompleted(args: EmitSessionInitTelemetryArgs): void {
  try {
    if (args.prevStatus === "initialized") return; // steady state, nothing to emit
    const state = args.store.get(args.compositeKey);
    if (!state) return; // never set -> e.g. sessionKey=unknown
    if (state.status !== "initialized") return; // pending midway -> not completed

    const info = state.sessionInfo;
    const input: SessionInitLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: args.compositeKey,
      spaceId: info?.space_id,
      userId: info?.user_id,
      teamId: info?.team_id,
      agentId: info?.agent_id,
      agentSource: args.agentSource,
      bypassed: state.bypassed === true,
      bypassReason: args.bypassReason ?? "",
      finalStatus: "initialized",
    };
    const sink = args.sink ?? writeSessionInitRow;
    try {
      sink(input);
    } catch {
      // sink threw -> decorator stays silent; telemetry must never block business logic
    }
  } catch {
    // The decorator itself must also never throw
  }
}
