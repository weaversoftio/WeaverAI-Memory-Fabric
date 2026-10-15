/**
 * safe-path.ts — boundary check for on-disk paths.
 *
 * The on-disk path of ingest is indirectly derived from LLM output (FILE block path + frontmatter type);
 * an error at any link of the derivation chain could yield a relative path that escapes the project directory. This provides a last gate
 * independent of the derivation logic: it only accepts "still inside root after resolving to an absolute path".
 */

import { resolve, sep } from "node:path";

/**
 * Whether candidate still falls inside root after resolution (root itself counts).
 *
 * Both sides go through resolve before comparing, so `..`, `.` and repeated separators are already collapsed;
 * the prefix comparison additionally includes the separator, so `/data/proj-evil` is not judged to be inside `/data/proj`.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
