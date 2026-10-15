/**
 * Unified entry point of the mem-command module
 *
 * Provides:
 *  - parseMemCommand()  - detects whether the input is a mem: command
 *  - executeMemCommand() - executes a command and returns the result
 *
 * Command interception is **always enabled** (no config switch); the command whitelist is deprecated - unknown commands are
 * handled by the KNOWN_COMMANDS fallback inside executeMemCommand, which returns an "unknown command" hint.
 */

import type { MemCommandContext, MemCommandResult } from "./types.js";
import { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
import { buildMemResponse } from "./response-builder.js";
import { executeHelp } from "./commands/help.js";
import { executeSync } from "./commands/sync.js";
import { executeCreateSkill } from "./commands/create-skill.js";
import { executeCreateTask } from "./commands/create-task.js";
import { executeUpdateTask } from "./commands/update-task.js";
import { executeSessionReset } from "./commands/session-reset.js";

export { parseMemCommand, parseCommandFromText, type ParsedMemCommand } from "./parser.js";
export { buildMemResponse } from "./response-builder.js";
export type { MemCommandContext, MemCommandResult, MemCommandName, MemCommandMessage } from "./types.js";
export { getHelpText } from "./commands/help.js";
export { extractSimpleMessages, truncateArgs } from "./utils.js";

/** List of known commands */
const KNOWN_COMMANDS = new Set([
  "sync",
  "create-skill",
  "create-task",
  "update-task",
  "session-reset",
  "help",
]);

/**
 * Executes a parsed mem: command.
 */
export async function executeMemCommand(
  cmd: ParsedMemCommand,
  ctx: MemCommandContext,
): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;

  // Unknown command
  if (!KNOWN_COMMANDS.has(cmd.command)) {
    const text = `❌ Unknown command: \`mem:${cmd.command}\`. Type \`mem:help\` to see the available commands.`;
    return {
      success: false,
      messageText: text,
      response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
    };
  }

  switch (cmd.command) {
    case "help":
      return executeHelp(ctx);
    case "sync":
      return executeSync(ctx);
    case "create-skill":
      return executeCreateSkill(ctx);
    case "create-task":
      return executeCreateTask(ctx);
    case "update-task":
      return executeUpdateTask(ctx);
    case "session-reset":
      return executeSessionReset(ctx);
    default: {
      const text = `❌ Unknown command: \`mem:${cmd.command}\``;
      return {
        success: false,
        messageText: text,
        response: buildMemResponse(text, { protocol: ctx.protocol, stream: ctx.stream, requestId, thinking: ctx.thinking }),
      };
    }
  }
}
