/**
 * Fake L0 document generation for the bench.
 *
 * Design points:
 *  - `_id` = `msg-` + full UUID (32 hex), matching the production change in
 *    `src/gateway/v2-router.ts` — no truncation, no collisions at 1e8.
 *  - `tokens` (FTS segmentation) is precomputed ONCE per template into a
 *    pool; the hot generation path never tokenizes, so write QPS reflects
 *    Mongo + network, not tokenization cost. Production pre-tokenizes on the
 *    request path instead, which is a separate (bounded) cost.
 *  - Isolation dimensions (team/user/agent) and sessions are spread across
 *    pools so business-shaped queries hit an index instead of scanning.
 *  - `makeDoc(globalIndex, ctx)` is pure and cheap so workers can lazily
 *    generate their slice — essential for the 100M phase (never materialize
 *    all docs in memory).
 */

import { randomUUID } from "node:crypto";
import { tokenizeForFts } from "../../src/core/store/tokenize.js";
import type { L0Doc } from "../../src/core/store/mongodb/doc-mappers.js";

/** `msg-` + 32 hex (full UUID, hyphens stripped). Same shape as production. */
export function newMsgId(): string {
  return `msg-${randomUUID().replace(/-/g, "")}`;
}

/**
 * Seed sentences with varied English phrasing so BM25 has real tokens to score. ~100 distinct
 * base sentences (the pool cycles through them) — richer than the original 16 so
 * the search index's term cardinality is closer to real traffic.
 */
