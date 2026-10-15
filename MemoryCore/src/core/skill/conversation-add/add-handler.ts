/**
 * SkillConversationAddHandler — §7 Handler main flow.
 *
 * Handles `POST /v3/skill/conversation/add`:
 *   ① validate required fields + role
 *   ② compute raw_bytes
 *   ③ branch by path: normal (< requestCompressThreshold) / compressed (≥) / oversize (> chunkMax after concatenation)
 *   ④ concatenate into data-current and accumulate counters
 *   ⑤ check thresholds → trigger archiving (SkillTriggerService)
 *   ⑥ write back data-current + meta
 */

import {
  DEFAULT_COMPRESS_OPTIONS,
  type CompressibleMessage,
  type CompressOptions,
  type CompressibleRole,
} from "./message-compressor.js";
import {
  DEFAULT_OVERSIZE_OPTIONS,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";
import { prepareArchivePayload } from "./prepare-archive.js";
import type { SkillBufferStorage, SessionKey, SessionMeta } from "./buffer-storage.js";
import type { SkillTriggerService } from "./trigger-service.js";
import { obsLogger } from "../../report/obs-logger.js";

const VALID_ROLES: ReadonlySet<CompressibleRole> = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
]);

/**
 * The set of roles counted for the archive threshold `tool_call_count`.
 *
 * **Only `tool_call` counts, not `tool_result`.** The two are naturally paired 1:1 (every
 * tool call by the agent brings back one result); counting both would double the count, and users would
 * observe "the agent archives after 5 tool calls" - nowhere near the 10 in the config.
 *
 * Specifically, of VALID_ROLES, "tool_call" is a call actively initiated by the agent and
 * "tool_result" is the paired return value. The archive trigger semantics are "how many times the agent used tools",
 * so only the call side is counted.
 *
 * The validation path (in validate()) still requires tool_call_id for both tool_call and tool_result
 * - that is a **structural validity** check, unrelated to counting; two separate things.
 */
const TOOL_CALL_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call"]);

/** Set of roles that need a tool_call_id during validation (both call and result carry the pairing anchor). */
const TOOL_PAIR_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call", "tool_result"]);

const ID_FORBIDDEN_CHAR = "|";

export interface AddConversationInput {
  /**
   * Added 2026-07-30: multi-tenant instance ID. Passed through into the AgentTuple so the worker pool
   * can dynamically resolve the matching instance's storage/database/LLM resources when dequeuing.
   * In standalone mode the gateway falls back to "default". Missing values are rejected in the validate stage.
   */
  instance_id: string;
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  /** Business-side task reference, passed through to task.task_ref_id when the archive lands. */
  task_id?: string;
  messages: CompressibleMessage[];
  /**
   * The upstream HTTP handler's req_id, used by obsLogger to correlate segmented events along the chain.
   * If omitted, events just lack a req_id; business logic is unaffected.
   */
  perfRequestId?: string;
}

export interface AddConversationResult {
  /** Semantic status: ok = appended normally / archived = archiving was triggered. */
  status: "ok" | "archived";
  archived?: {
    task_id: string;
    archived_at_ms: number;
    archive_key: string;
    /** normal triggers on reaching the threshold / compressed always triggers / oversize triggers after the fallback */
    reason: "tool_calls" | "bytes" | "compressed" | "oversize";
  };
}

export interface HandlerThresholds {
  /** tool_call accumulation threshold. Default 10. */
  toolCallThreshold: number;
  /** Byte accumulation threshold. Default 40960 (40KB). */
  bytesThreshold: number;
  /** Take the compression path when this add's bytes ≥ this value. Default 40960. */
  requestCompressThresholdBytes: number;
}

export const DEFAULT_HANDLER_THRESHOLDS: HandlerThresholds = {
  toolCallThreshold: 10,
  bytesThreshold: 40 * 1024,
  requestCompressThresholdBytes: 40 * 1024,
};

export interface SkillConversationAddHandlerOptions {
  buffer: SkillBufferStorage;
  trigger: SkillTriggerService;
  thresholds?: Partial<HandlerThresholds>;
  compressOptions?: Partial<CompressOptions>;
  oversizeOptions?: Partial<OversizeOptions>;
  now?: () => number;
}

export class HandlerValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "HandlerValidationError";
  }
}

