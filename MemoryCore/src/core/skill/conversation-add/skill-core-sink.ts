/**
 * SkillCoreSink — registers the candidates extracted by SkillConversationExtractWorker as a fallback
 * skill asset registration.
 *
 * ⚠️ Semantic clarification (fully aligned with the fallback path of the old synchronous `/v3/skill/extract` branch):
 *   SkillExtractor internally uses a tool-calling review agent - the agent calls `SkillCore.create`
 *   directly through the create tool in `<skill_tools>` to persist the skill,
 *   and the candidate is merely an "after-the-fact receipt" (carrying skill_id / name / action="create").
 *
 *   So the sink **should not** call SkillCore.create again, otherwise it would:
 *     1) hit a same-name/same-team conflict → SKILL_NAME_DUPLICATE throws
 *     2) the candidate usually has no content either (the extractor persists directly from tool-call arguments,
 *        and the result payload only keeps a skill_id / name summary)
 *
 *   The sink only does fallback asset registration - in standalone mode SkillVersioning has no
 *   onSkillCreated hook mounted (to avoid coupling core to metadata), so the asset registration must be topped up here;
 *   in service mode buildSkillCore has mounted the hook, and calling ensureSkillAsset here is idempotent,
 *   acting as double insurance.
 */

import type { ExtractedCandidate, ExtractorLogger } from "../queue/types.js";
import type { SkillCandidatesSink } from "./extract-worker.js";

/** Shape aligned with the one used by the gateway-side MetadataService (only ensureSkillAsset is used). */
export interface MetadataServiceLike {
  ensureSkillAsset(input: {
    skill_id: string;
    team_id: string;
    agent_id: string;
    name: string;
  }): Promise<unknown>;
}

export interface SkillCoreSinkOptions {
  /** Optional - registers the asset as a fallback when a metadata service is present. When missing, the sink is a no-op. */
  metadata?: MetadataServiceLike;
  logger: ExtractorLogger;
}

/**
 * SkillCoreSink only does fallback asset registration and no longer creates skills.
 * The skill itself was already persisted by SkillExtractor's tool-call review agent through SkillCore.create.
 */
export class SkillCoreSink implements SkillCandidatesSink {
  constructor(private readonly opts: SkillCoreSinkOptions) {}

  async applyCandidates(input: {
    task: {
      team_id: string;
      user_id: string;
      agent_id: string;
      task_ref_id?: string;
      session_id: string;
    };
    candidates: ExtractedCandidate[];
    workerId: string;
  }): Promise<void> {
    const { metadata, logger } = this.opts;
    const { task, candidates, workerId } = input;
    if (!candidates.length) return;
    if (!metadata) return; // no metadata → the sink is a no-op (asset registration can only rely on hooks)

    for (const c of candidates) {
      if (c.action !== "create") {
        // Currently only create is turned into an asset; patch/update need no re-registration of the asset (skill_id unchanged)
        continue;
      }
      const skillId = c.skill_id;
      const name = c.name;
      if (!skillId || !name) {
        logger.warn(
          `[skill-core-sink] worker=${workerId} candidate missing skill_id/name — skip asset register`,
        );
        continue;
      }
      try {
        await metadata.ensureSkillAsset({
          skill_id: skillId,
          team_id: task.team_id,
          agent_id: task.agent_id,
          name,
        });
      } catch (err) {
        // Asset registration failure does not affect the main flow - the skill is already in the skills table,
        // the frontend management page may not show it, and ops can top it up later
        logger.warn(
          `[skill-core-sink] worker=${workerId} ensureSkillAsset failed skill_id=${skillId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}
