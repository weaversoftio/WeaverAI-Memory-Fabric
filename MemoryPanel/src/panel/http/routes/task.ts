/**
 * /api/v1/task/list-with-agents -- Task aggregation endpoint (eliminates N+1 at the Panel layer).
 *
 * Why this endpoint exists:
 *   The kernel `task/list` only returns the task itself, without linked_agents.
 *   The frontend used to call `task/get` + `task-agent/list` one by one (2N+1 calls),
 *   so 10 tasks = 21 requests, a severe N+1.
 *
 * Panel-layer aggregation:
 *   1. Call kernel `task/list` once to get the task list (with pagination)
 *   2. Call `task-agent/list` N times in parallel to fill in linked_agents
 *   3. Return `{ items: TaskWithAgents[], total, limit, offset }` to the frontend in one go
 *
 * The network round trips are absorbed inside the Panel layer (same host, very low latency); the frontend sends just 1 request.
 *
 * /api/v1/task/outputs -- what the task's agents produced (L1 memories tagged with this task_id).
 *   Agents/users come from the task's participation log (written by the proxy when an agent works on the task)
 *   plus the explicitly linked agents. Outputs of team agents are visible to every team member;
 *   outputs of private agents only to their owner, team admins and instance admins.
 */
import type { Hono, Context } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import { toKernelCredentials, type MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { respondEnvelope, respondControlError } from "../envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { fetchAllMetaListItems, isCallerTeamAdmin, resolveCaller } from "./knowledge/common.js";

function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get("panelMeta");
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get("reqId"),
  };
}

function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: "ok", request_id: c.get("reqId") ?? "", data };
}

// -- Type definitions ---------------------------------------------------------

interface TaskEntity {
  task_id: string;
  team_id: string;
  title: string;
  description?: string;
  status: string;
  source_type?: string;
  risk_level?: string;
  created_at: string;
  updated_at: string;
}

interface TaskAgent {
  agent_id: string;
  task_id: string;
  team_id: string;
  status: string;
  created_at: string;
}

interface TaskWithAgents extends TaskEntity {
  agents: TaskAgent[];
}

interface ListWithAgentsBody {
  team_id: string;
  limit?: number;
  offset?: number;
  status?: string;
  title?: string;
}

// -- Route registration -------------------------------------------------------

