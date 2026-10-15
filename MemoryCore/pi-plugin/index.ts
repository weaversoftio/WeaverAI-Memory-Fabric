/**
 * @weaversoft/pi-wamf-client — Pi coding-agent extension.
 *
 * Routes Pi through the WAMF Memory Proxy. Config is env-only (Pi's
 * ExtensionAPI has no plugin config object). The extension carries only
 * routing + the dynamic per-session x-conversation-id header; all memory
 * capability (L3/L2 injection, L0 capture, L0/L1/L2 search via curl
 * recipes) arrives server-side from the proxy. (Scope C.)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const proxyBase = process.env.WAMF_PROXY_URL ?? "http://127.0.0.1:8096";
  const spaceId = process.env.WAMF_SPACE_ID ?? "default";
  const agentSource = process.env.WAMF_AGENT_SOURCE ?? "pi";
  const model = process.env.WAMF_MODEL ?? "glm-5.2-vision";
  const userKey = process.env.WAMF_USER_KEY ?? "";
  const teamId = process.env.WAMF_TEAM_ID ?? "";
  const agentId = process.env.WAMF_AGENT_ID ?? "";
  const taskId = process.env.WAMF_TASK_ID ?? "";

  // Graceful degradation: if required identity env vars are missing, warn and
  // skip registration so Pi still starts. The user sees the warning at load
  // and can fix the env. (A startup extension must not throw and block Pi.)
  // NOTE: WAMF_TASK_ID is OPTIONAL — task_id is an optional business dimension
  // in the WAMF kernel (MemoryCore/src/core/store/isolation.ts), and the proxy
  // registers from team+agent alone (broad recall when task is absent).
  const required: Record<string, string> = {
    WAMF_USER_KEY: userKey,
    WAMF_TEAM_ID: teamId,
    WAMF_AGENT_ID: agentId,
  };
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length > 0) {
    console.warn(
      `[pi-wamf-client] Not registering the WAMF provider: missing required env var(s): ` +
        `${missing.join(", ")}. Set WAMF_USER_KEY, WAMF_TEAM_ID, ` +
        `WAMF_AGENT_ID (see MemoryCore/pi-plugin/README.md). ` +
        `WAMF_TASK_ID is optional. ` +
        `Pi will start without the WAMF provider.`,
    );
    return;
  }

  // Only send x-task-id when explicitly set; an absent/stale task makes the
  // proxy register with broad recall (no task filter) instead of failing.
  const headers: Record<string, string> = {
    "x-team-id": teamId,
    "x-agent-id": agentId,
  };
  if (taskId) headers["x-task-id"] = taskId;

  // baseUrl MUST include /v1: the OpenAI-completions provider appends
  // /chat/completions but does NOT insert /v1. Including /v1 hits the
  // proxy's explicit /:agent/:spaceId/v1/chat/completions route.
  pi.registerProvider("wamf", {
    name: "WAMF Memory Proxy",
    baseUrl: `${proxyBase}/${agentSource}/${spaceId}/v1`,
    api: "openai-completions",
    apiKey: userKey,
    headers,
    models: [
      {
        id: model,
        name: model,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 524288,
        maxTokens: 16384,
        thinkingLevelMap: {
          off: "none",
          minimal: "minimal",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
    ],
  });

  pi.on("before_provider_headers", (event: any, ctx: any) => {
    if (ctx.model?.provider !== "wamf") return;
    const sid = ctx.sessionManager.getSessionId();
    event.headers["x-conversation-id"] = `pi-${sid}`;
  });
}
