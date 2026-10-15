/**
 * Chat-memory tools. Each tool maps onto one WeaverAI Memory Fabric panel endpoint
 * (/api/v1/chat-memory/*), called with the caller's own user key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HubClient, HubError } from "./hub.js";
import { loadIdentity, resolveTarget, type Target, type TargetHint } from "./identity.js";
import { getProjectSettings, setProjectSaving, NO_MEMORY_TAG } from "./project.js";
import { redactSecrets } from "./hooks.js";

export interface RequestContext {
  hub: HubClient;
  identityCacheMs: number;
  /** Default agent from the client's X-Memory-Agent-Id / X-Memory-Team-Id headers. */
  defaultTarget: TargetHint;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const MEMORY_TYPES = ["work_fact", "work_task", "work_method", "work_artifact", "persona", "episodic", "instruction"] as const;

const targetArgs = {
  agent_id: z
    .string()
    .optional()
    .describe("Which agent's memory to use. Omit to use your default agent (see memory_whoami)."),
  team_id: z.string().optional().describe("Team of agent_id. Only needed for an agent you don't own."),
};

interface LayerItem {
  id: string;
  title?: string;
  role?: string;
  body?: string;
  created_at?: string;
  score?: number;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function failure(err: unknown): ToolResult {
  const msg =
    err instanceof HubError
      ? `WeaverAI Memory Fabric panel error ${err.code}: ${err.message}`
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text: msg }], isError: true };
}

function clip(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters]` : s;
}

function formatItems(items: LayerItem[], bodyMax: number): string {
  return items
    .map((it) => {
      const meta = [it.title, it.role, it.created_at, typeof it.score === "number" ? `score ${it.score.toFixed(2)}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `- id ${it.id}${meta ? ` (${meta})` : ""}\n  ${clip(it.body, bodyMax).replace(/\n/g, "\n  ")}`;
    })
    .join("\n");
}

async function target(ctx: RequestContext, args: { agent_id?: string; team_id?: string }): Promise<Target> {
  const identity = await loadIdentity(ctx.hub, ctx.identityCacheMs);
  return resolveTarget(identity, { agentId: args.agent_id, teamId: args.team_id }, ctx.defaultTarget);
}

function where(t: Target): string {
  return `${t.agentName} (${t.agentId}) in ${t.teamName}`;
}

