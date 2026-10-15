/**
 * log-writer.ts — maintains the wiki/log.md ingest log (OKF §7 / llm-wiki timeline, OQ-10).
 *
 * After each source is ingested, a date-grouped entry is appended, newest first, easy for grep and manual review:
 *   ## YYYY-MM-DD
 *   * **ingest** <source file name> — wrote N pages
 *
 * Batch ingest additionally has:
 *   * **batch-ingest** N sources (...) — wrote M pages
 *
 * log.md is a structural file (page/write/rm may not modify it), but ingest may maintain it.
 * No frontmatter (OKF convention). Plain-text append, no LLM call.
 *
 * Self-developed implementation, with no GPL code referenced.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HEADER = "# Ingest Log";

/** Get the local date YYYY-MM-DD. */
function today(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Render one log entry line. Exported for unit tests.
 */
export function renderLogEntry(sourceName: string, pageCount: number): string {
  return `* **ingest** ${sourceName} — wrote ${pageCount} pages`;
}

/** Render a batch ingest log line. */
export function renderBatchLogEntry(sourcesProcessed: string[], pageCount: number): string {
  const list = sourcesProcessed.join(", ");
  return `* **batch-ingest** ${sourcesProcessed.length} sources (${list}) — wrote ${pageCount} pages`;
}

function readLogBody(logPath: string): string {
  if (!existsSync(logPath)) return "";
  try {
    return readFileSync(logPath, "utf-8");
  } catch {
    return "";
  }
}

function appendEntries(projectPath: string, entries: string[], now: Date): void {
  const logPath = join(projectPath, "wiki", "log.md");
  const day = today(now);
  let body = readLogBody(logPath);
  for (const entry of entries) {
    body = mergeEntry(body, day, entry);
  }
  writeFileSync(logPath, body, "utf-8");
}

/**
 * Append an ingest log entry to wiki/log.md (newest date group first).
 *
 * @param projectPath wiki project root
 * @param sourceName  source file name of this ingest
 * @param pageCount   number of pages written/updated this time
 * @param now         injected time (for tests)
 */
export function appendIngestLog(
  projectPath: string,
  sourceName: string,
  pageCount: number,
  now = new Date(),
): void {
  appendEntries(projectPath, [renderLogEntry(sourceName, pageCount)], now);
}

export interface BatchIngestLogInput {
  sourcesProcessed: string[];
  pagesWritten: string[];
  mergeErrors: string[];
}

/**
 * Batch aggregate log (one batch record per ingest, optionally with merge-errors).
 * Coexists with appendIngestLog and writes to the same wiki/log.md.
 */
export function appendIngestLogBatch(
  projectPath: string,
  input: BatchIngestLogInput,
  now = new Date(),
): void {
  const entries = [
    renderBatchLogEntry(input.sourcesProcessed, input.pagesWritten.length),
  ];
  for (const err of input.mergeErrors) {
    entries.push(`* **merge-errors** ${err}`);
  }
  appendEntries(projectPath, entries, now);
}

/**
 * Merge an entry into the log text: if today's group exists, insert at the very top of that group; otherwise create a new group for today after the header.
 * The newest date group is always first. Exported for unit tests.
 */
export function mergeEntry(existing: string, day: string, entry: string): string {
  const dayHeading = `## ${day}`;
  const lines = (existing || `${HEADER}\n`).split("\n");

  // Find the header line index (add one if absent).
  let headerIdx = lines.findIndex((l) => l.trim() === HEADER);
  if (headerIdx === -1) {
    lines.unshift(HEADER, "");
    headerIdx = 0;
  }

  // Find today's group.
  const dayIdx = lines.findIndex((l) => l.trim() === dayHeading);
  if (dayIdx !== -1) {
    // Insert on the line after today's group heading (the top of that group).
    lines.splice(dayIdx + 1, 0, entry);
  } else {
    // Insert the new group for today after the header (and any blank lines following it), so it sits before all older groups.
    let insertAt = headerIdx + 1;
    if (lines[insertAt]?.trim() === "") insertAt++;
    lines.splice(insertAt, 0, dayHeading, entry, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n";
}
