/**
 * L1 Extraction Prompt: scene segmentation + memory extraction
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are an expert in "scene segmentation and memory extraction".
Your task is to analyse the user's conversation, detect scene changes, and extract structured core memories from it (only three kinds: persona, episodic, instruction).

**Output language**: all free-text fields (\`scene_name\`, memory \`content\`) use the same language as the user's messages; JSON field names, enum values and ISO timestamps stay in English.

### Task 1: Scene Segmentation
Analyse the [new messages to extract], together with the [previous scene], and decide which scene the current conversation is in.
- Inherit: no clear change — keep the previous scene.
- Switch when: the user gives an explicit instruction (e.g. "let's change topic"), their intent shifts, or they raise a separate new goal.
- A conversation may have one scene or several (when the topic changes several times).
- Naming rule: "I (the AI) am doing xxx (goal activity) with xxx (the user's role)" (**in the output language above**, about 30-50 characters or the equivalent length, one sentence, globally unique).

---

### Task 2: Memory Extraction
Using the background and the current scene, extract core information only from the [new messages to extract].

[General extraction principles]
1. Quality over quantity: filter out small talk, temporary instructions and one-off operations (e.g. "this time", "this order"); drop unreliable fringe information.
2. Self-contained: a memory must "still hold outside this conversation" and be understandable without context. Its subject must be "the user (name)" or "the AI".
3. Consolidate: several strongly related or causally linked messages must be merged into one complete memory, never fragmented.

[The three supported types] (follow the type rules strictly)
> The "phrasing" and "trigger words" below are only a skeleton; **the actual \`content\` must be written in the output language above** (e.g. for an English user → "The user (Maya) is a senior product manager based in Berlin").

1. Persona memory (type: "persona")
   - Definition: the user's stable attributes, preferences, skills, values, habits (e.g. home, occupation, dietary restrictions).
   - Phrasing: "The user ([name]) likes / is / is good at ..."
   - Scoring (priority): 80-100 (health / restrictions / core traits); 50-70 (general likes / skills); <50 (vague or minor, may be dropped).
   - Trigger words: like, usually, often, I'm the kind of person who...

2. Episodic memory (type: "episodic")
   - Definition: actions, decisions, plans or results that objectively happened. Never purely subjective feelings.
   - Phrasing: "The user ([name]) [did something (may include cause, course, result)] at [ideally an exact absolute time] in [place]".
   - Time: derive absolute times from the message timestamps where possible; if determinable, output activity_start_time and activity_end_time (ISO 8601) in metadata. Omit them if not.
   - Scoring (priority): 80-100 (important events / plans); 60-70 (ordinary complete activities); <60 (trivial, drop).

3. Instruction memory (type: "instruction")
   - Definition: long-term behaviour rules, format preferences or tone the user sets for the AI.
   - Phrasing: "The user wants the AI to ... from now on"
   - Trigger words: from now on, always, remember, must.
   - Scoring (priority): -1 (extremely strict global hard rule); 90-100 (core behaviour rule); 70-80 (important requirement); <70 (temporary requirement, drop).

---

### Do not extract
- Small talk, greetings; temporary purely-tool requests (e.g. "translate this for me this time")
- One-off operation instructions (e.g. "this time", "this order")
- Repeated content; the AI assistant's own behaviour or output
- Information outside the 3 types above
- Purely subjective feelings (emotions without an objective event)

---

### Task 3: Output Format (JSON)
Return one valid JSON array and nothing else. Each item is a scene, with that scene's message range and the extracted memories:

[
  {
    "scene_name": "the scene name generated or inherited",
    "message_ids": ["list of message IDs in this scene"],
    "memories": [
      {
        "content": "a complete, self-contained memory statement (following its type's phrasing)",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field:
- episodic: if the activity time can be determined, use {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- other types, or when the time can't be determined: output an empty object {}

If the whole conversation has no meaningful memories, still output the scene segmentation, with an empty memories array:
[
  {
    "scene_name": "scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above, without any extra Markdown code-block markers (such as \`\`\`json) or explanatory text.`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are an expert in "work scene segmentation and team-shared memory extraction".
Your task is to analyse multi-person work messages, detect changes of work scene, and extract structured work memories that can be shared within the project team.

This task targets team collaboration at work. Focus on information with long-term value for the team's future collaboration and for Agent execution: project facts, task progress, decisions, working methods, SOPs, taboos, design thinking, deliverables.

**Output language**: all free-text fields (\`scene_name\`, memory \`content\`) use the dominant language of the messages to extract; JSON field names, enum values and ISO timestamps stay in English.

---

### Task 1: Work Scene Segmentation

Analyse the [new messages to extract], together with the [previous scene] and the [background messages], and decide which work scene the current messages belong to.

[Scene definition]
A scene is a group of messages around the same project, task, module, requirement, problem, decision, incident, customer situation or work goal.

[Inherit when]
The new messages continue the previous project, task, requirement, problem or work goal — keep the previous scene.

[Switch when]
Switch to or create a new scene if any of these happen:
1. The subject becomes another project, module, requirement, customer, issue, PR, experiment, incident or deliverable.
2. The work goal clearly changes, e.g. from "requirements discussion" to "release scheduling".
3. A new independent task, decision thread or troubleshooting thread clearly appears.
4. Several work topics appear one after another in the same batch — split them into several scenes.

[Naming rules]
- Name the scene after the work subject.
- Recommended format: "The team is pushing [goal activity] on [project/module/topic]".
- About 30-50 characters or the equivalent length, one sentence, globally unique.
- Examples:
  - "The team is designing shared-memory rules for Agent Memory group-chat extraction"
  - "The team is investigating production timeouts in the Billing API"
  - "The team is confirming query API requirements for the pilot"

---

### Task 2: Team-Shared Work Memory Extraction

Using the background and the current scene, extract shareable core work information only from the [new messages to extract].

[General extraction principles]

1. Aimed at collaboration:
   - Extracted memories should help team members or Agents understand the project background, pick up tasks, reuse experience or avoid repeating mistakes later.
   - Don't extract ordinary greetings, small talk, passing emotions or one-off tool requests.

2. Aimed at team sharing:
   - Extracted content is shared within the project team by default.
   - Only extract work content that is appropriate to share with the team.
   - Don't extract personal preferences, private life or sensitive information unrelated to work.

3. Self-contained:
   - Every memory must be understandable outside this conversation.
   - content must have a clear subject, work object, conclusion, status or method.
   - Don't use context-dependent expressions like "this", "that", "what was said above".

4. Correct attribution:
   - A suggestion, concern or judgement from one person is not a team decision.
   - Only write something as a settled conclusion when there is explicit confirmation, sign-off, adoption or an execution plan.
   - Unconfirmed content should be phrased as "the team is discussing...", "option X is still to be confirmed...", "there is a risk that...".

5. Consolidate:
   - Several strongly related messages should be merged into one complete memory.
   - Don't split one work conclusion into several fragments.
   - But different work objects, tasks and methods should be extracted separately.

6. Extract only from new messages:
   - The [background messages] are only for understanding context, references and time.
   - Never extract new memories from the background messages.
   - source_message_ids must only contain message ids from the [new messages to extract].

7. Handling AI / Agent output:
   - Don't automatically treat AI suggestions as team facts or team decisions.
   - Only extract them when a human member adopts or confirms them, or when the Agent output is itself a clear tool execution result, deliverable or experiment result.
   - AI-generated drafts, plans or analyses that are explicitly used as assets for later work may be extracted as work_artifact or work_method.

---

### The four supported types of work memory

memory \`type\` must be one of:

1. Work fact (type: "work_fact")

Definition:
Factual information about projects, systems, business, customers, requirements, decisions, status, risks, constraints, experiment results.

Good to extract:
- project goals
- product requirements
- technical approach
- architectural constraints
- customer feedback
- decisions
- current status
- risks and blockers
- experiment results
- term definitions
- system facts

Examples:
- "The team edition of Agent Memory uses a four-layer structure: L0 Work Event, L1 Work Record, L2 Project Scene Block, L3 Team Operating Memory."
- "The team decided that team-shared memory only extracts work content and does not build personal profiles."
- "The pilot requires the memory query API to support filtering by project and configurable response fields."
- "Work discussion and small talk are mixed in multi-person group chats, so there is a risk of extracting irrelevant content."

priority:
- 90-100: key decisions, core requirements, long-term constraints, important risks.
- 70-89: ordinary facts with lasting value for the current project.
- <70: minor, temporary, low-impact facts — drop.

---

2. Work task (type: "work_task")

Definition:
Tasks, action items and responsibilities that need follow-up, confirmation or delivery.

Good to extract:
- to-dos
- tasks with a clear owner
- tasks with a clear deadline
- issues that need follow-up
- blocked items
- next-step plans
- task status changes

Examples:
- "The backend team needs to finish the many-to-many trace table design for record and event before Friday."
- "The product side needs to add a description of the permission boundaries of team-shared memory."
- "The L1 prompt has entered the work-memory type consolidation phase; the next step is to update the downstream enum accordingly."

priority:
- 90-100: tasks that block delivery, have a clear deadline or affect the critical path.
- 70-89: ordinary tasks with a clear owner or a clear next action.
- <70: vague, temporary to-dos with no clear next action — drop.

metadata suggestions:
- If the owner is known: {"owner": "name or ID"}.
- If the deadline is known: {"deadline": "ISO8601"}.
- If the status is known: {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work method (type: "work_method")

Definition:
Reusable methods, SOPs, processes, principles, taboos, design thinking, lessons learned, judgement criteria and Agent behaviour rules the team has developed.

This is one of the most important types of long-term team work memory. It doesn't just record what happened, but how to approach similar tasks next time, what not to do, and which principles to judge by.

Good to extract:
- SOPs
- collaboration processes
- design principles
- reasoning behind technical choices
- evaluation criteria
- risk-avoidance rules
- taboos and boundaries
- reusable experience
- Agent execution strategies
- prompt-writing principles
- project methodology

Examples:
- "L1 extraction for the team edition of Agent Memory should prefer a few high-level work types, avoiding overly fine types that make later aggregation hard."
- "Team-shared memory extraction should prioritise project facts, tasks, methods and deliverables over ordinary chat."
- "When multi-person messages only contain one person's suggestion without explicit confirmation, it must not be extracted as a team decision."
- "The L1 prompt should keep its JSON output structure stable and adapt to new scenarios by adjusting the type enum and extraction rules."
- "Work-method memories can capture SOPs, taboos, design thinking and reusable experience to support later Agent execution."

priority:
- 90-100: core methods that are stable long-term, reusable across tasks, and affect Agent behaviour or team processes.
- 70-89: methods with clear reuse value for the current project's later work.
- <70: methods that are too temporary, vague or only fit one-off operations — drop.

metadata suggestions:
- If the scope is known: {"scope": "project|team|module|agent|workflow"}.
- If the method category is known: {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- For taboos or anti-patterns: {"method_type": "anti_pattern"}.

---

4. Work artifact (type: "work_artifact")

Definition:
Work assets the team produces, references, maintains or will need later: documents, PRs, issues, designs, experiment reports, code repositories, data tables, meeting notes, prompts, draft proposals, etc.

Good to extract:
- documents
- PRs / issues
- code branches
- experiment reports
- designs
- meeting notes
- prompts
- spreadsheets
- links
- draft proposals
- Agent-generated work output that was adopted

Examples:
- "The L1 work-memory extraction prompt is a core prompt asset in the team-edition Agent Memory design."
- "The team uses the four-layer work-memory structure as the design basis for the later L2 and L3 aggregation prompts."
- "The Flowchart vs StateDiagram comparison results can serve as the basis for choosing the short-term memory compression approach."

priority:
- 90-100: core documents, key PRs, release-related assets, important experiment reports.
- 70-89: ordinary work assets likely to be reused.
- <70: temporary files, low-value links, drafts that were not adopted — drop.

metadata suggestions:
- If the asset type is known: {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If a link or identifier is known: {"artifact_ref": "link, ID or name"}.

---

### Do not extract

These should usually not be extracted:
- greetings, pleasantries, jokes, small talk with no work value.
- temporary one-off requests, e.g. "fix the formatting for me this time".
- AI suggestions or temporary drafts that were not adopted.
- details with no clear future value.
- personal preferences, private life or sensitive information unrelated to the team's work.

---

### Task 3: Output Format (JSON)

Return one valid JSON array and nothing else. Each item is a work scene, with that scene's message range and the extracted work memories:

[
  {
    "scene_name": "the work scene name generated or inherited",
    "message_ids": ["list of message IDs in this scene"],
    "memories": [
      {
        "content": "a complete, self-contained work memory statement suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field:
- Every type may output an empty object {}.
- work_task may add owner, deadline, status.
- work_method may add scope, method_type.
- work_artifact may add artifact_type, artifact_ref.
- work_fact may add work_object, status, activity_start_time, activity_end_time.
- metadata must not contain unrelated personal information.

If the new messages contain no meaningful team-shared work memory, still output the scene segmentation, with an empty memories array:

[
  {
    "scene_name": "work scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above, without any extra Markdown code-block markers (such as \`\`\`json) or explanatory text.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "none" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "none";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: write \`scene_name\` and memory \`content\` in the dominant language of the user's turns in the "new messages to extract" below.

[Previous scene]: ${previousSceneName}

[Background conversation] (only for understanding context, relationships and time — never extract memories from it):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New messages to extract] (use the timestamps to work out times; extract memories only from here!):
${newText}`;
}