export class SkillConversationAddHandler {
  private readonly buffer: SkillBufferStorage;
  private readonly trigger: SkillTriggerService;
  private readonly thresholds: HandlerThresholds;
  private readonly compressOptions: CompressOptions;
  private readonly oversizeOptions: OversizeOptions;
  private readonly now: () => number;

  constructor(opts: SkillConversationAddHandlerOptions) {
    this.buffer = opts.buffer;
    this.trigger = opts.trigger;
    this.thresholds = { ...DEFAULT_HANDLER_THRESHOLDS, ...opts.thresholds };
    this.compressOptions = { ...DEFAULT_COMPRESS_OPTIONS, ...opts.compressOptions };
    this.oversizeOptions = { ...DEFAULT_OVERSIZE_OPTIONS, ...opts.oversizeOptions };
    this.now = opts.now ?? (() => Date.now());
  }

  async handle(input: AddConversationInput): Promise<AddConversationResult> {
    // [obs] handler-internal segments: readBuffer / prepareArchive / trigger.archive / writeBack.
    // Built on the obsLogger base (structured events + FileLogger + ClickHouse backend),
    // correlated via req_id with the upstream handleConversationAdd + trigger + worker across the full chain.
    const rid = input.perfRequestId;

    // ① Validate
    this.validate(input);
    const sess: SessionKey = {
      instance_id: input.instance_id,
      space_id: input.space_id,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      session_id: input.session_id,
    };

    // ② Compute raw_bytes
    const rawBytes = totalMessagesBytes(input.messages);

    // ③ Branch by path: read current state + use the shared helper for compression + fallback
    const useCompress = rawBytes >= this.thresholds.requestCompressThresholdBytes;
    const t0Buf = Date.now();
    const [current, meta] = await Promise.all([
      this.buffer.readCurrent(sess),
      this.buffer.readMeta(sess),
    ]);
    obsLogger.info("skill.add_handler.read_buffer", {
      req_id: rid, session_id: input.session_id, instance_id: input.instance_id,
      dur_ms: Date.now() - t0Buf,
      current_msgs: current.messages.length,
      raw_bytes: rawBytes,
      use_compress: useCompress,
    });

    // conversation-add specific semantics: only the compression path takes the oversize fallback (see the comment below for the original implementation);
    // when using the helper, forceCompress=useCompress, and when useCompress=false the helper
    // also does not go through applyOversizeStrategy - because on the normal path combinedBytes should not be > chunkMax
    // (in that case rawBytes would already be >= requestCompressThresholdBytes and took the compression path).
    // The oversize check in the helper is semantically equivalent to the original implementation: both are "combined > chunkMax".
    const t0Prep = Date.now();
    const prepared = prepareArchivePayload(
      current.messages as OversizeMessage[],
      input.messages,
      {
        compress: this.compressOptions,
        oversize: this.oversizeOptions,
        forceCompress: useCompress,
      },
    );
    obsLogger.info("skill.add_handler.prepare_archive", {
      req_id: rid, session_id: input.session_id, instance_id: input.instance_id,
      dur_ms: Date.now() - t0Prep,
      msg_in: input.messages.length,
      msg_out: prepared.messages.length,
      used_oversize: prepared.usedOversize,
    });
    const combinedMessages: OversizeMessage[] = prepared.messages;
    const usedOversize = prepared.usedOversize;

    // ④ Update meta counters
    // Count only tool_call, not tool_result - the two are paired 1:1, and counting twice would turn the threshold of 10
    // into an actual "archive after 5 tool calls", violating the config semantics. See the TOOL_CALL_ROLES comment.
    const addedToolCalls = countRoles(input.messages, TOOL_CALL_ROLES);
    const nextTool = meta.tool_call_count + addedToolCalls;
    const nextBytes = meta.byte_count + rawBytes;

    // ⑤ Threshold check
    const hitTool = nextTool >= this.thresholds.toolCallThreshold;
    const hitBytes = nextBytes >= this.thresholds.bytesThreshold;
    const shouldArchive = useCompress || hitTool || hitBytes;

    let result: AddConversationResult = { status: "ok" };

    if (shouldArchive) {
      // Archive segment
      const reason: NonNullable<AddConversationResult["archived"]>["reason"] = usedOversize
        ? "oversize"
        : useCompress
          ? "compressed"
          : hitTool
            ? "tool_calls"
            : "bytes";

      const t0Arch = Date.now();
      const archiveRes = await this.trigger.archive({
        session: sess,
        bufferAtTrigger: { messages: combinedMessages as Array<Record<string, unknown>> },
        taskRefId: input.task_id,
        // Pass req_id through to the trigger's internal segment events (write_archive / mutex_* / enqueue_agent)
        perfRequestId: input.perfRequestId,
      });
      obsLogger.info("skill.add_handler.trigger_archive", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Arch,
        task_id: archiveRes.taskId,
        archive_key: archiveRes.archiveKey,
        reason,
      });

      // After archiving, clear data-current + counters
      const nowMs = this.now();
      const nextMeta: SessionMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      };

