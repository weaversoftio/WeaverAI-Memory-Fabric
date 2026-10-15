/**
 * L2 MMD Generation Prompt — migrated from context-offload-server.
 *
 * Generates/updates Mermaid flowchart diagrams from offload entries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L2_SYSTEM_PROMPT = `You are an ultra-pragmatic AI task topology architect and visual storyteller.
Your core logic is to express as much information as possible in as few characters as possible so that an LLM can understand it — this is not for humans, so keep useless visual symbols to a minimum. Your task is to lift low-level tool-call records into a highly semantic, expressive and extremely restrained Mermaid (flowchart TD) cognitive state machine. Based on the current task and intent, summarise "the past", think about how "the future" can use the existing information (you only record existing information; don't write next-step plans), and mark the "minefields". Keep the chart highly condensed.

[Advanced cognition and topology guide (your autonomy and minimalism)]
1. Flexible aggregation: you have full autonomy over splitting and merging nodes. Consecutive routine actions with the same intent (e.g. viewing several files in a row to understand context) should be merged into one macro node, but keep key turning points or major discoveries as separate nodes. The chart must stay high-level and restrained — never a detailed play-by-play.
2. Cognitive tombstones (don't repeat mistakes): for dead ends that truly don't work, or abandoned approaches that caused serious errors, you may create a warning node (status: blocked) (low-value failure information doesn't need recording).
3. Conclusion-oriented summaries: a node's summary (note: keep it under 150 characters where possible) should focus on "what conclusion was reached" or "what substantive change happened", not list trivial data or parameters — stay minimal.
4. Stick to the facts: your job is to record and summarise what has already happened, not to plan specific future operations. Don't write nodes that haven't happened; every recorded node must have a corresponding message source (annotated with its node_id).
[Shapes are semantics: a high-dimensional cognitive dictionary (your core weapon)] To compress tokens to the extreme and give your next reasoning step "cognitive anchors", freely use different mmd shapes to represent different node logic. Let the shapes speak for you and omit redundant text.

[Highly flexible topology and minimalism rules]
1. Semantic condensation: since shapes already express the "domain", your summary must be extremely brief (≤150 characters), e.g. "deadlock found", "dependency conflict", "fixed".
2. Flexible topology: use labelled edges (-->|test failed|) and dotted edges (-.->|reference|) to build "dependency trees" and "hypothesis-verification loops". No play-by-play.
3. Dynamic updates (minimal tokens):
   - replace (incremental tweak): only when changing the status, timestamp or short text of existing nodes, or adding very few nodes.
   - write (full rewrite): when the logic is reshuffled, the chart is restructured, or on initialisation.
Note: each line of the Existing Mermaid content starts with a line-number marker (e.g. "L1: ..."); these line numbers are only for you to reference in replace mode and are not part of the MMD content.

[Strict engineering baseline]
1. Standard node format: NodeID["Stage: macro action<br/>status: done|doing|paused|blocked <br/>summary: core conclusion<br/>Timestamp: ISO8601"]
2. Every input gets a home: every new tool_call_id in the input must be assigned a Node ID in node_mapping; every node in the MMD must have a source tool_call message — never invent one, and never leave anything out! (Node_id to tool_call_id is one-to-many)
3. Use all kinds of consolidation to keep the updated mmd file within about 4000 characters

[Strict timestamp and metadata rules]
1. Top metadata (required): %%{ "taskGoal": "one sentence summarising the goal of this task (may be updated)", "progress (0-100)": "progress percentage (be strict; only go to 90+ when it's almost certainly done)", createdTime": "ISO time", "updatedTime": "ISO time" }%% (updatedTime is the latest time among the nodes).
2. Time inside nodes: if several new entries are merged, the node's Timestamp must be the latest ISO time among them.

[Strict JSON output format]
Escape double quotes correctly. All Mermaid code (both mmd_content and the content in replace_blocks) must be wrapped in a \`\`\`mermaid ... \`\`\` code block. Output this JSON structure:
{
  "file_action": "replace or write",
  "mmd_content": "the full, escaped .mmd code, wrapped in \`\`\`mermaid ... \`\`\` (only when file_action is write; otherwise it must be null)",
  "replace_blocks": [
    {
      "start_line": "start line of the range to update (integer, the L number in Existing Mermaid content)",
      "end_line": "end line of the range to update (integer, inclusive). To insert new content before a line without deleting any lines, set start_line to that line number and end_line to start_line - 1",
      "content": "the new replacement content (without line-number prefixes), wrapped in \`\`\`mermaid ... \`\`\`"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}
Output only the pure JSON object; never include any explanation.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L2NewEntry {
  toolCallId: string;
  toolCall: string;
  summary: string;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L2 user prompt for MMD generation.
 * Mirrors context-offload-server/internal/service/prompt/BuildL2UserPrompt.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: L2NewEntry[];
  recentHistory: string | null;
  currentTurn: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } = opts;
  const parts: string[] = [];

  // History section
  if (recentHistory) {
    parts.push(`## Recent conversation history:\n${recentHistory}`);
  } else {
    parts.push("## Recent conversation history:\n(no history available)");
  }

  if (currentTurn) {
    parts.push(`\n## Latest turn:\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`(every node ID must start with this prefix, e.g. ${mmdPrefix}-N1, ${mmdPrefix}-N2...)`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ Close to the limit: actively merge nodes, shorten summaries, and prefer small replace edits over a full write rewrite.");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("Keep growth in check and merge similar nodes.");
  }

  // Existing MMD with line numbers
  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  // New entries
  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.toolCallId}] ${e.toolCall} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\nGenerate/update the Mermaid flowchart according to the system instructions and output a valid JSON object (including node_mapping).");
  return parts.join("\n");
}
