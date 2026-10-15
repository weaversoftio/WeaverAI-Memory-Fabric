import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpServer } from "./server.js";
import { clearIdentityCache } from "./identity.js";
import { chunk, redactSecrets } from "./hooks.js";
import { clearProjectCache, isTrivial, projectFromPath, projectFromRemote } from "./project.js";

const KEY = "sk-mem-test-key";
const REPO = "git@bitbucket.org:weaversoft/agent-memory.git";
const REPO_KEY = "bitbucket.org/weaversoft/agent-memory";
const CWD = "C:\\Users\\dana\\work\\Agent-Memory";
const CWD_KEY = "path:c:/users/dana/work/agent-memory";

/** Fake Memory Fabric panel. `projects` seeds the agent's per-project saving answers (agent metadata). */
function fakeHub(opts: { failImport?: boolean; projects?: Record<string, boolean> } = {}) {
  const imports: Array<Record<string, unknown>> = [];
  const projects = Object.fromEntries(Object.entries(opts.projects ?? {}).map(([k, save]) => [k, { save, name: k.split("/").pop() }]));
  let metadata = JSON.stringify({ other: "kept", memory_saving: { projects } });
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    switch (path) {
      case "auth/waip/exchange":
        return new Headers(init?.headers).get("x-waip-identity") === "signed-for-dana"
          ? ok({ user_key: KEY, user: { user_id: "usr-1", username: "dana" } })
          : new Response(JSON.stringify({ code: 401, message: "WeaverAI identity rejected: signature verification failed", data: null }), { status: 401 });
      case "meta/auth/verify":
        return ok({ valid: true, user: { user_id: "usr-1", username: "dana" } });
      case "meta/team/list":
        return ok({ items: [{ team_id: "team-a", name: "Core" }] });
      case "meta/agent/list":
        return ok({ items: [{ agent_id: "agt-1", name: "builder", status: "active" }] });
      case "meta/agent/get":
        return ok({ agent_id: "agt-1", metadata_json: metadata });
      case "meta/agent/update":
        metadata = body.metadata_json;
        return ok({ agent_id: "agt-1", metadata_json: metadata });
      case "chat-memory/import":
        if (opts.failImport) return new Response(JSON.stringify({ code: 500, message: "boom", data: null }), { status: 500 });
        imports.push(body);
        return ok({ imported: true, accepted_count: (body.messages as unknown[]).length, session_id: body.session_id });
      case "chat-memory/layer":
        return ok(
          body.layer === "L3"
            ? { items: [{ id: "core", title: "core memory", body: "The team ships on Thursdays." }] }
            : { items: [{ id: "scene_blocks/release.md", title: "scene_blocks/release.md", body: "Release process and staging setup" }] },
        );
      default:
        return new Response(JSON.stringify({ code: 404, message: "NOT_FOUND", data: null }), { status: 404 });
    }
  };
  return { imports, fetchImpl, metadata: () => JSON.parse(metadata) };
}

let server: http.Server;
let base: string;

async function start(fetchImpl: typeof fetch) {
  server = createHttpServer({ port: 0, hubUrl: "http://hub.test", serviceId: "default", timeoutMs: 5000, identityCacheMs: 60000 }, fetchImpl);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Claude Code sends the repo's git remote as X-Memory-Project (see the plugin's send-hook.sh). */
