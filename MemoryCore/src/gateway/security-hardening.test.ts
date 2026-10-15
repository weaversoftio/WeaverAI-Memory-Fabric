import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isSafeInstanceId } from "../utils/instance-id.js";
import { scenarioListRequestSchema } from "./v2-schemas.js";

describe("isSafeInstanceId", () => {
  it.each(["default", "ins-abc_123", "team.memory", "A".repeat(128)])("accepts %s", (id) => {
    expect(isSafeInstanceId(id)).toBe(true);
  });
  it.each(["", "..", "../x", "a/../../b", "a/b", "a\\b", ".hidden", "-x", "a..b", "A".repeat(129), "x\u0000"])(
    "rejects %j",
    (id) => {
      expect(isSafeInstanceId(id)).toBe(false);
    },
  );
});

describe("scenario/ls path_prefix", () => {
  it.each(["../../", "a/../../b", "/etc", "a\\b"])("rejects %j", (path_prefix) => {
    expect(scenarioListRequestSchema.safeParse({ path_prefix }).success).toBe(false);
  });
  it.each([undefined, "", "project-x/"])("accepts %j", (path_prefix) => {
    expect(scenarioListRequestSchema.safeParse(path_prefix === undefined ? {} : { path_prefix }).success).toBe(true);
  });
});

describe("gateway HTTP hardening", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wamf-sec-"));
  const API_KEY = "gateway-test-key";
  let base = "";
  let gateway: { start(): Promise<void>; stop(): Promise<void> };

  beforeAll(async () => {
    vi.stubEnv("WAMF_GATEWAY_CONFIG", join(dataDir, "no-config.yaml"));
    const { WamfGateway } = await import("./server.js");
    gateway = new WamfGateway({
      server: { port: 0, host: "127.0.0.1", apiKey: API_KEY },
      data: { baseDir: dataDir },
      llm: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "real-llm-secret", model: "m" },
    });
    await gateway.start();
    const addr = (gateway as unknown as { server: { address(): AddressInfo } }).server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await gateway?.stop();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, ...headers },
      body: JSON.stringify(body),
    });

  it("rejects an instance id that climbs out of the data directory", async () => {
    const res = await post(
      "/v2/conversation/add",
      { session_id: "s", messages: [{ role: "user", content: "hi" }] },
      { "x-wamf-service-id": "../../escaped" },
    );
    expect(res.status).toBe(400);
    // dataDir/instances/../../escaped = the directory next to dataDir
    expect(existsSync(join(dataDir, "..", "escaped"))).toBe(false);
  });

  it("lets a plain instance id through the header check", async () => {
    const res = await post("/v2/scenario/ls", {}, { "x-wamf-service-id": "default" });
    expect(res.status).not.toBe(400);
  });

  it("rejects a traversal instance_id on destroy", async () => {
    const res = await post("/v2/instance/destroy", { instance_id: "../../escaped" });
    expect(res.status).toBe(400);
  });

  it("never lets /seed redirect the LLM (and its key) to another endpoint", async () => {
    const res = await post("/seed", {
      data: [{ role: "user", content: "hi" }],
      config_override: { llm: { baseUrl: "http://attacker.invalid/v1" } },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("config_override may only set");
  });
});