export function registerChatMemoryTools(server: McpServer, ctx: RequestContext): void {
  server.registerTool(
    "memory_whoami",
    {
      title: "Who am I in Agent Memory",
      description:
        "Show which Agent Memory user your key belongs to, the agents you own (each has its own chat memory), and which agent the other memory tools use by default.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const identity = await loadIdentity(ctx.hub, ctx.identityCacheMs);
        let def = "none: pass agent_id to each tool, or set the X-Memory-Agent-Id header";
        try {
          def = where(resolveTarget(identity, {}, ctx.defaultTarget));
        } catch {
          /* several agents and no header: keep the hint */
        }
        const agents = identity.agents.length
          ? identity.agents.map((a) => `- ${a.agentName}: agent_id ${a.agentId}, team ${a.teamName} (${a.teamId})`).join("\n")
          : "- none yet (create one in the WeaverAI Memory Fabric panel)";
        return text(`User: ${identity.username} (${identity.userId})\nDefault agent: ${def}\nYour agents:\n${agents}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description:
        "Search the agent's memory by keywords. layer L1 (default) searches extracted facts, decisions and methods; L0 searches the raw conversation history. Use this before answering questions about the team's past work, conventions or decisions.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords to look for, e.g. 'staging database port'."),
        layer: z.enum(["L1", "L0"]).default("L1"),
        limit: z.number().int().min(1).max(50).default(10),
        ...targetArgs,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const t = await target(ctx, args);
        const data = await ctx.hub.post<{ items: LayerItem[]; total: number }>("chat-memory/search", {
          block_id: t.blockId,
          layer: args.layer,
          query: args.query,
          limit: args.limit,
        });
        const items = data.items ?? [];
        if (items.length === 0) return text(`No ${args.layer} memories match "${args.query}" for ${where(t)}.`);
        return text(`${items.length} ${args.layer} result(s) for "${args.query}" in ${where(t)}:\n${formatItems(items, 1200)}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List memory",
      description:
        "List one memory layer, newest first. L0 = raw messages, L1 = extracted facts, L2 = scene files (pass path to read one scene in full), L3 = the agent's profile summary.",
      inputSchema: {
        layer: z.enum(["L0", "L1", "L2", "L3"]),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
        path: z.string().optional().describe("L2 only: the scene file path to read in full (from an L2 list)."),
        ...targetArgs,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const t = await target(ctx, args);
        const body: Record<string, unknown> = { block_id: t.blockId, layer: args.layer, limit: args.limit, offset: args.offset };
        if (args.path) body.path = args.path;
        const data = await ctx.hub.post<{ items: LayerItem[]; total: number }>("chat-memory/layer", body);
        const items = data.items ?? [];
        if (items.length === 0) return text(`${args.layer} is empty for ${where(t)}.`);
        const full = args.layer === "L3" || (args.layer === "L2" && !!args.path);
        return text(
          `${args.layer} for ${where(t)}: showing ${items.length} of ${data.total ?? items.length}\n${formatItems(items, full ? 20000 : 600)}`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_add",
    {
      title: "Remember a fact",
      description:
        "Save one memory (L1) for the agent right away, e.g. a decision, convention, fact about the codebase or a task. Write it as one standalone sentence that will still make sense later without this conversation. Search first to avoid saving a duplicate; to change an existing memory use memory_update.",
      inputSchema: {
        content: z.string().min(1).max(8192).describe("The memory, as one self-contained statement."),
        type: z
          .enum(MEMORY_TYPES)
          .default("work_fact")
          .describe("work_fact (default), work_task, work_method, work_artifact; persona / episodic / instruction for personal assistants."),
        priority: z.number().int().min(-1).max(100).default(50).describe("0-100, higher = more important."),
        background: z.string().max(512).optional().describe("Optional scene/topic name to group it under."),
        ...targetArgs,
      },
    },
    async (args) => {
      try {
        const t = await target(ctx, args);
        const body: Record<string, unknown> = {
          block_id: t.blockId,
          layer: "L1",
          content: redactSecrets(args.content),
          type: args.type,
          priority: args.priority,
        };
        if (args.background) body.background = args.background;
        const data = await ctx.hub.post<{ id: string; type?: string }>("chat-memory/layer-add", body);
        return text(`Saved to ${where(t)} as L1 memory ${data.id} (${data.type ?? args.type}).`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Edit memory",
      description:
        "Replace the content of an existing memory. L1: pass the memory id (from search/list). L2: pass the scene path. L3: the whole profile, no id needed. Only the owner of the agent can edit.",
      inputSchema: {
        layer: z.enum(["L1", "L2", "L3"]),
        id: z.string().optional().describe("L1 memory id or L2 scene path. Not used for L3."),
        content: z.string().min(1).describe("The full new content."),
        summary: z.string().optional().describe("L2 only: new one-line scene summary."),
        ...targetArgs,
      },
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        if ((args.layer === "L1" || args.layer === "L2") && !args.id) {
          return failure(new HubError(400, `${args.layer} needs an id (L1 memory id or L2 scene path).`));
        }
        const t = await target(ctx, args);
        const body: Record<string, unknown> = { block_id: t.blockId, layer: args.layer, content: redactSecrets(args.content) };
        if (args.id) body.id = args.id;
        if (args.summary !== undefined) body.summary = args.summary;
        await ctx.hub.post("chat-memory/layer-update", body);
        return text(`Updated ${args.layer}${args.id ? ` ${args.id}` : ""} in ${where(t)}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete memory",
      description:
        "Permanently delete memories. L1: pass memory ids. L0: pass message ids, or session_ids to delete whole conversations. Only the owner of the agent can delete. Confirm with the user before deleting.",
      inputSchema: {
        layer: z.enum(["L1", "L0"]),
        ids: z.array(z.string()).max(5000).optional().describe("L1 memory ids, or L0 message ids."),
        session_ids: z.array(z.string()).max(100).optional().describe("L0 only: delete these whole sessions."),
        ...targetArgs,
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        const ids = args.ids ?? [];
        const sessions = args.session_ids ?? [];
        if (ids.length === 0 && sessions.length === 0) {
          return failure(new HubError(400, "Pass ids (or session_ids for L0) to delete."));
        }
        const t = await target(ctx, args);
        const body: Record<string, unknown> = { block_id: t.blockId, layer: args.layer };
        if (args.layer === "L1") body.ids = ids;
        else {
          if (ids.length) body.message_ids = ids;
          if (sessions.length) body.session_ids = sessions;
        }
        const data = await ctx.hub.post<{ deleted_count?: number }>("chat-memory/layer-delete", body);
        return text(`Deleted ${data?.deleted_count ?? "the requested"} ${args.layer} item(s) from ${where(t)}.`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_save_conversation",
    {
      title: "Save conversation to memory",
      description:
        "Save conversation messages to the agent's raw history (L0). The memory pipeline later extracts facts from them into L1 automatically. Use it to record a session summary or an important exchange; for a single fact use memory_add instead.",
      inputSchema: {
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
          .min(1)
          .max(100),
        session_id: z.string().optional().describe("Group these messages under one session (e.g. your conversation id)."),
        ...targetArgs,
      },
    },
    async (args) => {
      try {
        const t = await target(ctx, args);
        const messages = args.messages.map((m) => ({ ...m, content: redactSecrets(m.content) }));
        const body: Record<string, unknown> = { team_id: t.teamId, agent_id: t.agentId, messages };
        if (args.session_id) body.session_id = args.session_id;
        const data = await ctx.hub.post<{ accepted_count: number; session_id: string }>("chat-memory/import", body);
        return text(
          `Saved ${data.accepted_count} message(s) to L0 of ${where(t)} (session ${data.session_id}). Facts are extracted into L1 in the background.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "memory_project_saving",
    {
      title: "Turn saving of a project's conversations on or off",
      description:
        "Whether the hooks save this project's conversations (raw history, L0) to Agent Memory. Saving is off until the user agrees. Pass project (the key from the session-start memory note) and save=true/false to record the user's answer; pass only project to read it; pass nothing to list every project's setting. Only call with save after the user has answered.",
      inputSchema: {
        project: z
          .string()
          .max(300)
          .optional()
          .describe('Project key from the session-start note, e.g. "bitbucket.org/weaversoft/agent-memory".'),
        save: z.boolean().optional().describe("The user's answer: true saves this project's conversations, false doesn't."),
        ...targetArgs,
      },
    },
    async (args) => {
      try {
        const t = await target(ctx, args);
        if (args.project && typeof args.save === "boolean") {
          const key = args.project.trim().toLowerCase();
          const name = key.replace(/^path:/, "").split("/").pop() || key;
          await setProjectSaving(ctx.hub, t, { key, name }, args.save);
          return text(
            args.save
              ? `Saving is on for ${name}: its conversations are now saved to ${where(t)}. ${NO_MEMORY_TAG} in a message skips a single chat.`
              : `Saving is off for ${name}: its conversations won't be saved. Memory is still loaded at the start of each session.`,
          );
        }
        const projects = await getProjectSettings(ctx.hub, t);
        if (args.project) {
          const key = args.project.trim().toLowerCase();
          const s = projects[key];
          return text(s ? `Saving is ${s.save ? "on" : "off"} for ${s.name ?? key} (decided ${s.decided_at ?? "earlier"}).` : `Saving isn't decided for ${key} yet, so it's off.`);
        }
        const rows = Object.entries(projects).map(([key, s]) => `- ${s.save ? "on " : "off"}  ${s.name ?? key}  (${key})`);
        return text(rows.length ? `Saving per project for ${where(t)}:\n${rows.join("\n")}` : "No project has been decided yet: saving is off everywhere.");
      } catch (err) {
        return failure(err);
      }
    },
  );
}