async function hook(client: string, body: unknown, key: string | null = KEY, extra: Record<string, string> = { "x-memory-project": REPO }) {
  const res = await fetch(`${base}/hooks/${client}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-memory-user-key": key } : {}), ...extra },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const prompt = (session: string, text: string) => ({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: CWD, prompt: text });
const reply = (session: string, text: string) => ({ hook_event_name: "Stop", session_id: session, cwd: CWD, last_assistant_message: text });

beforeEach(() => {
  clearIdentityCache();
  clearProjectCache();
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("Claude Code hooks", () => {
  it("adds the profile and scene index at session start, and asks about an undecided project", async () => {
    await start(fakeHub().fetchImpl);
    const { body } = await hook("claude-code", { hook_event_name: "SessionStart", session_id: "s1", cwd: CWD, source: "startup" });
    const ctx = body.hookSpecificOutput.additionalContext as string;
    expect(body.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(ctx).toContain("ships on Thursdays");
    expect(ctx).toContain("scene_blocks/release.md");
    expect(ctx).toContain("Saving: not decided for agent-memory");
    expect(ctx).toContain(`project="${REPO_KEY}"`);
  });

  it("saves nothing in a project the user hasn't said yes to", async () => {
    const hub = fakeHub();
    await start(hub.fetchImpl);
    await hook("claude-code", prompt("s1", "When do we deploy?"));
    await hook("claude-code", reply("s1", "On Thursdays."));
    expect(hub.imports).toEqual([]);
  });

  it("saves nothing in a project the user declined, and says so at session start", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: false } });
    await start(hub.fetchImpl);
    const { body } = await hook("claude-code", { hook_event_name: "SessionStart", session_id: "s1", cwd: CWD });
    expect(body.hookSpecificOutput.additionalContext).toContain("Saving: off for agent-memory");
    await hook("claude-code", prompt("s1", "When do we deploy?"));
    expect(hub.imports).toEqual([]);
  });

  it("saves the prompt and the final reply under one session once the project is on", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: true } });
    await start(hub.fetchImpl);
    await hook("claude-code", prompt("s1", "When do we deploy?"));
    await hook("claude-code", reply("s1", "On Thursdays."));
    expect(hub.imports).toEqual([
      { team_id: "team-a", agent_id: "agt-1", session_id: "claude-code-s1", messages: [{ role: "user", content: "When do we deploy?" }] },
      { team_id: "team-a", agent_id: "agt-1", session_id: "claude-code-s1", messages: [{ role: "assistant", content: "On Thursdays." }] },
    ]);
  });

  it("falls back to the folder when there's no git remote", async () => {
    const hub = fakeHub({ projects: { [CWD_KEY]: true } });
    await start(hub.fetchImpl);
    await hook("claude-code", prompt("s1", "Notes for today"), KEY, {});
    expect(hub.imports).toHaveLength(1);
  });

  it("#nomemory stops saving that chat, and only that chat", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: true } });
    await start(hub.fetchImpl);
    const paused = await hook("claude-code", prompt("s1", "#nomemory let's talk about salaries"));
    expect(paused.body.hookSpecificOutput.additionalContext).toContain("no longer saved");
    await hook("claude-code", reply("s1", "Sure."));
    await hook("claude-code", prompt("s1", "Later message in the same chat"));
    await hook("claude-code", prompt("s2", "Another chat"));
    expect(hub.imports.map((i) => i.session_id)).toEqual(["claude-code-s2"]);
  });

  it("skips bare acknowledgements", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: true } });
    await start(hub.fetchImpl);
    for (const t of ["ok", "Thanks!", "👍", "thank you."]) await hook("claude-code", prompt("s1", t));
    await hook("claude-code", prompt("s1", "ok, now deploy staging"));
    expect(hub.imports.map((i) => (i.messages as any[])[0].content)).toEqual(["ok, now deploy staging"]);
  });

  it("warns instead of failing when no key is configured", async () => {
    await start(fakeHub().fetchImpl);
    const { status, body } = await hook("claude-code", reply("s1", "x"), null);
    expect(status).toBe(200);
    expect(body.systemMessage).toContain("no memory key");
  });

  it("saves turns for the WeaverAI user the MCP proxy vouches for", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: true } });
    await start(hub.fetchImpl);
    const { status } = await hook("claude-code", prompt("s1", "Hi there"), null, { "x-waip-identity": "signed-for-dana", "x-memory-project": REPO });
    expect(status).toBe(200);
    expect(hub.imports).toHaveLength(1);
  });

  it("says why when the WeaverAI identity is refused", async () => {
    const hub = fakeHub({ projects: { [REPO_KEY]: true } });
    await start(hub.fetchImpl);
    const { body } = await hook("claude-code", reply("s1", "x"), null, { "x-waip-identity": "forged" });
    expect(body.systemMessage).toContain("identity rejected");
    expect(hub.imports).toHaveLength(0);
  });
});

describe("Cursor hooks", () => {
  const roots = ["/home/dana/work/agent-memory"];
  const rootsKey = "path:/home/dana/work/agent-memory";

  it("always lets the prompt through, even when saving fails", async () => {
    await start(fakeHub({ failImport: true, projects: { [rootsKey]: true } }).fetchImpl);
    const { status, body } = await hook("cursor", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", workspace_roots: roots, prompt: "hi there" }, KEY, {});
    expect(status).toBe(200);
    expect(body).toEqual({ continue: true });
  });

  it("saves prompt and response in a project that's on, and adds context at session start", async () => {
    const hub = fakeHub({ projects: { [rootsKey]: true } });
    await start(hub.fetchImpl);
    const start1 = await hook("cursor", { hook_event_name: "sessionStart", session_id: "x", conversation_id: "c1", workspace_roots: roots }, KEY, {});
    expect(start1.body.additional_context).toContain("ships on Thursdays");
    expect(start1.body.additional_context).toContain("Saving: on for agent-memory");
    await hook("cursor", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", workspace_roots: roots, prompt: "Plan the release" }, KEY, {});
    await hook("cursor", { hook_event_name: "afterAgentResponse", conversation_id: "c1", workspace_roots: roots, text: "Here is the plan." }, KEY, {});
    expect(hub.imports.map((i) => [i.session_id, (i.messages as any[])[0].role])).toEqual([
      ["cursor-c1", "user"],
      ["cursor-c1", "assistant"],
    ]);
  });

  it("#nomemory pauses a Cursor chat but still lets the prompt through", async () => {
    const hub = fakeHub({ projects: { [rootsKey]: true } });
    await start(hub.fetchImpl);
    const r = await hook("cursor", { hook_event_name: "beforeSubmitPrompt", conversation_id: "c9", workspace_roots: roots, prompt: "#nomemory private" }, KEY, {});
    expect(r.body).toEqual({ continue: true });
    await hook("cursor", { hook_event_name: "afterAgentResponse", conversation_id: "c9", workspace_roots: roots, text: "ok" }, KEY, {});
    expect(hub.imports).toEqual([]);
  });
});

describe("helpers", () => {
  it("redacts credentials", () => {
    const out = redactSecrets("key sk-mem-AbCdEfGh1234 and AKIAABCDEFGHIJKLMNOP done");
    expect(out).toBe("key [REDACTED] and [REDACTED] done");
  });

  it("redacts tokens, bearer headers and passwords in URLs and assignments", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJub2EubGV2aSJ9.c2lnbmF0dXJlLWJ5dGVz";
    const cases: Array<[string, string]> = [
      [`WAIP token ${jwt}`, "WAIP token [REDACTED]"],
      ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [REDACTED]"],
      ["bitbucket ATBB3xYzAbCdEfGhIjKlMnOpQrStUv", "bitbucket [REDACTED]"],
      ["postgres://app:hunter2secret@db.internal:5432/x", "postgres://[REDACTED]@db.internal:5432/x"],
      ['DB_PASSWORD="hunter2secret"', 'DB_PASSWORD="[REDACTED]"'],
      ["api_key: abcdef123456", "api_key: [REDACTED]"],
      ["glpat-abcdefghijklmnopqrstu", "[REDACTED]"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input), input).toBe(expected);
  });

  it("leaves ordinary prose and code alone", () => {
    for (const s of ["the token budget is 4000", "password reset flow", "https://bitbucket.org/weaversoft/repo.git", "const x = a.b.c;"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });

  it("splits long text into L0-sized messages", () => {
    expect(chunk("a".repeat(17000)).map((c) => c.length)).toEqual([8000, 8000, 1000]);
  });

  it("identifies a repo by its remote, whatever the URL form, and never keeps credentials", () => {
    for (const remote of [
      "git@bitbucket.org:weaversoft/Agent-Memory.git",
      "https://dyze:s3cr3t-token@bitbucket.org/weaversoft/agent-memory.git",
      "https://bitbucket.org/weaversoft/agent-memory/",
      "ssh://git@bitbucket.org/weaversoft/agent-memory.git",
    ]) {
      const ref = projectFromRemote(remote);
      expect(ref?.key).toBe(REPO_KEY);
      expect(ref?.name.toLowerCase()).toBe("agent-memory");
      expect(JSON.stringify(ref)).not.toContain("s3cr3t");
    }
    expect(projectFromRemote("not a url")).toBeNull();
    expect(projectFromPath("C:\\Users\\dana\\work\\Agent-Memory\\")).toEqual({ key: CWD_KEY, name: "Agent-Memory" });
  });

  it("treats only bare acknowledgements as trivial", () => {
    expect(["ok", "OK.", "thanks!!", "👍", "", "  "].every(isTrivial)).toBe(true);
    expect(["ok do it", "thanks, also fix the CI", "no", "yes please deploy"].some(isTrivial)).toBe(false);
  });
});
