/**
 * User query extractor - strips all harness context from the user
 * message content of CC / CodeBuddy / other coding agents, keeping only "the text the user actually typed".
 *
 * Usage scenarios (shared by three places in the proxy):
 *   1. wamf/recorder.ts::extractLatestUserMessage - L0 writes
 *   2. agent-adapters/codebuddy.ts::extractUserText - mem command parser +
 *      normalize-conversation extracting clean text for the skill buffer
 *   3. mem-command calls it indirectly via adapter.extractUserText
 *
 * Extraction semantics (in priority order):
 *
 *   0) CC client internal prompts / tool_result disguises / session-init receipts,
 *      and the DSH plain-text `Current runtime context.` snapshot -> dropped entirely, returns "",
 *      the caller uses this to decide not to write L0 / not to enter the skill buffer this turn
 *
 *   1) Explicit `<user_query>...</user_query>` blocks (CodeBuddy standard + some CC templates)
 *      -> only the joined content inside the blocks is extracted, unaffected even if the same message also contains a session-init form
 *
 *   2) When there is no user_query, strip in order:
 *      - `<question_answer>...</question_answer>` (session-init form backfill)
 *      - common XML wrappers (system-reminder / additional_data / user_info /
 *        open_and_recently_viewed_files / session / persisted-output /
 *        tool_use_error / tool_result, etc.)
 *      - single-line tool echoes (Bash completed / Read's cat -n format / Write success receipts)
 *      - MEMORY.md-style yaml frontmatter blocks
 *      - leftover "Session setup - ..." title lines
 *      -> whatever remains after stripping is what the user typed
 *
 * Migration history: this file was extracted from wamf/recorder.ts (originally private to wamf); semantics unchanged.
 * See the appendix of docs/design/2026-07-30-cc-request-routing-plan.md + the codebuddy adapter
 * packet-capture conclusions.
 */

/**
 * Title marker of the session-init (choose Team / Agent / task) form Q&A.
 * Used to strip leftover title lines; real user input is unaffected.
 */
const SESSION_INIT_TITLE_MARKER = "Session setup";

/**
 * Recognizer for the "internal helper prompts" the Claude Code CLI stuffs into the conversation stream with role=user.
 *
 * Scenario: the CC client uses role=user to carry many kinds of content that are **not real user input**; if the whole message hits
 * any pattern, it is judged "not human input" -> this turn is not written to L0, to avoid polluting the memory store.
 *
 * Hit rules design:
 *   - an obvious CC pattern marker appears at the **start** of the whole message ([SUGGESTION MODE], [TITLE MODE], etc.);
 *   - or CC structured metadata JSON ({"parentUuid": ..., "promptId": ...});
 *   - or a system-level recap/summary prompt ("The user stepped away and is coming back...");
 *   - or the receipt of a session-init AskUserQuestion ("Your questions have been answered:");
 *   - or the typical format of tool output disguised as user ("(Bash completed with no output)",
 *     `<persisted-output>` large-file placeholders, CC timestamped log blocks).
 *
 * Matching uses startsWith / whole-string anchoring - so real user input is not hit by mistake.
 */
const CC_INTERNAL_PROMPT_PATTERNS: RegExp[] = [
  // CC pattern marker: [XXX MODE: ...] / [XXX: ...]
  /^\s*\[(?:SUGGESTION|TITLE|SUMMARY|COMPACT|COMPACTION|ANALYSIS|EVAL|RECAP|MEMORY|SIDECHAIN)\s+MODE[:\s]/i,
  // CC session-resume prompt (defined in core prompts/session-resume)
  /^\s*The user stepped away and is coming back\.\s*Recap/i,
  // AskUserQuestion receipt (session-init or runtime Q&A)
  /^\s*Your questions have been answered:\s*"/i,
  // CC structured promptId metadata JSON (first char is a digit + JSON, or directly JSON meta info)
  /^\s*\d+\s*\{"parentUuid"|^\s*\{"parentUuid":\s*"[^"]+","isSidechain"/,
  // CC replays the conversation log with a timestamp prefix ([2026-07-11T...][user] / [assistant])
  /^\s*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]\[(?:user|assistant|system)\]/,
  // Note: <persisted-output> / (Bash completed with no output) are handled in the wrapper-stripping layer of 2b/2c -
  //     they are often concatenated with the user's next sentence in the same user message,
  //     so only they themselves should be removed, keeping the user's following input.
];

function isClaudeCodeInternalPrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CC_INTERNAL_PROMPT_PATTERNS.some((re) => re.test(t));
}

/**
 * DSH appends the runtime environment snapshot as a separate `role=user` message after the real question.
 * Fixed opening, the same anchor as the session-init skip logic, so L0 does not take harness metadata
 * as user input. A real user question never starts with this English passage.
 */
export const DSH_RUNTIME_CONTEXT_PREFIX = "Current runtime context.";

