/**
 * source-fetcher barrel — the public exit of the source-pulling interface layer.
 */

export type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
export {
  gitAuthConfig,
  gitCredentialFromEnv,
  resolveGitCredential,
  inferGitUsername,
  credentialAppliesTo,
  type GitHttpCredential,
  type GitAuthOverride,
} from "./git-auth.js";
