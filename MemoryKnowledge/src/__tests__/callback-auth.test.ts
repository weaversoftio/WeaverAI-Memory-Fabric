import { afterEach, describe, expect, it, vi } from "vitest";
import { callbackTMC, sendProgressCallback, setCallbackAuthToken } from "../callback.js";

afterEach(() => {
  setCallbackAuthToken("");
  vi.restoreAllMocks();
});

function captureFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
}

const authOf = (call: unknown[] | undefined) =>
  new Headers((call?.[1] as RequestInit | undefined)?.headers).get("authorization");

describe("status callbacks to the panel", () => {
  it("carry the service key as a Bearer when one is set", async () => {
    const fetchMock = captureFetch();
    setCallbackAuthToken("knowledge-secret");
    await callbackTMC(
      { knowledge_id: "wiki-1", type: "wiki", status: "ready" } as Parameters<typeof callbackTMC>[0],
      { tmcCallbackUrl: "http://panel.test" },
    );
    sendProgressCallback("http://panel.test", {
      wiki_id: "wiki-1", service_id: "default", team_id: "t", event: "ingest_progress",
      progress: { phase: "extract", total: 1, completed: 0, failed: 0 },
    } as Parameters<typeof sendProgressCallback>[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) expect(authOf(call)).toBe("Bearer knowledge-secret");
  });

  it("send no Authorization header without a key", async () => {
    const fetchMock = captureFetch();
    await callbackTMC(
      { knowledge_id: "wiki-1", type: "wiki", status: "ready" } as Parameters<typeof callbackTMC>[0],
      { tmcCallbackUrl: "http://panel.test" },
    );
    expect(authOf(fetchMock.mock.calls[0])).toBeNull();
  });
});
