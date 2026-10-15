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
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // Silent failure: the list still uses asset defaults (v1 / empty owner_agent_id)
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /**
   * Overwrite the version / owner_agent_id fields of the skill object with the latest values in the cache.
   * On a cache miss it is returned as is, without affecting rendering.
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return { ...skill, version: cached.version, owner_agent_id: cached.owner_agent_id };
  }, []);

  return { getFromCache, preload, applyCachedDetail, cacheRef, cacheVersion };
}
