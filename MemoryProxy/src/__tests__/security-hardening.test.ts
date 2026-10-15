import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../instance-upstream-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-upstream-cache.js")>()),
  getInstanceUpstreamConfigs: async () => [],
}));

import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { BRIDGE_SIG_HEADER, initBridgeSecret, signBridgeSession, verifyBridgeSession } from "../bridge-signature.js";
import { renderWamfMemoryToolsBlock } from "../injection/injectors/wamf-tools-injector.js";

function baseConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = "http://upstream.test/v1";
  return config;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin endpoints", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/v3/admin/rate-limits"],
    ["PUT", "/v3/admin/rate-limits"],
    ["DELETE", "/v3/admin/rate-limits"],
    ["POST", "/v3/session/refresh-cache"],
    ["POST", "/v3/session/force-archive-skill"],
    ["POST", "/v3/instance/proxy-destroy"],
  ];

  it.each(routes)("%s %s is refused when no admin key is configured", async (method, path) => {
    const app = createApp(baseConfig());
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    expect(res.status).toBe(403);
  });

  it.each(routes)("%s %s needs the admin Bearer when a key is configured", async (method, path) => {
    const config = baseConfig();
    config.admin.apiKey = "admin-secret-for-tests";
    const app = createApp(config);
    const init = { method, body: method === "GET" ? undefined : "{}" };
    const missing = await app.request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json" } });
    expect(missing.status).toBe(401);
    const wrong = await app.request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
    const ok = await app.request(`http://localhost${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret-for-tests" },
    });
    expect([401, 403]).not.toContain(ok.status);
  });
});

describe("/direct passthrough", () => {
  it("is not routed unless PROXY_DIRECT_PASSTHROUGH=true", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream"));
    const app = createApp(baseConfig());
    const res = await app.request("http://localhost/direct/v1/key/list", { method: "GET" });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bridge signature", () => {
  it("round-trips and binds to session and space", () => {
    initBridgeSecret("seed-a");
    const sig = signBridgeSession("sess-1", "space-1");
    expect(verifyBridgeSession(sig, "sess-1", "space-1")).toBe(true);
    expect(verifyBridgeSession(sig, "sess-2", "space-1")).toBe(false);
    expect(verifyBridgeSession(sig, "sess-1", "space-2")).toBe(false);
    expect(verifyBridgeSession(undefined, "sess-1", "space-1")).toBe(false);
    initBridgeSecret("seed-b");
    expect(verifyBridgeSession(sig, "sess-1", "space-1")).toBe(false);
  });

  it("is baked into the injected memory curl recipe", () => {
    initBridgeSecret("seed-a");
    const block = renderWamfMemoryToolsBlock("http://proxy.test", "sess-1", "space-1");
    expect(block).toContain(`${BRIDGE_SIG_HEADER}: ${signBridgeSession("sess-1", "space-1")}`);
  });

  it.each(["/memory-bridge/v3/atomic/search", "/skill-bridge/v3/skill/search"])(
    "%s rejects a session id without a valid signature",
    async (path) => {
      const app = createApp(baseConfig());
      const headers = {
        "content-type": "application/json",
        "x-conversation-id": "victim-session",
        "x-wamf-service-id": "default",
      };
      const unsigned = await app.request(`http://localhost${path}`, { method: "POST", headers, body: "{}" });
      expect(unsigned.status).toBe(401);
      expect(await unsigned.text()).toContain(BRIDGE_SIG_HEADER);

      const forged = await app.request(`http://localhost${path}`, {
        method: "POST",
        headers: { ...headers, [BRIDGE_SIG_HEADER]: "forged" },
        body: "{}",
      });
      expect(forged.status).toBe(401);
      expect(await forged.text()).toContain(BRIDGE_SIG_HEADER);
    },
  );
});

describe("outbound headers", () => {
  it("never forwards proxy-internal or client-identifying headers upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = createApp(baseConfig());
    const res = await app.request("http://localhost/opencode/default/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-wamf-user-key": "sk-mem-secret",
        "x-wamf-user-token": "panel-token",
        "x-user-id": "someone",
        cookie: "session=abc",
        "x-forwarded-for": "10.0.0.1",
        [BRIDGE_SIG_HEADER]: "sig",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }),
    });
    expect(res.status).toBe(200);
    const upstreamCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("http://upstream.test"));
    expect(upstreamCall).toBeDefined();
    const sent = new Headers(upstreamCall![1]?.headers as HeadersInit);
    for (const h of ["x-wamf-user-key", "x-wamf-user-token", "x-user-id", "cookie", "x-forwarded-for", BRIDGE_SIG_HEADER]) {
      expect(sent.has(h), h).toBe(false);
    }
  });
});
