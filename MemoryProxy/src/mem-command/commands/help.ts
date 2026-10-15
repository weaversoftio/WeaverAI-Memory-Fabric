/**
 * mem:help - returns the list of supported commands with examples
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## Supported mem: commands

| Command | What it does |
|------|------|
| \`mem:session-reset\` | Reset this session's Team / Agent / Task binding and open the selection again right away |
| \`mem:sync\` | Refresh all asset injections for this session (Skill / memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [prompt]\` | Archive this conversation as a Skill, extracted in the background |
| \`mem:create-task [title]\` | Create a Task from the current conversation and bind it to this session |
| \`mem:update-task [new description]\` | Update the description of the bound Task |
| \`mem:help\` | Show this help |

---

### 🆕 \`mem:create-task\` — create and bind a Task

**Usage**
- **No argument**: the LLM infers title + description from the recent conversation
- **With argument**: the argument becomes the title (cut at 40 characters); the LLM only writes the description

**If this session already has a real Task bound**, you get a preview of the new Task. Reply with one of:

| Reply | Effect |
|------|------|
| \`mem:create-task confirm\` | ✅ Replace the binding and create the new Task |
| \`mem:update-task\` or \`mem:update-task <new description>\` | ⭐ **Recommended** — keep the current Task and only update its description |
| \`mem:create-task cancel\` | 🚫 Cancel, change nothing |

---

### ✏️ \`mem:update-task\` — update the current Task's description

**Usage**
- **No argument**: the LLM compares "current description + recent conversation" and writes a new description
  - No real change → returns ℹ️ no update needed (idempotent, safe to retry)
  - Changes found → returns a preview
- **With argument**: the argument is used as the new description directly (no LLM call); returns a preview

**Confirm the preview**:
- ✅ \`mem:update-task confirm\` — confirm
- 🚫 \`mem:update-task cancel\` — cancel

**Safeguards**:
- No Task bound to this session → blocked, with a hint to run \`mem:create-task\` first
- The bound Task was not created by you → update refused (no cross-user edits); use \`mem:create-task\` to create one of your own

---

### Examples

\`\`\`
mem:sync
mem:create-skill Summarize the database migration steps and pitfalls
mem:create-task Refactor SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task Add today's progress and remaining risks
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:help
\`\`\`

> The standard format is \`mem:<command>\` with no space after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
