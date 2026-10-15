import { describe, expect, it } from "vitest";
import { extractLatestUserMessage } from "../wamf/recorder.js";
import { opencodeAdapter } from "../agent-adapters/opencode.js";

describe("OpenCode user input with recalled memory", () => {
  it("classifies the OpenCode 2.0 title request as auxiliary", () => {
    expect(opencodeAdapter.classifyRequest({
      messages: [
        { role: "system", content: "You are a title generator. You output ONLY a thread title. Nothing else." },
        { role: "user", content: "user question" },
      ],
    })).toBe("auxiliary");
    expect(opencodeAdapter.classifyRequest({
      messages: [
        { role: "system", content: "You are an AI agent running in OpenCode" },
        { role: "user", content: "user question" },
      ],
    })).toBe("main");
  });

  it("keeps the human message when L1 recall is prepended in the user role", () => {
    const messages = [
      { role: "system", content: "agent instructions" },
      {
        role: "user",
        content: "<wamf_recalled_l1_memories>\nprevious private memory\n</wamf_recalled_l1_memories>\nHello, I am using hyhmodel",
      },
    ];

    expect(extractLatestUserMessage(messages)).toEqual({
      role: "user",
      content: "Hello, I am using hyhmodel",
    });
  });

  it("does not report recall-only context as a new human input", () => {
    const messages = [
      { role: "user", content: "first-round real question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "<wamf_recalled_l1_memories>\nprevious private memory\n</wamf_recalled_l1_memories>" },
    ];

    expect(extractLatestUserMessage(messages)?.content).toBe("first-round real question");
    expect(opencodeAdapter.extractUserText(messages[2].content)).toBeNull();
  });

  it("cleans recalled memory in content-block messages too", () => {
    expect(opencodeAdapter.extractUserText([
      { type: "text", text: "<wamf_recalled_l1_memories>old memory</wamf_recalled_l1_memories>" },
      { type: "text", text: "new user question" },
    ])).toBe("new user question");
  });
});
