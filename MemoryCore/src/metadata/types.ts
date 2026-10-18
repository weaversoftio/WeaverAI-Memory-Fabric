/**
 * Metadata module — Entity types & shared contracts.
 *
 * Corresponds to design doc 08-metadata-migration-and-permission-design.md sections 2 / 6.
 *
 * This is the metadata entity type definitions migrated from team-memory-control into the memory kernel.
 * Unlike the simplified entity_* types already in core/store, this is the complete business model
 * (including user_key / password / visibility / acl, etc.).
 */

// ============================
// Enums and literal types
// ============================

export type UserStatus = "active" | "inactive" | "invited";
export type UserType = "normal" | "system_admin";
export type TeamStatus = "active" | "archived";
export type TeamRole = "admin" | "member" | "reviewer";
export type MemberStatus = "active" | "removed";
export type AgentStatus = "active" | "inactive";
export type TaskStatus = "running" | "completed";
export type TaskSourceType = "manual" | "tapd" | "github" | "other";

export type AssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type AssetVisibility = "private" | "team" | "restricted" | "agent" | "task";
export type AssetStatus =
  | "draft"
  | "candidate"
  | "approved"
  | "deprecated"
  | "archived"
  | "failed";

export type InjectionMode = "direct" | "summary" | "tool" | "reference";

/** Permission actions (6 kinds). */
export type Permission =
  | "read"
  | "write"
  | "delete"
  | "assign"
  | "share"
  | "use";

/** ACL grant subject type. */
export type AclSubjectType = "user" | "team_role" | "agent";

/** ACL effect (phase 1 only allow, deny reserved). */
export type AclEffect = "allow" | "deny";

// ============================
// Entity types
// ============================

export type UserKeyStatus = "active" | "revoked";

