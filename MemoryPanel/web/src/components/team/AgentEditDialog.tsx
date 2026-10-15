/**
 * AgentEditDialog - dialog for editing/viewing an Agent.
 *
 * Editing scope conventions:
 *   - Name, one-line description, and role prompt / rules prompt can be edited and saved.
 *   - Resource capabilities can be checked/unbound and saved directly in this dialog:
 *     · Wiki knowledge base / CodeGraph -> allocate / unbind (reference binding, incremental diff)
 *     · Chat Memory -> setAgentFixed (full overwrite, naturally handles add/remove; excludes the agent's own memory)
 *     · Skill -> still read-only. The "mount" semantics of a skill is forking an independent copy with owner = that agent
 *       (see skillApi.forkToAgent); adding/removing copies in the edit dialog involves optimistic locking and archiving,
 *       is high-risk, and is not opened up in this phase; it stays maintained in "Create Agent" / the skill management page.
 *
 * The bound state of resources reads the real binding sources (skill table owner_agent_id + agent-fixed-asset table), consistent with runtime.
 */

import { useState, useMemo, useEffect } from 'react';
import { Button, Input, Modal } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import { ToolsIcon, CodeIcon, LibraryIcon, ChatIcon } from '@/components/ui/icons';
import { type Agent as StoreAgent, invalidateBackendCache, writeAgentUiMeta } from '@/services';
import { agentsApi, skillApi, chatMemoryApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { feedback } from '@/lib/feedback';
import { useTeamAssets, syncChatMemoryBindings } from './useAgentAssets';
import { LightField, CollapseGroup, AssetCheckList } from './shared';

export default function AgentEditDialog({
  agent,
  onClose,
}: {
  agent: StoreAgent;
  onClose: () => void;
}) {
  const selfChatMemoryId = `chat_memory-${agent.team_id}-${agent.agent_id}`;
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [rolePrompt, setRolePrompt] = useState(agent.role_prompt);
  const [rulesPrompt, setRulesPrompt] = useState(agent.rules_prompt);
  const [savingPrompt, setSavingPrompt] = useState(false);

  const [codeGraphOpen, setCodeGraphOpen] = useState(false);
  const [wikiOpen, setWikiOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  // Editable resources: fill the initial checked state from the real binding sources.
  const [skills, setSkills] = useState<string[]>([]);
  const [codeGraphs, setCodeGraphs] = useState<string[]>([]);
  const [llmWikis, setLlmWikis] = useState<string[]>([]);
  const [chatMemories, setChatMemories] = useState<string[]>([selfChatMemoryId]);
  // Initial binding snapshot: on save, compared with the current selection to compute the add/remove diff (skill is read-only and not part of the diff).
  const [initialCodeGraphs, setInitialCodeGraphs] = useState<string[]>([]);
  const [initialWikis, setInitialWikis] = useState<string[]>([]);
  const [initialChatMemories, setInitialChatMemories] = useState<string[]>([selfChatMemoryId]);
  const [savingAssets, setSavingAssets] = useState(false);
  // Bindings the agent really owns but that may not be in the team asset pool (e.g. skill fork copies, borrowed memory),
  // injected into the asset pool so that every "bound" item can be displayed and the count matches the list card.
  const [realSkillItems, setRealSkillItems] = useState<Array<{ key: string; title: string }>>([]);
  const [realCodeGraphIds, setRealCodeGraphIds] = useState<string[]>([]);
  const [realWikiIds, setRealWikiIds] = useState<string[]>([]);
  const [realChatMemoryIds, setRealChatMemoryIds] = useState<string[]>([]);
  const [realBindingsLoaded, setRealBindingsLoaded] = useState(false);

  const assets = useTeamAssets(agent.team_id);
  const { t } = useTranslation();

  // Loading-state orchestration:
  //   assets.loading -- team asset pool is loading (all 4 collapse groups use the asset pool data)
  //   realBindingsLoaded -- real binding sources are ready (decides whether the collapse groups' count is trustworthy)
  // If either is not ready -> the collapse groups show skeleton placeholders, avoiding a jump from "selected 0 / total 0" to the real numbers.
  const bindingsLoading = assets.loading || !realBindingsLoaded;

  function injectBound<T extends { key: string; title: string; group: string; slug: string }>(
    pool: T[],
    boundIds: string[],
    group: string,
  ): T[] {
    const map = new Map(pool.map((item) => [item.key, item]));
    for (const id of boundIds) {
      if (!map.has(id)) {
        map.set(id, { key: id, title: id, group, slug: id } as T);
      }
    }
    return Array.from(map.values());
  }

  const skillsAssets = useMemo(() => {
    const map = new Map(assets.skills.map((item) => [item.key, item]));
    for (const it of realSkillItems) {
      if (!map.has(it.key)) {
        map.set(it.key, { key: it.key, title: it.title, group: 'SKILL', slug: it.key });
      }
    }
    return Array.from(map.values());
  }, [assets.skills, realSkillItems]);
  const codeGraphAssets = useMemo(
    () => injectBound(assets.codeGraphs, realCodeGraphIds, 'CODE'),
    [assets.codeGraphs, realCodeGraphIds],
  );
  const wikiAssets = useMemo(
    () => injectBound(assets.wikis, realWikiIds, 'WIKI'),
    [assets.wikis, realWikiIds],
  );
  const memoryAssets = useMemo(() => {
    const map = new Map(assets.chatMemories.map((item) => [item.key, item]));
    if (!map.has(selfChatMemoryId)) {
      map.set(selfChatMemoryId, {
        key: selfChatMemoryId,
        title: agent.name,
        group: 'MEMORY',
        slug: selfChatMemoryId,
      });
    }
    for (const id of realChatMemoryIds) {
      if (!map.has(id)) {
        map.set(id, { key: id, title: id, group: 'MEMORY', slug: id });
      }
    }
    return Array.from(map.values());
  }, [agent.name, realChatMemoryIds, assets.chatMemories, selfChatMemoryId]);

  // Editable: show the full team asset pool (bound and unbound) for the user to check/uncheck.
  // skill is still read-only and shows only bound items (fork semantics, see the file header).
  const boundSkills = useMemo(
    () => skillsAssets.filter((a) => skills.includes(a.key)),
    [skillsAssets, skills],
  );

  function toggle(list: string[], setList: (v: string[]) => void, key: string) {
    setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  }

  // Whether assets changed relative to the initial binding (used to enable the save button)
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const assetsChanged =
    !sameSet(codeGraphs, initialCodeGraphs) ||
    !sameSet(llmWikis, initialWikis) ||
    !sameSet(chatMemories, initialChatMemories);

  const promptChanged =
    name !== agent.name ||
    description !== agent.description ||
    rolePrompt !== agent.role_prompt ||
    rulesPrompt !== agent.rules_prompt;
  const agentChanged = promptChanged || assetsChanged;
  const saving = savingPrompt || savingAssets;

  /** Save the asset binding diff: wiki / code_graph use allocate/unbind, chat_memory uses the full setAgentFixed. */
  async function saveAssetBindings() {
    // Wiki
    for (const id of llmWikis.filter((x) => !initialWikis.includes(x))) {
      await knowledgeApi.wiki.allocate(agent.team_id, id, agent.agent_id);
    }
    for (const id of initialWikis.filter((x) => !llmWikis.includes(x))) {
      await knowledgeApi.wiki.unbind(id, agent.agent_id);
    }
    // CodeGraph
    for (const id of codeGraphs.filter((x) => !initialCodeGraphs.includes(x))) {
      await knowledgeApi.code.allocate(agent.team_id, id, agent.agent_id);
    }
    for (const id of initialCodeGraphs.filter((x) => !codeGraphs.includes(x))) {
      await knowledgeApi.code.unbind(id, agent.agent_id);
    }
    // Chat Memory: full overwrite (internally filters out the agent's own memory and validates the borrow limit)
    if (!sameSet(chatMemories, initialChatMemories)) {
      await syncChatMemoryBindings(agent.team_id, agent.agent_id, chatMemories);
    }
  }

  async function saveAgent() {
    if (!agentChanged || saving) return;
    const nextName = name.trim();
    const nextDescription = description.trim();
    const nextRolePrompt = rolePrompt.trim();
    const nextRulesPrompt = rulesPrompt.trim();
    if (!nextName) {
      feedback.notify.error(t('agentEdit.notify.nameRequired'));
      return;
    }
    setSavingPrompt(true);
    setSavingAssets(true);
    try {
      // Runtime uses the full prompt text; metadata_json keeps the split of the two fields so the frontend can restore them when editing again.
      if (promptChanged) {
        await agentsApi.update(agent.agent_id, {
          name: nextName,
          description: nextDescription,
          prompt: [nextRolePrompt, nextRulesPrompt].filter(Boolean).join('\n\n'),
          metadata_json: writeAgentUiMeta(agent.metadata_json, {
            role_prompt: nextRolePrompt,
            rules_prompt: nextRulesPrompt,
          }),
        });
      }
      if (assetsChanged) {
        await saveAssetBindings();
      }
      invalidateBackendCache();
      feedback.notify.success(t('agentEdit.notify.saved'));
      onClose();
    } catch (error) {
      feedback.notify.error(
        t('agentEdit.notify.saveFailed', {
          msg: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSavingPrompt(false);
      setSavingAssets(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (assets.loading || realBindingsLoaded)
      return () => {
        cancelled = true;
      };

    // Read the real binding sources (authoritative, consistent with runtime), used only for read-only display.
    Promise.allSettled([
      skillApi.listByAgent(agent.team_id, agent.agent_id),
      knowledgeApi.agentFixed(agent.agent_id),
      chatMemoryApi.agentFixed(agent.agent_id),
    ])
      .then(([skillResult, knowledgeResult, chatResult]) => {
        if (cancelled) return;

        const skillItems = skillResult.status === 'fulfilled' ? skillResult.value : [];
        const nextSkillItems = skillItems.map((s) => ({
          key: s.skill_id,
          title: s.name || s.skill_id,
        }));
        setRealSkillItems(nextSkillItems);
        setSkills(nextSkillItems.map((s) => s.key));

        const knowledgeItems = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : [];
        const nextCodeGraphs = Array.from(
          new Set(
            knowledgeItems
              .filter((it) => it.asset_type === 'code_graph')
              .map((it) => it.knowledge_id),
          ),
        );
        const nextLlmWikis = Array.from(
          new Set(
            knowledgeItems
              .filter((it) => it.asset_type === 'llm_wiki')
              .map((it) => it.knowledge_id),
          ),
        );
        setRealCodeGraphIds(nextCodeGraphs);
        setRealWikiIds(nextLlmWikis);
        setCodeGraphs(nextCodeGraphs);
        setLlmWikis(nextLlmWikis);
        setInitialCodeGraphs(nextCodeGraphs);
        setInitialWikis(nextLlmWikis);

        const chatItems = chatResult.status === 'fulfilled' ? (chatResult.value.items ?? []) : [];
        const nextChatMemories = Array.from(
          new Set([selfChatMemoryId, ...chatItems.map((it) => it.id)]),
        );
        setRealChatMemoryIds(nextChatMemories);
        setChatMemories(nextChatMemories);
        setInitialChatMemories(nextChatMemories);

        setRealBindingsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setRealBindingsLoaded(true);
        const msg = err instanceof Error ? err.message : String(err);
        // In read-only mode the backend may refuse access to another user's agent assets (NOT_YOUR_AGENT); this is expected behavior.
        if (!/NOT_YOUR_AGENT/.test(msg)) {
          feedback.notify.error(t('agentEdit.notify.loadAssetsFailed', { msg }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agent, assets.loading, realBindingsLoaded, selfChatMemoryId]);

  return (
    <Modal visible caption={t('agentEdit.caption')} size="l" onClose={onClose}>
      <Modal.Body>
        <div className="_memory-form-stack">
          <div className="_memory-modal-description">{agent.agent_id}</div>
          <LightField label={t('agentEdit.name')}>
            <Input size="full" value={name} onChange={setName} disabled={saving} />
          </LightField>

          <LightField label={t('agentEdit.descLabel')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={2}
              disabled={saving}
            />
          </LightField>

          <LightField label={t('agentEdit.roleLabel')}>
            <Input.TextArea
              size="full"
              value={rolePrompt}
              onChange={setRolePrompt}
              rows={3}
              disabled={saving}
              placeholder={t('agentEdit.rolePlaceholder')}
            />
          </LightField>

          <LightField label={t('agentEdit.rulesLabel')}>
            <Input.TextArea
              size="full"
              value={rulesPrompt}
              onChange={setRulesPrompt}
              rows={4}
              disabled={saving}
              className="_memory-mono-textarea"
              placeholder={t('agentEdit.rulesPlaceholder')}
            />
          </LightField>

          <div className="_memory-asset-section">
            {bindingsLoading ? (
              // Whole asset area loading: skeleton placeholder outlining the 4 collapse groups
              <div className="_memory-asset-section-loading" aria-label="loading assets">
                <div className="_memory-asset-loading">{t('agentEdit.assets.loading')}</div>
                <div className="_memory-collapse-group-stack">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="_memory-collapse-group _memory-collapse-group--loading"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <div className="_memory-collapse-group-header">
                        <span className="_memory-collapse-group-chevron" />
                        <span className="_memory-collapse-group-title">
                          <span className="_memory-collapse-group-title-skeleton" />
                        </span>
                        <span className="_memory-collapse-group-count _memory-collapse-group-count--loading" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className="_memory-asset-toolbar">
                  <span className="_memory-asset-toolbar-label">{t('agentEdit.assets.label')}</span>
                  <span className="_memory-asset-toolbar-hint">
                    {t('agentEdit.assets.editHint')}
                  </span>
                </div>
                <div className="_memory-collapse-group-stack">
                  <CollapseGroup
                    icon={<LibraryIcon size={16} />}
                    title={t('settings.module.wiki')}
                    selectedCount={llmWikis.length}
                    totalCount={wikiAssets.length}
                    open={wikiOpen}
                    onToggle={() => setWikiOpen(!wikiOpen)}
                  >
                    <AssetCheckList
                      assets={wikiAssets}
                      checkedKeys={llmWikis}
                      onToggle={(k) => toggle(llmWikis, setLlmWikis, k)}
                    />
                  </CollapseGroup>
                  <CollapseGroup
                    icon={<CodeIcon size={16} />}
                    title={t('settings.module.code')}
                    selectedCount={codeGraphs.length}
                    totalCount={codeGraphAssets.length}
                    open={codeGraphOpen}
                    onToggle={() => setCodeGraphOpen(!codeGraphOpen)}
                  >
                    <AssetCheckList
                      assets={codeGraphAssets}
                      checkedKeys={codeGraphs}
                      onToggle={(k) => toggle(codeGraphs, setCodeGraphs, k)}
                    />
                  </CollapseGroup>
                  <CollapseGroup
                    icon={<ChatIcon size={16} />}
                    title={t('settings.module.chatMemory')}
                    selectedCount={chatMemories.length}
                    totalCount={memoryAssets.length}
                    open={memoryOpen}
                    onToggle={() => setMemoryOpen(!memoryOpen)}
                  >
                    <AssetCheckList
                      assets={memoryAssets}
                      checkedKeys={chatMemories}
                      onToggle={(k) => toggle(chatMemories, setChatMemories, k)}
                      disabledKeys={new Set([selfChatMemoryId])}
                    />
                  </CollapseGroup>
                  {/* Skill is still read-only: its binding is a forked independent copy, and the edit dialog does not add/remove (see the file header) */}
                  <CollapseGroup
                    icon={<ToolsIcon size={16} />}
                    title={t('settings.module.skill')}
                    selectedCount={skills.length}
                    totalCount={boundSkills.length}
                    open={skillsOpen}
                    onToggle={() => setSkillsOpen(!skillsOpen)}
                    hideTotal
                  >
                    <div className="_memory-asset-readonly-hint">
                      {t('agentEdit.assets.skillReadonly')}
                    </div>
                    <AssetCheckList
                      assets={boundSkills}
                      checkedKeys={skills}
                      onToggle={() => {}}
                      readOnly
                    />
                  </CollapseGroup>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} disabled={saving}>
          {t('agentEdit.cancel')}
        </Button>
        <Button
          type="primary"
          onClick={() => void saveAgent()}
          disabled={!agentChanged || saving}
          loading={saving}
        >
          {t('agentEdit.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
