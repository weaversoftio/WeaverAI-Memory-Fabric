/**
 * useSkillDetailCache — on-demand loading cache of skill data-plane details.
 *
 * Background: the asset list returned by the asset/list-accessible API contains only asset-layer fields
 * (version is always 1, no owner_agent_id); the real version and
 * owner_agent_id of the skill data plane need getSkill() to obtain. The old implementation, after the list loaded, called getSkill()
 * N times concurrently, once per skill (N+1), pulling back all details before the user had opened any one.
 *
 * This hook switches to on-demand: the list first renders with asset-layer defaults, and only when the user selects a skill
 * is that one's data-plane detail fetched and written to the cache; later hits on the same skill read the cache directly.
 *
 * Usage (parent component):
 *   const { getFromCache, preload, applyCachedDetail } = useSkillDetailCache(activeTeamId);
 *   useEffect(() => { if (selectedId) void preload(selectedId); }, [selectedId]);
 *   List rendering: const s = applyCachedDetail(skill);
 */

import { useRef, useState, useCallback } from 'react';
import { getSkill } from '@/lib/api/skill-api';

export interface CachedSkillDetail {
  version: number;
  owner_agent_id: string;
  updated_at_ms: number;
}

export function useSkillDetailCache(teamId: string | null | undefined) {
  /** skill_id -> fetched data-plane details (version + owner_agent_id). */
  const cacheRef = useRef(new Map<string, CachedSkillDetail>());

  /** Set of skill_ids with requests in flight, preventing concurrent duplicate requests for the same skill. */
  const inFlightRef = useRef(new Set<string>());

  /** Incremented by 1 after every cache write; the parent depends on this value to recompute list items in useMemo. */
  const [cacheVersion, setCacheVersion] = useState(0);

  /** Read the cache synchronously (does not trigger a request). */
  const getFromCache = useCallback((skillId: string): CachedSkillDetail | undefined => {
    return cacheRef.current.get(skillId);
  }, []);

  /** Preload the data-plane details of a skill (idempotent; skipped directly if already cached or in flight). */
  const preload = useCallback(async (skillId: string) => {
    if (!teamId || !skillId) return;
    if (cacheRef.current.has(skillId) || inFlightRef.current.has(skillId)) return;
    inFlightRef.current.add(skillId);
    try {
      const full = await getSkill({
        skill_id: skillId,
        team_id: teamId,
        include_content: false,
        include_manifest: false,
      });
      cacheRef.current.set(skillId, {
        version: full.version,
        owner_agent_id: full.owner_agent_id,
        updated_at_ms: full.updated_at_ms,
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // Silent failure: the list still uses asset defaults (v1 / empty owner_agent_id)
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /** Prefetch data-plane details for many skills (team list). Bounded concurrency; skips cached / in-flight ids. */
  const preloadMany = useCallback(
    async (skillIds: string[]) => {
      const pending = [...new Set(skillIds.filter(Boolean))].filter(
        (id) => !cacheRef.current.has(id) && !inFlightRef.current.has(id),
      );
      if (pending.length === 0) return;
      const concurrency = Math.min(6, pending.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < pending.length) {
            const id = pending[next];
            next += 1;
            await preload(id);
          }
        }),
      );
    },
    [preload],
  );

  /**
   * Overwrite the version / owner_agent_id / updated_at_ms fields of the skill object with the cache.
   * On a cache miss it is returned as is, without affecting rendering.
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string; updated_at_ms: number }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return {
      ...skill,
      version: cached.version,
      owner_agent_id: cached.owner_agent_id,
      updated_at_ms: cached.updated_at_ms || skill.updated_at_ms,
    };
  }, []);

  return { getFromCache, preload, preloadMany, applyCachedDetail, cacheRef, cacheVersion };
}
