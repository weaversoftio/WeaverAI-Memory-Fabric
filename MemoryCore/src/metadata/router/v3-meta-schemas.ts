/**
 * v3 metadata API request body Zod schemas (55 public APIs).
 *
 * Corresponds to design doc section 7.1. Each schema validates the request body of the corresponding route;
 * the route handler validates with `schema.safeParse(body)` before calling MetadataService.
 */
import { z } from "zod";
import { paginationInputSchema } from "./pagination.js";

// -- Enums --
const assetType = z.enum(["skill", "llm_wiki", "code_graph", "chat_memory"]);
const visibility = z.enum(["private", "team", "restricted", "agent", "task"]);
const assetStatus = z.enum(["draft", "candidate", "approved", "deprecated", "archived", "failed"]);
const injectionMode = z.enum(["direct", "summary", "tool", "reference"]);
const permission = z.enum(["read", "write", "delete", "assign", "share", "use"]);
const teamRole = z.enum(["admin", "member", "reviewer"]);
const aclSubjectType = z.enum(["user", "team_role", "agent"]);
const aclEffect = z.enum(["allow", "deny"]);
const userStatus = z.enum(["active", "inactive", "invited"]);
const teamStatus = z.enum(["active", "archived"]);
const memberStatus = z.enum(["active", "removed"]);
const agentStatus = z.enum(["active", "inactive"]);
const taskStatus = z.enum(["running", "completed"]);
const taskSourceType = z.enum(["manual", "tapd", "github", "other"]);

const nonEmpty = z.string().min(1);
const idList = z.array(nonEmpty).min(1);

/** Either user_id or user_key (compatible with old callers passing only user_id). */
const userIdOrKeyFields = z.object({
  user_id: z.string().min(1).optional(),
  user_key: z.string().min(1).optional(),
});
const requireUserIdOrKey = (v: { user_id?: string; user_key?: string }) => !!v.user_id || !!v.user_key;
const userIdOrKeyRefine = { message: "user_id or user_key is required" } as const;

export const userIdOrKeySchema = userIdOrKeyFields.refine(requireUserIdOrKey, userIdOrKeyRefine);

// -- User (v3.1) --
/**
 * External-auth association identifier: the user's unique id under the external IdP (e.g. the Enterprise SSO employee-ID system).
 * Directly reuses the existing meta_users.external_id field in core (introduced by origin, originally for Taihu OAuth2
 * sub / employee ID), without creating a new association table.
 */
const externalIdField = z.string().min(1);

/** Look up a user by external-auth identifier: after external-auth login, determine whether it is the first time (no binding = first time). */
export const userFindByExternalSchema = z.object({
  external_id: externalIdField,
  auth_provider: z.string().min(1).optional(),
});

/** Bind an external-auth identifier to an existing account (existing accounts onboarding to external auth). */
export const userBindExternalSchema = z.object({
  user_id: z.string().min(1),
  external_id: externalIdField,
  auth_provider: z.string().min(1).optional(),
  // Optional: display name on the IdP side. Only written when the target account's display_name is empty,
  // and does not overwrite an existing name.
  display_name: z.string().min(1).optional(),
});

