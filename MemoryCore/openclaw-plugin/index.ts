/**
 * memory-weaverai-client — OpenClaw memory plugin (v3 client)
 *
 * Connects to the remote Memory Gateway via @weaversoft/memory-fabric-sdk-ts-v2,
 * using the /v3/* API with mandatory team/agent/user isolation,
 * and provides automatic capture, recall and tool calls for the four memory layers.
 *
 * File reads (tool wamf_read_file) go through the isolated v3 core/scenario read endpoints.
 * This plugin contains no data-processing logic (no vector store/Embedding/Pipeline) and no Offload;
 * all memory operations are delegated to the remote Gateway.
 */

import { MemoryClient } from "@weaversoft/memory-fabric-sdk-ts-v2";
import { performRecall } from "./src/hooks/recall.js";
import { performCapture } from "./src/hooks/capture.js";
import { handleMemorySearch } from "./src/tools/memory-search.js";
import { handleConversationSearch } from "./src/tools/conversation-search.js";
import { handleReadFile } from "./src/tools/read-file.js";

const TAG = "[memory-client]";

// ── Config types (matches openclaw.plugin.json configSchema) ──────────
interface ServerConfig {
  url?: string;
  apiKey?: string;
  instanceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  rejectUnauthorized?: boolean;
}
interface RecallConfig {
  maxResults?: number;
  includePersona?: boolean;
  includeSceneNav?: boolean;
}
interface CaptureConfig {
  enabled?: boolean;
}
interface PluginConfig {
  server?: ServerConfig;
  recall?: RecallConfig;
  capture?: CaptureConfig;
}

