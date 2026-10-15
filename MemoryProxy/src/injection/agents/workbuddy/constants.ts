/**
 * WorkBuddy system prompt known XML tags and their display names.
 *
 * NOTE: This is a fully independent copy of the CodeBuddy constants layout —
 * we intentionally do NOT import from ../codebuddy/*. WorkBuddy is a distinct
 * client with its own tag inventory (some overlap with CodeBuddy, some unique).
 */

/**
 * All known top-level XML tag names in WorkBuddy's rendered system prompt,
 * in typical order of appearance.
 *
 * Source of truth: real captured system prompt fixture
 *   src/__tests__/agent-adapters/fixtures/workbuddy-real-system-prompt.txt
 *
 * The 4 memory slots (workbuddy_memory_slot_1 / working_memory /
 * user_local_memory / user_memory) appear as their own top-level XML
 * sections near the head of the prompt, right after the preamble.
 */
export const WORKBUDDY_KNOWN_TAGS = [
  // Memory slots (rendered from 4 nunjucks placeholders in the tpl)
  "workbuddy_memory_slot_1",
  "working_memory",
  "user_local_memory",
  "user_memory",
  // Structural / policy sections
  "content_policy",
  "personal_files_safety",
  "working_modes",
  "agent_loop",
  "result_presentation",
  "sharing_files",
  "final_answer_instructions",
  "automations",
  "tool_use",
  "tool_usage_policy",
  "asking_questions",
  "task_management",
  "instructions_for_visualizer",
  "visualizer_examples",
  "regional_conventions",
  "response_language",
  "mcp_configuration",
  "expert_management",
  "agent_skills",
  // Common example wrappers (used within various sections but sometimes top-level)
  "examples",
  "example",
] as const;

export type WorkbuddyTag = (typeof WORKBUDDY_KNOWN_TAGS)[number];

/**
 * Human-readable names for each tag (for debugging).
 */
export const TAG_DISPLAY_NAMES: Record<string, string> = {
  workbuddy_memory_slot_1: "WorkBuddy memory slot 1",
  working_memory: "Working memory",
  user_local_memory: "User local memory",
  user_memory: "User global memory",
  content_policy: "Content policy",
  personal_files_safety: "Personal file safety",
  working_modes: "Work mode",
  agent_loop: "Agent loop",
  result_presentation: "Presenting results",
  sharing_files: "File sharing",
  final_answer_instructions: "Final answer guidance",
  automations: "Automations",
  tool_use: "Tool use",
  tool_usage_policy: "Tool use strategy",
  asking_questions: "Asking questions",
  task_management: "Task management",
  instructions_for_visualizer: "Visualization instructions",
  visualizer_examples: "Visualization examples",
  regional_conventions: "Regional conventions",
  response_language: "Response language",
  mcp_configuration: "MCP configuration",
  expert_management: "Expert management",
  agent_skills: "Agent skills",
  examples: "Examples",
  example: "Example",
};

/**
 * Tags that serve as "tool/skill injection anchors" in WorkBuddy.
 */
export const TOOL_ANCHOR_TAGS = ["agent_skills"] as const;

/**
 * Tags that serve as "memory injection anchors".
 *
 * WorkBuddy has 4 distinct memory sections; the primary anchor for
 * injected memory is `workbuddy_memory_slot_1` (the free-form long-term
 * profile slot rendered from `{{ WorkbuddyMemory_1 }}`). The other three
 * are typically owned by the WorkBuddy client itself.
 */
export const MEMORY_ANCHOR_TAGS = [
  "workbuddy_memory_slot_1",
  "working_memory",
  "user_local_memory",
  "user_memory",
] as const;

// ── Unknown Tag Detection ────────────────────────────────────────────────────────

const KNOWN_TAG_SET: Set<string> = new Set(WORKBUDDY_KNOWN_TAGS);

/**
 * Scan a text for XML tags that are NOT in WORKBUDDY_KNOWN_TAGS.
 * Returns a list of unique unknown tag names found.
 */
export function detectUnknownTags(text: string): string[] {
  const tagRegex = /<(\w[\w-]*)(?:\s[^>]*?)?>/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const tagName = match[1];
    if (!KNOWN_TAG_SET.has(tagName)) {
      found.add(tagName);
    }
  }
  return Array.from(found).sort();
}

/**
 * Scan a text for ALL XML tags (both known and unknown).
 * Returns { known: string[], unknown: string[] }.
 */
export function classifyTags(text: string): { known: string[]; unknown: string[] } {
  const tagRegex = /<(\w[\w-]*)(?:\s[^>]*?)?>/g;
  const known = new Set<string>();
  const unknown = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    const tagName = match[1];
    if (KNOWN_TAG_SET.has(tagName)) {
      known.add(tagName);
    } else {
      unknown.add(tagName);
    }
  }
  return {
    known: Array.from(known).sort(),
    unknown: Array.from(unknown).sort(),
  };
}
