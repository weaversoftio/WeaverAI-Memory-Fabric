import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { SkillStoreError } from "../../skill/skill-store.interface.js";
import type { AppendVersionInput } from "../../skill/types.js";
import { isSkillsVersionUniqueConstraint, SqliteSkillStore } from "./skill-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function makeInput(over: Partial<AppendVersionInput> = {}): AppendVersionInput {
  return {
    skill_id: over.skill_id ?? "sk-fix",
    team_id: "team-a",
    owner_agent_id: "agent-a",
    user_id: "user-a",
    task_id: "task-a",
    name: over.name ?? "mismatch-skill",
    description: over.description ?? "desc",
    content: over.content ?? "# Skill\nv1",
    content_hash: over.content_hash ?? "hash-v1",
    manifest: [],
    storage_dir: over.storage_dir ?? "skills/sk-fix/v1",
    ...over,
  };
}

function insertRaw(
  db: InstanceType<typeof DatabaseSync>,
  opts: { skillId?: string; version: number; isHead: number; content: string; name?: string },
): void {
  const skillId = opts.skillId ?? "sk-fix";
  const name = opts.name ?? "mismatch-skill";
  db.prepare(
    `INSERT INTO skills (
      row_id, skill_id, version, is_head,
      user_id, owner_agent_id, team_id, task_id,
      name, description, content, content_hash, manifest_json, storage_dir,
      status, metadata_json, created_at_ms, updated_at_ms
    ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
  ).run(
    `row-${skillId}-v${opts.version}`,
    skillId,
    opts.version,
    opts.isHead,
    "user-a",
    "agent-a",
    "team-a",
    "task-a",
    name,
    "desc",
    opts.content,
    `hash-v${opts.version}`,
    "[]",
    `skills/${skillId}/v${opts.version}`,
    "active",
    "{}",
    1,
    1,
  );
}

describe("SqliteSkillStore head reconciliation + atomic append", () => {
  let db: InstanceType<typeof DatabaseSync>;
  let store: SqliteSkillStore;

  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
  });

  function openStore(): SqliteSkillStore {
    db = new DatabaseSync(":memory:");
    store = new SqliteSkillStore({ db, dimensions: 0 });
    store.init();
    return store;
  }

  it("init() points is_head at MAX(version) when the pointer lags", async () => {
    openStore();
    insertRaw(db, { version: 1, isHead: 1, content: "old" });
    insertRaw(db, { version: 2, isHead: 0, content: "newest" });

    store.init();

    const head = await store.getHead("sk-fix", "team-a");
    expect(head).not.toBeNull();
    expect(head!.version).toBe(2);
    expect(head!.content).toBe("newest");
    expect(head!.is_head).toBe(true);

    const v1 = await store.getByVersion("sk-fix", 1, "team-a");
    expect(v1!.is_head).toBe(false);

    const max = db.prepare("SELECT MAX(version) AS m FROM skills WHERE skill_id=?").get("sk-fix") as { m: number };
    expect(head!.version).toBe(max.m);
  });

  it("appendVersion after a mismatch inserts MAX+1 and leaves a single head", async () => {
    openStore();
    insertRaw(db, { version: 1, isHead: 1, content: "old" });
    insertRaw(db, { version: 2, isHead: 0, content: "newest" });

    const v3 = await store.appendVersion(makeInput({
      content: "from-client",
      content_hash: "hash-v3",
      storage_dir: "skills/sk-fix/v3",
    }));
    expect(v3.version).toBe(3);
    expect(v3.is_head).toBe(true);
    expect(v3.content).toBe("from-client");

    const versions = await store.listVersions("sk-fix", "team-a");
    expect(versions.filter((v) => v.is_head)).toHaveLength(1);
    expect(versions.find((v) => v.is_head)!.version).toBe(3);
    expect((await store.getByVersion("sk-fix", 1, "team-a"))!.is_head).toBe(false);
    expect((await store.getByVersion("sk-fix", 2, "team-a"))!.is_head).toBe(false);
  });

  it("second appendVersion with the same expected_version throws SKILL_VERSION_STALE", async () => {
    openStore();
    await store.appendVersion(makeInput({ content: "v1", content_hash: "h1" }));
    const first = await store.appendVersion(makeInput({
      content: "v2",
      content_hash: "h2",
      expected_version: 1,
      storage_dir: "skills/sk-fix/v2",
    }));
    expect(first.version).toBe(2);

    await expect(store.appendVersion(makeInput({
      content: "v3-lost-update",
      content_hash: "h3",
      expected_version: 1,
      storage_dir: "skills/sk-fix/v3",
    }))).rejects.toMatchObject({
      name: "SkillStoreError",
      code: "SKILL_VERSION_STALE",
    });

    const head = await store.getHead("sk-fix", "team-a");
    expect(head!.version).toBe(2);
    expect(head!.content).toBe("v2");
  });

  it("maps a UNIQUE(skill_id, version) abort to SKILL_VERSION_STALE", async () => {
    openStore();
    db.exec(`
      CREATE TRIGGER fail_skill_version_unique BEFORE INSERT ON skills
      BEGIN
        SELECT RAISE(ABORT, 'UNIQUE constraint failed: skills.skill_id, skills.version');
      END
    `);

    try {
      await store.appendVersion(makeInput());
      expect.fail("expected SkillStoreError");
    } catch (e) {
      expect(e).toBeInstanceOf(SkillStoreError);
      expect((e as SkillStoreError).code).toBe("SKILL_VERSION_STALE");
      expect((e as Error).message).toMatch(/head is \d+/);
      expect((e as Error).message).not.toMatch(/ERR_SQLITE_ERROR/);
    }
  });

  it("detects the SQLite UNIQUE message used by the hub logs", () => {
    expect(isSkillsVersionUniqueConstraint(
      new Error("ERR_SQLITE_ERROR: UNIQUE constraint failed: skills.skill_id, skills.version"),
    )).toBe(true);
    expect(isSkillsVersionUniqueConstraint(new Error("UNIQUE constraint failed: skills.name"))).toBe(false);
  });
});