// Matches OpenClaw plugin register() signature: export default function register(api)
export default function register(api: any) {
  // ── Read config (nested objects per configSchema) ──────────────────
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  const server = cfg.server ?? {};
  const recall = cfg.recall ?? {};
  const capture = cfg.capture ?? {};

  const serverUrl = server.url || "http://127.0.0.1:8420";
  const apiKey = server.apiKey || "local";
  const instanceId = server.instanceId || "default";
  const teamId = server.teamId || "default";
  const agentId = server.agentId || "default";
  const userId = server.userId || "default";
  const recallMaxResults = recall.maxResults ?? 5;
  const includePersona = recall.includePersona !== false;
  const includeSceneNav = recall.includeSceneNav !== false;
  const captureEnabled = capture.enabled !== false;
  const rejectUnauthorized = server.rejectUnauthorized !== false;

  // ── Initialize v3 SDK ──
  // Isolation (team/agent/user) is required by Gateway /v3/*; sessionId may be
  // narrowed per-hook via client.withIsolation({ sessionId }).
  const client = new MemoryClient({
    endpoint: serverUrl,
    apiKey,
    serviceId: instanceId,
    teamId,
    agentId,
    userId,
    rejectUnauthorized,
  });

  api.logger.info?.(
    `${TAG} Initialized: server=${serverUrl}, instance=${instanceId}, ` +
    `isolation(team=${teamId},agent=${agentId},user=${userId}), ` +
    `recall(persona=${includePersona},sceneNav=${includeSceneNav},max=${recallMaxResults}), ` +
    `capture=${captureEnabled}, rejectUnauthorized=${rejectUnauthorized}`,
  );

  // ── Register Tools (same pattern as extensions/memory-weaverai/index.ts) ──

  api.registerTool(
    {
      name: "wamf_memory_search",
      label: "Memory Search",
      description:
        "Search structured memories (L1). Returns relevant memory fragments about " +
        "user preferences, past events, rules, and facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text (natural language)." },
          limit: { type: "number", description: "Max results to return (default: 5)." },
          type: { type: "string", description: "Filter by memory type." },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleMemorySearch(client, params as any, api.logger);
      },
    },
    { name: "wamf_memory_search" },
  );

  api.registerTool(
    {
      name: "wamf_conversation_search",
      label: "Conversation Search",
      description:
        "Search raw conversation history (L0). Returns original messages with timestamps.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text." },
          limit: { type: "number", description: "Max results (default: 5)." },
          session_key: { type: "string", description: "Filter by session ID." },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleConversationSearch(client, params as any, api.logger);
      },
    },
    { name: "wamf_conversation_search" },
  );

  api.registerTool(
    {
      name: "wamf_read_file",
      label: "Read Memory File",
      description:
        "Read a memory pipeline file by relative path through the Memory Gateway " +
        "(Scene Navigation paths like 'scene_blocks/xxx.md', or 'persona.md').",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Full relative storage key (e.g. 'scene_blocks/travel-plan.md' or 'persona.md').",
          },
        },
        required: ["path"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return handleReadFile(client, params as any, api.logger);
      },
    },
    { name: "wamf_read_file" },
  );

  // ── Register Hooks (api.on pattern, same as memory-weaverai) ──

  // Per-session caches:
  //   - pendingOriginalPrompts: clean user prompt + messageCount captured at
  //     before_prompt_build, used at agent_end to (a) replace polluted user
  //     message and (b) position-slice this turn's new messages.
  //   - sessionCursors: max timestamp of last captured batch — used as a
  //     fallback when the position slice cannot be determined.
  const pendingOriginalPrompts = new Map<string, { text: string; messageCount: number }>();
  const sessionCursors = new Map<string, number>();

  api.on("before_prompt_build", async (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    const userText = event?.prompt;
    if (!userText) return;

    // Cache original prompt for agent_end (only if capture is enabled — it is
    // the only consumer; recall doesn't need this data).
    if (captureEnabled) {
      const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
      pendingOriginalPrompts.set(sessionKey, { text: userText, messageCount });
    }

    try {
      // Scope L0/L1 recall to this session when sessionId is available
      const sessionClient = ctx?.sessionId
        ? client.withIsolation({ sessionId: ctx.sessionId })
        : client;

      const result = await performRecall(sessionClient, {
        query: userText,
        maxResults: recallMaxResults,
        includePersona,
        includeSceneNav,
      }, api.logger);

      // OpenClaw consumes the *return value* of before_prompt_build,
      // not mutations on the event object. Map our RecallResult to the
      // PluginHookBeforePromptBuildResult shape.
      const out: { prependContext?: string; appendSystemContext?: string } = {};
      if (result.prependContext) out.prependContext = result.prependContext;
      if (result.appendSystemContext) out.appendSystemContext = result.appendSystemContext;
      return out;
    } catch (err) {
      api.logger.warn(`${TAG} [recall] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (captureEnabled) {
    api.logger.info?.(`${TAG} Registering agent_end hook for auto-capture`);
    api.on("agent_end", async (event: any, ctx: any) => {
      const startMs = Date.now();
      const sessionKey = ctx?.sessionKey;
      const messages = (event?.messages ?? []) as unknown[];

      api.logger.debug?.(
        `${TAG} [agent_end] hook triggered: success=${event?.success}, ` +
        `messages=${messages.length}, sessionKey=${sessionKey ?? "(none)"}`,
      );

      // Skip on agent failure — partial / errored turns shouldn't pollute L0.
      if (event?.success === false) {
        api.logger.info(`${TAG} [agent_end] agent did not succeed, skip capture`);
        return;
      }

      if (!sessionKey) {
        api.logger.warn(`${TAG} [agent_end] no sessionKey in ctx, skip capture`);
        return;
      }
      if (messages.length === 0) {
        api.logger.debug?.(`${TAG} [agent_end] event.messages is empty, skip capture`);
        return;
      }

      const cached = pendingOriginalPrompts.get(sessionKey);
      // Don't delete on read — keep until we successfully send (in case of retry),
      // or let it be overwritten on next before_prompt_build.

      try {
        const sessionClient = ctx?.sessionId
          ? client.withIsolation({ sessionId: ctx.sessionId })
          : client;

        const result = await performCapture(
          sessionClient,
          {
            sessionKey,
            sessionId: ctx?.sessionId,
            rawMessages: messages,
            originalUserText: cached?.text,
            originalUserMessageCount: cached?.messageCount,
            afterTimestamp: sessionCursors.get(sessionKey),
          },
          api.logger,
        );

        if (result.maxTimestamp) {
          sessionCursors.set(sessionKey, result.maxTimestamp);
        }
        // Cached prompt has been used — clear it so a stale value doesn't
        // bleed into the next turn (e.g. after agent restart).
        pendingOriginalPrompts.delete(sessionKey);

        const elapsed = Date.now() - startMs;
        api.logger.info(
          `${TAG} [agent_end] capture done in ${elapsed}ms ` +
          `(captured=${result.capturedCount}, serverTotal=${result.serverTotalCount ?? "?"})`,
        );
      } catch (err) {
        const elapsed = Date.now() - startMs;
        api.logger.warn(
          `${TAG} [capture] Failed after ${elapsed}ms: ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  } else {
    api.logger.info?.(`${TAG} capture disabled by config`);
  }
}
