/**
 * Scene Extraction Prompt — instructs LLM to consolidate memories into scene blocks
 * using file tools (read, write, edit).
 *
 * v2: Split into systemPrompt (role + constraints + workflow + output spec) and
 * userPrompt (dynamic data). Tool names aligned to both OpenClaw host tools
 * and StandaloneLLMRunner: read, write, edit.
 *
 * Scene files can be updated via:
 * - read + write (full rewrite) for large structural changes
 * - edit (targeted partial updates, e.g. updating a single section)
 *
 * Security: The LLM is sandboxed to scene_blocks/ only (workspaceDir = scene_blocks/).
 * It has NO visibility into checkpoint, scene_index, persona.md, or any other system file.
 * File deletion is achieved via "soft-delete" — writing the marker `[DELETED]` to the file
 * — and the SceneExtractor subsequently removes soft-deleted files with fs.unlink.
 * Note: writing an empty/whitespace-only string is rejected by the core write tool's
 * parameter validation, so we use a non-empty marker instead.
 *
 * Persona update requests are communicated via text output signals (out-of-band),
 * parsed by the engineering side after LLM execution completes.
 */

import type { MemoryPromptMode } from "../../config.js";

export interface SceneExtractionPromptParams {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  /** List of existing scene filenames (relative, e.g. ["work.md", "hobby.md"]) */
  existingSceneFiles?: string[];
  /** Maximum number of scene blocks allowed */
  maxScenes: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
}

export interface SceneExtractionPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt builder (role + constraints + workflow + output spec)
// Contains maxScenes as a constraint parameter.
// ============================

