import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

const P = DEFAULT_PAGINATION;

describe("SqliteMetadataStore agent viewer scope", () => {
  let store: SqliteMetadataStore;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  it("hides others' private and default-agent-* assistants from team lists", async () => {
    const u1 = await store.createUser({
      auth_provider: "local",
      external_id: "ext-u1",
      username: "user1",
    });
    const u2 = await store.createUser({
      auth_provider: "local",
      external_id: "ext-u2",
      username: "user2",
    });
    const team = await store.createTeam({ name: "customer service", owner_user_id: u1.user_id });
    const mineDefault = await store.createAgent({
      team_id: team.team_id,
      owner_user_id: u1.user_id,
      name: "default-agent-user1",
      visibility: "private",
    });
    const theirDefault = await store.createAgent({
      team_id: team.team_id,
      owner_user_id: u2.user_id,
      name: "default-agent-user2",
      visibility: "team",
    });
    const sharedCustom = await store.createAgent({
      team_id: team.team_id,
      owner_user_id: u2.user_id,
      name: "CS Assistant",
      visibility: "team",
    });
    const theirPrivate = await store.createAgent({
      team_id: team.team_id,
      owner_user_id: u2.user_id,
      name: "secret-bot",
      visibility: "private",
    });

    const visible = (
      await store.listAgentsByTeam(team.team_id, P, { status: "active" }, { viewerUserId: u1.user_id })
    ).items.map((a) => a.agent_id);

    expect(visible).toContain(mineDefault.agent_id);
    expect(visible).toContain(sharedCustom.agent_id);
    expect(visible).not.toContain(theirDefault.agent_id);
    expect(visible).not.toContain(theirPrivate.agent_id);
  });
});