export function registerTaskRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * POST /api/v1/task/list-with-agents
   *
   * Aggregates task/list + batch task-agent/list, returning the task list and its associated agents in one go.
   * The frontend only calls this one endpoint; N+1 is no longer needed.
   */
  api.post(
    "/task/list-with-agents",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const body = await c.req
        .json<ListWithAgentsBody>()
        .catch(() => ({ team_id: "" }) as ListWithAgentsBody);
      const { team_id: teamId, limit, offset, status, title } = body;

      if (!teamId) {
        return respondControlError(c, 400, "MISSING_TEAM_ID");
      }

      const ctx = buildCtx(c);

      // 1. Call task/list once to get the task list (with pagination)
      const listPayload: Record<string, unknown> = { team_id: teamId };
      if (typeof limit === "number" && limit > 0)
        listPayload.limit = Math.min(limit, 200);
      if (typeof offset === "number" && offset >= 0)
        listPayload.offset = offset;
      if (status) listPayload.status = status;
      if (title) listPayload.title = title;

      const taskEnv = await deps.metaKernel.invoke(
        "task/list",
        listPayload,
        ctx,
      );

      if (taskEnv.code !== 0) return respondEnvelope(c, taskEnv);

      const taskData = taskEnv.data as {
        items?: TaskEntity[];
        total?: number;
        limit?: number;
        offset?: number;
      } | null;

      const tasks = taskData?.items ?? [];
      const total = taskData?.total ?? tasks.length;

      // 2. Call task-agent/list N times in parallel to fill in linked_agents
      //    Parallel in batches (20 each), to avoid overwhelming the kernel connection pool when N is large.
      //    Reads do not conflict with reads (SQLite WAL / MongoDB), but connection/thread counts have a limit.
      const BATCH_SIZE = 20;
      const agentsResults: TaskAgent[][] = [];
      for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map((t) =>
            deps.metaKernel
              .invoke("task-agent/list", { task_id: t.task_id }, ctx)
              .then((env) =>
                env.code === 0 && env.data
                  ? ((env.data as { items?: TaskAgent[] }).items ?? [])
                  : [],
              )
              .catch(() => [] as TaskAgent[]),
          ),
        );
        agentsResults.push(...batchResults);
      }

      // 3. Merge and return
      const items: TaskWithAgents[] = tasks.map((t, i) => ({
        ...t,
        agents: agentsResults[i] ?? [],
      }));

      return c.json(
        okEnvelope(c, {
          items,
          total,
          limit: (listPayload.limit as number) ?? 50,
          offset: (listPayload.offset as number) ?? 0,
        }),
      );
    },
  );

  /**
   * POST /api/v1/task/outputs  body: { task_id, limit? }
   */
  api.post("/task/outputs", validatePanelMetaHeaders(deps), async (c) => {
    const body = await c.req
      .json<{ task_id?: string; limit?: number }>()
      .catch(() => ({}) as { task_id?: string; limit?: number });
    const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
    if (!taskId) return respondControlError(c, 400, "MISSING_TASK_ID");
    const perAgentLimit =
      typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 200) : 50;

    const ctx = buildCtx(c);
    const caller = await resolveCaller(deps, ctx);
    if (!caller) return respondControlError(c, 401, "INVALID_USER_KEY");

    // task/get enforces team membership (or instance admin) in the kernel.
    const taskEnv = await deps.metaKernel.invoke("task/get", { task_id: taskId }, ctx);
    if (taskEnv.code !== 0 || !taskEnv.data) return respondEnvelope(c, taskEnv);
    const task = taskEnv.data as TaskEntity;
    const isAdmin = await isCallerTeamAdmin(deps, ctx, task.team_id);

    // (agent, user) pairs that worked on this task
    const pairs = new Map<string, { agent_id: string; user_id: string }>();
    const logs = await fetchAllMetaListItems<{ agent_id: string; user_id: string }>(
      deps,
      ctx,
      "participation-log/list",
      { team_id: task.team_id, task_id: taskId },
    );
    for (const l of logs) pairs.set(`${l.agent_id}|${l.user_id}`, { agent_id: l.agent_id, user_id: l.user_id });

    const links = await fetchAllMetaListItems<TaskAgent>(deps, ctx, "task-agent/list", { task_id: taskId });
    const agentIds = new Set<string>([...links.map((l) => l.agent_id), ...[...pairs.values()].map((p) => p.agent_id)]);

    interface AgentInfo {
      agent_id: string;
      name: string;
      owner_user_id: string;
      visibility?: string;
      linked: boolean;
      visible: boolean;
    }
    const agents = new Map<string, AgentInfo>();
    for (const agentId of agentIds) {
      const env = await deps.metaKernel.invoke("agent/get", { agent_id: agentId }, ctx);
      if (env.code !== 0 || !env.data) continue;
      const a = env.data as { agent_id: string; name: string; owner_user_id: string; visibility?: string };
      agents.set(agentId, {
        agent_id: a.agent_id,
        name: a.name,
        owner_user_id: a.owner_user_id,
        visibility: a.visibility,
        linked: links.some((l) => l.agent_id === agentId),
        visible: a.visibility !== "private" || a.owner_user_id === caller.userId || isAdmin,
      });
    }
    // Linked agents that have no log yet: their owner is the default author of the agent's memories.
    for (const a of agents.values()) {
      if (![...pairs.values()].some((p) => p.agent_id === a.agent_id)) {
        pairs.set(`${a.agent_id}|${a.owner_user_id}`, { agent_id: a.agent_id, user_id: a.owner_user_id });
      }
    }

    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const memories: Array<Record<string, unknown>> = [];
    const hiddenAgents = new Set<string>();
    for (const p of pairs.values()) {
      const agent = agents.get(p.agent_id);
      if (!agent) continue;
      if (!agent.visible) {
        hiddenAgents.add(agent.agent_id);
        continue;
      }
      const env = await deps.kernelHttp.postEnvelope<{ items?: Array<Record<string, unknown>> }>(
        "/v3/atomic/query",
        {
          team_id: task.team_id,
          agent_id: p.agent_id,
          user_id: p.user_id,
          session_id: "default",
          task_id: taskId,
          limit: perAgentLimit,
          offset: 0,
        },
        cred,
      );
      if (env.code !== 0) continue;
      for (const r of (env.data as { items?: Array<Record<string, unknown>> } | null)?.items ?? []) {
        memories.push({
          id: r.id,
          type: r.type,
          content: r.content,
          agent_id: p.agent_id,
          agent_name: agent.name,
          user_id: p.user_id,
          created_at: r.created_at,
        });
      }
    }
    memories.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

    return c.json(
      okEnvelope(c, {
        task_id: taskId,
        team_id: task.team_id,
        agents: [...agents.values()],
        memories,
        hidden_private_agents: hiddenAgents.size,
      }),
    );
  });
}
