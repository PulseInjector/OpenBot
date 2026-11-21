import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentCreationRequests,
  agentProfiles,
  agents,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID();
const actors = ["owner", "other"].map((name) => ({
  id: `${name}-${suite}`,
  role: "user" as const,
}));
const owner = actors[0]!;
const other = actors[1]!;
const createdIds = new Set<string>();
const evidence: unknown[] = [];
const input = {
  name: `Retry Bot ${suite}`,
  title: "Research",
  roleDescription: "Track compatibility changes.",
  visibility: "private" as const,
};
const profiles = createAgentProfileStore(database, undefined);
function appAs(actor = owner) {
  return new Hono<{ Variables: AppVariables }>().route(
    "/",
    createAgentRoutes(profiles, async (context, next) => {
      context.set("actor", { ...actor, email: `${actor.id}@example.test` });
      await next();
    }),
  );
}
function post(app: ReturnType<typeof appAs>, body: unknown) {
  return app.request("http://openbot.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function rows(actorId: string, requestId: string) {
  return database
    .select()
    .from(agentCreationRequests)
    .where(
      and(
        eq(agentCreationRequests.actorId, actorId),
        eq(agentCreationRequests.requestId, requestId),
      ),
    );
}
async function counts() {
  const bots = await database
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, input.name));
  for (const bot of bots) createdIds.add(bot.id);
  return bots.length;
}
beforeAll(async () => {
  for (const actor of actors)
    await database
      .insert(users)
      .values({ id: actor.id, email: `${actor.id}@example.test` });
});
afterAll(async () => {
  for (const id of createdIds)
    await database.delete(agents).where(eq(agents.id, id));
  for (const actor of actors)
    await database.delete(users).where(eq(users.id, actor.id));
  if (process.env.AOOO_CREATION_EVIDENCE)
    await Bun.write(
      process.env.AOOO_CREATION_EVIDENCE,
      JSON.stringify(evidence, null, 2),
    );
  await database.$client.close();
});

test("a committed response can be discarded and a fresh store returns the original Bot", async () => {
  const requestId = randomUUID();
  const before = await counts();
  // Never read the first response body: the client cannot know whether creation committed.
  expect((await post(appAs(), { ...input, requestId })).status).toBe(201);
  const [committed] = await rows(owner.id, requestId);
  expect(committed).toBeDefined();
  const restarted = createAgentProfileStore(database, undefined);
  const replay = await restarted.create(
    owner,
    { ...input, systemPrompt: input.roleDescription },
    requestId,
  );
  expect(replay.id).toBe(committed!.agentId);
  const after = await counts();
  expect(after - before).toBe(1);
  expect(await rows(owner.id, requestId)).toHaveLength(1);
  evidence.push({
    scenario: "lost-response",
    botsBefore: before,
    botsAfter: after,
    created: after - before,
    requestRows: 1,
    sameBot: true,
  });
});

test("concurrent retries with the same actor and key produce one Bot", async () => {
  const requestId = randomUUID();
  const before = await counts();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => post(appAs(), { ...input, requestId })),
  );
  const ids = await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(201);
      const body = await response.json();
      return body.agent.id;
    }),
  );
  expect(new Set(ids).size).toBe(1);
  const after = await counts();
  expect(after - before).toBe(1);
  evidence.push({
    scenario: "six-concurrent-retries",
    created: after - before,
    uniqueBotIds: new Set(ids).size,
  });
});

test("the same key with different Bot content or confirmed permissions is a conflict", async () => {
  const requestId = randomUUID();
  const app = appAs();
  const body = {
    ...input,
    requestId,
    confirmation: { skills: ["read-docs"], apps: [] },
  };
  expect((await post(app, body)).status).toBe(201);
  expect((await post(app, { ...body, title: "Changed" })).status).toBe(409);
  expect(
    (
      await post(app, {
        ...body,
        confirmation: { skills: ["read-docs", "write-docs"], apps: [] },
      })
    ).status,
  ).toBe(409);
  expect(await rows(owner.id, requestId)).toHaveLength(1);
  await counts();
  evidence.push({
    scenario: "changed-content",
    botConflictStatus: 409,
    permissionConflictStatus: 409,
    requestRows: 1,
  });
});

test("the same request ID is independent for different authenticated actors", async () => {
  const requestId = randomUUID();
  const first = await profiles.create(
    owner,
    { ...input, systemPrompt: input.roleDescription },
    requestId,
  );
  const second = await profiles.create(
    other,
    { ...input, systemPrompt: input.roleDescription },
    requestId,
  );
  createdIds.add(first.id);
  createdIds.add(second.id);
  expect(first.id).not.toBe(second.id);
  expect(first.ownerUserId).toBe(owner.id);
  expect(second.ownerUserId).toBe(other.id);
});

test("failure writing the dedup record rolls back the Bot and profile too", async () => {
  const requestId = `rollback-${suite}`;
  const constraint = `creation_retry_${suite.replaceAll("-", "")}`;
  const before = await counts();
  await database.execute(
    sql.raw(
      `ALTER TABLE agent_creation_requests ADD CONSTRAINT ${constraint} CHECK (request_id <> '${requestId}')`,
    ),
  );
  try {
    await expect(
      profiles.create(
        owner,
        { ...input, systemPrompt: input.roleDescription },
        requestId,
      ),
    ).rejects.toThrow();
    expect(await counts()).toBe(before);
    expect(await rows(owner.id, requestId)).toHaveLength(0);
    const profilesAfter = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, owner.id));
    expect(
      profilesAfter.every((profile) => createdIds.has(profile.agentId)),
    ).toBe(true);
  } finally {
    await database.execute(
      sql.raw(
        `ALTER TABLE agent_creation_requests DROP CONSTRAINT ${constraint}`,
      ),
    );
  }
  const retry = await profiles.create(
    owner,
    { ...input, systemPrompt: input.roleDescription },
    requestId,
  );
  createdIds.add(retry.id);
  expect(await rows(owner.id, requestId)).toHaveLength(1);
  evidence.push({
    scenario: "dedup-write-failure",
    botsAfterFailure: before,
    botsBefore: before,
    requestRowsAfterFailure: 0,
    retryCreated: true,
  });
});

test("a deleted original Bot consumes its key instead of recreating it", async () => {
  const requestId = randomUUID();
  const made = await profiles.create(
    owner,
    { ...input, systemPrompt: input.roleDescription },
    requestId,
  );
  createdIds.add(made.id);
  await profiles.softDelete(owner, made.id);
  expect((await post(appAs(), { ...input, requestId })).status).toBe(409);
  expect(await rows(owner.id, requestId)).toHaveLength(1);
});