const SEED_TEXTS: string[] = [
  "The user asks how to deploy a MongoDB replica set in production with authentication enabled",
  "Help me troubleshoot timeouts in the order service, the logs show many refused connections",
  "Please summarize the key conclusions of this requirements review and the follow-up schedule",
  "We want to stress-test the write throughput of memory storage, what is the target inserts per second",
  "The customer wants to migrate their vector search workload to a keyword BM25 index",
  "Analyze the time complexity of this code and suggest possible optimizations",
  "Turn the previous round of conversation into a to-do list sorted by priority",
  "What size should the database connection pool be, and how does latency change as QPS rises",
  "Explain the Okapi BM25 scoring formula and the role of term frequency saturation",
  "Help me write a concurrent batch insert script that controls batch size and concurrency",
  "Meeting notes: the canary release plan is confirmed, ramp-up starts next Monday",
  "Retrieval recall is not high enough, does the tokenization granularity need adjusting",
  "There is a memory leak in production, help me find which module holds the large objects",
  "give me the p99 latency of the search endpoint under peak traffic",
  "Visualize this JSON report as a bar chart showing QPS and percentile latency for each tier",
  "Users report irrelevant search results, I suspect the isolation filter is not pushed down correctly",
  "Help me design a multi-tenant permission model with three isolation levels: team, user and agent",
  "How do we guarantee idempotency of this endpoint, can duplicate submissions create dirty data",
  "We need to archive historical conversations and migrate cold data to cheaper storage",
  "Explain how change streams keep the search index in sync with the collection",
  "Help me rewrite this Python code as an async version, reusing the HTTP client with a connection pool",
  "Find out why the consumer group has so many rebalances and a growing message backlog",
  "Give me this week's stability report, including alert counts and mean time to recovery",
  "I want to add long-term memory to the agent so it can recall user preferences across sessions",
  "Analyze this slow query, is it a missing index or a wrongly chosen query plan",
  "The embedding model latency spiked after we increased the batch size",
  "Help me write a rate-limiting middleware that supports both token bucket and sliding window strategies",
  "Do a postmortem of last night's incident, the root cause was a config rollout overwriting production parameters",
  "What is our vector dimension, and does recall use cosine similarity or inner product",
  "Split the uploaded long document into chunks with overlapping windows to improve retrieval continuity",
  "Help me evaluate the benefits and risks of migrating from single-node SQLite to a distributed solution",
  "Production CPU is maxed out, the flame graph shows most of the time is spent in serialization",
  "Add OpenAPI documentation and request examples to this REST endpoint",
  "We want to A/B test two recall strategies, how should we design the metrics and traffic split",
  "Help me parameterize the prompt template so different scenarios inject different system instructions",
  "The write amplification got worse after we added the full-text index",
  "Troubleshoot the gateway returning 502, I suspect an upstream timeout closed the connection early",
  "Help me put together an onboarding doc for newcomers, including steps to start the four services locally",
  "We want to add reranking to the retrieval results, a cross-encoder or rule-based scoring",
  "Analyze the ten most common user intents in this batch of conversations and categorize them",
  "Help me add a Bloom filter layer to the cache to reduce useless origin fetch queries",
  "Data skew is severe, one tenant accounts for eighty percent of all writes",
  "Show me the error rate and P95 latency trend of each endpoint over the last hour",
  "Help me convert the batch job to stream processing to lower end-to-end latency",
  "We need to shard the collection by team_id to spread the write load",
  "Find out why scheduled tasks are occasionally lost, could the distributed lock not have been acquired",
  "Help me write unit tests covering the boundary conditions of this pagination logic",
  "After our knowledge base is updated, should the old vector index be rebuilt",
  "Analyze the execution plan of this SQL, why did it do a full table scan",
  "Help me unify the log format into structured JSON to make later collection easier",
  "Data is occasionally inconsistent in production, I suspect replication lag from read/write splitting",
  "Add tool calling to the agent, starting with two tools: weather lookup and calendar event creation",
  "Help me evaluate the feasibility and refactoring cost of moving authentication down to the gateway",
  "The reranker improved precision but doubled the tail latency",
  "Find out why objects in memory are never reclaimed, there may be closure references",
  "Help me design a rollback plan that can switch back to the old version within five minutes if something goes wrong",
  "We need to count token consumption per agent for cost attribution",
  "Analyze whether the bottleneck of this stress test is the client, the network or the database",
  "Help me change this synchronous endpoint to support streaming responses, sending while generating",
  "Online search sometimes returns empty results, I suspect the index is queried before it has finished building",
  "Give me a capacity plan, when will we need to scale out at the current growth rate",
  "Help me add timeouts and retries to this code to avoid cascading failures",
  "We should pre-tokenize long-form text so Lucene doesn't re-segment it",
  "Find out why cold start is so slow, is it loading too many dependencies",
  "Help me make the user profile incrementally updatable instead of fully recomputed each time",
  "Analyze this batch of error logs and cluster the most frequent kinds of exceptions",
  "We want to tag conversations and automatically detect emotion and urgency",
  "Help me write a health check endpoint that returns the connectivity of each dependency component",
  "An avalanche happened in production, help me add circuit breaking and degradation to protect the core path",
  "Compare several vector databases for me in terms of recall and cost",
  "Help me split this long transaction into smaller ones to reduce lock hold time",
  "The isolation filter must be pushed into the search compound query",
  "Find out why the trace of some requests is broken and the downstream span is missing",
  "Help me add a loading skeleton screen to the frontend to improve first-paint experience",
  "We need a canary release, bucketing by user ID hash and ramping up gradually",
  "Analyze why this conversation fails to recall relevant memories, is the filter too strict",
  "Help me get hot reload of the config center working so changing parameters needs no service restart",
  "The production disk is almost full, help me find which collections take the most space",
  "Add a reflection step to the agent so it self-checks before giving an answer",
  "Help me evaluate the throughput gain of running embedding computation on GPU",
  "We keep the message text for replay and index only the tokens field",
  "Find out why batch writes occasionally report primary key conflicts, is there a problem with ID generation",
  "Help me make this crawler distributed, dispatching tasks through a queue",
  "Analyze the key points of user churn and see at which step they give up",
  "Help me add an idempotency key layer to the endpoint to prevent duplicate orders caused by network retries",
  "We want to merge the three injections of retrieval, memory and skills into one pipeline",
  "Occasional OOM in production, help me tune the JVM heap and GC parameters",
  "Give me an index usage report, which indexes have never been hit",
  "Help me summarize and compress long conversations, keeping only key facts and decisions",
  "The canary write proved the search index is queryable before the full load",
  "Find out why cross-region access latency is so high, is it not going to the nearest node",
  "Help me cache the result of permission checks to reduce per-request overhead",
  "We need to support multilingual retrieval, how should mixed-script text be tokenized",
  "Analyze the metric regression after this release, has the conversion rate dropped significantly",
  "Help me write a data validation script that compares record counts and checksums before and after migration",
  "A slow endpoint in production dragged down the whole thread pool, help me add bulkhead isolation",
  "Connect the agent to a knowledge base and include source citations when answering",
  "Help me evaluate the effect on write latency of changing synchronous logging to asynchronous flushing",
  "We measure P50, P90, P95 and P99 to understand the latency distribution",
  "Find out why the message order in a session got scrambled, are the timestamps duplicated",
];

