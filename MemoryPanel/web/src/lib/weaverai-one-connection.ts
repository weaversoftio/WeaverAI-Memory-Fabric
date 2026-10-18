/**
 * WeaverAI One (Open WebUI) → Memory Fabric proxy connection recipe.
 *
 * OWUI Admin → Settings → Connections → OpenAI uses:
 *   API Base URL, API Key, Prefix ID, Model ID
 * plus request headers that preselect team / agent / task / conversation.
 */

export const WEAVERAI_ONE_KEY_PLACEHOLDER = '<your-team-memory-api-key>';
export const WEAVERAI_ONE_DEFAULT_PREFIX = 'proxy';
export const WEAVERAI_ONE_DEFAULT_PROXY_HOST =
  'https://weaverai-memory-fabric-proxy.platform.weaversoft.io';

export interface WeaveraiOneConnectionInput {
  proxyBase: string;
  instanceId: string;
  teamId: string;
  agentId: string;
  /** Upstream model id sent in the chat body (must exist on the MF→LiteLLM upstream). */
  modelId: string;
  /** OWUI "Prefix ID" field; path segment is always `proxy` for the legacy OpenAI URL. */
  prefixId?: string;
  taskId?: string;
  apiKeyPlaceholder?: string;
}

/** OpenAI-compatible base: `{proxy}/proxy/{instanceId}/v1` */
export function weaveraiOneProxyUrl(proxyBase: string, instanceId: string): string {
  const base = (proxyBase || WEAVERAI_ONE_DEFAULT_PROXY_HOST).replace(/\/$/, '');
  const iid = instanceId.trim() || 'default';
  return `${base}/proxy/${iid}/v1`;
}

export function weaveraiOneHeadersJson(input: {
  teamId: string;
  agentId: string;
  taskId?: string;
}): string {
  return JSON.stringify(
    {
      'x-team-id': input.teamId,
      'x-agent-id': input.agentId,
      'x-task-id': input.taskId?.trim() || 'no-task',
      'x-conversation-id': '{{CHAT_ID}}',
    },
    null,
    2,
  );
}

/** Full copy-paste recipe for WeaverAI One / Open WebUI admin connections. */
export function weaveraiOneConnectionConfig(input: WeaveraiOneConnectionInput): string {
  const url = weaveraiOneProxyUrl(input.proxyBase, input.instanceId);
  const prefix = (input.prefixId ?? WEAVERAI_ONE_DEFAULT_PREFIX).trim() || WEAVERAI_ONE_DEFAULT_PREFIX;
  const key = input.apiKeyPlaceholder ?? WEAVERAI_ONE_KEY_PLACEHOLDER;
  const headers = weaveraiOneHeadersJson(input);
  return [
    '# WeaverAI One (Open WebUI)',
    '# Admin → Settings → Connections → OpenAI (compatible)',
    `API Base URL: ${url}`,
    `API Key: ${key}`,
    `Prefix ID: ${prefix}`,
    `Model ID: ${input.modelId}`,
    '',
    '# Required request headers (Connection advanced / extra_headers):',
    headers,
  ].join('\n');
}
