/**
 * Codex asset injection - `<wamf_injections>` wrapper generator.
 *
 * Appends a text block at the end of content[] of codex body.input[0] (the developer message):
 * `{type:"input_text", text:"<wamf_injections>...\n</wamf_injections>"}`.
 *
 * Two modes:
 *   - **raw** (the path the current codex handler takes): the **complete finished text** already produced by the pipeline
 *     (containing multiple groups of internal XML tags such as `<available_skills>` / `<user_memory>` / `<wamf_profile_memory>` /
 *     `<memory-tools-guide>`) is embedded as-is in the inner layer of the wrapper, with no
 *     escaping or extra tag wrapping, **byte-identical** to what the CC / CB clients see in the system message
 *     - the model learns exactly the same semantics, and no "codex-specific prompt" is needed.
 *
 *   - **structured** (`{skills, memory, ...}` split into 5 sections): reserved for a future codex-specific
 *     renderer (enabled when a real per-section split is needed, e.g. the UI layer wants to render per section). **The current pipeline
 *     output is a single text string and cannot be split back into 5 sections, so this mode cannot be used for the main path**
 *     - misuse would stuff the whole pipeline output into the single `<available_skills>` tag, and all inner
 *     `<...>` would be XML-escaped into `&lt;...&gt;`, which the model cannot read. The history of this pitfall is recorded in the P0 fix
 *     commit body.
 *
 * Why a wrapper rather than appending the pipeline output directly as raw text:
 *   - When something goes wrong, `grep '<wamf_injections>'` locates the section injected by this handler in one step
 *   - Easier to compress context when the client replays on the next turn
 *   - Gives a place to add metadata inside the wrapper later in P2/P3
 *
 * See docs/2026-08-07-codex-integration-plan.md section 4.
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode: escapes the five XML special characters < > & " '.
 * Used only in structured mode; raw mode (the current main path) does not escape, because what is passed in is already
 * a valid XML structure, and escaping would turn all tags into entity characters so the model could not read the tag semantics.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Segments ─────────────────────────────────────────────────────────────────

/** structured mode sub-section definition: tag name + corresponding input field name. Order is render order. */
const SEGMENTS: Array<{ tag: string; field: keyof CodexInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw mode input: the complete XML text string already produced by the pipeline (no second escaping / wrapping).
 * The current codex handler takes this path, byte-identical to the CC / CB system message content.
 */
export interface CodexInjectionInputRaw {
  raw: string;
}

/**
 * Structured mode input: split into 5 sections (reserved for a future codex-specific renderer).
 * WARNING: do not use for the current main pipeline path - see the explanation in the module doc.
 */
export interface CodexInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildCodexInjectionBlock` input: raw / structured, either one.
 * Passing `{raw}` -> raw mode, embedded as-is; otherwise treated as structured and rendered split into 5 sections.
 */
export type CodexInjectionInput = CodexInjectionInputRaw | CodexInjectionInputStructured;

/**
 * Build the `<wamf_injections>` wrapper, returning an input_text object that can be pushed directly into codex's
 * `body.input[0].content` array.
 *
 * - raw mode: `{raw: "..."}` -> embedded as-is in the inner layer of the wrapper, no escape, no sub-tags
 * - structured mode: `{skills, memory, ...}` -> each section wrapped in the matching tag + XML escape,
 *   empty sections (empty string / undefined) omitted
 * - with no content, still returns the empty wrapper `<wamf_injections>\n</wamf_injections>`
 */
export function buildCodexInjectionBlock(
  input: CodexInjectionInput,
): { type: "input_text"; text: string } {
  // Raw mode: embed directly, no processing
  if (isRawInput(input)) {
    const raw = input.raw ?? "";
    const inner = raw.length > 0 ? "\n" + raw + "\n" : "\n";
    return { type: "input_text", text: `<wamf_injections>${inner}</wamf_injections>` };
  }

  // Structured mode: 5-section split + XML-escaped content
  const parts: string[] = [];
  for (const seg of SEGMENTS) {
    const raw = input[seg.field];
    if (!raw) continue;
    parts.push(`<${seg.tag}>\n${xmlEscape(raw)}\n</${seg.tag}>`);
  }
  const inner = parts.length > 0 ? "\n" + parts.join("\n\n") + "\n" : "\n";
  return { type: "input_text", text: `<wamf_injections>${inner}</wamf_injections>` };
}

function isRawInput(input: CodexInjectionInput): input is CodexInjectionInputRaw {
  return typeof (input as CodexInjectionInputRaw).raw === "string";
}
