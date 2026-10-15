/**
 * GitSourceFetcher — source pulling implementation based on simple-git.
 *
 * simple-git internally uses child_process.spawn with an args array and no shell, which eliminates shell injection by design.
 *
 * Security protections (002 §4-5):
 *   - R1 git hooks: clone/fetch never pulls the remote .git/hooks (hooks are local state), so
 *     core.hooksPath is not configured additionally (hardened git rejects that config and needs allowUnsafeHooksPath).
 *   - R2 SSRF: only public HTTPS is allowed + a blacklist of internal/loopback addresses (aligned with the project's security_rules).
 *   - Bug fix (plan A): git clean in incremental sync excludes .codegraph/, so the codegraph index DB is not deleted.
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
import { gitAuthConfig, gitCredentialFromEnv, type GitHttpCredential } from "./git-auth.js";

/**
 * Blacklist of internal / loopback / link-local addresses (standard ranges):
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 private ranges
 *   - 169.254.                     → link-local (including the cloud metadata address 169.254.169.254)
 *   - 127. / 0. / localhost / ::1  → loopback
 *   - fe80:                        → IPv6 link-local
 *
 * This blacklist can be turned off with the environment variable KNOWLEDGE_SSRF_CHECK=off (see the GitSourceFetcher constructor).
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * Read the SSRF private-network blacklist switch. Enabled by default;
 * turned off when KNOWLEDGE_SSRF_CHECK is off/false/0/no (case-insensitive).
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * Whether to enable the SSRF private-network / loopback address blacklist check.
   * Defaults to the environment variable KNOWLEDGE_SSRF_CHECK (enabled by default); an explicitly passed value takes precedence over the environment variable.
   */
  ssrfCheck?: boolean;
  /**
   * Server-side credential for private repos under a URL prefix.
   * Defaults to KNOWLEDGE_GIT_AUTH_* env (see git-auth.ts); pass null to disable.
   */
  credential?: GitHttpCredential | null;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** Switch for the SSRF private-network blacklist check (the https-only protocol check always applies and is not affected by this switch). */
  private readonly ssrfCheck: boolean;
  private readonly credential: GitHttpCredential | null;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.credential = opts?.credential !== undefined ? opts.credential : gitCredentialFromEnv();
  }

  validate(sourceUrl: string): void {
    // HTTPS only; private repos authenticate via the server-side credential (git-auth.ts).
    if (!sourceUrl.startsWith("https://")) {
      throw new Error("only HTTPS repo URLs are supported (SSH is not)");
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // A password/token in the URL would be stored and shown with the repo; private repos
    // must use the server-side credential instead.
    if (this.hasEmbeddedPassword(sourceUrl)) {
      throw new Error(
        "repo_url must not contain a password or token; private repos use the server-side git credential",
      );
    }
    // R2: SSRF protection — forbid addresses pointing to the internal network / loopback (can be turned off via KNOWLEDGE_SSRF_CHECK=off).
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // Shallow clone of a single branch. Note: git clone/fetch does not pull the remote .git/hooks (hooks are local state),
    // so a normally cloned repo carries no executable hooks; core.hooksPath is no longer configured here
    // (hardened git rejects that config: it needs allowUnsafeHooksPath).
    await simpleGit({ config: gitAuthConfig(sourceUrl, this.credential) }).clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit({ baseDir: localPath, config: gitAuthConfig(sourceUrl, this.credential) });
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug fix (plan A): clean excludes .codegraph/, otherwise the codegraph index DB would be deleted,
    // making incremental sync fail forever and fall back to a full clone every time.
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── Internal helpers ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private hasEmbeddedPassword(url: string): boolean {
    try {
      return new URL(url).password !== "";
    } catch {
      return false;
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
