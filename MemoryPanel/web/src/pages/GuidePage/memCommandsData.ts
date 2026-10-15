/**
 * memCommandsData.ts — data source of the GuidePage "memory commands" page (pure data, no UI).
 *
 * Collects all `mem:` commands supported in an Agent session: command name, copyable examples,
 * description copy keys (i18n), and the "reply options" for commands that need multi-step confirmation.
 * The component (MemCommands.tsx) only renders from this data, keeping data and view separate.
 *
 * Conventions:
 *   - The standard format is `mem:<command>`, with no space after the colon, and the command name is case-insensitive.
 *   - All copy fields are i18n keys (see the guide.mem.* section of i18n/*.ts).
 *
 * Note: the file name is deliberately distinct from the component MemCommands.tsx, to avoid resolution ambiguity on case-insensitive file systems.
 */

/** Command categories: everyday high-frequency / task management (confirmation flow required) */
export type MemCommandGroup = 'session' | 'task';

/** One row of "confirm/reply options" under a command (used for the multi-step confirmation of create-task / update-task) */
export interface MemCommandOption {
  /** The command the user should reply with (copyable), e.g. `mem:create-task confirm` */
  reply: string;
  /** i18n key of this reply's effect */
  effect: string;
  /** Whether it is the recommended option (highlighted when rendered) */
  recommended?: boolean;
}

export interface MemCommand {
  /** Command identifier (also used as the React key) */
  id: string;
  group: MemCommandGroup;
  /** Raw copyable command text (static part), e.g. `mem:sync`, `mem:create-task` */
  command: string;
  /** i18n key of the command argument placeholder (optional), e.g. "[title]"; switches with the language and is appended after command for display and copying */
  argKey?: string;
  /** i18n key of the one-line description */
  descKey: string;
  /** List of i18n keys of the detailed description paragraphs (optional) */
  detailKeys?: string[];
  /** Confirm/reply options of this command (optional, only create-task / update-task have them) */
  options?: MemCommandOption[];
}

/** Group title / subtitle i18n keys */
export const MEM_GROUPS: Array<{ id: MemCommandGroup; titleKey: string; subKey: string }> = [
  { id: 'session', titleKey: 'guide.mem.group.session.title', subKey: 'guide.mem.group.session.sub' },
  { id: 'task', titleKey: 'guide.mem.group.task.title', subKey: 'guide.mem.group.task.sub' },
];

export const MEM_COMMANDS: MemCommand[] = [
  {
    id: 'help',
    group: 'session',
    command: 'mem:help',
    descKey: 'guide.mem.cmd.help.desc',
  },
  {
    id: 'session-reset',
    group: 'session',
    command: 'mem:session-reset',
    descKey: 'guide.mem.cmd.sessionReset.desc',
  },
  {
    id: 'sync',
    group: 'session',
    command: 'mem:sync',
    descKey: 'guide.mem.cmd.sync.desc',
  },
  {
    id: 'create-skill',
    group: 'session',
    command: 'mem:create-skill',
    argKey: 'guide.mem.arg.prompt',
    descKey: 'guide.mem.cmd.createSkill.desc',
  },
  {
    id: 'create-task',
    group: 'task',
    command: 'mem:create-task',
    argKey: 'guide.mem.arg.title',
    descKey: 'guide.mem.cmd.createTask.desc',
    detailKeys: [
      'guide.mem.cmd.createTask.detail1',
      'guide.mem.cmd.createTask.detail2',
    ],
    options: [
      { reply: 'mem:create-task confirm', effect: 'guide.mem.cmd.createTask.opt.confirm' },
      { reply: 'mem:update-task', effect: 'guide.mem.cmd.createTask.opt.update', recommended: true },
      { reply: 'mem:create-task cancel', effect: 'guide.mem.cmd.createTask.opt.cancel' },
    ],
  },
  {
    id: 'update-task',
    group: 'task',
    command: 'mem:update-task',
    argKey: 'guide.mem.arg.newDesc',
    descKey: 'guide.mem.cmd.updateTask.desc',
    detailKeys: [
      'guide.mem.cmd.updateTask.detail1',
      'guide.mem.cmd.updateTask.detail2',
    ],
    options: [
      { reply: 'mem:update-task confirm', effect: 'guide.mem.cmd.updateTask.opt.confirm' },
      { reply: 'mem:update-task cancel', effect: 'guide.mem.cmd.updateTask.opt.cancel' },
    ],
  },
];

/** Examples area: a set of common command examples that can be copied as a whole.
 *  Examples containing arguments switch with the language; see i18n key `guide.mem.examples.list` (multi-line string). */
export const MEM_EXAMPLES_KEY = 'guide.mem.examples.list';
