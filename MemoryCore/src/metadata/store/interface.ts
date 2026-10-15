/**
 * IMetadataStore -- metadata storage abstraction interface.
 *
 * Corresponds to design doc section 6.1. All backend implementations (SQLite / MongoDB / MySQL reserved) must satisfy this contract,
 * which is verified uniformly by the shared test suite in metadata-store.contract.ts, guaranteeing consistent backend behavior.
 *
 * Conventions:
 *   - All methods may be sync or async; callers always await.
 *   - Composite writes (createTeam + automatic admin, createTask + linkAgents, full replacement of setAgentFixedAssets)
 *     must guarantee atomicity internally (SQLite serial transactions / MongoDB withTransaction).
 *   - get* returns null when not found; delete* returns BatchDeleteResult.
 */

import type {
  UserEntity,
  UserKeyEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AgentFixedAssetCountRow,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  TeamFilter,
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  TeamRole,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
  InstanceUpstreamConfigEntity,
  UpsertInstanceUpstreamConfigInput,
  InstanceUpstreamConfigFilter,
  UpstreamConfigType,
} from "../types.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * When the caller specifies default_key_value / key_value, it hits the meta_user_keys.key_value UNIQUE constraint.
 * The Service layer catches it and translates it into MetadataError("duplicate_user_key"); the HTTP layer maps it to 409.
 * The Store layer throws this error directly, independent of the business-layer MetadataError (avoiding the storage layer depending back on service).
 */
export class DuplicateUserKeyError extends Error {
  constructor(public readonly keyValue: string) {
    super(`user_key already exists: ${keyValue}`);
    this.name = "DuplicateUserKeyError";
  }
}

export interface IMetadataStore {
  /** Initialize storage (create tables/indexes/connections). Idempotent. */
  init(): MaybePromise<void>;
  /** Close the storage connection. */
  close(): MaybePromise<void>;

  // ── User ──
  createUser(input: CreateUserInput): MaybePromise<UserEntity>;
  getUserById(userId: string): MaybePromise<UserEntity | null>;
  getUserByKey(userKey: string): MaybePromise<UserEntity | null>;
  getUserByEmail(email: string): MaybePromise<UserEntity | null>;
  getUserByExternalId(authProvider: string, externalId: string): MaybePromise<UserEntity | null>;
  getUserByUsername(authProvider: string, username: string): MaybePromise<UserEntity | null>;
  updateUser(userId: string, patch: Partial<UserEntity>): MaybePromise<UserEntity | null>;
  deleteUsers(userIds: string[]): MaybePromise<BatchDeleteResult>;
  listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  countUsers(): MaybePromise<number>;
  countSystemAdmins(): MaybePromise<number>;
  countTeams(): MaybePromise<number>;

  // -- UserKey (multiple API keys) --
  createUserKey(input: CreateUserKeyInput): MaybePromise<UserKeyEntity>;
  getUserKeyById(keyId: string): MaybePromise<UserKeyEntity | null>;
  listUserKeys(userId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<UserKeyEntity>>;
  countActiveUserKeys(userId: string): MaybePromise<number>;
  revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): MaybePromise<UserKeyEntity | null>;
  updateUserKey(keyId: string, patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>): MaybePromise<UserKeyEntity | null>;
  touchUserKeyUsage(keyId: string): MaybePromise<void>;
  revokeAllUserKeysForUser(userId: string): MaybePromise<void>;
  getDefaultUserKey(userId: string): MaybePromise<UserKeyEntity | null>;

