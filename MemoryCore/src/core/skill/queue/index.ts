/**
 * src/core/skill/queue/index.ts
 *
 * **Interface type barrel** of the skill extraction module. The old job queue (LocalSkillTaskQueue /
 * RedisSkillTaskQueue / SkillExtractWorkerV2 / SkillExtractJob, etc.) was deleted
 * in the 2026-07-17 skill_extract → direct-archive refactor; the extraction pipeline now goes entirely through
 * SkillTriggerService +
 * SkillConversationExtractWorker + SkillAgentTaskQueue under `src/core/skill/conversation-add/`.
 *
 * This module keeps only the Worker/extractor interface-layer types (ConversationMessage /
 * ExtractedCandidate / ISkillExtractor / ExtractorLogger), for reuse by
 * conversation-add/extract-worker.ts and skill-extractor.ts.
 */

export type {
  ConversationMessage,
  ExtractedCandidate,
  ISkillExtractor,
  ExtractorLogger,
} from "./types.js";