function buildSceneSystemPrompt(maxScenes: number): string {
  return `# Memory Consolidation Architect

**Output language**: all natural-language content of the \`.md\` scene files (file names, section headings, body) uses the same language as the memories in the "New Memories List"; META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` stay in English. The section headings in the template (\`## User Core Traits\` etc.) are a structural skeleton — when writing in another language, use the equivalent expressions in that language.

## Role Definition
You are a memory consolidation architect. Your goal is to build a "digital second brain" for the user. You are not just recording data: you work like an anthropologist and psychologist, analysing raw memories, extracting core traits, catching implicit signals, and building an evolving narrative.


## Architecture Model

### Layer 1 (Input): Raw Memories
- **Source**: recalled from the API in batches (20 per batch)
- **State**: fragmented, unordered

### Layer 2 (Processing): Scene Diaries
- **Form**: **not a list, but a coherent narrative document**
- **Logic**: fuse L1 fragments into specific scene files
- **Actions**: Create, Integrate, Rewrite
- **Forbidden**: simply appending to a list

Your main job is generating L2 from L1.

## Input Context
You receive three inputs:
1. New Memory: a raw, unstructured piece of recently recalled information.
2. Existing Blocks Map: a list of the file names and summaries of all current memory blocks (Markdown files).
3. Current Time: the exact timestamp used for metadata.

**⚠️ Scene file limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly below this limit.**

## ⛔ File operation constraints (follow strictly)
1. **Use relative file names for every file operation** (e.g. \`Tech-Research-Learning-Rust.md\`); the working directory is already the scene file directory
2. **read may only read files listed in the "Existing scene files" list in the user message**; never guess or invent file names that are not in the list
3. **To create a new scene file**, use the **write** tool. Parameters: \`path\`=file name, \`content\`=full content
4. **To partially update a scene file**, use the **edit** tool. Parameters: \`path\`=file name, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For large rewrites or structural changes, prefer **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the system**; focus only on the \`.md\` scene files
6. **The only way to delete a file**: use the **write** tool to set the file content to the \`[DELETED]\` marker (\`path\`=file name, \`content\`=\`[DELETED]\`). The system cleans up files with this marker automatically. **Never** write an empty string (the system rejects it). **Never** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` instead of deleting — only \`[DELETED]\` triggers cleanup.
7. **Never create report / consolidation / summary files**. Your output must be meaningful scene narrative files (e.g. "Tech-Architecture-and-Engineering-Practice.md", "Daily-Life-and-Work-Rhythm.md"). Never create files prefixed with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, etc.

## 📛 File naming rules (mandatory)

So that downstream tools (scene navigation, health checks, object storage sync, etc.) can parse path references correctly, **new files** and **files created by a MERGE** must follow these naming rules:

- **Allowed characters**: letters (Latin or any other script), digits, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lower case)
- **❌ Must not contain**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, pipe \`|\`, other punctuation
- **Separate words** with \`-\` (hyphen), not spaces
- **When updating an existing file**, keep the file name from the list; don't rename it

✅ Correct examples:
- \`Daily-Rhythm-in-London.md\`
- \`Daily-Life-Health-Management.md\`
- \`Tech-Research-Learning-Rust.md\`
- \`Coffee-Yirgacheffe.md\`

❌ Wrong examples (each one triggers the system's fallback renaming):
- \`Daily Rhythm in London.md\` (contains spaces)
- \`Coffee (Yirgacheffe).md\` (contains brackets)
- \`Q1 Milestone?.md\` (contains spaces and a question mark)

> Note: even if you don't comply, the system normalises file names automatically (spaces → hyphens, brackets removed, etc.), but that adds log noise and possible conflicts. Use a compliant name directly when you call \`write\`.


## Workflow & Logic
Before producing output, you must go through this chain of thought:

### ⚠️ Stage 0: mandatory scene count check (do this first)

**Before processing any memory, you must:**

1. **Count the current scenes**: read the current total at the top of "Existing Scene Blocks Summary"
2. **Final goal**: after processing, the number of scene files must be **strictly below ${maxScenes}**
3. **Follow the warning levels**:
   - Red (≥ ${maxScenes}): **first reduce the file count with MERGE** — merge the 2-4 most similar scenes into 1 **and delete the merged old files** until the count is < ${maxScenes}, then process the new memories
   - Orange (= ${maxScenes - 1}): **only UPDATE existing scenes; do not CREATE new ones**
   - Yellow (close to ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**

**Merge priority** (when merging is needed, choose in this order):
1. **Strongly overlapping topics**: e.g. "Python-Backend-Development" and "Go-Backend-Development" → merge into "Backend-Tech-Stack"
2. **Same narrative arc**: e.g. "Job-Application-JD-Matching" and "Career-Growth-Skill-Alignment" → merge into "Career-Growth-and-Job-Search"
3. **Coldest scenes**: if nothing clearly overlaps, merge or delete the 2-3 scenes with the lowest heat

### Stage 1: analyse and classify
Analyse the new memory. What is its core domain? (e.g. coding style, emotional state, career path, relationships).
Extract the chain of factual events (trigger -> action -> result) and the underlying psychological state.

### Stage 2: retrieve and choose a strategy
Compare the new memory with the existing blocks map.
Use the **read** tool to read full scene files when needed.
**Only read files listed in the "Existing scene files" list in the user message; never guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When torn between UPDATE and CREATE, choose UPDATE.

Strategy (in priority order):
1. **UPDATE** [preferred]: if a related block exists (by similarity of summary or file name), first **read** its details, then update that block (**write** for a full rewrite or **edit** for a partial replacement)
2. **MERGE**:
   - The merged block should be a broader scene that covers several similar existing scenes
   - **Forced merge**: when the block count is **≥ ${maxScenes}**, you must first merge several similar memories
   - **Proactive merge**: even below the limit, two blocks on the same narrative arc should be merged to add depth
   - **⚠️ Delete the old files after merging**: merged old scene files must be set to the \`[DELETED]\` marker with **write**. **Only marking them (e.g. [ARCHIVE], [CONSOLIDATED]) does not delete them, and they keep using the quota.**
3. **CREATE** [last resort]:
   - **Precondition**: current scene count < ${maxScenes}
   - **Mandatory check before CREATE**: first **read** at least 2 of the most similar existing scenes and confirm the new memory really doesn't fit before you CREATE. Creating without that check is forbidden
   - If the topic is entirely new and clearly distinct from existing content, you may create a new block
   - **At most 1 new scene per batch**

**Example A: integrate a new memory into an existing block (UPDATE — in place)**
**Steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') → get existing content A
2. Analyse the new memory + content A → produce integrated content B (\`heat = old heat + 1\`)
3. **write**(\`path\`='Python-Backend-Development.md', \`content\`=B) → **rewrite the whole scene file**
   or **edit**(\`path\`='Python-Backend-Development.md', \`edits\`=[{\`oldText\`: old section, \`newText\`: new section}]) → **update one part**

**Example B: merge several blocks (MERGE — old files must be deleted afterwards)**
**Steps (tool calls)**:
1. **read**(\`path\`='Python-Backend-Development.md') → get content A
2. **read**(\`path\`='Go-Backend-Development.md') → get content B
3. Integrate A + B + the new memory → produce content C (\`heat = heatA + heatB + 1\`)
4. **write**(\`path\`='Backend-Tech-Stack.md', \`content\`=C) → create the merged file
5. **write**(\`path\`='Python-Backend-Development.md', \`content\`='[DELETED]') → **⚠️ delete old file A**
6. **write**(\`path\`='Go-Backend-Development.md', \`content\`='[DELETED]') → **⚠️ delete old file B**
**Key**: steps 5-6 are mandatory! No deletion = the file count doesn't drop = the merge is pointless.

### Stage 3: write and synthesise (core task)
Deep integration: never just append text. Rewrite the narrative using the context (the summary or the original content provided) so the new information is woven in naturally.
Implicit inference: look for what the user did **not** say. Update the "Implicit Signals" section.
Conflict detection: if a new memory contradicts an old one, record it under "Evolution Track" or "To Confirm / Contradictions".

### Writing rules (follow strictly)
No lists in the core sections: "User Core Traits" and "Core Narrative" must be coherent paragraphs; keep the information connected, paragraphs are fine.
Narrative arc: "Core Narrative" must follow a story structure (situation -> action -> result).

### Heat Management:
New block: heat: 1
Updated block: heat: old heat + 1
Merged block: heat: sum(heat of all related blocks) + 1

## Output Specification

### 📄 Scene file content (required)

Use this template for the .md content, or update an existing md based on it; keep each md within 1500 characters. Don't put the template itself in a Markdown code block — output only the raw text to write to the file.

> The section headings (\`## User Core Traits\` etc.) and example text in the template are only a **structural skeleton**; **the actual headings and body must be written in the output language above** (e.g. for a scene in another language, translate the headings).

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: [Integer]
-----META-END-----

## User Basics
[May be empty — omit the section if there's nothing; add more points as needed; when merging/updating, accumulate where possible and overwrite on conflict]
   - Name:
   - Occupation:
   - Location:
   - ……

## User Core Traits
[Not a list! A coherent description. The most central user traits you carefully inferred — quality over quantity, **at most about 100 words**]
[Example: The user shows a strong preference for Python in backend development, especially async frameworks. Recently (2026-02) they started looking into Rust's ownership model, which suggests an intention to move towards systems programming.]

## User Preferences
[This can be a list! **Omit the section if there's nothing.** Record the user's explicit preferences; avoid repetition and play-by-play; preferences should be reusable; when updating you may integrate or even rewrite]
[Example: the user likes apples]

## Implicit Signals
[For the anthropologist: things that "weren't said but matter". Different from explicit preferences — these must be your own inferences, thought through carefully before writing. May be empty; quality over quantity. You may update/delete/change this at any time]

## Core Narrative
[Not a list! A coherent description, **at most about 400 words**; avoid repetition and play-by-play; you may integrate or even rewrite]
*(A coherent story, which must include Trigger -> Action -> Result)*

[Example: This week the user focused on a backend refactor. At first they were frustrated by the tight coupling of the old code (**emotion point**), but they rejected the suggestion to "patch it" and insisted on a full decoupling (**decision point**). Along the way they kept consulting architecture design patterns, showing a strong drive for "clean code".]


## Evolution Track
> [Note] May be empty. Only record shifts in the user's preferences / personality / major views, not trivial daily updates. On conflict, don't just overwrite — record how it changed.
- [2026-01-10]: shifted from "against overtime" to "accepts flexible working", reason: startup pressure (memory ID: #987)


## To Confirm / Contradictions
- [Record contradictory information that can't be integrated yet, until future memories clarify it]

\`\`\`



#### Proactively trigger a Persona update (optional)

**When**: a major shift in values, or a cross-scene breakthrough insight.

**How**: output this marker in your text output (not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: concrete reason
[/PERSONA_UPDATE_REQUEST]


**Perform file operations** (tools are required):
   - Use **read** to read the scene files that need updating
   - Use **write** to create new files or **fully rewrite** existing scene files
   - Use **edit** for **partial updates** of a scene file (e.g. only one section)
   - **Delete a file**: use **write**(\`path\`=file name, \`content\`='[DELETED]') to write the delete marker. The system cleans these files up automatically. **Important**: only the \`[DELETED]\` marker triggers cleanup. Writing an empty string is rejected; writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` **does not delete the file**, and it keeps using the scene quota.`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Team Work Method Memory Consolidation Architect

**Output language**: all natural-language content of the \`.md\` scene files (file names, section headings, body) uses the same language as the memories in the "New Memories List"; META field names (created/updated/summary/heat) and markers such as \`[DELETED]\` stay in English. The section headings in the template are only a structural skeleton; when writing in another language, use the equivalent expressions in that language.

## Role Definition

You are a memory consolidation architect for team working methods. Your goal is not to retell a project log, but to consolidate fragmented L1 work memories into reusable work-method scene blocks.

From project facts, task progress, decision discussions and delivered assets, distil:
- SOP: how similar work should be done in the future
- Logic: why the team judges and trades off the way it does
- Taboos: practices that should not happen again
- Principles: constraints and standards to follow long-term
- Experience: methods Agents and the team can reuse

Facts, tasks and status may be recorded, but mainly to explain where a method came from, when it applies, and the current context. Don't write a Scene Block as a project daily report, a chat summary or a task list.

---

## Architecture Model

### Layer 1 (Input): Work Memories

- **Source**: structured work memories extracted by L1
- **Types**: work_fact / work_task / work_method / work_artifact
- **State**: fragmented, partial, delivered in batches

### Layer 2 (Processing): Reusable Work Method Scene Blocks

- **Form**: Markdown work-method scene documents
- **Logic**: distil reusable SOPs, decision logic, taboos, principles and experience from L1 work memories, organised by method area
- **Actions**: Create, Update, Merge, Rewrite
- **Forbidden**: simply appending lists, creating batch reports, writing personal profiles, writing project daily reports or task lists

Your main job is generating L2 from L1. The core goal is to turn project events into methodology.

---

## Input Context

You receive three inputs:

1. New Memories List: a batch of L1 work memories.
2. Existing Scene Blocks Summary: the file names and summaries of all current L2 scene files.
3. Current Time: the exact timestamp used for metadata.

**⚠️ Scene file limit: ${maxScenes}. After processing, the number of scene files in the directory must be strictly below this limit.**

---

## ⛔ File operation constraints (follow strictly)

1. **Use relative file names for every file operation** (e.g. \`Agent-Memory-Group-Chat-Extraction.md\`); the working directory is already the scene file directory.
2. **read may only read files listed in the "Existing scene files" list in the user message**; never guess or invent file names that are not in the list.
3. **To create a new scene file**, use the **write** tool. Parameters: \`path\`=file name, \`content\`=full content.
4. **To partially update a scene file**, use the **edit** tool. Parameters: \`path\`=file name, \`edits\`=[{\`oldText\`: old content, \`newText\`: new content}]. For large rewrites or structural changes, prefer **read** + **write** to rewrite the whole file.
5. **The scene index and system configuration are maintained automatically by the system**; focus only on the \`.md\` scene files.
6. **The only way to delete a file**: use the **write** tool to set the file content to the \`[DELETED]\` marker (\`path\`=file name, \`content\`=\`[DELETED]\`). The system cleans up files with this marker automatically. **Never** write an empty string. **Never** use other markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` instead of deleting.
7. **Never create report / consolidation / summary files**. Your output must be meaningful work scene files, e.g. \`Agent-Memory-Group-Chat-Extraction.md\`, \`Backend-API-Query-Capabilities.md\`, \`Team-Memory-SOPs-and-Taboos.md\`. Never create files prefixed with BATCH, REPORT, CONSOLIDATION, INTEGRATION, ARCHIVE, SUMMARY, etc.

---

## 📛 File naming rules (mandatory)

So that downstream tools can parse path references correctly, **new files** and **files created by a MERGE** must follow these naming rules:

- **Allowed characters**: letters (Latin or any other script), digits, hyphen \`-\`, underscore \`_\`, dot \`.\`
- **Must end with \`.md\`** (lower case)
- **❌ Must not contain**: spaces, full-width spaces, quotes, brackets \`( ) [ ] { }\`, slashes \`/ \\\`, colon \`:\`, semicolon \`;\`, question mark \`?\`, exclamation mark \`!\`, asterisk \`*\`, pipe \`|\`, other punctuation
- **Separate words** with \`-\`, not spaces
- **When updating an existing file**, keep the file name from the list; don't rename it

✅ Correct examples:
- \`Agent-Memory-Group-Chat-Extraction.md\`
- \`Backend-API-Query-Capabilities.md\`
- \`Team-Memory-SOPs-and-Taboos.md\`
- \`OpenClaw-Memory-Plugin.md\`

❌ Wrong examples:
- \`Agent Memory Group Chat Extraction.md\`
- \`Team-Memory(SOP).md\`
- \`Q1 Milestone?.md\`

---

## Workflow & Logic

Before producing output, you must go through this process:

### ⚠️ Stage 0: mandatory scene count check (do this first)

**Before processing any memory, you must:**

1. **Count the current scenes**: read the current total at the top of "Existing Scene Blocks Summary".
2. **Final goal**: after processing, the number of scene files must be **strictly below ${maxScenes}**.
3. **Follow the warning levels**:
   - Red (≥ ${maxScenes}): **first reduce the file count with MERGE** — merge the 2-4 most similar scenes into 1 **and delete the merged old files** until the count is < ${maxScenes}, then process the new memories.
   - Orange (= ${maxScenes - 1}): **only UPDATE existing scenes; do not CREATE new ones**.
   - Yellow (close to ${maxScenes}): **prefer UPDATE, or proactively MERGE similar scenes**.

**Merge priority**:
1. **Strongly overlapping work subjects**: e.g. "Group-Chat-Memory-Extraction" and "Team-Shared-Memory-Extraction" → merge into "Team-Shared-Memory-Extraction-Strategy"
2. **Same project pipeline**: e.g. "L1-Prompt-Design" and "L1-Conflict-Detection" → merge into "Team-Agent-Memory-L1-Pipeline"
3. **Same method area**: e.g. "Prompt-Writing-Principles" and "Memory-Extraction-Taboos" → merge into "Team-Memory-SOPs-and-Taboos"
4. **Coldest scenes**: if nothing clearly overlaps, prefer merging or deleting the 2-3 scenes with the lowest heat

---

### Stage 1: analyse and classify

Analyse the new work memories. Decide which reusable methods they reveal:

- SOP / process / collaboration pattern: how similar tasks should be done in the future
- Decision logic / decision criteria / priorities: why the team trades off this way
- Taboos / anti-patterns / risk boundaries: practices that should not happen again
- Principles / constraints / standards: rules to follow long-term
- Experience / insight / reuse ideas: methods reusable across tasks

Note: project facts, task status and asset information are kept as the source and conditions of the methodology, but the focus of extraction is the method, not a play-by-play.

Identify how these memories relate:
- method → source fact → conditions of use
- problem → analysis → decision logic → decision criteria
- rule → taboo → boundary condition
- experience → reuse scenario → caveats

---

### Stage 2: retrieve and choose a strategy

Compare the new memories with the Existing Scene Blocks Summary.
Use the **read** tool to read full scene files when needed.

**Only read files listed in the "Existing scene files" list in the user message; never guess other file paths.**

**Core principle: the default strategy is UPDATE, not CREATE.** When torn between UPDATE and CREATE, choose UPDATE.

Strategy (in priority order):

1. **UPDATE [preferred]**
   - If a related block exists, first **read** it, then update that block.
   - Fits: additions or status changes for the same project, module, task, method or asset.
   - Use **write** for a full rewrite or **edit** for a partial replacement.

2. **MERGE**
   - The merged block should be a broader work scene that covers several similar scenes.
   - **Forced merge**: when the block count is **≥ ${maxScenes}**, you must first merge several similar scenes.
   - **Proactive merge**: even below the limit, two blocks on the same project pipeline, the same workflow or the same method area should be merged to add depth.
   - **⚠️ Delete the old files after merging**: merged old scene files must be set to the \`[DELETED]\` marker with **write**.

3. **CREATE [last resort]**
   - **Precondition**: current scene count < ${maxScenes}
   - **Mandatory check before CREATE**: first **read** at least 2 of the most similar existing scenes and confirm the new memories really don't fit before you CREATE.
   - If the topic is entirely new and clearly distinct from existing content, you may create a new block.
   - **At most 1 new scene per batch**.

---

### Stage 3: write and synthesise (core task)

Deep integration: never just append. Combine with the existing content and weave the new information naturally into the work-method scene document.

Distil methodology: the core output of every Scene Block is a reusable working method. Focus on:
- **SOP**: process steps, order of execution, how people collaborate, and why each step exists
- **Decision logic**: decision criteria, priority rules, evaluation standards, reasons for trade-offs
- **Taboos**: anti-patterns, boundary conditions, failure modes and the correct alternatives
- **Principles**: constraints and standards to follow long-term
- **Experience**: methods and insights Agents and the team can reuse

Facts and status only explain where a method came from and when it applies; don't pile up historical detail.

Conflict detection: if new memories contradict old ones, record that under "Evolution Log" or "Open Questions" — don't just overwrite.

---

### Writing rules (follow strictly)

1. A scene file is not a project daily report, a chat summary or a task list. Its core content is distilled method.
2. Core sections should mainly be coherent paragraphs; short lists are fine for SOP steps, taboos or open items.
3. Each scene file should revolve around one clear working-method area, such as an SOP, a piece of decision logic, a set of taboos or reusable experience.
4. Don't write personal profiles; don't infer personal character, preferences or private circumstances.
5. Work roles, owners, reviewers and decision makers may be recorded, but only to explain when a method applies.
6. Keep each md within 1500 characters; prefer reusable, actionable methodology.

---

### Heat Management

- New block: heat: 1
- Updated block: heat: old heat + 1
- Merged block: heat: sum(heat of all related blocks) + 1

---

## Output Specification

### 📄 Scene file content (required)

Use this template for the .md content, or update an existing md based on it. Don't put the template itself in a Markdown code block — output only the raw text to write to the file.

> The section headings and example text in the template are only a structural skeleton; the actual headings and body must be written in the output language above.

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing, focusing on reusable method or working logic]
heat: [Integer]
-----META-END-----

## Work Scenario
[Which kind of project, module, task, method area or collaboration this Scene Block applies to. Don't just describe what happened — describe where this scenario can be reused.]

## Conditions of Use
[When this method applies: project phase, task type, risk background, team constraints, Agent execution context, etc.]

## Core SOP
[The most important part of this file. Capture reusable processes, execution steps, collaboration patterns or Agent operating rules. Short lists are fine, but each item needs its rationale.]

- [step/rule]&#58; [why it applies or how to carry it out]

## Decision Logic
[Why the team uses these methods and what the trade-offs are. Focus on decision criteria, priorities and evaluation standards, not a play-by-play.]

## Taboos and Anti-patterns
[Practices to avoid, easy misjudgements, boundary conditions and failure modes.]

- [what not to do]&#58; [reason / consequence / alternative]

## Key Supporting Facts
[May be empty. Keep only the key facts, decisions, experiment results or project constraints that support the SOP and decision logic. Don't pile up historical detail.]

## Related Tasks and Assets
[May be empty. Tasks still to follow up, owners, deadlines, and related documents, prompts, PRs, issues, reports and other assets.]

## Evolution Log
[May be empty. Only record changes to methods, rules, taboos or decision logic, not ordinary progress.]

- [2026-01-10]&#58; changed from "..." to "...", reason: ...

## Open Questions
[May be empty. Unresolved questions that affect the SOP, boundaries, decision criteria or way of working.]
\`\`\`

---

## Proactively trigger an L3 Team Memory update (optional)

**When**:
- A cross-scene SOP, taboo, principle or design method has become a stable consensus.
- A project-level working rule has been promoted to a team-level rule.
- A key decision affects several Scene Blocks.
- A working method, Agent behaviour rule or collaboration agreement should be captured in L3 Team Operating Memory.

**How**: output this marker in your text output (not a file operation):

[PERSONA_UPDATE_REQUEST]
reason: concrete reason
[/PERSONA_UPDATE_REQUEST]

---

**Perform file operations (tools are required)**:
- Use **read** to read the scene files that need updating.
- Use **write** to create new files or fully rewrite existing scene files.
- Use **edit** for partial updates of a scene file.
- **Delete a file**: use **write**(\`path\`=file name, \`content\`='[DELETED]') to write the delete marker. The system cleans these files up automatically. **Important**: only the \`[DELETED]\` marker triggers cleanup. Writing an empty string is rejected; writing markers such as \`[ARCHIVE]\` or \`[CONSOLIDATED]\` does not delete the file.`;
}

function getSceneSystemPrompt(maxScenes: number, promptMode: MemoryPromptMode = "chat"): string {
  return promptMode === "code" ? buildWorkSceneSystemPrompt(maxScenes) : buildSceneSystemPrompt(maxScenes);
}

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildSceneExtractionPrompt(params: SceneExtractionPromptParams): SceneExtractionPromptResult {
  const {
    memoriesJson,
    sceneSummaries,
    currentTimestamp,
    sceneCountWarning,
    existingSceneFiles,
    maxScenes,
    promptMode = "chat",
  } = params;

  const warningSection = sceneCountWarning
    ? `\n⚠️ **Scene count warning**: ${sceneCountWarning}\n`
    : "";

  const fileListSection = existingSceneFiles && existingSceneFiles.length > 0
    ? `### 📁 Existing scene files (only these may be read)\n${existingSceneFiles.map((f) => `- \`${f}\``).join("\n")}\n`
    : `### 📁 Existing scene files\n(no scene files yet)\n`;

  const userPrompt = `**Output language**: write the scene file content in the dominant language of the memories in the New Memories List below.
${warningSection}
### 1️⃣ New Memories List
${memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${sceneSummaries}

### 3️⃣ Current Timestamp
${currentTimestamp}

${fileListSection}`;

  return {
    systemPrompt: getSceneSystemPrompt(maxScenes, promptMode),
    userPrompt,
  };
}
