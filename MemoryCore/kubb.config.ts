import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";

export default defineConfig({
  root: ".",
  input: {
    // Team-memory extended contract: adds optional IdFields on top of the 13 endpoints in offload.yaml
    // (team_id / agent_id / user_id / task_id); used for identity isolation in service mode.
    // Legacy clients that omit IdFields keep the original offload.yaml semantics.
    path: "./docs/team-api-memory-only.yaml",
  },
  output: {
    path: "./src/gateway/generated",
    clean: true,
    barrelType: false,
  },
  plugins: [
    pluginOas({
      generators: [],
    }),
    pluginTs({
      output: {
        path: "./types.ts",    // single file
        barrelType: false,
      },
    }),
    pluginZod({
      output: {
        path: "./schemas.ts",  // single file
        barrelType: false,
      },
      typed: true,
      importPath: "zod",
    }),
  ],
});
