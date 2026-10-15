/** Hono app factory — registers all routes. */

import { Hono, type MiddlewareHandler } from "hono";
import { handleChatCompletions } from "./handler.js";
import { handleAnthropicMessages } from "./anthropicHandler.js";
import { handleAuxiliaryEndpoint } from "./auxiliaryHandler.js";
import { handleDirectPassthrough } from "./directHandler.js";
import { handleCodexEndpoint } from "./codexHandler.js";
import { handleWorkbuddyEndpoint } from "./workbuddyHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { adminAuthError, checkAdminAuth } from "./routes/admin-auth.js";
import { initBridgeSecret } from "./bridge-signature.js";
import { hasAnalyseMarker, hasCostGuardMarker } from "./routes/whitelist.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import { getEffectiveBackend } from "./storage/factory.js";
import type { ProxyConfig } from "./types.js";

export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();
  initBridgeSecret(config.admin?.apiKey);

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // `/cost-guard` marker gate (P0 prerequisite):
  // When markerOptIn=false the marker is completely void -- any request whose path carries a `/cost-guard/` segment
  // directly gets 404, to keep the catch-all `POST /*` from catching it and taking the default route (which would be confusing:
  // the client thinks it "enabled the marker" while the proxy handles it as default_passthrough).
  // Placed at the very front, before all business routes.
  if (!config.costGuard.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasCostGuardMarker(c.req.path)) {
        return c.json(
          {
            error: "cost_guard_marker_disabled",
            message:
              "The /cost-guard URL marker is disabled on this deployment. " +
              "Remove the /cost-guard segment from the path, or set costGuard.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // `/analyse` marker gate (structure fully aligned with cost-guard):
  // When assetReflection.markerOptIn=false any request with an `/analyse/` segment gets 404,
  // to prevent the catch-all from silently catching it and handling the marker request as the default path. Previously only the registration switch
  // of the primary route existed, lacking this top-level rejection -- `/analyse` marker requests on the CC/CB side
  // would, when markerOptIn=false, fall through to the catch-all `POST /*` and make the upstream
  // receive the bare body (the marker client thinks it is "enabled" but actually did not go through the injector); the codex side
  // had the same symptom (the `/analyse` variant besides `/cost-guard` in the P1-6 report). Fixed together,
  // keeping the gating behaviour of the two markers symmetric.
  if (!config.injection?.assetReflection?.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasAnalyseMarker(c.req.path)) {
        return c.json(
          {
            error: "analyse_marker_disabled",
            message:
              "The /analyse URL marker is disabled on this deployment. " +
              "Remove the /analyse segment from the path, or set " +
              "injection.assetReflection.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // Health check
  //
  // All storage backends (sqlite / fs / memory) are process-local. `storage.degraded` reports whether the
  // requested backend fell back down the chain; it is informational and does not fail the health check.
  app.get("/health", (c) => {
    const eff = getEffectiveBackend();
    const degraded = !!config.storage?.enabled && eff.effective !== eff.requested;
    const body = {
      status: "ok",
      version: "0.2.0",
      upstream: config.upstream.url,
      opik: config.opik.enabled ? config.opik.url : "disabled",
      costGuard: config.costGuard.enabled ? "enabled" : "disabled",
      rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0 ? "enabled" : "disabled",
      storage: {
        enabled: !!config.storage?.enabled,
        requested: eff.requested,
        effective: eff.effective,
        degraded,
        ...(eff.error ? { lastError: eff.error } : {}),
      },
    };
    return c.json(body, 200);
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

  // -- /direct/* -- pure routing passthrough channel (must be placed before all business routes) -----
  // Fully bypasses cost-guard / auth / model alias / thinking sanitize;
  // but keeps opik trace/span reporting and jsonl usage table writes (effective only for Anthropic messages
  // and OpenAI chat/completions). See the header comment of directHandler.ts for details.
  // Off unless PROXY_DIRECT_PASSTHROUGH=true: it skips auth and reaches any method/path on the
  // upstream host, which on a public proxy exposes internal upstream endpoints to anyone.
  if (process.env.PROXY_DIRECT_PASSTHROUGH === "true") {
    app.all("/direct/*", (c) => handleDirectPassthrough(c, config));
  }

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: same pattern but reverse-proxies the wamf L0/L1/L2/L3 read-only endpoints.
  // Let the LLM use Bash to call <proxy>/memory-bridge/v3/atomic/search etc., with the proxy injecting identity.
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // -- Ops endpoint (registered before the catch-all `POST /*`) ----------------
  // /v3/instance/proxy-destroy -- when an instance is destroyed, clean up the proxy-side storage cache.
  // The contract field names align with core `/v3/instance/destroy`, and the path uses the
  // `proxy-destroy` action to distinguish it from core. Auth uses config.admin.apiKey (refused if empty).
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  // Ops endpoints below are reachable on the public proxy route: admin key only.
  const requireAdmin: MiddlewareHandler = async (c, next) => {
    const result = checkAdminAuth(c, config.admin.apiKey);
    if (result !== "ok") return adminAuthError(c, result);
    await next();
  };
  app.use("/v3/admin/*", requireAdmin);
  app.use("/v3/session/refresh-cache", requireAdmin);
  app.use("/v3/session/force-archive-skill", requireAdmin);

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  // -- Session management endpoints (underlying interfaces of mem: commands, reusable by the panel frontend) --
  app.post("/v3/session/refresh-cache", (c) => {
    return import("./routes/session-refresh.js").then(({ createSessionRefreshHandler }) =>
      createSessionRefreshHandler(config)(c),
    );
  });
  app.post("/v3/session/force-archive-skill", (c) => {
    return import("./routes/session-force-archive.js").then(({ createSessionForceArchiveHandler }) =>
      createSessionForceArchiveHandler(config)(c),
    );
  });

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  // Anthropic Messages API
  app.post("/v1/messages", (c) => handleAnthropicMessages(c, config));

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // These endpoints go through a lightweight passthrough handler (not entering the routing module, and not constituting a conversation round).
  // See docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId -- the standard client config format:
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // Example path: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  // `/cost-guard` marker: after the primary handler detects this segment it enables cost-guard routing;
  // the default path (without the marker) skips the router and passes straight through to the upstream.
  //
  // The marker mechanism is gated by `config.costGuard.markerOptIn`:
  //   - false (default / online): these two routes are not registered -- all requests go through `/:agent/:spaceId/v1/...`,
  //     useGuard is always true inside the handler, behaving the same as the historical "default goes through router". Then any
  //     `/cost-guard/...` request hits no route and goes to the final catch-all or returns 404
  //     (the catch-all `/*` exists and would fall through to handleChatCompletions; a marker->404 rejection was
  //     added at the top below, see handler / anthropicHandler).
  //   - true (test environment): the following two marker routes are registered; inside the handler the marker decides
  //     whether to go through the router.
  // See `hasCostGuardMarker`.
  // Hono matches the more specific path first, so it must be registered before the generic `/:agent/:spaceId/v1/...`.
  if (config.costGuard.markerOptIn) {
    app.post("/:agent/:spaceId/cost-guard/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // `/analyse` marker (asset-reflection internal effect evaluation) -- fully symmetric with cost-guard:
  // gated by `injection.assetReflection.markerOptIn`. The marker is just a transparent tag;
  // once detected inside the handler (AssetReflectionInjector) it appends
  // <asset_reflection> to the end of the system prompt; requests without the marker go through the original normal routing.
  //
  // WARNING, key: if these two routes are not registered, `/{agent}/{spaceId}/analyse/v1/messages`
  // (5 segments) falls through to the catch-all `POST /*` at the bottom -> handleChatCompletions
  // (the OpenAI handler), hitting the OpenAI endpoint with an Anthropic body -> upstream 400. So whenever
  // markerOptIn=true these two anthropic/openai 5-segment routes must be registered explicitly.
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/:agent/:spaceId/analyse/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // ── Codex endpoints (must precede generic /:agent/:spaceId routes) ────────
  // The Codex CLI client uses the OpenAI Responses API, a third independent protocol path.
  //
  // Client behaviour difference: the endpoint constant in codex-rs core/src/client.rs is `/responses`
  // (without /v1), while the CC/CB client constants are `/v1/messages` `/v1/chat/completions`
  // (with /v1). User base_url conventions:
  //   - CC/CB: base without /v1, the client automatically appends /v1/messages etc.
  //   - Codex: base must carry /v1 itself, the client appends /responses
  //
  // To make the onboarding method uniform for users across the three agents (base always filled as `/<agent>/<spaceId>`
  // without /v1), the proxy accepts both paths **with v1** and **without v1**:
  //   /codex/<spaceId>/v1/responses  <- hit when the codex client base carries v1 itself
  //   /codex/<spaceId>/responses     <- hit when the codex client base has no v1 (aligned with CC/CB usage)
  // Both paths map to handleCodexEndpoint, with fully identical behaviour.
  app.post("/codex/:spaceId/v1/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => handleCodexEndpoint(c, config));
  // Compatible with the style where base_url has no /v1 (aligned with the CC/CB user experience)
  app.post("/codex/:spaceId/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/responses", (c) => handleCodexEndpoint(c, config));

  // ── Workbuddy endpoints (must precede generic /:agent/:spaceId routes) ────
  // The WorkBuddy CLI/Desktop client uses the OpenAI Responses API (same protocol as Codex),
  // but its client behaviour differs from codex-cli (more sub-paths: compact / trace_summarize
  // / realtime / memories are aux; the main endpoint is /v1/responses).
  //
  // Like CC/CB/Codex, both base_url styles with / without /v1 are supported.
  app.post("/workbuddy/:spaceId/v1/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/responses", (c) => handleWorkbuddyEndpoint(c, config));
  // Compatible with the style where base_url has no /v1
  app.post("/workbuddy/:spaceId/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/responses", (c) => handleWorkbuddyEndpoint(c, config));

  // The `/cost-guard` / `/analyse` marker routes on the Codex side -- fully aligned with CC/CB:
  // the marker is an independent segment in the URL (after `/{agent}/{spaceId}`), with the same gating switches.
  // If these routes are not registered, the 5-segment path `/codex/{spaceId}/cost-guard/responses` neither
  // matches the 8 exact codex routes above nor any agent-prefixed route, and falls
  // through to the catch-all `POST /*` -> handleChatCompletions, hitting the OpenAI /chat/completions upstream with a Responses API
  // body, returning a 200 chatcmpl-* that crashes the client.
  //
  // `/cost-guard` semantics: after the primary handler detects this segment it enables cost-guard routing;
  //   the codex-side handler must read hasCostGuardMarker in forwardToUpstream
  //   to decide whether to go through the router. (Currently codexHandler.ts has not yet wired in resolveForwardTarget,
  //   see the P1-6 report; this commit only solves route registration and the silent-200 fall-through
  //   problem, letting requests reach codexHandler first. Actual support for cost-guard router
  //   dispatch is handled in a separate commit.)
  //
  // `/analyse` semantics: after AssetReflectionInjector detects this segment it appends an `<asset_reflection>`
  //   reflection block to the end of the system prompt; codexHandler.ts already passes requestPath
  //   to the injection pipeline (see `requestPath:
  //   c.req.path` in the injection section of codexHandler.ts), so once the route registers the `/analyse` marker it takes effect for codex immediately.
  if (config.costGuard.markerOptIn) {
    app.post("/codex/:spaceId/cost-guard/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/responses", (c) => handleCodexEndpoint(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/codex/:spaceId/analyse/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/analyse/responses", (c) => handleCodexEndpoint(c, config));
  }

  // ── deepseek-harness (dsh) endpoints ──────────────────────────────────────
  // dsh is DeepSeek's official agent harness, protocol = standard OpenAI Chat Completions
  // (POST /chat/completions + SSE), with body/messages shape 100% compatible with the existing CB handler.
  //
  // Client behaviour differences (confirmed by captured fixtures/*.req.json,
  // see docs/dsh-recon/2026-08-14-dsh-capture-analysis.md):
  //   - dsh source endpoint constant: `${baseURL}/chat/completions` (**without /v1**,
  //     see packages/llm/llm-deepseek/src/adapter.ts:301)
  //   - suggested user config: OPENAI_BASE_URL=http://<proxy>:8096/dsh/<spaceId>
  //   - aligned with the CC/CB/Codex/Workbuddy convention, both paths **with v1** and **without v1** are accepted,
  //     and the user may choose to set baseURL to `.../dsh/<spaceId>` or `.../dsh/<spaceId>/v1`
  //
  // Recognition of the main / title / compaction request types is not done at the route layer, but by classifyRequest in agent-adapters/dsh.ts
  // by header + body features (see its doc).
  app.post("/dsh/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));
  app.post("/dsh/:spaceId/chat/completions", (c) => handleChatCompletions(c, config));
  // No embeddings/moderations/completions seen in dsh captures so far; aux endpoints reserved (symmetric with CC/CB)
  app.post("/dsh/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // dsh cost-guard / analyse marker routes -- fully symmetric with CC/CB/Codex.
  // Following the codex comment: these four 5-segment paths must be registered explicitly, otherwise they fall through to the catch-all
  // POST /* (the default path), and the marker silently fails.
  if (config.costGuard.markerOptIn) {
    app.post("/dsh/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/dsh/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // opencode cost-guard / analyse marker routes -- fully symmetric with CC/CB/Codex/dsh.
  // The opencode client uses standard OpenAI Chat Completions (POST /v1/chat/completions),
  // with a path shape in the same family as CB/dsh; so the marker-segment routing shape is the same as dsh:
  //   /opencode/{spaceId}/cost-guard/v1/chat/completions
  //   /opencode/{spaceId}/cost-guard/chat/completions (when the client base has no /v1)
  // If these 5-segment paths are not registered explicitly, they fall through to the catch-all POST /*, and the marker silently fails.
  // Router dispatch is already passed to resolveForwardTarget in handler.ts via agentName=agentFromPath("opencode"),
  // so as long as the route can hit, the Router can decide per the agentSource=opencode branch.
  if (config.costGuard.markerOptIn) {
    app.post("/opencode/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/opencode/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  app.post("/:agent/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Legacy /proxy/<spaceId>/ prefix — no agent info, defaults to codebuddy.
  // Kept for compatibility with clients that carry no agent prefix.
  app.post("/proxy/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/*", (c) => handleChatCompletions(c, config));

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", (c) => handleChatCompletions(c, config));

  return app;
}
