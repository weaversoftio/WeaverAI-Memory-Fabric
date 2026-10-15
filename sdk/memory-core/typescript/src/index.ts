/**
 * @weaversoft/memory-fabric-sdk-ts-v2 — TypeScript SDK for WeaverAI Memory Fabric v3 API.
 *
 * Top-level exports come directly from the v3 strict-isolation version. Old code that previously imported from the
 * `@weaversoft/memory-fabric-sdk-ts-v2/v3` subpath can keep using it (the subpath
 * is kept as a backward-compatible alias with exactly the same content as this module).
 */

export * from "./v3/index.js";

// Raw data-shape types of the HTTP contract -- the v3 client returns these shapes (v3/types.ts
// has a `V3*` alias; both names work).
export type {
  // Common
  ApiResponseEnvelope, CountData,
  // L0
  ConversationItem, ConversationAddData, ConversationQueryData,
  ConversationSearchData, ConversationSearchHit, ConversationDeleteData,
  // L1
  AtomicDetail, AtomicUpdateData, AtomicQueryData,
  AtomicSearchData, AtomicSearchHit, AtomicDeleteData,
  // L2
  ScenarioEntry, ScenarioListData, ScenarioFile, ScenarioWriteData,
  // L3
  CoreFile, CoreWriteData,
  // Offload
  OffloadToolPair, OffloadRecentMessage,
  OffloadIngestRequest, OffloadIngestData,
  OffloadCompactRequest, OffloadCompactData, OffloadCompactReport,
  OffloadQueryMmdRequest, OffloadQueryMmdData,
} from "./types.js";

// Shared types / util (neither v3-only nor v2 API implementation; exported for callers who need a custom transport)
export { ParamError, WAMFError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export type { MemoryClientConfig, Transport } from "./client.js";
