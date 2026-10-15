import type {
  AtomicDeleteData,
  AtomicDetail,
  AtomicQueryData,
  AtomicSearchData,
  AtomicUpdateData,
  ConversationAddData,
  ConversationDeleteData,
  ConversationItem,
  ConversationQueryData,
  ConversationSearchData,
  CoreFile,
  CoreWriteData,
  CountData,
  ScenarioEntry,
  ScenarioFile,
  ScenarioListData,
  ScenarioWriteData,
} from "../types.js";
import type { MemoryClientConfig, Transport } from "../client.js";

export interface V3MemoryClientConfig extends MemoryClientConfig {
  /** Team ID. Required by v3 strict isolation. */
  teamId: string;
  /** Agent ID. Required by v3 strict isolation. */
  agentId: string;
  /** User ID. Required by v3 strict isolation. */
  userId: string;
  /** Optional default session ID. L0/L1 calls may override it per request. */
  sessionId?: string;
  /** Optional task ID carried in isolation fields. */
  taskId?: string;
  /**
   * Optional user API key, passed through as the `x-wamf-user-key` header.
   *
   * The L0-L3 data plane and `clearChatMemory()` do **not** need it -- the kernel does no user-level authentication.
   * This option is kept to align with `MetadataClient`: when the gateway is fronted by a gateway/panel
   * that validates user identity, the request can carry the caller's identity.
   */
  userKey?: string;
}

export type V3MemoryClientInput = V3MemoryClientConfig | Transport;

export interface V3IsolationContext {
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id?: string;
  task_id?: string;
}

export interface V3IsolationOverrides {
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}

export interface V3ConversationAddRequest {
  session_id?: string;
  messages: ConversationItem[];
}
export type V3ConversationAddData = ConversationAddData;

export interface V3ConversationQueryRequest {
  session_id?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export type V3ConversationQueryData = ConversationQueryData;

export interface V3ConversationSearchRequest {
  query: string;
  limit?: number;
  session_id?: string;
  time_start?: string;
  time_end?: string;
}
export type V3ConversationSearchData = ConversationSearchData;

export interface V3ConversationDeleteRequest {
  /** List of message ids to delete, at most 5000 per call (deduplicated automatically). */
  message_ids?: string[];
  /** List of session ids to clear, at most 100 per call (deduplicated automatically). */
  session_ids?: string[];
  /**
   * @deprecated Use `session_ids` instead. Kept only for compatibility with old callers; it is merged into
   * `session_ids`. Note: the delete path does **not** fall back to the session_id in the constructor.
   */
  session_id?: string;
}
export type V3ConversationDeleteData = ConversationDeleteData;
export interface V3ConversationCountRequest {
  session_id?: string;
  time_start?: string;
  time_end?: string;
}

export interface V3AtomicUpdateRequest {
  id: string;
  content: string;
  background?: string;
  session_id?: string;
}
export type V3AtomicUpdateData = AtomicUpdateData;

export interface V3AtomicQueryRequest {
  type?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}
export type V3AtomicDetail = AtomicDetail;
export type V3AtomicQueryData = AtomicQueryData;

export interface V3AtomicSearchRequest {
  query: string;
  limit?: number;
  type?: string;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}
export type V3AtomicSearchData = AtomicSearchData;

export interface V3AtomicDeleteRequest {
  /** List of L1 note ids to delete, at most 5000 per call (deduplicated automatically). */
  ids: string[];
  session_id?: string;
}
export type V3AtomicDeleteData = AtomicDeleteData;

// -- Chat Memory (asset-level) ---------------------------------------------

export interface V3ChatMemoryClearRequest {
  /** List of chat memory asset ids to clear, 1-100 (deduplicated automatically). */
  memory_ids: string[];
}

/** Clear result for a single memory. */
export interface V3ChatMemoryClearItem {
  memory_id: string;
  /** Whether the clear succeeded. When false, content may remain. */
  cleared: boolean;
  l0_deleted: number;
  l1_deleted: number;
  /** Number of L2/L3 profile records (store rows + storage files). */
  profile_deleted: number;
  /** Failure reason; not returned on success. */
  reason?: string;
  /**Whether the failure is worth retrying (the server has already retried automatically). */
  retryable?: boolean;
  /** Number of attempts actually made by the server. */
  attempts?: number;
}

export interface V3ChatMemoryClearData {
  items: V3ChatMemoryClearItem[];
  /** True when everything succeeded. */
  all_cleared: boolean;
}

export interface V3AtomicCountRequest {
  type?: string;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}

export interface V3ScenarioListRequest {
  path_prefix?: string;
}
export type V3ScenarioEntry = ScenarioEntry;
export type V3ScenarioListData = ScenarioListData;

export interface V3ScenarioReadRequest {
  path: string;
}
export type V3ScenarioFile = ScenarioFile;

export interface V3ScenarioWriteRequest {
  path: string;
  content: string;
  summary?: string;
}
export type V3ScenarioWriteData = ScenarioWriteData;

export interface V3ScenarioRmRequest {
  path: string;
}

export interface V3ScenarioCountRequest {
  path_prefix?: string;
}

export type V3CoreReadRequest = Record<string, never>;
export type V3CoreFile = CoreFile;

export interface V3CoreWriteRequest {
  content: string;
}
export type V3CoreWriteData = CoreWriteData;
export type V3CountData = CountData;
