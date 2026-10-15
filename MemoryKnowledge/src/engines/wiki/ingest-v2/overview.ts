/**
 * overview.ts — generates the wiki/overview.md global overview page (llm-wiki synthesis idea, OQ-9).
 *
 * Called once after a batch of sources is fully ingested: feeds all current wiki pages (title + description) to the LLM,
 * asking it to write a global overview that strings the entities/concepts into a narrative, helping humans and the LLM quickly build an overall understanding.
 *
 * overview.md carries frontmatter (type: overview); the body is encouraged to use [[wikilink]] to point to pages.
 * Failure does not affect the main ingest flow (the caller uses try/catch).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { LlmClient } from "./llm.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-overview");

/** Structural files are not part of the overview input, and are not overwritten by the overview. */
const STRUCTURAL = new Set(["index.md", "schema.md", "purpose.md", "log.md", "overview.md"]);

interface PageBrief {
  title: string;
  type: string;
  description: string;
}

function collectBriefs(wikiDir: string): PageBrief[] {
  const out: PageBrief[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry !== "media") walk(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(wikiDir, full).replace(/\\/g, "/");
      if (STRUCTURAL.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      out.push({
        title:
          typeof frontmatter.title === "string" && frontmatter.title.trim()
            ? frontmatter.title.trim()
            : entry.replace(/\.md$/, ""),
        type: frontmatter.type,
        description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
      });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

const OVERVIEW_SYSTEM = `You are a knowledge base maintainer. Given a list of all current wiki pages (title + type + description),
write a concise "global overview" that weaves these entities and concepts into a coherent narrative,
helping readers quickly build a holistic mental model.
Requirements:
- 2–5 paragraphs, clearly structured. Do not list items one by one — organize and summarize themes and their relationships.
- Use [[Page Title]] wikilinks to point to specific pages (title only, no paths or suffixes).
- Output only the overview body (markdown) — no frontmatter, no FILE blocks, no extra commentary.`;

/**
 * Generate/update wiki/overview.md. Skipped when there are too few pages (<2) (an overview is of little value).
 *
 * @returns whether the overview was written.
 */
export async function generateOverview(projectPath: string, llm: LlmClient): Promise<boolean> {
  const wikiDir = join(projectPath, "wiki");
  const briefs = collectBriefs(wikiDir);
  if (briefs.length < 2) {
    log.debug("too few pages, skipping overview generation", { pages: briefs.length });
    return false;
  }

  const list = briefs
    .map((b) => `- ${b.title} [${b.type}]`)
    .join("\n");
  const prompt = `## Wiki Pages\n${list}\n\nWrite a global overview.`;

  const body = (await llm.chat({ system: OVERVIEW_SYSTEM, prompt, label: "overview" })).trim();
  if (!body) {
    log.warn("overview generated empty, skip writing");
    return false;
  }

  const content = buildPage(
    { type: "overview", title: "Overview", description: "A global overview of this wiki", timestamp: new Date().toISOString() },
    body,
  );
  writeFileSync(join(wikiDir, "overview.md"), content, "utf-8");
  log.info("overview.md written", { pages: briefs.length, bytes: content.length });
  return true;
}
