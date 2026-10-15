/**
 * Start a temporary gateway for the SDK real-machine e2e.
 *
 * Uses a separate port and a temporary data directory, leaving services already running on the dev machine untouched.
 * After startup it prints the admin user_key for the e2e script; on Ctrl-C / SIGTERM exit it cleans up the data directory.
 *
 * Usage:
 *   node --import tsx scripts/start-e2e-gateway.ts [port]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { WamfGateway } from "../src/gateway/server.js";

const PORT = Number(process.argv[2] ?? 18620);
const API_KEY = process.env.E2E_API_KEY ?? "sdk-e2e-token";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-e2e-gw-"));

process.env.WAMF_METADATA_SQLITE_BASE_DIR = path.join(tmpDir, "metadata");

function post(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(pathname, `http://127.0.0.1:${PORT}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(json)),
          "x-wamf-service-id": "default",
          Authorization: `Bearer ${API_KEY}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

const gateway = new WamfGateway({
  server: { port: PORT, host: "127.0.0.1", apiKey: API_KEY },
  data: { baseDir: tmpDir },
  // Placeholder LLM: this run only verifies the deletion path and does not need real distillation
  llm: { baseUrl: "http://localhost:1", apiKey: "test-key", model: "test-model" },
});

async function shutdown() {
  try { await gateway.stop(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await gateway.start();

// Initialize admin and print the user_key for the e2e script
const admin = await post("/v3/internal/meta/user/init-admin", {
  username: `sdk-e2e-admin-${Date.now().toString(36)}`,
});
const adminKey = admin.body?.data?.user_key ?? admin.body?.data?.default_user_key;

console.log("GATEWAY_READY");
console.log(`PORT=${PORT}`);
console.log(`ADMIN_KEY=${adminKey}`);
console.log(`DATA_DIR=${tmpDir}`);

// Keep the process alive: the gateway's HTTP server alone may not hold the event loop
// (especially after detaching from the terminal via setsid/nohup); explicitly hold a timer until a signal arrives.
setInterval(() => { /* keep-alive */ }, 1 << 30);
