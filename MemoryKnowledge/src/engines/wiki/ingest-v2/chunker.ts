/**
 * chunker.ts — chunking of overlong sources.
 *
 * When the number of source characters exceeds the model context budget, the text is cut into chunks processed one by one,
 * with a small overlap between chunks to preserve context continuity (INTERFACE §6).
 *
 * Splitting unit (OQ-5 optimization): prefer cutting at markdown heading (`#`~`######`) boundaries,
 * so each semantic section lands as completely as possible in one chunk; overlong sections fall back to splitting by blank-line paragraphs,
 * and paragraphs that are still overlong are hard-cut last. This avoids abrupt cuts in the middle of a sentence/section.
 */

export interface ChunkOptions {
  /** Upper limit of target characters per chunk (default 12000). */
  targetChars?: number;
  /** Number of overlapping characters between chunks (default 400). */
  overlapChars?: number;
}

const DEFAULT_TARGET = 12_000;
const DEFAULT_OVERLAP = 400;

/**
 * Cut the text into an array of "splitting units": each unit is ideally one complete markdown section
 * (from one heading line to just before the next heading line). A headless leading part is its own unit.
 * Units longer than target are subdivided by blank-line paragraphs; paragraphs still too long are hard-cut.
 */
function splitIntoUnits(text: string, target: number): string[] {
  const lines = text.split("\n");
  // First cut into sections at heading lines.
  const sections: string[] = [];
  let cur: string[] = [];
  const isHeading = (line: string) => /^#{1,6}\s+\S/.test(line);
  for (const line of lines) {
    if (isHeading(line) && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join("\n"));

  // Overlong sections fall back to subdivision: first by blank-line paragraphs, then hard cuts.
  const units: string[] = [];
  for (const sec of sections) {
    const s = sec.trim();
    if (!s) continue;
    if (s.length <= target) {
      units.push(s);
      continue;
    }
    for (const para of s.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= target) {
        units.push(p);
      } else {
        for (let i = 0; i < p.length; i += target) units.push(p.slice(i, i + target));
      }
    }
  }
  return units;
}

/**
 * Aggregate the text into chunks. Each chunk tries not to exceed targetChars, aggregating along markdown section boundaries.
 *
 * @returns array of chunks; empty input returns [], input under the threshold returns a single-element array.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(1000, opts.targetChars ?? DEFAULT_TARGET);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(target / 2)));

  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= target) return [trimmed];

  const units = splitIntoUnits(trimmed, target);

  const chunks: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    if (candidate.length > target && buf) {
      chunks.push(buf);
      // Overlap: use the last overlap characters of the previous chunk as the start of the next chunk
      const tail = overlap > 0 ? buf.slice(-overlap) : "";
      buf = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** Roughly estimate the token count of a string (conservative len/3). Used to decide whether chunking is needed. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3);
}