  // -- Team -- (createTeam automatically adds the owner as an admin member)
  createTeam(input: CreateTeamInput): MaybePromise<TeamEntity>;
  getTeamById(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam(teamId: string, patch: Partial<TeamEntity>): MaybePromise<TeamEntity | null>;
  deleteTeams(teamIds: string[]): MaybePromise<BatchDeleteResult>;
  listTeamsByUser(userId: string, pagination?: PaginationParams | null, filter?: TeamFilter): MaybePromise<ListPage<TeamEntity>>;

  // ── TeamMember ──
  addTeamMember(input: AddTeamMemberInput): MaybePromise<TeamMemberEntity>;
  removeTeamMember(teamId: string, userId: string): MaybePromise<void>;
  listTeamMembers(teamId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TeamMemberEntity>>;
  getTeamMember(teamId: string, userId: string): MaybePromise<TeamMemberEntity | null>;
  listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<TeamMemberView>>;
  getTeamMemberWithProfile(teamId: string, userId: string): MaybePromise<TeamMemberView | null>;

  // ── Agent ──
  createAgent(input: CreateAgentInput): MaybePromise<AgentEntity>;
  getAgentById(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent(agentId: string, patch: Partial<AgentEntity>): MaybePromise<AgentEntity | null>;
  deleteAgents(agentIds: string[]): MaybePromise<BatchDeleteResult>;
  listAgentsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;
  listAgentsByOwner(userId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;

  // -- Task -- (createTask can linkAgents at the same time)
  createTask(input: CreateTaskInput): MaybePromise<TaskEntity>;
  getTaskById(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask(taskId: string, patch: Partial<TaskEntity>): MaybePromise<TaskEntity | null>;
  deleteTasks(taskIds: string[]): MaybePromise<BatchDeleteResult>;
  listTasksByTeam(teamId: string, pagination?: PaginationParams | null, filter?: TaskFilter): MaybePromise<ListPage<TaskEntity>>;
  listTasks(filter: TaskFilter, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskEntity>>;

  // ── TaskAgent ──
  linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): MaybePromise<TaskAgentEntity>;
  unlinkTaskAgent(taskId: string, agentId: string): MaybePromise<void>;
  listTaskAgents(taskId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskAgentEntity>>;

  // ── ParticipationLog ──
  appendParticipationLog(input: AppendParticipationLogInput): MaybePromise<ParticipationLogEntity>;
  listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<ParticipationLogEntity>>;

  // -- Asset -- (main table only; the detail tables stay in the control panel)
  createAsset(input: CreateAssetInput): MaybePromise<AssetEntity>;
  getAssetById(assetId: string): MaybePromise<AssetEntity | null>;
  updateAsset(assetId: string, patch: Partial<AssetEntity>): MaybePromise<AssetEntity | null>;
  deleteAssets(assetIds: string[]): MaybePromise<BatchDeleteResult>;
  listAssetsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AssetFilter): MaybePromise<ListPage<AssetEntity>>;
  touchAssetUsage(assetId: string): MaybePromise<void>;

  // -- AgentFixedAsset -- (setAgentFixedAssets is a full replacement)
  setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): MaybePromise<void>;
  /**
   * Append one agent binding, **keeping** the other existing bindings of that agent; when (agent_id, asset_id)
   * already exists it is treated as a no-op (idempotent).
   *
   * Scenario: when writing memory, automatically register a chat_memory asset and bind it to the agent, which must coexist with the existing bindings of
   * skill / wiki / code_graph and other assets -- setAgentFixedAssets
   * is a full replacement that would overwrite those bindings, so an operation with append semantics is needed.
   */
  addAgentFixedAsset(agentId: string, binding: FixedAssetBindingInput): MaybePromise<void>;
  listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    /**
     * Optional filter: only return bindings whose asset type is in the list. Empty/omitted = no filtering.
     * The store internally JOINs meta_assets to filter at the SQL layer, avoiding truncation from "paginate first, filter by type later".
     */
    filter?: { assetTypes?: readonly string[] },
  ): MaybePromise<ListPage<FixedAssetBindingEntity>>;
  getAgentFixedAsset(agentId: string, assetId: string): MaybePromise<FixedAssetBindingEntity | null>;
  /**
   * Aggregate COUNT(DISTINCT asset_id) by agent_id + asset_type.
   * Does not fill in missing agents / missing types (the Service layer fills in zeros).
   */
  summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): MaybePromise<AgentFixedAssetCountRow[]>;

  // ── ACL ──
  grantAcl(input: GrantAclInput): MaybePromise<AclEntity>;
  getAclById(id: string): MaybePromise<AclEntity | null>;
  revokeAcl(id: string): MaybePromise<void>;
  listAclByAsset(assetId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;
  listAclBySubject(subjectType: string, subjectId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;

  // ── ConfigParam ──
  getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): MaybePromise<ConfigParamEntity | null>;
  upsertConfigParam(input: UpsertConfigParamInput): MaybePromise<ConfigParamEntity>;
  listConfigParams(filter: ListConfigParamsFilter): MaybePromise<ConfigParamEntity[]>;

  // ── InstanceUpstreamConfig ──
  getInstanceUpstreamConfig(
    agentSource: string,
    type: UpstreamConfigType,
  ): MaybePromise<InstanceUpstreamConfigEntity | null>;
  upsertInstanceUpstreamConfig(
    input: UpsertInstanceUpstreamConfigInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;
  listInstanceUpstreamConfigs(
    filter?: InstanceUpstreamConfigFilter,
  ): MaybePromise<InstanceUpstreamConfigEntity[]>;
  deleteInstanceUpstreamConfig(
    agentSource: string,
    type: UpstreamConfigType,
  ): MaybePromise<boolean>;
}

/** Backend type. */
export type MetadataBackend = "sqlite" | "mongodb" | "mysql";

export type { TeamRole };
