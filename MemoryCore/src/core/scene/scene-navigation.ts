/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER_LOCAL = `📌 How to use:
- Path is the absolute path of the scene block; read its full content directly with the **read** tool (parameter: filePath)
- Heat: how many times memories have hit this scene; higher means more important
- Summary: the scene's key points`;

/**
 * Footer for backends addressed by storage key rather than filesystem path.
 * The reading tool is a property of the mounted surface, not of the backend,
 * so it is supplied by whoever assembles the two.
 */
export function storageNavFooter(readTool: string): string {
  return `📌 How to use:
- Path is the storage path of the scene block; read its full content with the **${readTool}** tool (parameter: path)
- Heat: how many times memories have hit this scene; higher means more important
- Summary: the scene's key points`;
}

export interface SceneNavigationRenderOptions {
  /**
   * Resolves an entry to the path the reader must pass back. Callers hand in
   * the same resolver they serve reads from, so a rendered path is by
   * construction a path that can be read (design doc D12).
   */
  pathFor: (entry: SceneIndexEntry) => string;
  /** Tool the model should call, named in the intro line. */
  readTool: string;
  footer: string;
}

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  paths are absolute for read_file.
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string): string {
  return renderSceneNavigation(entries, {
    pathFor: (e) =>
      dataDir
        ? path.join(dataDir, "scene_blocks", e.filename)
        : `scene_blocks/${e.filename}`,
    readTool: "read",
    footer: NAV_FOOTER_LOCAL,
  });
}

/**
 * Render the navigation section from entries and a caller-supplied resolver.
 *
 * Taking `pathFor` instead of a mode flag is the point: a backend renders the
 * paths it actually serves, so navigation and reads cannot drift apart.
 */
export function renderSceneNavigation(
  entries: SceneIndexEntry[],
  opts: SceneNavigationRenderOptions,
): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    const pathLine = `### Path: ${opts.pathFor(e)}`;
    const heatLine = `**Heat**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **Updated**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  return `${NAV_HEADER}\n*Below is the index of the current scene memories; use ${opts.readTool} to read the details when needed.*\n\n${blocks.join("\n\n")}\n\n${opts.footer}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
