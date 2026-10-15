/**
 * template.ts — read wiki/schema.md and wiki/purpose.md as the extraction template (FR-4b).
 *
 * These two files let the user/caller customize "what this wiki wants to extract and how to organize it":
 *   - purpose.md: declares the wiki's target domain and purpose.
 *   - schema.md: declares extraction preferences (which page types are wanted, fields of interest, naming/language conventions).
 *
 * At ingest they are "spliced verbatim into the system prompt" (no machine parsing of the skeleton is enforced, fault tolerant).
 * When empty/missing, a domain-neutral default skeleton is used as a fallback, so it works out of the box.
 *
 * Note: default files already written by init (manager.initWikiProject) may be just empty shells
 * (e.g. only `# Wiki Schema\n\nDefine ... here.`); these are treated as "no effective content" and the default is used.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface WikiTemplate {
  /** Effective body of purpose.md (frontmatter stripped); the default if none. */
  purpose: string;
  /** Effective body of schema.md (frontmatter stripped); the default if none. */
  schema: string;
  /** Whether user-customized content was used (for logging/debugging). */
  customized: boolean;
}

/** Default purpose — software engineering knowledge base. */
export const DEFAULT_PURPOSE = `This knowledge base accumulates and organizes engineering knowledge of software systems,
including system architecture, module design, data flow, deployment models, permission models, etc.
By ingesting requirement documents, architecture designs, meeting notes, RFCs, technical decisions and other
source documents, it builds a structured, cross-referenced knowledge graph to help team members quickly
understand the system landscape and the rationale behind design decisions.`;

/** Default schema skeleton — software engineering knowledge base. */
export const DEFAULT_SCHEMA = `# Page types
- entity — a concrete component or role in the system; must declare a kind field
- concept — an abstract design idea (system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework, etc.)
- source — one summary page per ingested source document; must declare a source_type field
Other types (comparison, synthesis, etc.) may be created as needed.

# Fields / sections per type
- entity:
    - kind: module | service | platform | external_system | user_role | other (required)
    - definition: responsibility / purpose
    - key attributes: key properties
    - relationships: relationships to other entities
- concept:
    - definition: concept definition
    - significance: importance / role
    - related entities: associated entities
    - common topics: system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework
- source:
    - source_type: requirement | architecture | meeting | rfc | decision | other (required)
    - source document summary
- Use OKF sections where applicable: # Schema / # Examples / # Citations

# Naming & language
- slug: lowercase, spaces→hyphens
- Output language: follow the source document — do not switch`;

/** Decide whether a body "has substantive content" (excluding the empty-shell placeholder written by init). */
function hasMeaningfulContent(body: string): boolean {
  const stripped = body
    .replace(/^#.*$/gm, "")              // strip heading lines
    .replace(/Define\b[^.]*\.?/gi, "") // strip the "Define ..." placeholder sentence (init default shell)
    .replace(/\s+/g, "");
  return stripped.length >= 8;
}

function readTemplateFile(projectPath: string, name: string): string | null {
  const full = join(projectPath, "wiki", name);
  if (!existsSync(full)) return null;
  try {
    const content = readFileSync(full, "utf-8");
    const { body } = parseFrontmatter(content);
    const trimmed = body.trim();
    if (!trimmed || !hasMeaningfulContent(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Load the extraction template. If the user's has substantive content, use it; otherwise use the domain-neutral default.
 */
export function loadTemplate(projectPath: string): WikiTemplate {
  const purpose = readTemplateFile(projectPath, "purpose.md");
  const schema = readTemplateFile(projectPath, "schema.md");
  return {
    purpose: purpose ?? DEFAULT_PURPOSE,
    schema: schema ?? DEFAULT_SCHEMA,
    customized: purpose != null || schema != null,
  };
}
