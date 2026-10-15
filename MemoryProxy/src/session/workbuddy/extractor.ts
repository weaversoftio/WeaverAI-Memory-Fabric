/**
 * WorkBuddy Session Init — Extractor.
 *
 * The WorkBuddy client reuses CC's `AskUserQuestion` tool contract (same tool name, same
 * questions/answers structure; confirmed by packet capture [wb-ask-user-schema]). So the user's reply
 * tool_result JSON structure is **exactly the same** as CC.
 *
 * This file directly re-exports CC's extractor -- keeping the architectural semantics
 * that "WB is handled by a standalone module" while avoiding copy-pasting 400 lines of matching logic; if either side's behaviour diverges in the future, just
 * add a wrapper in this file, with no need to change upstream.
 *
 * Note: the `SKIP_LABEL / MORE_LABEL / ASSET_CONFIRM_*` constants in the CC extractor
 * are imported from `./claude-code/form.js`. WB form.ts defines constants with the same names, and
 * identical values ("Skip this time (no injection, pass straight through)" / "More ->" etc.), so
 * the extractor works with either; keep using CC's.
 */

export {
  BYPASS_MARKER,
  MORE_MARKER,
  extractAssetConfirm,
  extractTeamFromOptionText,
  extractTaskFromOptionText,
  extractFromOptionText,
  extractStructured,
  resolveAgent,
  resolveTask,
} from "../claude-code/extractor.js";