export function isDshRuntimeContextSnapshot(text: string): boolean {
  return text.trimStart().startsWith(DSH_RUNTIME_CONTEXT_PREFIX);
}

/**
 * Extract what the user actually typed from the raw user content text.
 *
 * Returning an empty string means "this user message is entirely harness noise"; the caller should then
 * skip writing L0 / entering the skill buffer / matching mem commands.
 *
 * The parameter `raw` must already be a **string** (array content is joined by the caller - see
 * the respective extractUserText implementations in agent-adapters).
 */
export function extractUserQueryText(raw: string): string {
  // 0) CC internal prompt / tool_result disguise / form receipt -> dropped entirely (not written to L0)
  //    This is the highest priority: even if <user_query> is also present, the whole message is judged non-human input.
  //    Real user input does not hit these patterns anchored at the start / whole string.
  if (isClaudeCodeInternalPrompt(raw)) return "";
  // DSH runtime-context snapshot: plain text with no XML wrapper, must be dropped entirely,
  // otherwise extractLatestUserMessage scanning from back to front would take it as the real question and write it to L0.
  if (isDshRuntimeContextSnapshot(raw)) return "";

  // 1) Preferred: explicit <user_query> blocks (even if the same message is mixed with session-init Q&A,
  //    only the real query is taken and the user input is fully preserved).
  const queries: string[] = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1].trim();
    if (inner) queries.push(inner);
  }
  if (queries.length > 0) return queries.join("\n\n");

  // 2) No explicit user_query: strip all "not user-typed" content fragments, keeping the remaining
  //    real user input. Core principle: only text the user hand-typed is worth writing to L0; all tool echoes
  //    / system reminders / file bodies / form artifacts / CC local memory content - all stripped.
  let text = raw;

  // 2a) session-init form answers <question_answer>...</question_answer>
  text = text.replace(/<question_answer[^>]*>[\s\S]*?<\/question_answer>/gi, "");

  // 2b) XML-wrapper kind: the various harness sections CC / CodeBuddy stuff into the user role
  //     - system-reminder / system_reminder (both spellings covered)
  //     - additional_data (CB puts this in front of every user message: current_time, etc.)
  //     - user_info (OS/shell/workspace metadata CB puts in the first user message)
  //     - open_and_recently_viewed_files
  //     - session (session context wrapper injected by the proxy itself)
  //     - persisted-output (CC "Output too large" large-file placeholder)
  //     - tool_use_error / tool-use-error / tool-result / tool_result (pseudo wrappers)
  for (const tag of [
    "system-reminder", "system_reminder",
    "additional_data",
    "user_info",
    "open_and_recently_viewed_files",
    "session",
    "persisted-output", "persisted_output",
    "tool_use_error", "tool-use-error",
    "tool_result", "tool-result",
    // The proxy may prepend L1 recall inside a user-role message. It is
    // context for the model, not text typed by the user.
    "wamf_recalled_l1_memories",
  ]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // 2c) Line-level filtering: single-line matches of tool echoes / file fragments / memory frontmatter
  //     each rule is judged per line; a match deletes that line; other lines of user input are not blocked.
  const LINE_DROP_PATTERNS: RegExp[] = [
    // CC Write/Edit tool success receipt
    /^\s*The file .+ has been (updated|created) successfully.*$/i,
    /^\s*File created successfully at:/i,
    // CC Bash tool silent completion
    /^\s*\(Bash completed with no output\)\s*$/,
    // CC read tool's cat -n line-number format ("     1  content" / "1  content")
    // At least 3 digits is stricter; 1-2 digits may conflict with user input (e.g. user lists "1 abc")
    // so this only matches "digits + 2 spaces + content" with no other characters at line start - the cat -n specific format
    /^\s{0,6}\d+\t/,   // cat -n separates with a tab (the standard format of the Read tool)
    // MEMORY.md related: output produced by CC session_init/memory commands
    /^\s*File .+ has been (updated|created)/i,
  ];
  text = text
    .split("\n")
    .filter((line) => !LINE_DROP_PATTERNS.some((re) => re.test(line)))
    .join("\n");

  // 2d) Strip whole block: MEMORY.md yaml frontmatter (--- to ---, including metadata)
  //     Format:
  //       ---
  //       name: ...
  //       description: ...
  //       metadata: ...
  //       ---
  //     Only matches frontmatter that "contains at least one of the name / description / metadata / node_type keywords"
  //     to avoid hitting markdown horizontal rules by mistake.
  text = text.replace(
    /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi,
    "\n",
  );

  // 2e) Leftover session-init form title lines (e.g. "Session setup - choose Agent and task")
  text = text
    .split("\n")
    .filter((line) => !line.includes(SESSION_INIT_TITLE_MARKER))
    .join("\n");

  // 2f) Collapse extra blank lines (stripping above may leave large runs of blank lines)
  text = text.replace(/\n{3,}/g, "\n\n");

  // What remains is the user's real input; if the whole message was CC artifacts, this naturally becomes empty -> not written to L0.
  return text.trim();
}
