import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  // Optional: client access address (e.g. the baseUrl of CodeBuddy / ClaudeCode CLI).
  // Difference from `gateway_endpoint`:
  //   - `gateway_endpoint` is always the forwarding address from the Panel backend -> Kernel (core / gateway),
  //     the gateway in production, and in local open-source deployments it can point directly at core; this field controls **panel forwarding** and must never be moved.
  //   - `proxy_endpoint` is only used by the frontend to compose the "client access address" card for display.
  //     In production the gateway sits behind the proxy and the two values coincide (can be omitted; falls back to gateway_endpoint to keep the old behavior);
  //     in local open-source deployments core and proxy run separately and clients must connect to the proxy, so this field has to be filled in explicitly.
  proxy_endpoint: z.string().url().optional(),
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  /** See the comment above instanceSchema.proxy_endpoint; if not configured the frontend falls back to gateway_endpoint. */
  proxy_endpoint?: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * Forwarding address from the Panel backend -> Kernel (e.g. https://weaverai.platform.weaversoft.io or https://api.weaverai.example.com).
   * Not a secret -- CodeBuddy / ClaudeCode CLI users have historically also used it to configure baseUrl;
   * the frontend must not hard-code it, as each instance's endpoint differs (dev/staging/prod).
   * `api_key` is a secret and is not sent down.
   */
  gateway_endpoint: string;
  /**
   * Optional: client access baseUrl (used when the frontend "client access address" card is displayed).
   * When absent the frontend falls back to `gateway_endpoint`, equivalent to the old behavior. **Not used by the Panel forwarding path**.
   */
  proxy_endpoint?: string;
}

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstanceRegistryError';
  }
}

export class InstanceRegistry {
  private readonly byId: Map<string, InstanceEntry>;

  constructor(entries: InstanceEntry[]) {
    this.byId = new Map(entries.map((e) => [e.instance_id, e]));
  }

  static load(configPath: string): InstanceRegistry {
    const filePath = resolve(configPath);
    if (!existsSync(filePath)) {
      throw new InstanceRegistryError(
        500,
        `metadata instances config not found: ${filePath}\n` +
          `  hint: cp config/metadata-instances.example.json config/metadata-instances.json`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
      throw new InstanceRegistryError(500, `invalid metadata instances config: ${filePath}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InstanceRegistryError(500, `metadata instances config validation failed`);
    }
    const entries = parsed.data.instances.map((row) => ({
      instance_id: row.id,
      name: row.name,
      gateway_endpoint: row.gateway_endpoint,
      proxy_endpoint: row.proxy_endpoint,
      api_key: row.api_key,
    }));
    return new InstanceRegistry(entries);
  }

  resolve(instanceId: string): InstanceEntry {
    const entry = this.byId.get(instanceId);
    if (!entry) {
      throw new InstanceRegistryError(400, 'INVALID_INSTANCE');
    }
    return entry;
  }

  listPublic(): PublicInstance[] {
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint, proxy_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
      // If not filled, the field is not sent down (not an explicit undefined; the frontend `??` fallback is cleaner)
      ...(proxy_endpoint ? { proxy_endpoint } : {}),
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
