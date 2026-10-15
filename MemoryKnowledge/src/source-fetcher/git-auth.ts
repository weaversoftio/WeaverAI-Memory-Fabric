/**
 * Server-side HTTPS credentials for private git repositories.
 *
 * An operator configures one credential scoped to a URL prefix
 * (e.g. https://bitbucket.org/weaversoft/). Repos under that prefix are cloned/fetched
 * with an `Authorization: Basic` header passed as a per-command `git -c` option.
 *
 * The token never becomes part of the repo URL, so it is not stored in the database,
 * not shown in the panel, not written to the clone's .git/config and not echoed in git
 * error messages. Repos outside the prefix get no header.
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
