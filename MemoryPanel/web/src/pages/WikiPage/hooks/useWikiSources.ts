/**
 * useWikiSources -- all state and data logic for the Wiki assets page.
 * The component layer keeps only JSX rendering; state / data logic lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knowledgeApi, wikiProgressPercent, wikiStageLabel, type GraphData, type WikiDetail, type WikiPage } from '@/lib/api/knowledge-api';
import { useTeams, useAgents } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { findExistingRawFilenames, formatOverwriteFilenames } from '../utils/wiki-upload-utils';
import { type DetailTab, type SearchResult, type StatusFilter, type SubView, type ViewMode, type WikiScopeTab } from '../constants/wiki-constants';

export function useWikiSources() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<WikiDetail[]>([]);
  const [loading, setLoading] = useState(false);
  // Show Agent assets (fixed) by default, so users don't think their own assets are under "Team assets"
  const [scopeTab, setScopeTab] = useState<WikiScopeTab>('fixed');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [subView, setSubView] = useState<SubView>('list');
  const [selectedWikiId, setSelectedWikiId] = useState('');

  // Create wiki
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const uploadInFlightRef = useRef(false);

  // Allocate-to-agent
  const [allocateTarget, setAllocateTarget] = useState<{ wiki_id: string; name: string } | null>(
    null,
  );
  const [fixedBoundIds, setFixedBoundIds] = useState<Set<string>>(new Set());
  const { activeTeamId, activeTeam } = useTeams();
  // The "Configurable scope" tab needs the current user's identity; use the team role instead.
  const auth = readAuth();
  const currentUser = auth?.user_id ?? '';
  // The fixed assets tab lists only agents owned by the user (consistent with the ChatMemory / Skills panels,
  // and with the doc §4.2 permission rule: agent-fixed only allows viewing agents the caller owns).
  // Previously readActiveTeamAgents returned all team agents, letting users see other people's agents.
  const { agents: allAgents } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () =>
      allAgents
        .filter((a) => a.owner_user_id === currentUser)
        .map((a) => ({ id: a.agent_id, name: a.name })),
    [allAgents, currentUser],
  );
  // agent_id selected under the fixed tab
  const [agentFilter, setAgentFilter] = useState<string>('');

  useEffect(() => {
    if (teamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !teamAgents.some((a) => a.id === agentFilter)) {
      setAgentFilter(teamAgents[0].id);
    }
  }, [teamAgents, agentFilter]);

  const fetchFixedBindings = useCallback(async () => {
    if (!agentFilter) {
      setFixedBoundIds(new Set());
      return;
    }
    try {
      const items = await knowledgeApi.wiki.agentFixed(agentFilter);
      setFixedBoundIds(new Set(items.map((it) => it.knowledge_id)));
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.loadFixedFailed'));
      setFixedBoundIds(new Set());
    }
  }, [agentFilter]);

  useEffect(() => {
    if (scopeTab === 'fixed') void fetchFixedBindings();
  }, [scopeTab, fetchFixedBindings]);

  // Filter by owning tab
  const scopeSources = useMemo(() => {
    if (scopeTab === 'team') return sources;
    if (scopeTab === 'fixed') {
      if (!agentFilter) return [];
      return sources.filter((source) => source.wiki_id && fixedBoundIds.has(source.wiki_id));
    }
    return sources;
  }, [sources, scopeTab, agentFilter, fixedBoundIds]);

  // Stats are affected only by the asset scope, so search or status filters don't distort the overview data.
  const stats = useMemo(
    () => ({
      total: scopeSources.length,
      ready: scopeSources.filter((source) => source.status === 'ready').length,
      processing: scopeSources.filter(
        (source) => source.status === 'pending' || source.status === 'processing',
      ).length,
      totalPages: scopeSources.reduce((sum, source) => sum + (source.page_count ?? 0), 0),
    }),
    [scopeSources],
  );

  const filteredSources = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return scopeSources.filter((source) => {
      const isProcessing = source.status === 'pending' || source.status === 'processing';
      if (statusFilter === 'ready' && source.status !== 'ready') return false;
      if (statusFilter === 'processing' && !isProcessing) return false;
      if (!normalizedKeyword) return true;
      return (
        source.name.toLowerCase().includes(normalizedKeyword) ||
        source.wiki_id.toLowerCase().includes(normalizedKeyword) ||
        (source.owner_user_id ?? '').toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [scopeSources, keyword, statusFilter]);

  // Ingest progress
  const [ingestState, setIngestState] = useState<{
    active: boolean;
    wikiId: string;
    wiki: string;
    currentFile: string;
    detail: string;
    done: number;
    total: number;
    checkCount: number;
    lastCheckedAt: string;
    log: Array<{ file: string; status: 'done' | 'error'; error?: string }>;
  }>({
    active: false,
    wikiId: '',
    wiki: '',
    currentFile: '',
    detail: '',
    done: 0,
    total: 0,
    checkCount: 0,
    lastCheckedAt: '',
    log: [],
  });

  // Detail view state (Wiki details: graph / pages / search tabs)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedPage, setSelectedPage] = useState<WikiPage | null>(null);
  const [readContent, setReadContent] = useState('');
  const [readLoading, setReadLoading] = useState(false);
  const [pageTypeFilter, setPageTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Add doc (add documents: file / pasted markdown)
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [addDocTab, setAddDocTab] = useState<'file' | 'markdown'>('file');
  // Batch markdown: each item { filename, content }, can be added or removed
  const [mdDocs, setMdDocs] = useState<Array<{ filename: string; content: string }>>([
    { filename: '', content: '' },
  ]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Fetch ---
  // Request sequence number guards against races: when switching tabs quickly, an earlier request may return later,
  // and the old tab's data would overwrite the new tab's data. Each fetch increments the sequence;
  // when a response arrives, check that the sequence is still the latest, and discard it if not.
  const fetchSeqRef = useRef(0);

  const fetchSources = useCallback(async () => {
    if (!activeTeamId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    // On team switch, refresh silently (keep the old list until new data arrives), no empty flash or skeleton;
    // tab switch still clears + loading (so the previous tab's list is not seen).
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    if (!teamChanged) {
      setLoading(true);
      // Clear old data immediately -- otherwise switching tabs first shows the previous tab's list,
      // then suddenly replaces it when new data arrives, which looks like a "flash".
      setSources([]);
    }
    try {
      // Assets are unified at team level (visibility=team); there is no private / "my assets" concept.
      // The fixed tab also fetches all team assets, then filters by fixedBoundIds.
      const d = await knowledgeApi.wiki.teamAssets(activeTeamId);
      if (seq !== fetchSeqRef.current) return; // superseded by a later request
      setSources(Array.isArray(d) ? d : []);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error(e);
      setSources([]);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [activeTeamId, scopeTab]);

  // Trigger fetchSources: depends on raw params + fetchSources, deduped by key to avoid repeated triggers in a short time.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    const key = `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchSources();
  }, [activeTeamId, scopeTab, fetchSources]);

  // On team switch, leave the details and clear the old wiki's local state, so the previous team's pages/graph/content is not still shown.
  const prevTeamIdRef = useRef(activeTeamId);
  useEffect(() => {
    if (prevTeamIdRef.current === activeTeamId) return;
    prevTeamIdRef.current = activeTeamId;
    setSubView('list');
    setSelectedWikiId('');
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setShowAddDoc(false);
  }, [activeTeamId]);

  const fetchDetail = useCallback(async (wikiId: string) => {
    setGraphLoading(true);
    // The two sub-requests each have their own fallback, which the outer catch cannot see; use a flag to detect any failure and show one hint,
    // so the detail page does not silently go blank on load failure leaving the user unable to tell.
    let hadError = false;
    try {
      const [g, p] = await Promise.all([
        knowledgeApi.wiki.graph(wikiId).catch(() => {
          hadError = true;
          return null;
        }),
        knowledgeApi.wiki.pages(wikiId).catch(() => {
          hadError = true;
          return [];
        }),
      ]);
      setGraphData(g);
      setPages(Array.isArray(p) ? p : (p as { pages?: WikiPage[] } | null)?.pages || []);
    } finally {
      setGraphLoading(false);
    }
    if (hadError) tea.notify.error(t('wiki.notify.loadDetailFailed'));
  }, []);

  const runningWikiKey = useMemo(
    () =>
      sources
        .filter((s) => s.status === 'pending' || s.status === 'processing')
        .map((s) => `${s.wiki_id}:${s.status}:${s.internal_status ?? ''}`)
        .join('|'),
    [sources],
  );

  useEffect(() => {
    const running = sources.filter(
      (s) => s.wiki_id && (s.status === 'pending' || s.status === 'processing'),
    );
    if (running.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      const items = await Promise.all(
        running.map(async (s) => {
          try {
            return await knowledgeApi.wiki.get(s.wiki_id);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map = new Map(items.filter(Boolean).map((w) => [w!.wiki_id, w!]));
      setSources((prev) =>
        prev.map((s) => (map.get(s.wiki_id) ? { ...s, ...map.get(s.wiki_id)! } : s)),
      );
      if (selectedWikiId && map.has(selectedWikiId)) {
        const d = map.get(selectedWikiId)!;
        if (d.status === 'ready' || d.status === 'failed') void fetchDetail(selectedWikiId);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runningWikiKey, selectedWikiId, fetchDetail]);

  async function handleUnbindWiki(wikiId: string) {
    if (!agentFilter) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.unbind'),
        description: t('wiki.confirm.unbind.desc'),
        okText: t('wiki.confirm.unbind.ok'),
      },
      async () => {
        await knowledgeApi.wiki.unbind(wikiId, agentFilter);
        tea.notify.success(t('wiki.notify.unbound'));
        if (selectedWikiId === wikiId) setSelectedWikiId('');
        await fetchFixedBindings();
        await fetchSources();
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.unbindFailed')),
    );
  }

  // --- Handlers ---
  const handleCreate = async () => {
    if (!newName.trim() || !activeTeamId) return;
    setSubmitting(true);
    try {
      await knowledgeApi.wiki.create(activeTeamId, newName.trim());
      tea.notify.success(t('wiki.notify.created', { name: newName.trim() }));
      setShowCreate(false);
      setNewName('');
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const runningWiki = useMemo(
    () => sources.find((s) => s.status === 'pending' || s.status === 'processing') ?? null,
    [sources],
  );
  /** Set of all wiki_ids currently ingesting (pending / processing), used to decide button state per card in the list. */
  const runningWikiIds = useMemo(
    () =>
      new Set(
        sources
          .filter((s) => s.status === 'pending' || s.status === 'processing')
          .map((s) => s.wiki_id),
      ),
    [sources],
  );
  const hasManualIngestState =
    ingestState.active ||
    ingestState.log.length > 0 ||
    (ingestState.done > 0 && !!ingestState.detail);
  const displayIngestState = useMemo(() => {
    if (hasManualIngestState || !runningWiki) return ingestState;
    const stage = wikiStageLabel(runningWiki.status, runningWiki.internal_status);
    const pageHint =
      typeof runningWiki.page_count === 'number' ? t('wiki.ingest.currentPage', { count: runningWiki.page_count }) : '';
    return {
      active: true,
      wikiId: runningWiki.wiki_id ?? '',
      wiki: runningWiki.name,
      currentFile: '',
      detail: t('wiki.ingest.stateRecovery', { stage, pageHint }),
      done: wikiProgressPercent(runningWiki.status, runningWiki.internal_status),
      total: 100,
      checkCount: 0,
      lastCheckedAt: '',
      log: [],
    };
  }, [hasManualIngestState, ingestState, runningWiki]);
  const ingestBusy = displayIngestState.active || !!runningWiki;

  const handleIngest = async (wikiId: string) => {
    // Defensive: only one Wiki extraction is allowed at a time, avoiding backend queue chaos from concurrent ingests.
    // The button is already disabled by ingestBusy; this adds another guard against bypassing.
    if (ingestBusy) {
      tea.notify.warning(t('wiki.ingest.warning'));
      return;
    }
    const wiki = sources.find((s) => s.wiki_id === wikiId);
    const name = wiki?.name ?? wikiId;
    setIngestState({
      active: true,
      wikiId,
      wiki: name,
      currentFile: '',
      detail: t('wiki.ingest.triggering'),
      done: 0,
      total: 100,
      checkCount: 0,
      lastCheckedAt: '',
      log: [],
    });
    await knowledgeApi.wiki.ingestWithPolling(
      wikiId,
      {
        onProgress: (ev) => {
          setIngestState((prev) => {
            const next = { ...prev };
            const checkedAt = new Date(ev.ts).toLocaleTimeString();
            if (ev.type === 'file_start') {
              next.currentFile = ev.file || '';
              next.detail = ev.detail || t('wiki.ingest.processing');
              next.done = ev.done ?? prev.done;
              next.total = ev.total ?? prev.total;
              next.lastCheckedAt = checkedAt;
            } else if (ev.type === 'file_done') {
              next.done = ev.done ?? prev.done;
              next.total = ev.total ?? prev.total;
              next.detail = ev.detail || t('wiki.ingest.checked', { done: next.done, total: next.total });
              next.checkCount = prev.checkCount + 1;
              next.lastCheckedAt = checkedAt;
              if (ev.file) next.log = [...prev.log, { file: ev.file, status: 'done' }];
            } else if (ev.type === 'file_error') {
              next.done = ev.done ?? prev.done;
              next.detail = ev.detail || prev.detail;
              next.checkCount = prev.checkCount + 1;
              next.lastCheckedAt = checkedAt;
              next.log = [...prev.log, { file: ev.file || '', status: 'error', error: ev.error }];
            } else if (ev.type === 'batch_done') {
              next.done = ev.done ?? 100;
              next.total = ev.total ?? 100;
              next.detail = ev.detail || t('wiki.ingest.complete');
              next.lastCheckedAt = checkedAt;
            }
            return next;
          });
        },
        onComplete: (result) => {
          setIngestState((prev) => ({
            ...prev,
            active: false,
            done: 100,
            total: 100,
            detail: t('wiki.ingest.done', { count: result.ingested }),
            currentFile: '',
          }));
          tea.notify.success(t('wiki.notify.ingestComplete', { count: result.ingested }));
          fetchSources();
          fetchDetail(wikiId);
        },
        onError: (err) => {
          setIngestState((prev) => ({ ...prev, active: false, detail: t('wiki.ingest.error', { error: err }) }));
          tea.notify.error(err || t('wiki.notify.ingestFailed'));
        },
      },
      activeTeamId ?? '',
    );
    setIngestState((prev) =>
      prev.active
        ? { ...prev, active: false, detail: prev.log.length > 0 ? t('wiki.ingest.finished') : prev.detail }
        : prev,
    );
    fetchSources();
  };

  const handleDelete = async (wikiId: string, name: string) => {
    await confirmThenRun(
      {
        message: t('wiki.confirm.delete', { name }),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.delete(wikiId);
        if (selectedWikiId === wikiId) setSubView('list');
        fetchSources();
      },
    );
  };

  const openDetail = (wikiId: string) => {
    setSelectedWikiId(wikiId);
    setActiveTab('overview');
    setSelectedPage(null);
    setSearchQuery('');
    setSearchResults([]);
    setPageTypeFilter('all');
    // When switching to another wiki's details, the previous wiki's detail-level data (page list / graph / read content) must be cleared.
    // Otherwise, before the new wiki's fetchDetail returns, the overview/graph/pages tabs flash the previous wiki's content.
    setPages([]);
    setGraphData(null);
    setReadContent('');
    setSubView('detail');
    fetchDetail(wikiId);
  };

  const handleReadPage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    // When switching pages, clear the old content first and then enter loading -- otherwise derived metadata (from readContent)
    // would keep the previous document's labels before the new content returns, looking like a "flash of the old document".
    setSelectedPage(page);
    setReadContent('');
    setReadLoading(true);
    try {
      const r = await knowledgeApi.wiki.read(
        selectedWikiId,
        (page as { id?: string }).id || page.path,
      );
      setReadContent(r?.content || '');
    } catch (e: unknown) {
      setReadContent('');
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('wiki.notify.readPageFailed'));
    } finally {
      setReadLoading(false);
    }
  };

  const handleDeletePage = async (page: WikiPage) => {
    if (!selectedWikiId) return;
    const ref = (page as { id?: string }).id || page.path;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deletePage', { name: page.title || ref }),
        description: t('wiki.confirm.deletePage.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.pageDelete(selectedWikiId, [ref]);
        tea.notify.success(t('wiki.notify.pageDeleted'));
        if (selectedPage && ((selectedPage as { id?: string }).id || selectedPage.path) === ref) {
          setSelectedPage(null);
          setReadContent('');
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.pageDeleteFailed')),
    );
  };

  const handleDeleteRaw = async (filename: string) => {
    if (!selectedWikiId) return;
    await confirmThenRun(
      {
        message: t('wiki.confirm.deleteRaw', { name: filename }),
        description: t('wiki.confirm.deleteRaw.desc'),
        okText: t('common.delete'),
      },
      async () => {
        await knowledgeApi.wiki.rawDelete(selectedWikiId, [filename]);
        tea.notify.success(t('wiki.notify.rawDeleted'));
        if (selectedPage?.path === `raw/${filename}`) {
          setSelectedPage(null);
          setReadContent('');
        }
        await fetchDetail(selectedWikiId);
      },
      (e) => tea.notify.error((e as Error)?.message || t('wiki.notify.rawDeleteFailed')),
    );
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !selectedWikiId) return;
    setSearching(true);
    try {
      const r = await knowledgeApi.wiki.search(selectedWikiId, searchQuery, 20);
      setSearchResults((r as { results?: SearchResult[] }).results || []);
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSearching(false);
    }
  };

  // Raw document list refresh signal: RawFilesSection keeps its own independent state and reloads only when wikiId changes;
  // after a successful upload, fetchDetail refreshes only pages/graph and does not make it re-fetch. Incrementing this key forces a reload.
  const [rawRefreshKey, setRawRefreshKey] = useState(0);

  const confirmOverwrite = async (filenames: readonly string[]): Promise<boolean> => {
    try {
      const { files } = await knowledgeApi.wiki.rawList(selectedWikiId);
      const existing = findExistingRawFilenames(
        filenames,
        files.map((file) => file.filename),
      );
      if (existing.length === 0) return true;

      return tea.confirm({
        message: t('wiki.detail.overwrite.title', { count: existing.length }),
        description: t('wiki.detail.overwrite.desc', { files: formatOverwriteFilenames(existing) }),
        okText: t('wiki.detail.overwrite.ok'),
        cancelText: t('common.cancel'),
      });
    } catch (e: unknown) {
      tea.notify.error(e instanceof Error ? e : t('wiki.notify.uploadCancelled'));
      return false;
    }
  };

  /**
   * Upload only writes raw documents and does not trigger knowledge extraction automatically; on success, give a clear next step immediately,
   * so users know they still need to click "Start extraction".
   */
  const offerIngestAfterUpload = async (wikiId: string, uploadedCount: number) => {
    const shouldIngest = await tea.confirm({
      message: t('wiki.detail.uploaded', { count: uploadedCount }),
      description: t('wiki.detail.uploaded.desc'),
      okText: t('wiki.detail.uploaded.ok'),
      cancelText: t('wiki.detail.uploaded.cancel'),
    });
    if (shouldIngest) {
      void handleIngest(wikiId);
    } else {
      tea.notify.info(t('wiki.detail.uploaded.later'));
    }
  };

  const handleUploadMdBatch = async () => {
    if (!activeTeamId || !selectedWikiId) return;
    const valid = mdDocs.filter((d) => d.filename.trim() && d.content.trim());
    if (valid.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(valid.map((doc) => doc.filename.trim())))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    const failures: Array<{ filename: string; error: string }> = [];
    for (const doc of valid) {
      const filename = doc.filename.trim();
      try {
        await knowledgeApi.wiki.upload({ teamId: activeTeamId, wikiId: selectedWikiId, filename, content: doc.content });
      } catch (e: unknown) {
        failures.push({ filename, error: e instanceof Error ? e.message : String(e) });
      }
    }
    uploadInFlightRef.current = false;
    setSubmitting(false);
    if (failures.length === 0) {
      tea.notify.success(t('wiki.detail.upload.success', { count: valid.length }));
      setMdDocs([{ filename: '', content: '' }]);
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      await offerIngestAfterUpload(selectedWikiId, valid.length);
    } else {
      const okCount = valid.length - failures.length;
      // List the reason for each failed file, showing at most 3, the rest collapsed
      const shown = failures
        .slice(0, 3)
        .map((f) => `${f.filename}: ${f.error}`)
        .join('\n');
      const more = failures.length > 3 ? t('wiki.detail.upload.more', { count: failures.length - 3 }) : '';
      tea.notify.error(t('wiki.detail.upload.partialFail', { ok: okCount, fail: failures.length, detail: `${shown}${more}` }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      if (okCount > 0) await offerIngestAfterUpload(selectedWikiId, okCount);
    }
  };

  // Batch file upload: supports multi-select + drag-and-drop, concurrent uploads
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, 'pending' | 'done' | 'error'>
  >({});

  const handleBatchUpload = async () => {
    if (!activeTeamId || !selectedWikiId || pendingFiles.length === 0) return;
    if (uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    setSubmitting(true);
    if (!(await confirmOverwrite(pendingFiles.map((file) => file.name)))) {
      uploadInFlightRef.current = false;
      setSubmitting(false);
      return;
    }
    setUploadProgress(Object.fromEntries(pendingFiles.map((f) => [f.name, 'pending'])));
    // Upload all files concurrently
    const results = await Promise.allSettled(
      pendingFiles.map(async (f) => {
        const content = await f.text();
        await knowledgeApi.wiki.upload({ teamId: activeTeamId, wikiId: selectedWikiId, filename: f.name, content });
        setUploadProgress((prev) => ({ ...prev, [f.name]: 'done' }));
      }),
    );
    uploadInFlightRef.current = false;
    setSubmitting(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed === 0) {
      tea.notify.success(t('wiki.detail.upload.successFiles', { count: succeeded }));
      setPendingFiles([]);
      setUploadProgress({});
      setShowAddDoc(false);
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      // The file upload entry previously missed this step, so users didn't know they still had to extract manually after uploading.
      await offerIngestAfterUpload(selectedWikiId, succeeded);
    } else {
      results.forEach((r, i) => {
        if (r.status === 'rejected')
          setUploadProgress((prev) => ({ ...prev, [pendingFiles[i].name]: 'error' }));
      });
      tea.notify.error(t('wiki.detail.upload.fail', { ok: succeeded, fail: failed }));
      fetchDetail(selectedWikiId);
      setRawRefreshKey((k) => k + 1);
      if (succeeded > 0) await offerIngestAfterUpload(selectedWikiId, succeeded);
    }
  };

  // --- Computed ---
  const typeCounts = useMemo(
    () =>
      pages.reduce<Record<string, number>>((a, p) => {
        a[p.type] = (a[p.type] || 0) + 1;
        return a;
      }, {}),
    [pages],
  );
  const types = useMemo(() => Object.keys(typeCounts).sort(), [typeCounts]);
  const filteredPages = useMemo(
    () => (pageTypeFilter === 'all' ? pages : pages.filter((p) => p.type === pageTypeFilter)),
    [pages, pageTypeFilter],
  );
  const edgeCount = graphData?.edges?.length || 0;

  const { displayContent, metadata } = useMemo(() => {
    const text = readContent;
    // Case 1: standard --- fenced frontmatter
    const fenced = text.match(/^---\n([\s\S]*?)\n---\n*/);
    if (fenced) {
      const body = text.slice(fenced[0].length);
      const meta: Record<string, string> = {};
      fenced[1].split('\n').forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      return { displayContent: body, metadata: Object.keys(meta).length > 0 ? meta : null };
    }
    // Case 2: unfenced frontmatter (type: xxx\ntitle: xxx\n... at the start)
    const lines = text.split('\n');
    const fmLines: string[] = [];
    let i = 0;
    // skip leading blank lines
    while (i < lines.length && !lines[i].trim()) i++;
    // collect key: value lines (must have key at start, no leading whitespace, colon present)
    while (i < lines.length) {
      const line = lines[i];
      if (/^[a-zA-Z_][\w-]*\s*:/.test(line)) {
        fmLines.push(line);
        i++;
      } else {
        break;
      }
    }
    if (fmLines.length >= 2) {
      const meta: Record<string, string> = {};
      fmLines.forEach((l) => {
        const [k, ...v] = l.split(':');
        if (k?.trim() && v.length) meta[k.trim()] = v.join(':').trim();
      });
      // skip blank lines after frontmatter
      while (i < lines.length && !lines[i].trim()) i++;
      return {
        displayContent: lines.slice(i).join('\n'),
        metadata: Object.keys(meta).length > 0 ? meta : null,
      };
    }
    return { displayContent: text, metadata: null };
  }, [readContent]);

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    subView,
    setSubView,
    selectedWikiId,
    setSelectedWikiId,
    // create
    showCreate,
    setShowCreate,
    newName,
    setNewName,
    submitting,
    setSubmitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    fixedBoundIds,
    agentFilter,
    setAgentFilter,
    // detail
    activeTab,
    setActiveTab,
    pages,
    setPages,
    graphData,
    setGraphData,
    graphLoading,
    setGraphLoading,
    ingestState,
    setIngestState,
    selectedPage,
    setSelectedPage,
    readContent,
    setReadContent,
    readLoading,
    setReadLoading,
    pageTypeFilter,
    setPageTypeFilter,
    searchQuery,
    setSearchQuery,
    searchResults,
    setSearchResults,
    searching,
    setSearching,
    // add doc
    showAddDoc,
    setShowAddDoc,
    addDocTab,
    setAddDocTab,
    mdDocs,
    setMdDocs,
    pendingFiles,
    setPendingFiles,
    uploadProgress,
    setUploadProgress,
    rawRefreshKey,
    setRawRefreshKey,
    fileInputRef,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    fetchDetail,
    handleUnbindWiki,
    handleCreate,
    handleIngest,
    handleDelete,
    openDetail,
    handleReadPage,
    handleDeletePage,
    handleDeleteRaw,
    handleSearch,
    handleUploadMdBatch,
    handleBatchUpload,
    // computed
    scopeSources,
    stats,
    filteredSources,
    typeCounts,
    types,
    filteredPages,
    edgeCount,
    runningWikiIds,
    hasManualIngestState,
    displayIngestState,
    ingestBusy,
    displayContent,
    metadata,
  };
}

export type WikiSourcesStore = ReturnType<typeof useWikiSources>;
