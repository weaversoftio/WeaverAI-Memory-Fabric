/**
 * slug.ts — entity name → stable file name slug
 *
 * The foundation of dedup (merge on duplicates): the same entity name ingested twice must produce the same slug,
 * so the second ingest can hit the existing `wiki/<type>/<slug>.md` and merge instead of creating a new page.
 *
 * Rules (PRD FR-4 / INTERFACE §2, multilingual sources):
 *   - English/digits: lowercase, spaces and punctuation become hyphens, strip leading/trailing/repeated hyphens.
 *   - Han ideographs: keep the characters themselves, only strip spaces (no romanization, nothing dropped).
 *   - Mixed: process each part by the rules above, then join (`Redis Cluster` → `redis-cluster`).
 */

// Han ideographs; punctuation is not in this script (it is treated as a separator).
const HAN_SCRIPT_RE = /\p{Script=Han}/u;

function isIdeographChar(ch: string): boolean {
  return HAN_SCRIPT_RE.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Normalize an entity name/title into a stable slug.
 *
 * Implementation strategy: scan character by character, forming tokens that alternate between ideograph runs and Latin/digit runs,
 * joined by hyphens between runs; Latin runs are lowercased; all other characters (spaces, punctuation) are run boundaries.
 */
export function slugify(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  let buf = "";
  let bufKind: "ideograph" | "latin" | null = null;

  const flush = () => {
    if (buf) {
      tokens.push(bufKind === "latin" ? buf.toLowerCase() : buf);
      buf = "";
    }
    bufKind = null;
  };

  for (const ch of trimmed) {
    if (isIdeographChar(ch)) {
      if (bufKind !== "ideograph") flush();
      bufKind = "ideograph";
      buf += ch;
    } else if (isAlnumChar(ch)) {
      if (bufKind !== "latin") flush();
      bufKind = "latin";
      buf += ch;
    } else {
      // spaces / punctuation / others → run boundary
      flush();
    }
  }
  flush();

  // Join with hyphens, removing repeated/leading/trailing hyphens.
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Given a page type and title, return the wiki-relative path (without the leading `wiki/`).
 * e.g. type="entity", title="Redis Cluster" → "entities/redis-cluster.md"
 *
 * The type → directory mapping aligns with the existing manager's directory convention (entities/concepts/sources/...).
 */
const TYPE_DIR: Record<string, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
};

/**
 * Value domain of a legal type: type is an OKF category label, not a path, so it can only be an identifier.
 * Any value containing `/`, `.` (including `..`) or other characters is not a legal category and always goes to the other directory.
 */
const SAFE_TYPE_RE = /^[a-z0-9_-]+$/;

/** Map a type to a directory name; an unknown but legal type uses itself as a generic directory, an illegal value goes to other. */
export function dirForType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  // hasOwn rather than indexed lookup: avoids "__proto__"/"constructor" hitting members on the Object prototype chain.
  if (Object.hasOwn(TYPE_DIR, key)) return TYPE_DIR[key];
  if (!SAFE_TYPE_RE.test(key)) return "other";
  return key;
}

/**
 * Compute the wiki-relative path of a page (with the `wiki/` prefix), used for writing to disk and for dedup hits.
 * @param type page type (source/entity/concept/...)
 * @param title entity name/title
 */
export function pageRelPath(type: string, title: string): string {
  const slug = slugify(title);
  const dir = dirForType(type);
  return `wiki/${dir}/${slug}.md`;
}