export const userCreateSchema = z.object({
  username: nonEmpty,
  // Optional: when the admin/internal side creates a "service account", specify a deterministic user_id (e.g. knowledge-service),
  // so the proxy systemUsers allowlist can hit by a stable user_id; when not passed the kernel randomly generates usr-xxx.
  // Only system_admin may call this API (see assertCanManageUsers in v3-meta-router).
  user_id: z.string().min(1).optional(),
  // Optional: unique identifier (employee ID) in the external-auth system (e.g. Enterprise SSO). Must be passed when creating an account via external auth,
  // otherwise the next login cannot find the account by this id, and will be misjudged as a "first login".
  external_id: z.string().min(1).optional(),
  // Optional: external-auth system identifier (e.g. sso). When omitted it falls back to local, and together with external_id
  // forms the (auth_provider, external_id) lookup domain -- when passing external_id it **must** be passed as well,
  // otherwise binding and reverse lookup land in different domains (written to local, queried in sso) and are invisible to each other.
  auth_provider: z.string().min(1).optional(),
  // Optional: display name from the IdP. Lists / member displays prefer it, falling back to username when absent.
  display_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

// Sibling API of /v3/meta/user/create: allows system_admin to explicitly specify user_key when creating an account.
// user_id is not accepted as input (zod strips by default) and is returned after the kernel generates it; the format of user_key is the caller's responsibility,
// the kernel only checks non-empty + the DB-level UNIQUE fallback (duplicates throw duplicate_user_key).
export const userCreateWithKeySchema = z.object({
  username: nonEmpty,
  user_key: nonEmpty,
  // Optional: unique identifier (employee ID) in the external-auth system (e.g. Enterprise SSO), same semantics as userCreateSchema.external_id.
  external_id: z.string().min(1).optional(),
  // Optional: external-auth system identifier (e.g. sso) / display name / email, same semantics as the same-named optional fields of userCreateSchema.
  auth_provider: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});
export const initAdminSchema = z.object({
  username: nonEmpty,
  user_key: z.string().min(1).optional(),
});
export const userGetSchema = userIdOrKeySchema;
export const userDeleteSchema = z.object({ user_ids: idList });
export const userListSchema = z
  .object({
    team_id: nonEmpty.optional(),
    user_ids: z.array(nonEmpty).max(100).optional(),
    username: z.string().min(1).optional(),
  })
  .merge(paginationInputSchema);

export const userKeyCreateSchema = z.object({
  user_id: z.string().min(1).optional(),
  name: z.string().min(1).max(128).optional(),
  expires_at: z.string().datetime().optional(),
});
export const userKeyListSchema = z.object({
  user_id: z.string().min(1).optional(),
}).merge(paginationInputSchema);
export const userKeyGetSchema = z.object({ key_id: nonEmpty });
export const userKeyRevokeSchema = z.object({ key_id: nonEmpty });
export const userKeyUpdateSchema = z.object({
  key_id: nonEmpty,
  name: z.string().min(1).max(128).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

// ── Team ──
export const teamCreateSchema = z.object({
  name: nonEmpty,
  owner_user_id: nonEmpty,
  description: z.string().optional(),
  status: teamStatus.optional(),
  metadata_json: z.string().optional(),
});
export const teamGetSchema = z.object({ team_id: nonEmpty });
export const teamUpdateSchema = z.object({
  team_id: nonEmpty,
  name: z.string().optional(),
  description: z.string().optional(),
  // owner_user_id cannot be changed: if passed, it is silently ignored via zod's default strip
  status: teamStatus.optional(),
  metadata_json: z.string().optional(),
});
export const teamDeleteSchema = z.object({ team_ids: idList });
export const teamListSchema = userIdOrKeyFields
  .merge(z.object({ name: z.string().min(1).optional() }))
  .merge(paginationInputSchema)
  .refine(requireUserIdOrKey, userIdOrKeyRefine);

// ── TeamMember ──
export const teamMemberAddSchema = z.object({
  team_id: nonEmpty,
  user_id: nonEmpty,
  role: teamRole.optional(),
  status: memberStatus.optional(),
});
export const teamMemberRemoveSchema = z.object({ team_id: nonEmpty, user_id: nonEmpty });
export const teamMemberListSchema = z.object({ team_id: nonEmpty }).merge(paginationInputSchema);
export const teamMemberGetSchema = z.object({ team_id: nonEmpty, user_id: nonEmpty });

// ── Agent ──
export const agentCreateSchema = z.object({
  team_id: nonEmpty,
  owner_user_id: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  prompt: z.string().optional(),
  visibility: visibility.optional(),
  status: agentStatus.optional(),
  metadata_json: z.string().optional(),
});
export const agentGetSchema = z.object({ agent_id: nonEmpty });
export const agentUpdateSchema = z.object({
  agent_id: nonEmpty,
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  visibility: visibility.optional(),
  status: agentStatus.optional(),
  // owner_user_id cannot be changed: if passed, it is silently ignored via zod's default strip
  metadata_json: z.string().optional(),
});
export const agentDeleteSchema = z.object({ agent_ids: idList });
const agentListFields = z.object({
  team_id: z.string().optional(),
  owner_user_id: z.string().optional(),
  owner_user_key: z.string().optional(),
  status: agentStatus.optional(),
  name: z.string().min(1).optional(),
  /**
   * When listing by team_id, also include agents shared to this team from other teams.
   * Default true so the panel shows cross-team shared agents without an extra flag.
   * Ignored when listing by owner only.
   */
  include_shared: z.boolean().optional(),
});
const requireAgentListFilter = (v: {
  team_id?: string;
  owner_user_id?: string;
  owner_user_key?: string;
}) => !!v.team_id || !!v.owner_user_id || !!v.owner_user_key;

export const agentListSchema = agentListFields
  .merge(paginationInputSchema)
  .refine(requireAgentListFilter, {
    message: "either team_id, owner_user_id, or owner_user_key is required",
  });
export const agentArchiveSchema = z.object({ agent_id: nonEmpty });

// ── AgentShare (cross-team) ──
export const agentShareGrantSchema = z
  .object({
    agent_id: nonEmpty,
    target_team_id: nonEmpty,
    granted_by: nonEmpty.optional(),
    granted_by_key: z.string().min(1).optional(),
  })
  .refine((v) => !!v.granted_by || !!v.granted_by_key, {
    message: "granted_by or granted_by_key is required",
  });
export const agentShareRevokeSchema = z.object({ id: nonEmpty });
export const agentShareListSchema = z
  .object({
    agent_id: nonEmpty.optional(),
    team_id: nonEmpty.optional(),
  })
  .merge(paginationInputSchema)
  .refine((v) => !!v.agent_id || !!v.team_id, {
    message: "agent_id or team_id required",
  });

// ── Task ──
const linkedAgent = z.object({ agent_id: nonEmpty, role_in_task: z.string().optional() });
export const taskCreateSchema = z.object({
  team_id: nonEmpty,
  creator_user_id: nonEmpty,
  title: nonEmpty,
  description: z.string().optional(),
  source_type: taskSourceType.optional(),
  source_url: z.string().optional(),
  status: taskStatus.optional(),
  auto_assign_floating_assets: z.boolean().optional(),
  risk_level: z.string().optional(),
  metadata_json: z.string().optional(),
  linked_agents: z.array(linkedAgent).optional(),
});
export const taskGetSchema = z.object({ task_id: nonEmpty });
export const taskUpdateSchema = z.object({
  task_id: nonEmpty,
  title: z.string().optional(),
  description: z.string().optional(),
  source_type: taskSourceType.optional(),
  source_url: z.string().optional(),
  status: taskStatus.optional(),
  auto_assign_floating_assets: z.boolean().optional(),
  risk_level: z.string().optional(),
  metadata_json: z.string().optional(),
});
export const taskDeleteSchema = z.object({ task_ids: idList });
const taskListFields = z.object({
  team_id: nonEmpty.optional(),
  creator_user_id: nonEmpty.optional(),
  creator_user_key: z.string().min(1).optional(),
  status: taskStatus.optional(),
  title: z.string().min(1).optional(),
});
const requireTaskListFilter = (d: {
  team_id?: string;
  creator_user_id?: string;
  creator_user_key?: string;
}) => !!(d.team_id || d.creator_user_id || d.creator_user_key);

export const taskListSchema = taskListFields
  .merge(paginationInputSchema)
  .refine(requireTaskListFilter, {
    message: "team_id, creator_user_id, or creator_user_key required",
  });
export const taskArchiveSchema = z.object({ task_id: nonEmpty });

// ── TaskAgent ──
export const taskAgentLinkSchema = z.object({
  task_id: nonEmpty,
  agent_id: nonEmpty,
  role_in_task: z.string().optional(),
});
export const taskAgentUnlinkSchema = z.object({ task_id: nonEmpty, agent_id: nonEmpty });
export const taskAgentListSchema = z.object({ task_id: nonEmpty }).merge(paginationInputSchema);

// ── ParticipationLog ──
export const participationLogAppendSchema = z.object({
  team_id: nonEmpty,
  task_id: nonEmpty,
  agent_id: nonEmpty,
  user_id: nonEmpty,
  created_at: z.string().datetime().optional(),
  source: z.string().optional(),
  metadata_json: z.string().optional(),
});
export const participationLogListSchema = z.object({
  team_id: nonEmpty,
  task_id: nonEmpty.optional(),
  agent_id: nonEmpty.optional(),
  user_id: nonEmpty.optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  dedupe: z.boolean().optional(),
}).merge(paginationInputSchema);

// ── Asset ──
export const assetCreateSchema = z.object({
  asset_id: nonEmpty,
  team_id: nonEmpty,
  asset_type: assetType,
  name: nonEmpty,
  owner_user_id: nonEmpty,
  source_type: nonEmpty,
  description: z.string().optional(),
  source_ref: z.string().optional(),
  visibility: visibility.optional(),
  status: assetStatus.optional(),
  confidence: z.number().optional(),
  expires_at: z.string().optional(),
  content_ref: z.string().optional(),
  metadata_json: z.string().optional(),
});
export const assetGetSchema = z.object({ asset_id: nonEmpty });
export const assetUpdateSchema = z.object({
  asset_id: nonEmpty,
  name: z.string().optional(),
  description: z.string().optional(),
  visibility: visibility.optional(),
  status: assetStatus.optional(),
  confidence: z.number().optional(),
  expires_at: z.string().optional(),
  content_ref: z.string().optional(),
  version: z.number().int().optional(),
  source_ref: z.string().optional(),
  metadata_json: z.string().optional(),
});
export const assetDeleteSchema = z.object({ asset_ids: idList });
export const assetListSchema = z.object({
  team_id: nonEmpty,
  asset_type: assetType.optional(),
  status: assetStatus.optional(),
  owner_user_id: z.string().optional(),
  visibility: visibility.optional(),
}).merge(paginationInputSchema);
export const assetTouchUsageSchema = z.object({ asset_id: nonEmpty });

// ── AgentFixedAsset ──
const fixedBinding = z.object({
  asset_id: nonEmpty,
  asset_type: assetType,
  injection_mode: injectionMode.optional(),
  priority: z.number().int().optional(),
  created_by: nonEmpty,
});
export const fixedAssetSetSchema = z.object({
  agent_id: nonEmpty,
  bindings: z.array(fixedBinding),
});
export const fixedAssetListSchema = z.object({ agent_id: nonEmpty }).merge(paginationInputSchema);
export const fixedAssetListWithDetailSchema = z.object({
  agent_id: nonEmpty,
  apply_visibility_filter: z.boolean().optional(),
  touch_usage: z.boolean().optional(),
  /**
   * Optional type filter: only return bindings whose asset_type is in this list.
   * Passing an empty array or omitting = no filtering (return all types).
   * For callers that explicitly need only certain asset types (e.g. proxy knowledge-tools-injector
   * only needs llm_wiki + code_graph), avoiding truncation of types outside the mixed-list pagination.
   */
  asset_types: z.array(assetType).optional(),
}).merge(paginationInputSchema);

/** agent_ids deduplicated; 1-100. */
const agentIdsList = z
  .array(nonEmpty)
  .min(1)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

export const fixedAssetSummaryByAgentsSchema = z.object({
  agent_ids: agentIdsList,
  asset_id: nonEmpty.optional(),
});

// ── ACL ──
export const aclGrantSchema = z
  .object({
    asset_id: nonEmpty,
    subject_type: aclSubjectType,
    subject_id: nonEmpty,
    permission,
    effect: aclEffect.optional(),
    granted_by: nonEmpty.optional(),
    granted_by_key: z.string().min(1).optional(),
  })
  .refine((v) => !!v.granted_by || !!v.granted_by_key, {
    message: "granted_by or granted_by_key is required",
  });
export const aclRevokeSchema = z.object({ id: nonEmpty });
export const aclListSchema = z.object({ asset_id: nonEmpty }).merge(paginationInputSchema);
export const aclCheckSchema = userIdOrKeyFields
  .extend({
    asset_id: nonEmpty,
    action: permission,
    agent_id: z.string().optional(),
  })
  .refine(requireUserIdOrKey, userIdOrKeyRefine);

// ── Auth ──
export const authVerifySchema = z.object({ user_key: nonEmpty });

export const assetListAccessibleSchema = userIdOrKeyFields
  .extend({
    team_id: z.string().optional(),
    action: permission.optional(),
    asset_type: assetType.optional(),
    agent_id: z.string().optional(),
    // Optional server-side visibility filter:
    //   - single value: `visibility: "team"` -> only return team-visible items (used by the control page's "team assets" tab)
    //   - array: `visibility: ["team", "restricted"]` -> allowlist style
    //   - not passed: no visibility filtering (return everything accessible, including one's own private)
    // Key purpose: keep the frontend "team assets" tab from receiving one's own private data at the HTTP layer,
    // avoiding the information-leak risk of "the response body carries everything and frontend JS filters".
    visibility: z.union([visibility, z.array(visibility).min(1).max(5)]).optional(),
  })
  .merge(paginationInputSchema)
  .refine(requireUserIdOrKey, userIdOrKeyRefine);

/** internal list-by-instance: user_ids deduplicated; not passed or an empty array -> undefined (no filtering). */
const optionalUserIdsFilter = z
  .array(nonEmpty)
  .max(100)
  .optional()
  .transform((ids) => {
    if (!ids?.length) return undefined;
    return [...new Set(ids)];
  });

/** internal: instance user list (not written into the public API docs). */
export const internalListUsersByInstanceSchema = z.object({
  instance_id: z.string().min(1).optional(),
  status: userStatus.optional(),
  user_type: z.enum(["normal", "system_admin"]).optional(),
  user_ids: optionalUserIdsFilter,
}).merge(paginationInputSchema);

/** Route -> schema mapping (55 public APIs). */
// -- ConfigParam (v3.2) --
export const instanceQuotaGetSchema = z.object({});

export const configUserGetSchema = z.object({
  user_id: nonEmpty,
  module: nonEmpty,
  param_name: z.string().min(1).optional(),
});

export const configUserSetSchema = z.object({
  user_id: nonEmpty,
  module: nonEmpty,
  params: z.record(z.string().min(1), z.string()),
});

// ── InstanceUpstreamConfig ──
const upstreamConfigType = z.enum(["conversation", "extraction"]);
const upstreamConfigMode = z.enum(["official", "custom_unified", "custom_passthrough"]);

export const instanceUpstreamSetSchema = z.object({
  agent_source: z.string().min(1).default("default"),
  type: upstreamConfigType.default("conversation"),
  mode: upstreamConfigMode,
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  model_id: z.string().optional(),
  description: z.string().optional(),
});

export const instanceUpstreamGetSchema = z.object({
  agent_source: z.string().min(1).default("default"),
  type: upstreamConfigType.default("conversation"),
});

export const instanceUpstreamListSchema = z.object({
  agent_source: z.string().min(1).optional(),
  type: upstreamConfigType.optional(),
});

export const instanceUpstreamResetSchema = z.object({
  agent_source: z.string().min(1).default("default"),
  type: upstreamConfigType.default("conversation"),
});

export const V3_SCHEMAS = {
  "/v3/meta/user/create": userCreateSchema,
  "/v3/meta/user/create-with-key": userCreateWithKeySchema,
  "/v3/meta/user/get": userGetSchema,
  "/v3/meta/user/delete": userDeleteSchema,
  "/v3/meta/user/list": userListSchema,
  "/v3/meta/user-key/create": userKeyCreateSchema,
  "/v3/meta/user-key/list": userKeyListSchema,
  "/v3/meta/user-key/get": userKeyGetSchema,
  "/v3/meta/user-key/revoke": userKeyRevokeSchema,
  "/v3/meta/user-key/update": userKeyUpdateSchema,
  "/v3/meta/team/create": teamCreateSchema,
  "/v3/meta/team/get": teamGetSchema,
  "/v3/meta/team/update": teamUpdateSchema,
  "/v3/meta/team/delete": teamDeleteSchema,
  "/v3/meta/team/list": teamListSchema,
  "/v3/meta/team-member/add": teamMemberAddSchema,
  "/v3/meta/team-member/remove": teamMemberRemoveSchema,
  "/v3/meta/team-member/list": teamMemberListSchema,
  "/v3/meta/team-member/get": teamMemberGetSchema,
  "/v3/meta/agent/create": agentCreateSchema,
  "/v3/meta/agent/get": agentGetSchema,
  "/v3/meta/agent/update": agentUpdateSchema,
  "/v3/meta/agent/delete": agentDeleteSchema,
  "/v3/meta/agent/list": agentListSchema,
  "/v3/meta/agent/archive": agentArchiveSchema,
  "/v3/meta/agent-share/grant": agentShareGrantSchema,
  "/v3/meta/agent-share/revoke": agentShareRevokeSchema,
  "/v3/meta/agent-share/list": agentShareListSchema,
  "/v3/meta/task/create": taskCreateSchema,
  "/v3/meta/task/get": taskGetSchema,
  "/v3/meta/task/update": taskUpdateSchema,
  "/v3/meta/task/delete": taskDeleteSchema,
  "/v3/meta/task/list": taskListSchema,
  "/v3/meta/task/archive": taskArchiveSchema,
  "/v3/meta/task-agent/link": taskAgentLinkSchema,
  "/v3/meta/task-agent/unlink": taskAgentUnlinkSchema,
  "/v3/meta/task-agent/list": taskAgentListSchema,
  "/v3/meta/participation-log/append": participationLogAppendSchema,
  "/v3/meta/participation-log/list": participationLogListSchema,
  "/v3/meta/asset/create": assetCreateSchema,
  "/v3/meta/asset/get": assetGetSchema,
  "/v3/meta/asset/update": assetUpdateSchema,
  "/v3/meta/asset/delete": assetDeleteSchema,
  "/v3/meta/asset/list": assetListSchema,
  "/v3/meta/asset/list-accessible": assetListAccessibleSchema,
  "/v3/meta/asset/touch-usage": assetTouchUsageSchema,
  "/v3/meta/agent-fixed-asset/set": fixedAssetSetSchema,
  "/v3/meta/agent-fixed-asset/list": fixedAssetListSchema,
  "/v3/meta/agent-fixed-asset/list-with-detail": fixedAssetListWithDetailSchema,
  "/v3/meta/agent-fixed-asset/summary-by-agents": fixedAssetSummaryByAgentsSchema,
  "/v3/meta/acl/grant": aclGrantSchema,
  "/v3/meta/acl/revoke": aclRevokeSchema,
  "/v3/meta/acl/list": aclListSchema,
  "/v3/meta/acl/check": aclCheckSchema,
  "/v3/meta/auth/verify": authVerifySchema,
  "/v3/meta/instance-quota/get": instanceQuotaGetSchema,
  "/v3/meta/config/user/get": configUserGetSchema,
  "/v3/meta/config/user/set": configUserSetSchema,
  "/v3/meta/instance-upstream/set": instanceUpstreamSetSchema,
  "/v3/meta/instance-upstream/get": instanceUpstreamGetSchema,
  "/v3/meta/instance-upstream/list": instanceUpstreamListSchema,
  "/v3/meta/instance-upstream/reset": instanceUpstreamResetSchema,
} as const;

export type V3Route = keyof typeof V3_SCHEMAS;
