import { beforeEach, describe, expect, it, vi } from "vitest";

const reportGeneration = vi.hoisted(() => vi.fn());
const writeUsageLog = vi.hoisted(() => vi.fn());
const recordTurn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../langfuse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../langfuse.js")>()),
  langfuseReportGeneration: reportGeneration,
}));
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  writeLog: writeUsageLog,
}));
vi.mock("../instance-upstream-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../instance-upstream-cache.js")>()),
  getInstanceUpstreamConfigs: async () => [],
}));
vi.mock("../wamf/recorder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wamf/recorder.js")>()),
  recordWamfTurn: recordTurn,
}));

import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

describe("successful completion without usage", () => {
  beforeEach(() => {
    reportGeneration.mockClear();
    writeUsageLog.mockClear();
    recordTurn.mockClear();
  });

  it("still reports the Langfuse generation", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        id: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "original user text" }], stream: false }),
      });

      expect(response.status).toBe(200);
      expect(reportGeneration).toHaveBeenCalledWith(expect.objectContaining({
        traceInput: "original user text",
        usage: undefined,
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("still sends a successful no-usage turn to the L0 recorder", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    config.wamf.enabled = true;
    config.wamf.endpoint = "http://memory.test";
    config.wamf.memory.enabled = true;
    config.wamf.memory.writeL0 = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "original user text" }], stream: false }),
      });

      expect(response.status).toBe(200);
      expect(recordTurn).toHaveBeenCalledWith(
        expect.anything(),
        null,
        { role: "user", content: "original user text" },
        "answer",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("still reports a completed streaming generation", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "streaming original user text" }], stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(reportGeneration).toHaveBeenCalledWith(expect.objectContaining({
        traceInput: "streaming original user text",
        usage: undefined,
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not label an OpenCode tool continuation as a new user input", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "continued answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [
            { role: "user", content: "previous-round user question" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "call_1", content: "tool result" },
          ],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(reportGeneration).toHaveBeenCalledWith(expect.objectContaining({ traceInput: undefined }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("writes the human text rather than recalled memory to usage", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://upstream.test/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    try {
      const app = createApp(config);
      const response = await app.request("http://localhost/opencode/default/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{
            role: "user",
            content: "<wamf_recalled_l1_memories>history memory</wamf_recalled_l1_memories>\nthis round's original user text",
          }],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(writeUsageLog).toHaveBeenCalledWith(config, expect.objectContaining({
        event: "usage",
        userInput: "this round's original user text",
      }));
      expect(reportGeneration).toHaveBeenCalledWith(expect.objectContaining({ traceInput: "this round's original user text" }));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
