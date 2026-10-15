import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "./server.js";
import { clearIdentityCache } from "./identity.js";
import { clearProjectCache } from "./project.js";

const KEY = "sk-mem-test-key";

interface Call {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Fake Memory Fabric panel: answers the panel endpoints the MCP uses and records every call. */
function fakeHub(agents: Array<{ team_id: string; agent_id: string; name: string }>) {
  const calls: Call[] = [];
  let agentMetadata = JSON.stringify({ owner_note: "keep me" });
  const teams = [...new Map(agents.map((a) => [a.team_id, { team_id: a.team_id, name: `Team ${a.team_id}` }])).values()];
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    switch (path) {
      case "meta/auth/verify":
        return ok(body.user_key === KEY ? { valid: true, user: { user_id: "usr-1", username: "dana" } } : { valid: false, user: null });
      case "meta/team/list":
        return ok({ items: teams });
      case "meta/agent/list":
        return ok({ items: agents.filter((a) => a.team_id === body.team_id).map((a) => ({ ...a, status: "active" })) });
      case "meta/agent/get":
        return ok({ agent_id: body.agent_id, metadata_json: agentMetadata });
      case "meta/agent/update":
        agentMetadata = body.metadata_json;
        return ok({ agent_id: body.agent_id, metadata_json: agentMetadata });
      case "chat-memory/layer-add":
        return ok({ id: "m_1_abc", version: "v1", type: body.type });
      case "chat-memory/search":
        return ok({ items: [{ id: "m_9", title: "work_fact", body: "Staging DB is Postgres 16 on port 5433.", score: 0.9 }], total: 1 });
      case "chat-memory/layer":
        return ok({ layer: body.layer, items: [], total: 0 });
      case "chat-memory/layer-delete":
        return ok({ deleted_count: (body.ids as string[]).length });
      case "auth/waip/exchange": {
        const assertion = new Headers(init?.headers).get("x-waip-identity");
        if (assertion === "signed-for-dana") return ok({ user_key: KEY, user: { user_id: "usr-1", username: "dana" } });
        return new Response(JSON.stringify({
          code: 403,
          message: '"dyze" has an Agent Memory account that isn\'t linked to WeaverAI yet: sign in to the Agent Memory panel once with WeaverAI and link it',
          data: { error: "WAIP_IDENTITY_NOT_LINKED" },
        }), { status: 403 });
      }
      default:
        return new Response(JSON.stringify({ code: 404, message: "NOT_FOUND", data: null }), { status: 404 });
    }
  };
  return { calls, fetchImpl, metadata: () => JSON.parse(agentMetadata) };
}

let server: http.Server;
let baseUrl: string;

async function start(fetchImpl: typeof fetch) {
  server = createHttpServer({ port: 0, hubUrl: "http://hub.test", serviceId: "default", timeoutMs: 5000, identityCacheMs: 60000 }, fetchImpl);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers } }));
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");
}

