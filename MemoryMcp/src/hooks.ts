/**
 * Hook endpoints: let a coding agent's own lifecycle hooks save every turn to L0 and load
 * the agent's memory at session start, without relying on the model to call a tool.
 *
 *   POST /hooks/claude-code   body = Claude Code hook input (SessionStart, UserPromptSubmit, Stop)
 *   POST /hooks/cursor        body = Cursor hook input (sessionStart, beforeSubmitPrompt, afterAgentResponse)
 *
 * The client forwards its hook input unchanged (e.g. `curl --data-binary @-`) with the same
 * headers the MCP uses, plus X-Memory-Project (the repo's git remote), and gets back the JSON
 * that client expects. A hook must never break the user's session, so failures still answer
 * 200 with a safe body.
 *
 * What gets saved: only turns in projects the person said yes to (asked once per project;
 * see project.ts), never a chat after "#nomemory", and never a bare "ok"/"thanks".
 * Loading memory at session start happens everywhere.
 */
import { HubClient } from "./hub.js";
import { loadIdentity, resolveTarget, type Target, type TargetHint } from "./identity.js";
import {
  getProjectSettings,
  isPaused,
  isTrivial,
  pauseSession,
  projectFromPath,
  projectFromRemote,
  stateOf,
  wantsNoMemory,
  NO_MEMORY_TAG,
  type ProjectRef,
  type SavingState,
} from "./project.js";

export type HookClient = "claude-code" | "cursor";

export interface HookContext {
  hub: HubClient;
  identityCacheMs: number;
  defaultTarget: TargetHint;
  /** The client's git remote for the project (X-Memory-Project), if it sent one. */
  projectRemote?: string;
  log?: (msg: string) => void;
}