export interface UserEntity {
  user_id: string;
  /** Password hashed with scrypt+pepper (`$scrypt$...`), nullable. */
  password?: string | null;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json: string;
  status: UserStatus;
  user_type: UserType;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMemberEntity {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  status: MemberStatus;
}

/** team-member/list · get response: membership + username JOINed at read time (not persisted). */
export interface TeamMemberView extends TeamMemberEntity {
  username: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility: AssetVisibility;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type: TaskSourceType;
  source_url?: string | null;
  status: TaskStatus;
  auto_assign_floating_assets: boolean;
  risk_level?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskAgentEntity {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string | null;
  status: MemberStatus;
  created_at: string;
}

/** Task/Agent participation event log (append-only). */
export interface ParticipationLogEntity {
  id: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppendParticipationLogInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  created_at?: string;
  source?: string;
  metadata_json?: string;
}

export interface ParticipationLogFilter {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
  /** Whether to dedupe by user_id; default false. */
  dedupe?: boolean;
}

export interface AssetEntity {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  version: number;
  visibility: AssetVisibility;
  status: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  usage_count: number;
  content_ref?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface FixedAssetBindingEntity {
  id: string;
  agent_id: string;
  asset_id: string;
  asset_type: AssetType;
  injection_mode: InjectionMode;
  priority: number;
  created_by: string;
  created_at: string;
}

/** Fixed-asset binding count aggregated by asset_type (distinct asset_id). */
export interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

/** Fixed-asset allocation summary of a single agent. */
export interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  /** Total number of binding rows matched by this agent (not deduplicated). */
  total: number;
}

/** summary-by-agents response. */
export interface AgentFixedAssetSummaryResult {
  items: AgentFixedAssetSummary[];
  total: number;
}

/** Store/Service: group-count fixed-asset bindings by multiple agents. */
export interface SummarizeAgentFixedAssetsParams {
  agent_ids: string[];
  /** Optional: only count rows bound to this asset; used for bound_agent_count. */
  asset_id?: string;
}

/** Raw aggregate rows at the Store layer (not zero-filled). */
export interface AgentFixedAssetCountRow {
  agent_id: string;
  asset_type: AssetType;
  cnt: number;
}

/** User API key row (storage layer, containing the full key_value). */
export interface UserKeyEntity {
  key_id: string;
  user_id: string;
  key_value: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  metadata_json: string;
}

/** API redacted structure (list / get). */
export interface UserKeyPublic {
  key_id: string;
  user_id: string;
  key_prefix: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** create response: the full key_value is returned only this once. */
export interface UserKeyCreated extends UserKeyPublic {
  key_value: string;
}

export interface AclEntity {
  id: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect: AclEffect;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Cross-team agent share: grants members of `target_team_id` the right to
 * list/use an agent that still lives in its home `team_id`.
 */
export interface AgentShareEntity {
  id: string;
  agent_id: string;
  /** Home team of the agent at grant time (denormalized for listing/revoke UX). */
  home_team_id: string;
  target_team_id: string;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

// ============================
// Input types (create/update)
// ============================

export interface UserPublic {
  user_id: string;
  user_type: UserType;
  username: string;
  created_at: string;
}

/** Optional filters for public user/list (internal list-by-instance additionally has status / user_type). */
export interface UserListFilter {
  user_ids?: string[];
  /** Exact username match (for duplicate checks, etc.). */
  username?: string;
}

/** user/create response: does not contain username (see 08 section CreateUserResult). */
export interface CreateUserApiResult {
  user_id: string;
  user_type: UserType;
  created_at: string;
  default_user_key: string;
}

export interface InitAdminInput {
  username: string;
  user_key?: string;
}

export interface InitAdminResult {
  user_id: string;
  user_key: string;
}

export interface CreateUserInput {
  user_id?: string;
  /** Internal: init-admin may specify the default user_key. */
  default_key_value?: string;
  /** Storage-layer default `local` (not exposed by the API). */
  auth_provider?: string;
  /** Storage-layer default `user_id` (not exposed by the API). */
  external_id?: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json?: string;
  status?: UserStatus;
  metadata_json?: string;
  /** Internal to the storage layer only; API create is fixed to normal, init-admin is fixed to system_admin. */
  user_type?: UserType;
  /** v3.1: always NULL for new users; written only by the store layer. */
  password?: string | null;
}

export interface CreateUserKeyInput {
  user_id: string;
  key_value?: string;
  name?: string | null;
  expires_at?: string | null;
  is_default?: boolean;
  metadata_json?: string;
}

export interface CreateTeamInput {
  team_id?: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: TeamStatus;
  metadata_json?: string;
}

export interface AddTeamMemberInput {
  id?: string;
  team_id: string;
  user_id: string;
  role?: TeamRole;
  status?: MemberStatus;
}

export interface CreateAgentInput {
  agent_id?: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: AssetVisibility;
  status?: AgentStatus;
  metadata_json?: string;
}

export interface CreateTaskInput {
  task_id?: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type?: TaskSourceType;
  source_url?: string | null;
  status?: TaskStatus;
  auto_assign_floating_assets?: boolean;
  risk_level?: string | null;
  metadata_json?: string;
  /** Agents that can be linked at the same time when creating a task. */
  linked_agents?: Array<{ agent_id: string; role_in_task?: string }>;
}

export interface CreateAssetInput {
  /** Provided by the caller (the external asset system); the metadata module only records and authorizes, and does not generate asset_id. */
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  visibility?: AssetVisibility;
  status?: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  content_ref?: string | null;
  metadata_json?: string;
}

export interface FixedAssetBindingInput {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: InjectionMode;
  priority?: number;
  created_by: string;
}

export interface GrantAclInput {
  id?: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect?: AclEffect;
  granted_by: string;
}

export interface GrantAgentShareInput {
  id?: string;
  agent_id: string;
  target_team_id: string;
  granted_by: string;
}

// ============================
// Filter types
// ============================

export interface AgentFilter {
  status?: AgentStatus;
  /**
   * Combined filter: when used together with team_id it means "agents in the team owned by a given user".
   * When owner_user_id is used alone, listAgentsByOwner is used and this field is not needed.
   */
  owner_user_id?: string;
  /** Exact agent name match (for duplicate checks, etc.). */
  name?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  creator_user_id?: string;
  /** Exact task title match (for duplicate checks, etc.). */
  title?: string;
}

/** Optional filter for team/list (for duplicate checks, etc.). */
export interface TeamFilter {
  /** Exact team name match. */
  name?: string;
}

export interface AssetFilter {
  asset_type?: AssetType;
  status?: AssetStatus;
  owner_user_id?: string;
  visibility?: AssetVisibility;
}

// ============================
// Common result types
// ============================

/** Pagination input of list APIs (optional; when not passed the server defaults to limit=20, offset=0). */
export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Resolved pagination parameters (limit/offset both have definite values). */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/** Pagination response envelope of list APIs. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Store-layer list query result (internal pagination slice + total). */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** Optional filters for internal list-by-instance (extends UserListFilter). */
export interface InstanceUserListFilter extends UserListFilter {
  status?: UserStatus;
  user_type?: UserType;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

// ============================
// ConfigParam types
// ============================

export type ConfigParamScope = "global" | "user";

export interface ConfigParamEntity {
  id: number;
  scope: ConfigParamScope;
  user_id: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertConfigParamInput {
  scope: ConfigParamScope;
  user_id?: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
}

export interface ListConfigParamsFilter {
  scope?: ConfigParamScope;
  module: string;
  userId?: string;
  paramNames?: string[];
}

// ============================
// InstanceUpstreamConfig types
// ============================

/** Config type: conversation (user conversation model) or extraction (memory/Skill extraction model). */
export type UpstreamConfigType = "conversation" | "extraction";

/** Forwarding mode: official (official main model), custom_unified (custom + unified key), custom_passthrough (custom + user-supplied key). */
export type UpstreamConfigMode = "official" | "custom_unified" | "custom_passthrough";

/** Instance upstream config row (storage-layer entity). */
export interface InstanceUpstreamConfigEntity {
  id: number;
  /** Agent identifier. Fixed to "default" at the current stage, reserving per-agent extension. */
  agent_source: string;
  /** Config type. */
  type: UpstreamConfigType;
  /** Forwarding mode. extraction does not support custom_passthrough. */
  mode: UpstreamConfigMode;
  /** Custom LLM upstream URL. Empty string in official mode. */
  base_url: string;
  /** API Key (stored in plaintext). Only meaningful in custom_unified mode. */
  api_key: string;
  /** Optional: force-override the model_id in the request; empty string = pass through. */
  model_id: string;
  /** Admin remarks. */
  description: string;
  created_at: string;
  updated_at: string;
}

/** Write/update input. */
export interface UpsertInstanceUpstreamConfigInput {
  agent_source?: string;
  type?: UpstreamConfigType;
  mode: UpstreamConfigMode;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

/** Query filter. */
export interface InstanceUpstreamConfigFilter {
  agent_source?: string;
  type?: UpstreamConfigType;
}