      const t0Wb = Date.now();
      await Promise.all([
        this.buffer.writeCurrent(sess, { messages: [] }),
        this.buffer.writeMeta(sess, nextMeta),
      ]);
      obsLogger.info("skill.add_handler.write_back", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Wb,
        archived: true,
      });

      result = {
        status: "archived",
        archived: {
          task_id: archiveRes.taskId,
          archived_at_ms: archiveRes.archivedAtMs,
          archive_key: archiveRes.archiveKey,
          reason,
        },
      };
    } else {
      // Archive not triggered: write the concatenated data-current straight back
      const nowMs = this.now();
      const nextMeta: SessionMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: nextTool,
        byte_count: nextBytes,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: meta.last_archived_at_ms,
      };
      const t0Wb = Date.now();
      await Promise.all([
        this.buffer.writeCurrent(sess, { messages: combinedMessages as Array<Record<string, unknown>> }),
        this.buffer.writeMeta(sess, nextMeta),
      ]);
      obsLogger.info("skill.add_handler.write_back", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Wb,
        archived: false,
        tool_count: nextTool,
        byte_count: nextBytes,
      });
    }

    return result;
  }

  private validate(input: AddConversationInput): void {
    const required: Array<keyof AddConversationInput> = [
      "instance_id",
      "session_id",
      "space_id",
      "user_id",
      "team_id",
      "agent_id",
    ];
    for (const f of required) {
      const v = input[f];
      if (typeof v !== "string" || v.length === 0) {
        throw new HandlerValidationError(String(f), `${String(f)} is required and must be non-empty string`);
      }
      if ((v as string).includes(ID_FORBIDDEN_CHAR)) {
        throw new HandlerValidationError(
          String(f),
          `${String(f)} must not contain '|' (reserved for agent tuple)`,
        );
      }
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new HandlerValidationError("messages", "messages must be a non-empty array");
    }
    for (let i = 0; i < input.messages.length; i++) {
      const m = input.messages[i]!;
      if (!VALID_ROLES.has(m.role as CompressibleRole)) {
        throw new HandlerValidationError(`messages[${i}].role`, `invalid role: ${m.role}`);
      }
      if (typeof m.content !== "string") {
        throw new HandlerValidationError(`messages[${i}].content`, "content must be string");
      }
      if (TOOL_PAIR_ROLES.has(m.role as CompressibleRole)) {
        // tool_call_id is **required** (tool_call and tool_result are paired through it)
        // tool_name is **optional**: the Anthropic protocol's tool_use block has a name, while OpenAI's
        //   role=tool message itself has no tool_name field, only tool_call_id. Making tool_name
        //   required would force the proxy side to look up assistant.tool_calls to fill it, a detour caused by
        //   protocol differences; so it is relaxed to optional (for skill extraction, content is what matters).
        if (typeof m.tool_call_id !== "string" || m.tool_call_id.length === 0) {
          throw new HandlerValidationError(
            `messages[${i}].tool_call_id`,
            "tool_call/tool_result must carry tool_call_id",
          );
        }
        if (m.tool_name !== undefined && (typeof m.tool_name !== "string" || m.tool_name.length === 0)) {
          throw new HandlerValidationError(
            `messages[${i}].tool_name`,
            "tool_name if provided must be non-empty string",
          );
        }
      }
    }
  }
}

function totalMessagesBytes(msgs: CompressibleMessage[]): number {
  let sum = 0;
  for (const m of msgs) {
    sum += Buffer.byteLength(JSON.stringify(m), "utf8");
  }
  return sum;
}

function countRoles(msgs: CompressibleMessage[], roles: ReadonlySet<CompressibleRole>): number {
  let n = 0;
  for (const m of msgs) if (roles.has(m.role as CompressibleRole)) n++;
  return n;
}
