import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { BRIDGE_SIG_HEADER, initBridgeSecret, signBridgeSession } from "../bridge-signature.js";
import { getSessionStore, __resetSessionStoreForTests } from "../session/store.js";

function testConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.admin.apiKey = "knowledge-bridge-test-secret";
  config.knowledge.enabled = true;
  config.knowledge.serviceToken = "ks-token";
  config.knowledge.toolsEndpoint = "http://hub.test:8424";
  config.knowledge.serviceId = "default";
  config.upstream.url = "http://upstream.test/v1";
  return config;
}

async function seedSession(sessionId = "sess-kg"): Promise<void> {
  await getSessionStore().set(`codebuddy:${sessionId}`, {
    status: "initialized",
    keyId: `codebuddy:${sessionId}`,
    startedAt: Date.now(),
    attemptCount: 1,
    sessionInfo: {
      session_id: sessionId,
      team_id: "team-1",
      agent_id: "agt-1",
      user_id: "user-1",
      space_id: "default",
    },
  });
}

function signedHeaders(sessionId = "sess-kg", spaceId = "default"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-conversation-id": sessionId,
    "x-wamf-service-id": spaceId,
    [BRIDGE_SIG_HEADER]: signBridgeSession(sessionId, spaceId),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetSessionStoreForTests();
});

describe("knowledge-bridge", () => {
  it("forwards tools/list to MemoryKnowledge with session tenant headers", async () => {
    initBridgeSecret("knowledge-bridge-test-secret");
    await seedSession();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "ok", data: { tools: [{ name: "explore" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(testConfig());
    const res = await app.request("http://localhost/knowledge-bridge/v3/tools/list", {
      method: "POST",
      headers: signedHeaders(),
      body: JSON.stringify({ knowledge_id: "cg-p5cqar13" }),
    });
    expect(res.status).toBe(200);
    const ksCall = fetchMock.mock.calls.find(([url]) => String(url).includes("hub.test:8424"));
    expect(ksCall).toBeDefined();
    expect(String(ksCall![0])).toBe("http://hub.test:8424/v3/tools/list");
    const sent = new Headers(ksCall![1]?.headers as HeadersInit);
    expect(sent.get("x-wamf-service-id")).toBe("default");
    expect(sent.get("x-wamf-user-id")).toBe("user-1");
    expect(sent.get("x-wamf-team-id")).toBe("team-1");
    expect(sent.get("x-wamf-agent-id")).toBe("agt-1");
    expect(sent.get("authorization")).toBe("Bearer ks-token");
    expect(sent.has(BRIDGE_SIG_HEADER)).toBe(false);
    expect(JSON.parse(String(ksCall![1]?.body))).toEqual({ knowledge_id: "cg-p5cqar13" });
  });

  it("rejects unknown subpaths", async () => {
    initBridgeSecret("knowledge-bridge-test-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = createApp(testConfig());
    const res = await app.request("http://localhost/knowledge-bridge/v3/code-graph/delete", {
      method: "POST",
      headers: signedHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when toolsEndpoint is missing", async () => {
    initBridgeSecret("knowledge-bridge-test-secret");
    await seedSession();
    const config = testConfig();
    config.knowledge.toolsEndpoint = "";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = createApp(config);
    const res = await app.request("http://localhost/knowledge-bridge/v3/tools/call", {
      method: "POST",
      headers: signedHeaders(),
      body: JSON.stringify({ knowledge_id: "cg-1", tool_name: "explore", params: { query: "main" } }),
    });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
