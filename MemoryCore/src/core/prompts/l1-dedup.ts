/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Compare several [new memories] in a batch against the existing memories in the [unified candidate pool], and decide how to handle each one.

**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id and ISO timestamps stay in English.

## Core rules

- **Cross-type merge**: memories of different types (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same fact/event.
- **Many-to-many merge**: one new memory can replace/merge **several** existing memories in the candidate pool at once (given in the target_ids array).
- After merging, you must decide the best type for the new memory (merged_type).

## Decision logic

1. **Identify the kind of memory**:
   - **State** (persona/instruction): preferences, traits, long-term settings, relatively stable facts, behaviour rules
   - **Event** (episodic): one-off experiences, objective records with a point in time; prefer merging the causes and consequences of the same event

2. **Decide whether it's the same fact/event**: same subject, same topic, close in time, similar scene_name

3. **Choose an action**:
   - "store": treat it as new information and add the current memory.
   - "skip": the existing memory is better; the new memory adds nothing or is vaguer — ignore it.
   - "update": same fact/event, and the new memory is better in content or time (more specific, more recent or a correction) — overwrite the old memory based on the new one, keeping old details that are still correct.
   - "merge": same fact or same evolution, several memories complement each other without contradiction — merge them into one more complete memory with as little redundancy as possible.

4. **Tendencies**:
   - State: several memories describing the same preference/trait → lean towards merge; nothing new → skip; a clear change → update
   - Event: causes, consequences or stages of the same event → lean towards merging into one complete account; identical → skip
   - Cross-type example: an episodic "The user started a podcast in 2018" + a persona "The user has podcast production experience" → may merge into one persona or episodic (depending on the focus of the information)

5. **Timestamps**:
   - For merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (deduplicated, sorted)
   - This keeps the full timeline of the event

## Output format

Output strictly a JSON array, one element per new memory decision. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate record_id 1 to delete", "record_id 2"],
    "merged_content": "the merged/updated memory content (required for merge/update)",
    "merged_type": "best type after merging: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["timestamp array after merging: the union of all new and old memory timestamps (required for merge/update)"]
  }
]

Fields:
- target_ids: an **array** of old memory IDs to delete and replace (one or more). Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: the type the memory belongs to after merge/update, judged by the nature of the merged content.
- merged_priority: the new priority after merge/update (integer 0-100, required for merge/update). Merged information is more complete and more certain, so priority should usually be **raised where appropriate** (e.g. two memories at priority 70 may become 80 after merging). Guide: 80-100 (core traits / important events), 60-79 (ordinary preferences / activities), <60 (minor information).
- merged_timestamps: the timestamp array after merging. Collect the timestamps of the new memory + all merged old memories, deduplicated and sorted.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a conflict detector for team work memories. Compare several [new memories] in a batch against the existing memories in the [unified candidate pool], and decide how to handle each one.

**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id and ISO timestamps stay in English.

## Core rules

- **Cross-type merge**: memories of different types (work_fact / work_task / work_method / work_artifact) **may be merged** if they semantically describe the same work object, task, method or asset.
- **Many-to-many merge**: one new memory can replace/merge **several** existing memories in the candidate pool at once (given in the target_ids array).
- After merging, you must decide the best type for the new memory (merged_type).
- Memories are shared within the project team by default; merged content should keep only work-related information.

## Decision logic

1. **Identify the kind of memory**:
   - **Work fact (work_fact)**: project facts, requirements, decisions, status, risks, constraints, experiment results, customer feedback.
   - **Work task (work_task)**: to-dos, owners, deadlines, next-step plans, task status changes.
   - **Work method (work_method)**: SOPs, taboos, principles, experience, design thinking, judgement criteria, Agent behaviour rules.
   - **Work artifact (work_artifact)**: documents, PRs, issues, prompts, reports, code branches, designs, links, etc.

2. **Decide whether it's the same work object / evolution**:
   - Same project, module, requirement, task, risk, decision, method or asset, with a highly similar scene_name or meaning.
   - Different stages of the same task, additions to the same method, version or usage changes of the same asset can usually be merged.
   - Things that only belong to the same big project but discuss different objects should not be forced together.

3. **Choose an action**:
   - "store": treat it as new information and add the current memory.
   - "skip": the existing memory is better; the new memory adds nothing or is vaguer — ignore it.
   - "update": same work object, and the new memory is more specific, more recent, more authoritative or corrects the old information — overwrite the old memory based on the new one, keeping old details that are still correct.
   - "merge": same work object or same evolution, new and old memories complement each other without contradiction — merge them into one more complete memory with as little redundancy as possible.

4. **Tendencies**:
   - work_fact: additions to or corrections of the same fact/decision/status → lean towards update or merge.
   - work_task: owner, deadline or status changes of the same task → lean towards update; added dependencies or acceptance criteria → lean towards merge.
   - work_method: additions to the same SOP, taboo, principle or experience → lean towards merge; a clearer, more general phrasing → lean towards update.
   - work_artifact: added usage, version or link information for the same document, PR, prompt, report or other asset → lean towards merge or update.
   - Cross-type example: a work_fact "The team decided to keep L1 types to a few high-level categories" + a work_method "L1 types shouldn't be too fine-grained, or L2/L3 aggregation suffers" → may merge into a work_method.

5. **Timestamps**:
   - For merge / update, merged_timestamps should contain the **union of the timestamps of all related memories** (deduplicated, sorted).
   - This keeps the full timeline of how work facts, tasks or methods evolved.

## Output format

Output strictly a JSON array, one element per new memory decision. Output nothing else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate record_id 1 to delete", "record_id 2"],
    "merged_content": "the merged/updated memory content (required for merge/update)",
    "merged_type": "best type after merging: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["timestamp array after merging: the union of all new and old memory timestamps (required for merge/update)"]
  }
]

Fields:
- target_ids: an **array** of old memory IDs to delete and replace (one or more). Omit or leave empty for store/skip.
- merged_content: the final memory text for merge/update. Omit for store/skip.
- merged_type: the type the memory belongs to after merge/update, judged by the nature of the merged content.
- merged_priority: the new priority after merge/update (integer 0-100, required for merge/update). Merged information is more complete and more certain, so priority should usually be **raised where appropriate**. Guide: 80-100 (key facts / important tasks / core methods / important assets), 60-79 (ordinary work information), <60 (minor information).
- merged_timestamps: the timestamp array after merging. Collect the timestamps of the new memory + all merged old memories, deduplicated and sorted.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Unified candidate pool\n\n(empty: no existing memories, store every new memory)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified candidate pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (no similar candidates, store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### New memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related candidate IDs] ${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Output language**: \`merged_content\` uses the same language as the existing memories in the candidate pool.

${poolSection}

${"═".repeat(50)}

## New memories to decide (${matches.length})

${newMemoriesText}

Decide each one and output the JSON array of decisions. When a new memory has an empty candidate list, output action=store for it.`;
}
