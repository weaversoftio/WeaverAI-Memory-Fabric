/**
 * Per-project saving of raw conversations (L0) by the hooks.
 *
 * Off until the person says yes: at the first session in an undecided project the
 * agent asks them once, and their answer is kept on their own agent
 * (agent metadata_json → memory_saving.projects[key]). So it follows them across
 * machines, and this server stays stateless apart from the #nomemory pause list.
 *
 * A project is its git remote (host/path, sent by the client as X-Memory-Project with any
 * credentials removed) or, without one, its folder.
 */
import type { HubClient } from "./hub.js";
import type { Target } from "./identity.js";

export interface ProjectRef {
  /** Stable id, e.g. "bitbucket.org/weaversoft/agent-memory" or "path:c:/work/notes". */
  key: string;
  /** Short display name, e.g. "agent-memory". */
  name: string;
}

export interface ProjectSetting {
  save: boolean;
  name?: string;
  decided_at?: string;
}

export type SavingState = "on" | "off" | "undecided";

const META_KEY = "memory_saving";
const CACHE_MS = 60_000;
const settingsCache = new Map<string, { at: number; projects: Record<string, ProjectSetting> }>();
/** Chats paused with #nomemory → when. Kept in memory for a day (Claude Code also keeps a local flag). */
const paused = new Map<string, number>();

/** host/path of a git remote, without scheme, credentials or ".git"; null if it isn't one. */
export function projectFromRemote(remote: string | undefined): ProjectRef | null {
  const r = (remote ?? "").trim();
  if (!r) return null;
  let host: string;
  let path: string;
  const scp = r.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(r);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  return { key: `${host}/${path}`.toLowerCase(), name: path.split("/").pop() ?? path };
}

/** The folder, when there is no git remote. */
export function projectFromPath(dir: string | undefined): ProjectRef | null {
  const norm = (dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!norm) return null;
  return { key: `path:${norm.toLowerCase()}`, name: norm.split("/").pop() || norm };
}

function cacheKey(hub: HubClient, t: Target): string {
  return `${hub.serviceId}\u0000${hub.userKey}\u0000${t.agentId}`;
}

async function readMetadata(hub: HubClient, t: Target): Promise<Record<string, unknown>> {
  const agent = await hub.post<{ metadata_json?: string }>("meta/agent/get", { agent_id: t.agentId });
  try {
    const parsed = JSON.parse(agent?.metadata_json || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function projectsOf(meta: Record<string, unknown>): Record<string, ProjectSetting> {
  const saving = meta[META_KEY] as { projects?: Record<string, ProjectSetting> } | undefined;
  return saving?.projects && typeof saving.projects === "object" ? saving.projects : {};
}

/** Every project the person has decided on, for this agent (cached for a minute). */
export async function getProjectSettings(hub: HubClient, t: Target): Promise<Record<string, ProjectSetting>> {
  const key = cacheKey(hub, t);
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.projects;
  const projects = projectsOf(await readMetadata(hub, t));
  settingsCache.set(key, { at: Date.now(), projects });
  return projects;
}

export function stateOf(projects: Record<string, ProjectSetting>, project: ProjectRef | null): SavingState {
  if (!project) return "undecided";
  const s = projects[project.key];
  return s ? (s.save ? "on" : "off") : "undecided";
}

/** Records the person's answer. Only the agent's owner can change it (the hub enforces that). */
export async function setProjectSaving(hub: HubClient, t: Target, project: ProjectRef, save: boolean): Promise<void> {
  const meta = await readMetadata(hub, t);
  const saving = (meta[META_KEY] as Record<string, unknown> | undefined) ?? {};
  const projects = { ...projectsOf(meta), [project.key]: { save, name: project.name, decided_at: new Date().toISOString() } };
  meta[META_KEY] = { ...saving, projects };
  await hub.post("meta/agent/update", { agent_id: t.agentId, metadata_json: JSON.stringify(meta) });
  settingsCache.delete(cacheKey(hub, t));
}

/** Test hook: forget cached settings and #nomemory pauses. */
export function clearProjectCache(): void {
  settingsCache.clear();
  paused.clear();
}

// ── #nomemory: stop saving one chat ──────────────────────────────────────

export const NO_MEMORY_TAG = "#nomemory";
const PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

export function pauseSession(session: string): void {
  const now = Date.now();
  for (const [s, at] of paused) if (now - at > PAUSE_TTL_MS) paused.delete(s);
  paused.set(session, now);
}

export function isPaused(session: string): boolean {
  const at = paused.get(session);
  return at !== undefined && Date.now() - at <= PAUSE_TTL_MS;
}

export function wantsNoMemory(text: string | undefined): boolean {
  return (text ?? "").toLowerCase().includes(NO_MEMORY_TAG);
}

// ── Trivial turns ────────────────────────────────────────────────────────

const TRIVIAL = new Set([
  "ok", "okay", "okey", "k", "kk", "thanks", "thank you", "thanks a lot", "thx", "ty", "tnx",
  "cool", "nice", "great", "perfect", "got it", "noted", "lol", "👍", "🙏", "👌",
]);

/** Pure acknowledgements carry nothing worth keeping on their own. */
export function isTrivial(text: string | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase().replace(/[.!?,\s]+$/u, "").replace(/\s+/g, " ");
  return !t || TRIVIAL.has(t);
}
