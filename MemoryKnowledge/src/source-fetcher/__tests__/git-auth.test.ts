import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import simpleGit from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialAppliesTo, gitAuthConfig, gitCredentialFromEnv } from "../git-auth.js";
import { GitSourceFetcher } from "../git-fetcher.js";

const CRED = { urlPrefix: "https://bitbucket.org/weaversoft/", username: "x-token-auth", token: "tok123" };

describe("gitCredentialFromEnv", () => {
  it("returns null when nothing is configured", () => {
    expect(gitCredentialFromEnv({})).toBeNull();
  });

  it("normalises the prefix (lower-case host, trailing slash)", () => {
    const cred = gitCredentialFromEnv({
      KNOWLEDGE_GIT_AUTH_URL_PREFIX: "https://BitBucket.org/weaversoft",
      KNOWLEDGE_GIT_AUTH_USERNAME: "x-token-auth",
      KNOWLEDGE_GIT_AUTH_TOKEN: "tok123",
    });
    expect(cred).toEqual(CRED);
  });

  it("is off when the token is empty, even with prefix and username pre-filled", () => {
    expect(
      gitCredentialFromEnv({
        KNOWLEDGE_GIT_AUTH_URL_PREFIX: "https://bitbucket.org/weaversoft/",
        KNOWLEDGE_GIT_AUTH_USERNAME: "x-token-auth",
        KNOWLEDGE_GIT_AUTH_TOKEN: "",
      }),
    ).toBeNull();
  });

  it("throws when a token is set without prefix or username", () => {
    expect(() => gitCredentialFromEnv({ KNOWLEDGE_GIT_AUTH_TOKEN: "tok123" })).toThrow(/are required too/);
    expect(() =>
      gitCredentialFromEnv({ KNOWLEDGE_GIT_AUTH_TOKEN: "tok123", KNOWLEDGE_GIT_AUTH_URL_PREFIX: "https://bitbucket.org/x/" }),
    ).toThrow(/are required too/);
  });

  it("rejects non-https prefixes and prefixes with embedded credentials", () => {
    const base = { KNOWLEDGE_GIT_AUTH_USERNAME: "u", KNOWLEDGE_GIT_AUTH_TOKEN: "t" };
    expect(() => gitCredentialFromEnv({ ...base, KNOWLEDGE_GIT_AUTH_URL_PREFIX: "http://bitbucket.org/x/" })).toThrow(/https/);
    expect(() => gitCredentialFromEnv({ ...base, KNOWLEDGE_GIT_AUTH_URL_PREFIX: "https://u:p@bitbucket.org/x/" })).toThrow(/https/);
  });
});

describe("credentialAppliesTo / gitAuthConfig", () => {
  it("applies to repos under the prefix, including a username in the URL", () => {
    expect(credentialAppliesTo("https://bitbucket.org/weaversoft/coworker.git", CRED)).toBe(true);
    expect(credentialAppliesTo("https://jdoe@bitbucket.org/weaversoft/coworker.git", CRED)).toBe(true);
    expect(credentialAppliesTo("https://BITBUCKET.org/weaversoft/coworker.git", CRED)).toBe(true);
  });

  it("does not apply to other workspaces, hosts or look-alike paths", () => {
    expect(credentialAppliesTo("https://bitbucket.org/other/repo.git", CRED)).toBe(false);
    expect(credentialAppliesTo("https://bitbucket.org/weaversoft-evil/repo.git", CRED)).toBe(false);
    expect(credentialAppliesTo("https://github.com/weaversoft/repo.git", CRED)).toBe(false);
    expect(credentialAppliesTo("http://bitbucket.org/weaversoft/repo.git", CRED)).toBe(false);
  });

  it("builds a prefix-scoped Basic auth header, or nothing", () => {
    const basic = Buffer.from("x-token-auth:tok123").toString("base64");
    expect(gitAuthConfig("https://bitbucket.org/weaversoft/coworker.git", CRED)).toEqual([
      `http.https://bitbucket.org/weaversoft/.extraHeader=Authorization: Basic ${basic}`,
    ]);
    expect(gitAuthConfig("https://github.com/x/y.git", CRED)).toEqual([]);
    expect(gitAuthConfig("https://bitbucket.org/weaversoft/coworker.git", null)).toEqual([]);
  });
});

describe("GitSourceFetcher.validate", () => {
  const fetcher = new GitSourceFetcher({ credential: null });

  it("rejects tokens embedded in the repo URL", () => {
    expect(() => fetcher.validate("https://x-token-auth:tok@bitbucket.org/weaversoft/coworker.git")).toThrow(
      /must not contain a password or token/,
    );
  });

  it("still accepts a plain username in the URL (Bitbucket's clone button adds one)", () => {
    expect(() => fetcher.validate("https://jdoe@bitbucket.org/weaversoft/coworker.git")).not.toThrow();
  });
});

// Real git against a local HTTP server: proves git sends the header for URLs under the
// configured prefix and not for others. (gitAuthConfig itself is https-only, so the
// test builds the same http.<prefix>.extraHeader key for a plain-http local server.)
describe("git honours the prefix-scoped extraHeader", () => {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  let server: Server;
  let base: string;
  const workDir = mkdtempSync(join(tmpdir(), "git-auth-test-"));

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function cloneAndCapture(repoPath: string): Promise<IncomingHttpHeaders | undefined> {
    seen.length = 0;
    const header = `Authorization: Basic ${Buffer.from("x-token-auth:tok123").toString("base64")}`;
    const git = simpleGit({ config: [`http.${base}/team/.extraHeader=${header}`] });
    await git.clone(`${base}${repoPath}`, join(workDir, `c${Date.now()}${Math.random()}`)).catch(() => undefined);
    return seen[0]?.headers;
  }

  it("sends Authorization for a repo under the prefix", async () => {
    const headers = await cloneAndCapture("/team/repo.git");
    expect(headers?.authorization).toBe(`Basic ${Buffer.from("x-token-auth:tok123").toString("base64")}`);
  });

  it("does not send it for a repo outside the prefix", async () => {
    const headers = await cloneAndCapture("/other/repo.git");
    expect(headers).toBeDefined();
    expect(headers?.authorization).toBeUndefined();
  });
});
