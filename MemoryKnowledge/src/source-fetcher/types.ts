/**
 * SourceFetcher interface layer — protocol-agnostic abstraction of source pulling and security validation.
 *
 * Responsibility: abstract "pull code from some source (git/local/ftp) into a local directory" into a unified interface;
 * security validation (protocol whitelist + SSRF protection) is centralized in each implementation's validate().
 * Concrete implementations (such as GitSourceFetcher) depend on simple-git, but that dependency does not leak into this interface layer.
 */

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** Local directory (absolute path) the source is written to. */
  localPath: string;
  /** Current version identifier (for git, the first 12 characters of the commit hash; null if unavailable). */
  version: string | null;
  /** Source protocol type. */
  sourceType: SourceType;
}

/**
 * Source fetcher interface. Implementers are responsible for:
 *   1. validating the safety of sourceUrl (protocol whitelist, SSRF, etc.)
 *   2. pulling/syncing the source into localPath
 *   3. returning the version identifier
 *
 * Implementations:
 *   - GitSourceFetcher: simple-git, the first version supports only public HTTPS (SSH/private repo auth: see doc 005)
 *   - LocalSourceFetcher / FtpSourceFetcher: future extensions
 */
export interface ISourceFetcher {
  /** First pull: download the source into localPath. */
  fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Incremental sync: update the existing localPath to the latest version. */
  sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Validate whether sourceUrl is legal (protocol whitelist + SSRF protection). Throws if illegal. */
  validate(sourceUrl: string): void;

  /** Supported protocol types. */
  readonly supportedType: SourceType;
}
