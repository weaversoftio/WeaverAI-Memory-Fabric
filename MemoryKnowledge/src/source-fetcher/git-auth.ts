/**
 * HTTPS credentials for private git repositories.
 *
 * Two sources, in order:
 *   1. A per-repo token from Code Graph register (`git_token` / `git_username`).
 *      Stored in dedicated columns, never in repo_url, never returned on list/get.
 *   2. A server-wide credential scoped to a URL prefix
 *      (e.g. https://bitbucket.org/weaversoft/) via KNOWLEDGE_GIT_AUTH_*.
 *
 * Both are sent as `Authorization: Basic` on a per-command `git -c` option.
 * The token never becomes part of the repo URL, so it is not shown in the panel,
 * not written to the clone's .git/config and not echoed in git error messages.
 *
 * Env:
 *   KNOWLEDGE_GIT_AUTH_URL_PREFIX  https://bitbucket.org/<workspace>/
 *   KNOWLEDGE_GIT_AUTH_USERNAME    x-token-auth for Bitbucket access tokens
 *   KNOWLEDGE_GIT_AUTH_TOKEN       the token (secret)
 */

export interface GitHttpCredential {
  /** Normalised: lower-case scheme/host, always ends with "/". */
  urlPrefix: string;
  username: string;
  token: string;
}

function normalisePrefix(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `https://${url.host.toLowerCase()}${path}`;
}

/**
 * Read the credential from env. The token is the on/off switch: without it the feature is
 * off (public repos only), even if a prefix/username is pre-filled. With a token, a missing
 * or invalid prefix/username throws, so a typo fails at startup instead of on the first clone.
 */
export function gitCredentialFromEnv(env: NodeJS.ProcessEnv = process.env): GitHttpCredential | null {
  const prefix = env.KNOWLEDGE_GIT_AUTH_URL_PREFIX?.trim() ?? "";
  const username = env.KNOWLEDGE_GIT_AUTH_USERNAME?.trim() ?? "";
  const token = env.KNOWLEDGE_GIT_AUTH_TOKEN?.trim() ?? "";
  if (!token) return null;
  if (!prefix || !username) {
    throw new Error(
      "KNOWLEDGE_GIT_AUTH_TOKEN is set, so KNOWLEDGE_GIT_AUTH_URL_PREFIX and KNOWLEDGE_GIT_AUTH_USERNAME are required too",
    );
  }
  const urlPrefix = normalisePrefix(prefix);
  if (!urlPrefix) {
    throw new Error(
      "KNOWLEDGE_GIT_AUTH_URL_PREFIX must be an https:// URL without embedded credentials, e.g. https://bitbucket.org/<workspace>/",
    );
  }
  return { urlPrefix, username, token };
}

/** Does the credential apply to this repo URL? Scheme/host compare case-insensitively. */
export function credentialAppliesTo(repoUrl: string, cred: GitHttpCredential): boolean {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const normalised = `https://${url.host.toLowerCase()}${url.pathname}`;
  return normalised.startsWith(cred.urlPrefix);
}

/**
 * `git -c` entries for a repo: the auth header, scoped by git itself to the prefix
 * (http.<url>.extraHeader), or nothing when the credential doesn't apply.
 */
export function gitAuthConfig(repoUrl: string, cred: GitHttpCredential | null): string[] {
  if (!cred || !credentialAppliesTo(repoUrl, cred)) return [];
  const basic = Buffer.from(`${cred.username}:${cred.token}`, "utf8").toString("base64");
  return [`http.${cred.urlPrefix}.extraHeader=Authorization: Basic ${basic}`];
}

/** Default Basic-auth username for a host when the caller omits one. */
export function inferGitUsername(repoUrl: string): string {
  let host = "";
  try {
    host = new URL(repoUrl).host.toLowerCase();
  } catch {
    return "git";
  }
  if (host === "github.com" || host.endsWith(".github.com")) return "x-access-token";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "x-token-auth";
  if (host === "gitlab.com" || host.includes("gitlab")) return "oauth2";
  return "git";
}

/** https://host/ — used so a per-repo token is scoped to that clone command only. */
function hostPrefix(repoUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    return null;
  }
  // A username in the URL (Bitbucket clone button) is fine; a password is not.
  if (url.protocol !== "https:" || url.password) return null;
  return `https://${url.host.toLowerCase()}/`;
}

export interface GitAuthOverride {
  username?: string | null;
  token?: string | null;
}

/**
 * Prefer a per-repo token (register form). Otherwise the server-wide
 * KNOWLEDGE_GIT_AUTH_* credential, and only if its prefix matches.
 */
export function resolveGitCredential(
  repoUrl: string,
  override?: GitAuthOverride | null,
  env: NodeJS.ProcessEnv = process.env,
): GitHttpCredential | null {
  const token = override?.token?.trim() ?? "";
  if (token) {
    const urlPrefix = hostPrefix(repoUrl);
    if (!urlPrefix) return null;
    const username = override?.username?.trim() || inferGitUsername(repoUrl);
    return { urlPrefix, username, token };
  }
  const envCred = gitCredentialFromEnv(env);
  if (!envCred || !credentialAppliesTo(repoUrl, envCred)) return null;
  return envCred;
}