/** L0 accepts at most 8192 characters per message; stay under it. */
const MAX_MESSAGE_CHARS = 8000;
/** Panel import accepts at most 100 messages per call. */
const MAX_MESSAGES_PER_CALL = 100;
/** Size of the memory summary added at session start. */
const PROFILE_MAX_CHARS = 3000;
const SCENES_MAX = 30;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-mem-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  // Bitbucket / Atlassian API tokens
  [/\bAT(?:BB|ATT|CTT)[A-Za-z0-9_=+/-]{20,}/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  // JWTs, including WAIP and Keycloak tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [REDACTED]"],
  // user:password@ in URLs (database, git and broker connection strings)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[REDACTED]@"],
  // password=..., api_key: "...", token=... assignments
  // (lookbehind instead of \b so DB_PASSWORD / GIT_TOKEN match too)
  [/(?<![A-Za-z])((?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|token)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[REDACTED]"],
];

/** Mask obvious credentials before anything is stored. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, replacement]) => t.replace(re, replacement), text);
}

export function chunk(text: string, size = MAX_MESSAGE_CHARS): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

async function target(ctx: HookContext): Promise<Target> {
  const identity = await loadIdentity(ctx.hub, ctx.identityCacheMs);
  return resolveTarget(identity, {}, ctx.defaultTarget);
}

/** Save one side of a turn to L0 (long texts are split into several messages). */
export async function saveMessage(
  ctx: HookContext,
  sessionId: string,
  role: "user" | "assistant",
  text: string | undefined,
): Promise<number> {
  const clean = redactSecrets((text ?? "").trim());
  if (!clean) return 0;
  const t = await target(ctx);
  const messages = chunk(clean).map((content) => ({ role, content }));
  let saved = 0;
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_CALL) {
    const data = await ctx.hub.post<{ accepted_count?: number }>("chat-memory/import", {
      team_id: t.teamId,
      agent_id: t.agentId,
      session_id: sessionId,
      messages: messages.slice(i, i + MAX_MESSAGES_PER_CALL),
    });
    saved += data?.accepted_count ?? 0;
  }
  return saved;
}

interface LayerItem {
  id: string;
  title?: string;
  body?: string;
}

const RECENT_FACTS = 10;

async function readLayer(ctx: HookContext, t: Target, layer: "L1" | "L2" | "L3", limit: number): Promise<LayerItem[]> {
  const data = await ctx.hub.post<{ items: LayerItem[] }>("chat-memory/layer", { block_id: t.blockId, layer, limit, offset: 0 });
  return data.items ?? [];
}

function projectOf(ctx: HookContext, dir: string | undefined): ProjectRef | null {
  return projectFromRemote(ctx.projectRemote) ?? projectFromPath(dir);
}

async function savingState(ctx: HookContext, project: ProjectRef | null): Promise<SavingState> {
  return stateOf(await getProjectSettings(ctx.hub, await target(ctx)), project);
}

/** Saves one side of a turn if this project's saving is on and the chat isn't paused. */
async function saveTurn(
  ctx: HookContext,
  session: string,
  project: ProjectRef | null,
  role: "user" | "assistant",
  text: string | undefined,
): Promise<void> {
  if (isPaused(session)) return;
  if (role === "user" && isTrivial(text)) return;
  if (!(text ?? "").trim()) return;
  if ((await savingState(ctx, project)) !== "on") return;
  await saveMessage(ctx, session, role, text);
}

/** What the agent should know (and do) about saving this project's conversations. */
function projectNote(project: ProjectRef | null, state: SavingState): string[] {
  if (!project) return [];
  if (state === "on") {
    return [
      "",
      `## Saving: on for ${project.name}`,
      `This project's conversations are saved to Agent Memory. To stop: the user says so (call memory_project_saving with project="${project.key}", save=false), or writes ${NO_MEMORY_TAG} in a message to skip just this chat.`,
    ];
  }
  if (state === "off") {
    return [
      "",
      `## Saving: off for ${project.name}`,
      `This project's conversations are not saved (the user's choice). If they ask to save them, call memory_project_saving with project="${project.key}", save=true.`,
    ];
  }
  return [
    "",
    `## Saving: not decided for ${project.name}`,
    `Agent Memory doesn't save this project's conversations until the user agrees. Early in this session, at a natural point (not in the middle of a task), ask the user once:`,
    `"Should Agent Memory save our conversations in ${project.name}? They become searchable memory for you and your agents. You can turn it off any time, and ${NO_MEMORY_TAG} in a message skips a single chat."`,
    `Then call memory_project_saving with project="${project.key}" and save=true or save=false. If they decline, don't ask again.`,
  ];
}

/** The memory summary added to a new session: L3 profile plus the L2 scene index (or recent L1 facts early on). */
export async function buildSessionContext(ctx: HookContext, project: ProjectRef | null = null): Promise<string> {
  const t = await target(ctx);
  const [profile, scenes, projects] = await Promise.all([
    readLayer(ctx, t, "L3", 1),
    readLayer(ctx, t, "L2", SCENES_MAX),
    getProjectSettings(ctx.hub, t),
  ]);

  const lines = [`# WeaverAI Memory Fabric: ${t.agentName} (team ${t.teamName})`];
  const profileText = profile[0]?.body?.trim();
  if (profileText) {
    lines.push("", "## What the team already knows", profileText.length > PROFILE_MAX_CHARS ? `${profileText.slice(0, PROFILE_MAX_CHARS)}…` : profileText);
  }
  if (scenes.length) {
    lines.push("", "## Memory scenes (read one with memory_list, layer L2, path)");
    for (const s of scenes) {
      const summary = (s.body ?? "").split("\n").find((l) => l.trim()) ?? "";
      lines.push(`- ${s.title ?? s.id}${summary ? `: ${summary.slice(0, 160)}` : ""}`);
    }
  }
  if (!profileText && !scenes.length) {
    // Early on there's no profile or scenes yet; show the newest facts instead.
    const facts = await readLayer(ctx, t, "L1", RECENT_FACTS);
    if (facts.length) {
      lines.push("", "## Recent facts");
      for (const f of facts) lines.push(`- ${(f.body ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
    } else {
      lines.push("", "Nothing is stored for this agent yet.");
    }
  }
  lines.push(...projectNote(project, stateOf(projects, project)));
  lines.push(
    "",
    "Use memory_search before answering questions about past decisions, conventions or project facts. Save durable facts with memory_add. Never save secrets.",
  );
  return lines.join("\n");
}

interface ClaudeCodeHookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
}

interface CursorHookInput {
  hook_event_name?: string;
  workspace_roots?: string[];
  conversation_id?: string;
  session_id?: string;
  prompt?: string;
  text?: string;
}

const PAUSED_NOTE = `WeaverAI Memory Fabric: this chat is no longer saved (the user wrote ${NO_MEMORY_TAG}). Don't save anything from it with the memory tools either.`;

/** Returns the JSON body to send back to the client. Never throws. */
export async function handleHook(client: HookClient, input: unknown, ctx: HookContext): Promise<Record<string, unknown>> {
  const log = ctx.log ?? (() => {});
  if (client === "claude-code") {
    const h = (input ?? {}) as ClaudeCodeHookInput;
    const session = `claude-code-${h.session_id ?? "unknown"}`;
    const project = projectOf(ctx, h.cwd);
    try {
      switch (h.hook_event_name) {
        case "SessionStart":
          return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: await buildSessionContext(ctx, project) } };
        case "UserPromptSubmit":
          if (wantsNoMemory(h.prompt)) {
            pauseSession(session);
            return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: PAUSED_NOTE } };
          }
          await saveTurn(ctx, session, project, "user", h.prompt);
          return {};
        case "Stop":
          await saveTurn(ctx, session, project, "assistant", h.last_assistant_message);
          return {};
        default:
          return {};
      }
    } catch (err) {
      log(`[hooks] claude-code ${h.hook_event_name}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  const h = (input ?? {}) as CursorHookInput;
  const session = `cursor-${h.conversation_id ?? h.session_id ?? "unknown"}`;
  const project = projectOf(ctx, h.workspace_roots?.[0]);
  try {
    switch (h.hook_event_name) {
      case "sessionStart":
        return { additional_context: await buildSessionContext(ctx, project) };
      case "beforeSubmitPrompt":
        if (wantsNoMemory(h.prompt)) {
          pauseSession(session);
          return { continue: true };
        }
        await saveTurn(ctx, session, project, "user", h.prompt);
        return { continue: true };
      case "afterAgentResponse":
        await saveTurn(ctx, session, project, "assistant", h.text);
        return {};
      default:
        return {};
    }
  } catch (err) {
    log(`[hooks] cursor ${h.hook_event_name}: ${err instanceof Error ? err.message : String(err)}`);
    // Saving memory must never stop the user from sending a prompt.
    return h.hook_event_name === "beforeSubmitPrompt" ? { continue: true } : {};
  }
}