beforeEach(() => {
  clearIdentityCache();
  clearProjectCache();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("memory MCP server", () => {
  it("lists tools without a memory key, but refuses tool calls", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({});
    expect((await client.listTools()).tools).toHaveLength(8);
    const result = await client.callTool({ name: "memory_whoami", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Missing memory key");
    expect(hub.calls).toHaveLength(0);
    await client.close();
  });

  it("lists the chat-memory tools", async () => {
    await start(fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]).fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_add",
      "memory_delete",
      "memory_list",
      "memory_project_saving",
      "memory_save_conversation",
      "memory_search",
      "memory_update",
      "memory_whoami",
    ]);
    await client.close();
  });

  it("adds a memory to the user's only agent, sending their own key to the hub", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY });
    const result = await client.callTool({ name: "memory_add", arguments: { content: "We deploy on Thursdays." } });
    expect(textOf(result)).toContain("m_1_abc");
    const add = hub.calls.find((c) => c.path === "chat-memory/layer-add")!;
    expect(add.body).toMatchObject({ block_id: "chat_memory-team-a-agt-1", layer: "L1", content: "We deploy on Thursdays.", type: "work_fact" });
    expect(add.headers["x-wamf-user-key"]).toBe(KEY);
    expect(add.headers["x-wamf-service-id"]).toBe("default");
    await client.close();
  });

  it("asks which agent when the user owns several and no default is set", async () => {
    const hub = fakeHub([
      { team_id: "team-a", agent_id: "agt-1", name: "builder" },
      { team_id: "team-b", agent_id: "agt-2", name: "reviewer" },
    ]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY });
    const result = await client.callTool({ name: "memory_search", arguments: { query: "staging" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("agt-2");
    await client.close();
  });

  it("uses the X-Memory-Agent-Id header as the default agent", async () => {
    const hub = fakeHub([
      { team_id: "team-a", agent_id: "agt-1", name: "builder" },
      { team_id: "team-b", agent_id: "agt-2", name: "reviewer" },
    ]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY, "x-memory-agent-id": "agt-2" });
    const result = await client.callTool({ name: "memory_search", arguments: { query: "staging" } });
    expect(textOf(result)).toContain("port 5433");
    expect(hub.calls.find((c) => c.path === "chat-memory/search")!.body.block_id).toBe("chat_memory-team-b-agt-2");
    await client.close();
  });

  it("accepts the key as a Bearer token for direct connections", async () => {
    await start(fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]).fetchImpl);
    const client = await connect({ authorization: `Bearer ${KEY}` });
    const result = await client.callTool({ name: "memory_whoami", arguments: {} });
    expect(textOf(result)).toContain("dana");
    await client.close();
  });

  it("acts as the WeaverAI user the MCP proxy vouches for, with no key of their own", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-waip-identity": "signed-for-dana" });
    const result = await client.callTool({ name: "memory_add", arguments: { content: "We deploy on Thursdays." } });
    expect(textOf(result)).toContain("m_1_abc");
    const add = hub.calls.find((c) => c.path === "chat-memory/layer-add")!;
    expect(add.headers["x-wamf-user-key"]).toBe(KEY);
    await client.close();
  });

  it("tells the agent why a WeaverAI identity was refused", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-waip-identity": "signed-for-dyze" });
    const result = await client.callTool({ name: "memory_whoami", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("link it");
    expect(hub.calls.filter((c) => c.path !== "auth/waip/exchange")).toHaveLength(0);
    await client.close();
  });

  it("an explicit memory key wins over the proxy's identity", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY, "x-waip-identity": "signed-for-dyze" });
    const result = await client.callTool({ name: "memory_whoami", arguments: {} });
    expect(textOf(result)).toContain("dana");
    expect(hub.calls.some((c) => c.path === "auth/waip/exchange")).toBe(false);
    await client.close();
  });

  it("reports an invalid key as a tool error", async () => {
    await start(fakeHub([]).fetchImpl);
    const client = await connect({ "x-memory-user-key": "sk-mem-wrong" });
    const result = await client.callTool({ name: "memory_whoami", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not valid");
    await client.close();
  });

  it("records the user's answer about saving a project, keeping the agent's other settings", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY });
    const none = await client.callTool({ name: "memory_project_saving", arguments: {} });
    expect(textOf(none)).toContain("off everywhere");

    const on = await client.callTool({ name: "memory_project_saving", arguments: { project: "bitbucket.org/weaversoft/agent-memory", save: true } });
    expect(textOf(on)).toContain("Saving is on for agent-memory");
    await client.callTool({ name: "memory_project_saving", arguments: { project: "path:c:/notes", save: false } });

    expect(hub.metadata()).toMatchObject({
      owner_note: "keep me",
      memory_saving: {
        projects: {
          "bitbucket.org/weaversoft/agent-memory": { save: true, name: "agent-memory" },
          "path:c:/notes": { save: false, name: "notes" },
        },
      },
    });
    const listed = textOf(await client.callTool({ name: "memory_project_saving", arguments: {} }));
    expect(listed).toContain("on   agent-memory");
    expect(listed).toContain("off  notes");
    await client.close();
  });

  it("maps L1 deletes to record ids", async () => {
    const hub = fakeHub([{ team_id: "team-a", agent_id: "agt-1", name: "builder" }]);
    await start(hub.fetchImpl);
    const client = await connect({ "x-memory-user-key": KEY });
    const result = await client.callTool({ name: "memory_delete", arguments: { layer: "L1", ids: ["m_1", "m_2"] } });
    expect(textOf(result)).toContain("Deleted 2");
    expect(hub.calls.find((c) => c.path === "chat-memory/layer-delete")!.body).toMatchObject({ layer: "L1", ids: ["m_1", "m_2"] });
    await client.close();
  });
});
