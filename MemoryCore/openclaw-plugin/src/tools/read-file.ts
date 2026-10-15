/**
 * wamf_read_file tool — reads memory pipeline artifacts by relative path
 * through the Gateway's isolated v3 endpoints:
 *   - "persona.md"          → v3 SDK readCore    (POST /v3/core/read)
 *   - "scene_blocks/<file>" → v3 SDK readScenario (POST /v3/scenario/read)
 */

import type { MemoryClient } from "@weaversoft/memory-fabric-sdk-ts-v2";

interface Logger {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
}

const PERSONA_KEY = "persona.md";
const SCENE_BLOCKS_PREFIX = "scene_blocks/";

export async function handleReadFile(
  client: MemoryClient,
  params: { path: string },
  logger?: Logger,
) {
  const path = params.path?.trim();

  if (!path) {
    return { content: [{ type: "text" as const, text: "Path cannot be empty." }] };
  }

  // Security: reject path traversal
  if (path.includes("..") || path.startsWith("/")) {
    return { content: [{ type: "text" as const, text: `Invalid path: "${path}"` }] };
  }

  try {
    logger?.debug?.(`[read-file] read: "${path}"`);
    let content: string | null;
    if (path === PERSONA_KEY) {
      content = (await client.readCore()).content;
    } else if (path.startsWith(SCENE_BLOCKS_PREFIX) && path.length > SCENE_BLOCKS_PREFIX.length) {
      content = (await client.readScenario({ path: path.slice(SCENE_BLOCKS_PREFIX.length) })).content;
    } else {
      return {
        content: [{
          type: "text" as const,
          text: `Unsupported path: "${path}". Readable paths are "${PERSONA_KEY}" and "${SCENE_BLOCKS_PREFIX}<file>.md".`,
        }],
      };
    }

    if (content === null || content === undefined) {
      return { content: [{ type: "text" as const, text: `File not found: ${path}` }] };
    }
    logger?.debug?.(`[read-file] ✅ "${path}" (${content.length} chars)`);
    return { content: [{ type: "text" as const, text: content }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`[read-file] Failed to read "${path}": ${msg}`);
    return { content: [{ type: "text" as const, text: `Failed to read file: ${msg}` }] };
  }
}
