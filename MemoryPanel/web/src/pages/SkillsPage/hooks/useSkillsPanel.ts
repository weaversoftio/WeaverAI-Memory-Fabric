/**
 * useSkillsPanel -- state and data logic for the Skills page.
 * The component layer keeps only JSX rendering; state / data logic lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetsApi, agentsApi, type Asset } from '@/lib/teamApi';
import {
  listSkills,
  getSkill,
  deleteSkillV3,
  exportSkill,
  type SkillSummary,
} from '@/lib/api/skill-api';
import { getPanelSession } from '@/lib/panelSession';
import { useTeams } from '@/services';
import { useSkillDetailCache } from '@/services/use-skill-detail-cache';
import { tea } from '@/lib/tea-bridge';

export type Tab = 'team' | 'fixed';

export const TAB_I18N_KEY: Record<Tab, string> = {
  team: 'skills.scope.team',
  fixed: 'skills.scope.fixed',
};

export function useSkillsPanel() {
  const { t } = useTranslation();
  // Show Agent assets (fixed) by default, so users don't think their own assets are under "Team assets"
  const [tab, setTab] = useState<Tab>('fixed');
  const { activeTeamId, activeTeam } = useTeams();
  const myUserId = getPanelSession()?.user?.user_id ?? '';
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  // In-team agent data -- fetched once in full, two views derived on the frontend, avoiding the previous
  // two agent/list calls for the "name map (all)" and "agents I own (fixed dropdown)":
  //   - agentNameMap: id->name of ALL agents in the team (the team assets tab shows skills of
  //     other people's agents, so the owning agent name must be displayable).
  //   - teamAgents: filtered on the frontend by owner_user_id === myUserId to **agents I own**
  //     (used by the fixed tab dropdown / import / fork; agent-private visibility semantics).
  const [teamAgents, setTeamAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  // Agent list loading state: the fixed tab depends on agents (dropdown + per-agent skill fetch),
  // starts as true so the first paint is a loading state, avoiding the left list flashing empty then loading during the agent request.
  const [agentsLoading, setAgentsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!activeTeamId) {
      setAgentNameMap({});
      setTeamAgents([]);
      setAgentsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setAgentsLoading(true);
    agentsApi
      .list(activeTeamId)
      .then((agents) => {
        if (cancelled) return;
        setAgentNameMap(Object.fromEntries(agents.map((a) => [a.agent_id, a.name])));
        setTeamAgents(
          agents
            .filter((a) => !!myUserId && a.owner_user_id === myUserId)
            .map((a) => ({ id: a.agent_id, name: a.name })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // Agent load failure is not fatal (the list falls back to showing agent_id), but still surface a hint.
        tea.notify.error(err?.message || t('skills.notify.loadAgentsFailed'));
        setAgentNameMap({});
        setTeamAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, myUserId]);

  const [loading, setLoading] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  // Visibility of each skill under the team tab (from meta_assets), used for list badges.
  // key = skill_id (= asset_id). Not filled for the fixed tab.
  const [visibilityMap, setVisibilityMap] = useState<Record<string, Asset['visibility']>>({});

  // -- On-demand skill detail cache --
  // The team tab list source is asset/list-accessible, which lacks the skill data plane's
  // version / owner_agent_id; we no longer fire N concurrent getSkill() calls per skill,
  // instead fetching on demand after the user selects one and writing into this cache.
  const {
    applyCachedDetail,
    preload: preloadSkillDetail,
    cacheVersion,
  } = useSkillDetailCache(activeTeamId);

  // Apply the cache to the skills list: already-fetched skills are updated with the real version / owner_agent_id.
  const skillsWithCache = useMemo(
    () => skills.map((s) => applyCachedDetail(s)),
    [skills, cacheVersion],
  );

  // When a skill is selected, prefetch its data plane detail on demand (idempotent; skipped if cached).
  // No list-level bulk prefetch: firing getSkill() once per skill is wasteful,
  // details are loaded on demand only when the user opens one.
  useEffect(() => {
    if (selectedSkillId) void preloadSkillDetail(selectedSkillId);
  }, [selectedSkillId, preloadSkillDetail]);

  // ============================
  // Data fetching
  // ============================

  // Request sequence number guards against races: when switching tab/agent quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's data.
  const refreshSeqRef = useRef(0);
  // The team of the last refresh, used to tell "team switch" from "tab / agent switch".
  // On team switch, refresh silently (keep the old list until new data arrives), no empty flash or skeleton;
  // tab / agent switch keeps the original logic of clear + loading (so the previous tab's list is not seen).
  const prevTeamIdRef = useRef(activeTeamId);

  const refresh = useCallback(async () => {
    if (!activeTeamId) {
      setSkills([]);
      setVisibilityMap({});
      return;
    }
    const seq = ++refreshSeqRef.current;
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    prevTeamIdRef.current = activeTeamId;
    const silent = teamChanged;
    if (!silent) {
      setLoading(true);
      // Clear old data immediately -- otherwise switching tabs first shows the previous tab's list,
      // then suddenly replaces it when new data arrives, which looks like a "flash".
      setSkills([]);
      setVisibilityMap({});
    }
    try {
      if (tab === 'team') {
        // Team assets tab semantics: **only show shared skills (visibility=team)**;
        // private skills (including the user's own) never appear here. Own private ones are
        // viewed and managed in the "My asset allocation" tab.
        //
        // Data source (strictly filtered server-side, not obtainable even by packet capture):
        //   asset/list-accessible + visibility='team'
        //     -> the kernel SQL layer filters private directly; the HTTP response body contains neither
        //       others' private nor one's own private, so it is safe.
        //
        // Why not call skill/list:
        //   The data plane skill/list has no visibility concept and returns others' private skills too
        //   (the kernel permission-checker blocks later reads, but the list response
        //   still carries name/owner metadata; frontend filtering = data already leaked).
        //
        // Load version / owner_agent_id on demand:
        //   The asset table has neither field; the old implementation fired N concurrent
        //   getSkill() calls (N+1) per skill here, pulling all details before the user opened any.
        //   Now render with asset defaults first; version/owner_agent_id etc. are fetched on demand
        //   by useSkillDetailCache after selection and written to the cache.
        const accessible = await assetsApi.listAccessible(activeTeamId, {
          asset_type: 'skill',
          action: 'read',
          visibility: 'team',
        });
        if (seq !== refreshSeqRef.current) return; // superseded by a later request
        const visMap: Record<string, Asset['visibility']> = {};
        for (const a of accessible) visMap[a.asset_id] = a.visibility;
        const toMs = (iso: string): number => new Date(iso).getTime();
        const items: SkillSummary[] = accessible.map((a) => ({
          skill_id: a.asset_id,
          name: a.name,
          description: a.description ?? '',
          version: a.version ?? 1,
          is_head: true,
          status: a.status === 'archived' ? 'archived' : 'active',
          owner_user_id: a.owner_user_id,
          owner_agent_id: '',
          team_id: a.team_id,
          task_id: '',
          created_at_ms: toMs(a.created_at),
          updated_at_ms: toMs(a.updated_at),
        })) as SkillSummary[];
        // No extra waiting; render directly with asset defaults, auto-updated on cache hit.
        setSkills(items);
        setVisibilityMap(visMap);
      } else {
        // Fixed assets = skills owned by the given agent; this tab focuses on "what an agent is equipped with",
        // owner permission suffices, no extra visibility filtering (an agent owner can always see their own skills).
        // meta_assets main table, same source as assetsApi.update writes, so reads and writes are consistent.
        if (!selectedAgent) {
          if (seq !== refreshSeqRef.current) return;
          setSkills([]);
          setVisibilityMap({});
        } else {
          // visibility badge source: fetch only skill assets **owned by the current user**.
          //   The fixed tab list = skills owned by selectedAgent, and selectedAgent can only
          //   be an agent owned by the current user (teamAgents is already filtered by owner_user_id === myUserId),
          //   so these skills' owner_user_id is necessarily myUserId.
          //
          // Why asset/list + owner_user_id rather than asset/list-accessible:
          //   - list-accessible iterates **all team** skill assets and runs
          //     checkAssetPermission on each (N+1); after team merges assets balloon -> noticeably slow.
          //   - asset/list is a pure SQL WHERE lookup with no per-item permission check; with
          //     owner_user_id the scope narrows to "skills I own", same magnitude as before the merge.
          //   - asset/list does no visibility filtering, returning both team / private,
          //     so badge semantics are complete (an owner should see all their skills of any visibility).
          //
          // When myUserId is missing (not logged in / session anomaly), **do not** fall back to an
          // unfiltered full query: asset/list has no ACL, and omitting owner_user_id would pull the whole team's
          // skill metadata into the response (exposure + slow), not worth it. Badges are left empty
          // (the toggle already falls back to private for undefined); the list itself is unaffected.
          const [listRes, ownedAssets] = await Promise.all([
            listSkills({
              team_id: activeTeamId,
              filters: { owner_agent_id: selectedAgent, status: ['active'] },
              pagination: { limit: 200 },
            }),
            myUserId
              ? assetsApi
                  .list(activeTeamId, { asset_type: 'skill', owner_user_id: myUserId })
                  .catch(() => [] as Asset[])
              : Promise.resolve([] as Asset[]),
          ]);
          if (seq !== refreshSeqRef.current) return; // superseded by a later request
          const vm: Record<string, Asset['visibility']> = {};
          for (const a of ownedAssets) vm[a.asset_id] = a.visibility;
          setSkills(listRes.items);
          setVisibilityMap(vm);
        }
      }
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      tea.notify.error(err);
      setSkills([]);
      setVisibilityMap({});
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, [tab, selectedAgent, activeTeamId, myUserId]);

  // Sync selectedAgent to teamAgents:
  //   - After switching team, the old selectedAgent may no longer be in the new team and must be reset;
  //   - On first render selectedAgent also needs a default value.
  useEffect(() => {
    if (teamAgents.length === 0) {
      if (selectedAgent) setSelectedAgent('');
      return;
    }
    if (!selectedAgent || !teamAgents.some((a) => a.id === selectedAgent)) {
      setSelectedAgent(teamAgents[0].id);
    }
  }, [teamAgents, selectedAgent]);

  // Trigger refresh: depends on raw params + refresh, deduped by key to avoid repeated triggers in a short time.
  // Previously `useEffect(() => refresh(), [refresh])` fired multiple times because the refresh reference changed
  // (selectedAgent and other deps sync asynchronously), causing asset/list-accessible etc. to be requested repeatedly.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // Only the fixed tab includes selectedAgent in the key -- the team tab's data source
    // asset/list-accessible is unrelated to the selected agent. If selectedAgent were in the team key,
    // once teamAgents finished loading selectedAgent would change from '' to the first agent, changing the key and
    // triggering a **fully duplicate** list-accessible (one extra request on page entry).
    const key =
      tab === 'fixed' ? `${activeTeamId}|${tab}|${selectedAgent}` : `${activeTeamId}|${tab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void refresh();
  }, [activeTeamId, tab, selectedAgent, refresh]);

  // Clear the selection when the selected item is not in the list.
  // Skip the intermediate loading state: refresh does setSkills([]) first and then refetches;
  // judging at the moment of clearing would wrongly empty the selection (the current selection would be lost after edit-save refresh).
  // Wait until refresh completes (loading=false) and the list is filled, then judge; keep the selection if still present.
  useEffect(() => {
    if (loading) return;
    if (selectedSkillId && !skillsWithCache.find((s) => s.skill_id === selectedSkillId)) {
      setSelectedSkillId(null);
    }
  }, [skillsWithCache, selectedSkillId, loading]);

  const selectedSkill = useMemo(
    () =>
      selectedSkillId
        ? (skillsWithCache.find((s) => s.skill_id === selectedSkillId) ?? null)
        : null,
    [selectedSkillId, skillsWithCache],
  );

  // ============================
  // Delete handler
  // ============================

  const handleDelete = useCallback(
    async (skill: SkillSummary) => {
      if (!activeTeamId) return;
      setDeleteLoading(true);
      try {
        // owner_agent_id is the authorization basis for delete. The team tab data source comes from
        // asset/list-accessible, which has no owner_agent_id (the asset table lacks the field),
        // so skill.owner_agent_id in the list would be ''. Fetch skill/get on demand here to fill it in.
        let ownerAgentId = skill.owner_agent_id;
        if (!ownerAgentId) {
          const full = await getSkill({
            skill_id: skill.skill_id,
            team_id: activeTeamId,
            include_content: false,
            include_manifest: false,
          });
          ownerAgentId = full.owner_agent_id;
        }
        await deleteSkillV3({
          user_id: myUserId,
          team_id: activeTeamId,
          agent_id: ownerAgentId,
          skill_id: skill.skill_id,
        });
        if (selectedSkillId === skill.skill_id) {
          setSelectedSkillId(null);
        }
        tea.notify.success(t('skills.notify.deleted', { name: skill.name }));
        void refresh();
      } catch (err) {
        tea.notify.error(err);
      } finally {
        setDeleteLoading(false);
      }
    },
    [selectedSkillId, refresh, activeTeamId, myUserId],
  );

  // ============================
  // Export handler
  // ============================

  const handleExport = useCallback(async () => {
    const exportSkillId = selectedSkillId;
    if (!exportSkillId) return;
    setExportLoading(true);
    try {
      const result = await exportSkill({
        team_id: activeTeamId ?? '',
        skill_id: exportSkillId,
      });
      // base64 → Blob → download
      const byteChars = atob(result.zip_base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNums[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.warnings.length > 0) {
        tea.notify.warning(t('skills.export.partial', { warnings: result.warnings.join('; ') }));
      }
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : '';
      const msg =
        errorName === 'AbortError' || errorName === 'TimeoutError'
          ? t('skills.export.timeout')
          : (err instanceof Error ? err.message : String(err));
      tea.notify.error({ description: msg });
    } finally {
      setExportLoading(false);
    }
  }, [selectedSkillId, activeTeamId]);

  // ============================
  // Visibility toggle (shared/private)
  // ============================
  // Share/private toggle: the capability of the former "Personal assets" tab, moved onto asset items of the "Agent assets (fixed)" tab,
  // owner only (SkillsPanel checks owner_user_id at render). skill_id === asset_id.
  const handleToggleVisibility = useCallback(
    async (skill: SkillSummary, scope: 'team' | 'private') => {
      const current = visibilityMap[skill.skill_id];
      // When current is missing, fall back to private: from the owner's view getAssets no longer filters,
      // so visibility is normally available; if still missing (old data / API anomaly), still allow
      // toggling rather than returning, to avoid getting stuck unable to switch back to team.
      if (current === scope) return;
      try {
        await assetsApi.update(skill.skill_id, { visibility: scope });
        // Update the visibility badge locally to avoid whole-table flicker
        setVisibilityMap((prev) => ({ ...prev, [skill.skill_id]: scope }));
      } catch (err) {
        tea.notify.error(err);
      }
    },
    [visibilityMap],
  );

  // List loading state (used by the left AssetListPanel).
  // The fixed tab depends on agents and must cover three "data not ready" phases, otherwise it flashes empty first:
  //   1) agentsLoading: agent list request in flight
  //   2) the gap where teamAgents is ready but selectedAgent has not yet been set by the effect
  //   3) loading: per-agent skill list request in flight
  // The team tab does not depend on agents; use the skill list loading directly.
  const listLoading =
    tab === 'fixed'
      ? agentsLoading || loading || (teamAgents.length > 0 && !selectedAgent)
      : loading;

  return {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    skills,
    loading: listLoading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    // cache
    skillsWithCache,
    preloadSkillDetail,
    applyCachedDetail,
    cacheVersion,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  };
}

export type SkillsStore = ReturnType<typeof useSkillsPanel>;
