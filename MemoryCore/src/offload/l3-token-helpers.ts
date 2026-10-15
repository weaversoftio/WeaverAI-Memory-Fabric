/**
 * Heuristic token estimate (ideographs/1.7 + Latin/4) when tiktoken is disabled or fails.
 */

function countWideChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      n++;
    }
  }
  return n;
}

export function estimateL3MixedTokensHeuristic(text: string): number {
  const wide = countWideChars(text);
  const rest = Math.max(0, text.length - wide);
  return Math.ceil(wide / 1.7 + rest / 4);
}
