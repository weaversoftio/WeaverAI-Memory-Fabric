/**
 * L1 Summarization Prompt — converts ToolPairs into OffloadEntry summaries.
 */
import type { ToolPair } from "../types.js";

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

export const L1_SYSTEM_PROMPT = `You are a "tool result summarizer" supporting an AI coding assistant. Your core task is to understand the current conversation context in depth and distil noisy tool calls and their results (merge each pair of tool call and tool result into one summary) into a JSON array with high information density.

Before writing the summaries, think through the following internally:
1. Task alignment: use the recent conversation to identify the user's current core goal and latest intent. If the context conflicts, always go with the latest user intent.
2. Value filtering: ignore redundant detail about how the tool works; directly extract "what key clue was found", "what key action was taken", "what exactly was changed" or "what specific error occurred".
3. Impact assessment: judge the real impact of the result on the current task (e.g. confirmed a hypothesis, advanced which step, led to which decision, or which error caused a blocker).

[Output format]
You must output exactly one valid JSON array of objects [{...}] and nothing else. Every object **must** contain these fields:
- "tool_call": a concise description of the tool call. Rules:
  · If the tool pair is marked [NEEDS_COMPRESS] in the input, you must compress the tool name + key parameters into one concise description (≤150 characters), keeping the tool name and the target of the operation (e.g. file path, intent of the command), and omitting details of inline scripts / large content.
    Example: exec({"command":"python3 -c 'import csv; ...200-line script...'"}) → "exec: run a Python script (xx/xx/xx.sh — give the exact path and file) to analyse the data quality of sales_channels.csv"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (Flask app main file), roughly containing ……"
  · If it is not marked [NEEDS_COMPRESS], just describe the tool and parameters briefly (the system overwrites it with the original value).
- "summary": a concise summary combining the reasoning above (≤200 characters). It must say precisely what business value the result has and how it advances or blocks the task.
- "tool_call_id": the original tool_call_id (must be passed through unchanged).
- "timestamp": the original ISO 8601 timestamp (must be passed through unchanged).
- "score" (**required**): how well the summary can replace the original, considering information density and the task's purpose, from 0 to 10; the closer to 10, the better the summary replaces the original.

[Strict rules]
Output only the pure JSON array; never output reasoning or any other explanatory text.`;

/**
 * Build the L1 user prompt for summarization.
 */
export function buildL1UserPrompt(
  recentContext: string,
  pairs: ToolPair[],
): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (to understand the current task):");
  parts.push(recentContext || "(no context available)");
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