export interface Template {
  text: string;
  tokens: string;
}

/** Build a pool of distinct-but-overlapping templates with precomputed tokens. */
export function buildTemplatePool(size: number): Template[] {
  const pool: Template[] = [];
  for (let i = 0; i < size; i++) {
    const seed = SEED_TEXTS[i % SEED_TEXTS.length];
    const text = `${seed} (sample ${i})`;
    pool.push({ text, tokens: tokenizeForFts(text) });
  }
  return pool;
}

export interface IsolationPools {
  teams: string[];
  users: string[];
  agents: string[];
}

export function buildIsolationPools(teams: number, users: number, agents: number): IsolationPools {
  const mk = (prefix: string, n: number) =>
    Array.from({ length: Math.max(1, n) }, (_, i) => `${prefix}-${i}`);
  return { teams: mk("team", teams), users: mk("user", users), agents: mk("agent", agents) };
}

export interface GenContext {
  pool: Template[];
  iso: IsolationPools;
  /** Number of distinct sessions to cycle across the dataset. */
  sessionsCount: number;
  /** Messages per session (a session's rows share session_key/isolation). */
  msgsPerSession: number;
  /** Base epoch ms; each doc gets baseMs + globalIndex to keep ordering stable. */
  baseMs: number;
}

export function defaultGenContext(
  poolSize: number,
  totalDocs: number,
  baseMs = Date.now(),
): GenContext {
  const pool = buildTemplatePool(poolSize);
  // Aim for a realistic-ish fan-out: many sessions, a handful of turns each.
  const msgsPerSession = 6;
  const sessionsCount = Math.max(1, Math.ceil(totalDocs / msgsPerSession));
  const teams = Math.max(4, Math.ceil(Math.sqrt(sessionsCount) / 4));
  const iso = buildIsolationPools(teams, teams * 3, teams * 2);
  return { pool, iso, sessionsCount, msgsPerSession, baseMs };
}

/** Pure, allocation-light doc factory. Safe to call from concurrent workers. */
export function makeDoc(globalIndex: number, ctx: GenContext): L0Doc {
  const sessionIdx = Math.floor(globalIndex / ctx.msgsPerSession) % ctx.sessionsCount;
  const sessionId = `sess-${sessionIdx}`;
  const team = ctx.iso.teams[sessionIdx % ctx.iso.teams.length];
  const user = ctx.iso.users[sessionIdx % ctx.iso.users.length];
  const agent = ctx.iso.agents[sessionIdx % ctx.iso.agents.length];
  const tpl = ctx.pool[globalIndex % ctx.pool.length];
  const ts = ctx.baseMs + globalIndex;
  return {
    _id: newMsgId(),
    session_key: sessionId,
    session_id: sessionId,
    team_id: team,
    task_id: "",
    user_id: user,
    agent_id: agent,
    role: globalIndex % 2 === 0 ? "user" : "assistant",
    message_text: tpl.text,
    tokens: tpl.tokens,
    recorded_at: new Date(ts).toISOString(),
    recorded_at_ms: ts,
    timestamp: ts,
  };
}

export interface QueryTarget {
  /** A session guaranteed to exist (index 0) with several messages. */
  sessionId: string;
  sessionKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  /** A text whose tokens are guaranteed present in the dataset (BM25 hits). */
  hitText: string;
  /** A text whose tokens are absent (empty-result path). */
  missText: string;
}

/** Reconstruct a deterministic query target from the generation context. */
export function queryTargetFor(ctx: GenContext): QueryTarget {
  const sessionIdx = 0;
  return {
    sessionId: `sess-${sessionIdx}`,
    sessionKey: `sess-${sessionIdx}`,
    teamId: ctx.iso.teams[sessionIdx % ctx.iso.teams.length],
    userId: ctx.iso.users[sessionIdx % ctx.iso.users.length],
    agentId: ctx.iso.agents[sessionIdx % ctx.iso.agents.length],
    hitText: ctx.pool[0].text,
    // Pure latin gibberish — no token that could match back into the
    // corpus, so BM25 genuinely returns nothing (prices the no-hit path).
    missText: "zzqx wibblefrotz qwzxpl vhnkrt bxqztl mrrkgp",
  };
}
