/**
 * Shared text utility functions for the memory-wamf plugin.
 */

/**
 * Extract meaningful words from text (supports Latin and other scripts).
 *
 * Used by both auto-recall (keyword search) and l1-dedup (keyword candidate recall).
 * Extracted to a shared module to prevent implementation drift.
 */
export function extractWords(text: string): Set<string> {
  const words = new Set<string>();

  // Latin words (2+ chars)
  const latinWords = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (latinWords) {
    for (const w of latinWords) words.add(w);
  }

  // Wide-script characters (each char as a "word", plus 2-gram)
  const wideChars = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  if (wideChars) {
    for (const c of wideChars) words.add(c);
    // 2-grams for better matching
    for (let i = 0; i < wideChars.length - 1; i++) {
      words.add(wideChars[i] + wideChars[i + 1]);
    }
  }

  return words;
}
