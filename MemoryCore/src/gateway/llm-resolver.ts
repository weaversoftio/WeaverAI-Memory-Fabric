/**
 * LLM provider resolver -- combines the llm section in yaml and the memory systemUser into
 * a {baseUrl, apiKey, model, ...} config directly usable by the kernel runner.
 *
 * Two modes:
 *   1. provider="openai" (default): return the llm config as is, backward compatible
 *   2. provider="proxy": assemble baseUrl into `${baseUrl}/proxy/<instanceId>/v1`,
 *      apiKey uses metadata.systemUser.memory.userKey (memory system role sk-mem-xxx).
 *      This way all kernel LLM calls carry the memory identity and go through context_proxy's unified auth,
 *      cost guard, and observability chain.
 *
 * Single responsibility: this file only "computes the final baseUrl / apiKey" and does not create a runner; the four integration points
 * (wamf-core.ts:636/987/1037/1082, server.ts buildOffloadLlmClient) call this function
 * uniformly before constructing a runner.
 */

import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { GatewayMetadataConfig } from "./config.js";
import {
  isValidMemorySystemUserKey,
  resolveMemorySystemUserConfig,
  type MemorySystemUserConfig,
} from "../metadata/system-user.js";

export class LlmResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResolveError";
  }
}

/**
 * Compute the final (baseUrl, apiKey, model, ...) of kernel LLM calls for the given instanceId.
 *
 * @param llm            the llm section in the gateway yaml (including provider)
 * @param instanceId     the instance id currently being handled (used to build the path when provider=proxy)
 * @param memorySystemUser the resolved memory system-user config (optional, used only when provider=proxy and
 *                         useMemorySystemUserKey=true)
 *
 * @throws {LlmResolveError} when provider=proxy but required config is missing
 */
export function resolveEffectiveLlmConfig(
  llm: StandaloneLLMConfig,
  instanceId: string | undefined,
  memorySystemUser: MemorySystemUserConfig | undefined,
): StandaloneLLMConfig {
  const provider = llm.provider ?? "openai";
  if (provider !== "proxy") {
    // Default path: return as is, behavior fully equivalent to before the change
    return llm;
  }

  // provider=proxy validation
  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl to point to the context_proxy root URL (e.g. http://127.0.0.1:8096)",
    );
  }
  if (!instanceId || !instanceId.trim()) {
    throw new LlmResolveError(
      "llm.provider=proxy requires an instanceId, but core's current instanceId is empty — " +
      "in service mode make sure requests send x-wamf-service-id; in standalone mode make sure the yaml has instanceId",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  let effectiveApiKey = llm.apiKey;
  if (useSystemUserKey) {
    if (!memorySystemUser) {
      throw new LlmResolveError(
        "llm.provider=proxy with llm.proxy.useMemorySystemUserKey=true requires " +
        "a complete metadata.systemUser.memory (userId + userKey), which is missing",
      );
    }
    if (!isValidMemorySystemUserKey(memorySystemUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
    effectiveApiKey = memorySystemUser.userKey;
  }

  if (!effectiveApiKey) {
    throw new LlmResolveError(
      "llm.provider=proxy with useMemorySystemUserKey=false requires an explicit llm.apiKey",
    );
  }

  // baseUrl concatenation rule: strip the trailing slash, append /proxy/<iid>/v1
  const cleanBase = llm.baseUrl.replace(/\/+$/, "");
  const proxyBaseUrl = `${cleanBase}/proxy/${encodeURIComponent(instanceId)}/v1`;

  return {
    ...llm,
    baseUrl: proxyBaseUrl,
    apiKey: effectiveApiKey,
  };
}

/**
 * Only validates and returns no config -- used for startup "fail-fast" checks.
 * In standalone mode instanceId is generally "default" and can be validated directly;
 * in service mode instanceId is only known per request, so startup only validates that systemUser is valid.
 */
export function validateLlmProviderConfig(
  llm: StandaloneLLMConfig,
  metadata: GatewayMetadataConfig,
): void {
  if (llm.provider !== "proxy") return;

  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl to point to the context_proxy root URL",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  if (useSystemUserKey) {
    const memoryUser = resolveMemorySystemUserConfig(metadata);
    if (!memoryUser) {
      throw new LlmResolveError(
        "llm.provider=proxy with useMemorySystemUserKey=true requires " +
        "a complete metadata.systemUser.memory (userId + userKey)",
      );
    }
    if (!isValidMemorySystemUserKey(memoryUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
  } else if (!llm.apiKey) {
    throw new LlmResolveError(
      "llm.provider=proxy with useMemorySystemUserKey=false requires an explicit llm.apiKey",
    );
  }
}
