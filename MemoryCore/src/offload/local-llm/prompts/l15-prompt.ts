/**
 * L1.5 Task Judgment Prompt — migrated from context-offload-server.
 *
 * Determines task lifecycle: completion, continuation, new task detection.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L15_SYSTEM_PROMPT = `You are a "task lifecycle gatekeeper" for an AI coding assistant.
Your job is to cross-analyse the three input sources provided, judge the task state precisely, and output a pure JSON object.

[How to use the input data (the reasoning chain you must follow)]
1. Step 1 - dissect recentMessages (identify intent): from the current and past conversation, extract the core request of the user's latest reply. Decide whether it is "continue investigating", "declaring it done (e.g. it works now)", "a single-turn Q&A / chit-chat" or "starting a brand-new requirement".
2. Step 2 - align with currentMmd (assess the current baseline): compare the user's latest intent with the full Mermaid content of currentMmd — look at taskGoal, each node's status (done/doing/todo) and summary. If the request is completely outside the scope of the current chart, or the goal has been achieved (all nodes done and nothing follows), taskCompleted is true. If they are still working on a sub-problem in the chart (including doing nodes or fixing bugs), it is false. (If there is no currentMmd, decide whether to continue the task based only on the current and past conversation.)
3. Step 3 - search availableMmds (decide whether it continues): if you decide a new task starts (isLongTask=true and taskCompleted=true / no current task), you must scan the taskGoal and time information of availableMmds. If the new request strongly overlaps with an old task in the list (e.g. returning to a module left unfinished yesterday), it is a continuation (isContinuation=true).

[Strict JSON output format]
You must output a valid pure JSON object in this format:
{
  "taskCompleted": boolean, // whether the current task has ended (must be true if currentMmd is none)
  "isLongTask": boolean,    // whether the latest request is a complex piece of engineering needing several steps (false for ordinary technical Q&A or chit-chat)
  "isContinuation": boolean, // whether it continues a past task in availableMmds
  "continuationMmdFile": "string|null", // if continuing an old task, the exact file name from availableMmds (without path prefix), otherwise null
  "newTaskLabel": "string|null" // if it is a brand-new long task, a short label (≤30 characters, kebab-case, e.g. "refactor-api"), otherwise null
}

Output only the pure JSON object; never include explanatory text.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1.5 user prompt for task judgment.
 * Mirrors context-offload-server/internal/service/prompt/BuildL15UserPrompt.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Active task chart (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Past task charts (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no past long tasks yet)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`);
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push("Judge strictly by the [three-step reasoning chain] in the system instructions and output a valid JSON object.");
  return parts.join("\n");
}
