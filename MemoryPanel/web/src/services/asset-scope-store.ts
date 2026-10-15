/**
 * asset-scope-store.ts - unified override layer for an asset's "configurable scope" (local localStorage).
 *
 * Extracted from the original demoStore.ts (separate responsibility: unrelated to how team/agent/task
 * entities are persisted; it is a generic product-semantics layer on top of the 5 asset types).
 *
 * Requirement: each owner can manage "their own assets" and choose whether the asset is
 *   - team    configurable within the team: all team members can configure / edit this asset
 *   - private private to oneself: only the owner (+ team admin / global admin) can configure / edit
 *
 * This layer covers all 5 asset types (agent / skill / code / wiki / memory). The underlying data sources
 * of the assets differ (backendStore / mock / backend knowledgeApi), but the "configurable scope"
 * is a unified product semantic, so a lightweight override layer is extracted separately: one record is stored per `${kind}:${asset_id}`,
 * decoupled from the asset itself. Once the backend is live it becomes an asset_acl table, with no UI changes.
 */

import type { Team } from './backendStore';
import { isTeamAdmin, isTeamMember } from './backendStore';
import { emitChange, safeParse, useChangeNotifier } from './storage-utils';

const ASSET_SCOPES_KEY = 'wamf-memory.assetScopes.v1';

export type AssetKind = 'agent' | 'skill' | 'code' | 'wiki' | 'memory';
export type AssetConfigScope = 'team' | 'private';

export interface AssetScopeRecord {
  scope: AssetConfigScope;
  /** The asset's owner - who may change its configurable scope. For unowned assets, the first person to set it becomes the owner. */
  owner_user_id: string;
  updated_at_ms: number;
}

type AssetScopeMap = Record<string, AssetScopeRecord>;

function scopeKey(kind: AssetKind, asset_id: string): string {
  return `${kind}:${asset_id}`;
}

function readAssetScopeMap(): AssetScopeMap {
  if (typeof window === 'undefined') return {};
  return safeParse<AssetScopeMap>(localStorage.getItem(ASSET_SCOPES_KEY), {});
}

function writeAssetScopeMap(map: AssetScopeMap): void {
  try {
    localStorage.setItem(ASSET_SCOPES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  emitChange();
}

/**
 * Read the configurable scope of an asset.
 * Assets never explicitly set default to `team` (configurable within the team) - consistent with the current behavior (shared team pool),
 * and the owner falls back to the asset's own owner (fallbackOwner).
 */
export function getAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  fallbackOwner = ''
): { scope: AssetConfigScope; owner_user_id: string } {
  const rec = readAssetScopeMap()[scopeKey(kind, asset_id)];
  if (rec) return { scope: rec.scope, owner_user_id: rec.owner_user_id || fallbackOwner };
  return { scope: 'team', owner_user_id: fallbackOwner };
}

/**
 * Set the configurable scope of an asset.
 * Once determined, the owner is fixed (existing record -> asset's own owner -> current operator).
 * Callers should first use canManageAssetScope to block in the UI; authorization is not repeated here (demo stage).
 */
export function setAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  scope: AssetConfigScope,
  actor: string,
  fallbackOwner = ''
): void {
  const map = readAssetScopeMap();
  const key = scopeKey(kind, asset_id);
  const owner = map[key]?.owner_user_id || fallbackOwner || actor;
  map[key] = { scope, owner_user_id: owner, updated_at_ms: Date.now() };
  writeAssetScopeMap(map);
}

/**
 * Who can change an asset's configurable scope:
 *   - global admin / team admin -> allowed (needed for governance)
 *   - the owner -> allowed ("manage one's own assets")
 *   - unowned asset (ownerUserId empty, e.g. backend Code/Wiki have no owner concept)
 *     -> any team member may set it, and the first to set it becomes the owner
 */
export function canManageAssetScope(
  ownerUserId: string,
  team: Team | null | undefined,
  user_id: string,
  isAdmin?: boolean
): boolean {
  if (!user_id) return false;
  // A global admin no longer automatically gets asset management privileges, same as a regular member:
  // only the owner or a team admin can change an asset's configurable scope.
  // The isAdmin parameter is kept only for compatibility with existing caller signatures (can be removed in a future cleanup).
  void isAdmin;
  if (team && isTeamAdmin(team, user_id)) return true;
  if (!ownerUserId) return isTeamMember(team, user_id);
  return ownerUserId === user_id;
}

/**
 * Subscribe to changes of the asset configurable-scope override layer.
 * Components use it to re-render automatically after setAssetConfigScope (the return value is an incrementing tick, used only to trigger a refresh).
 */
export function useAssetConfigScopes(): number {
  return useChangeNotifier();
}
