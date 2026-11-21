import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  localRuns,
  localThreadBindings,
  users,
} from "../src/db/schema";
import { createLocalRuntimeStore } from "../src/local-runtime/store";
import {
  LocalRunStateError,
  summarizeRunState,
} from "../src/local-runtime/summary";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `local-summary-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const agentId = `${prefix}-agent`;
const threadIds: string[] = [];
const store = createLocalRuntimeStore(database);

beforeAll(async () => {
  await database.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
  });
  await database.insert(agents).values({
    id: agentId,
    name: "Run summary integration Bot",
    type: "built_in",
    configuration: {},
  });
});

afterAll(async () => {
  if (threadIds.length) {
    await database
      .delete(localThreadBindings)
      .where(inArray(localThreadBindings.threadId, threadIds));
  }
  await database.delete(agents).where(inArray(agents.id, [agentId]));
  await database.delete(users).where(inArray(users.id, [ownerId]));
  await database.$client.close();
});

function thread() {
  const id = `${prefix}-thread-${threadIds.length}`;
  threadIds.push(id);
  return id;
}

function submission(
  threadId: string,
  requestKey = "request-1",
  requestHash = "hash-1",
) {
  return {
    threadId,
    ownerUserId: ownerId,
    agentId,
    actorId: ownerId,
    source: "manual" as const,
    requestKey,
    requestHash,
  };
}

function summary(threadId: string) {
  return store
    .readHistory({ threadId, actorId: ownerId, agentId })
    .then(summarizeRunState);
}

test("a bound thread with no run rows reads as idle", async () => {
  const idleThread = thread();
  await database.insert(localThreadBindings).values({
    threadId: idleThread,
    ownerUserId: ownerId,
    agentId,
  });
  expect(await summary(idleThread)).toEqual({ phase: "idle" });
});

test("the newest run row and its terminal event derive every phase the store writes", async () => {
  const threadId = thread();
  const { run: first } = await store.submit(submission(threadId, "first"));
  expect(await summary(threadId)).toEqual({ phase: "queued", runId: first.id });

  const firstToken = await store.claimAttempt({
    threadId,
    runId: first.id,
    owner: "worker-first",
    leaseMs: 30_000,
  });
  expect(await summary(threadId)).toEqual({
    phase: "running",
    runId: first.id,
  });

  await store.finishAttempt(firstToken, "succeeded", { resultRef: "result-1" });
  expect(await summary(threadId)).toEqual({
    phase: "succeeded",
    runId: first.id,
  });

  const { run: second } = await store.submit(
    submission(threadId, "second", "hash-2"),
  );
  // The newest run decides, not the older terminal one.
  expect(await summary(threadId)).toEqual({
    phase: "queued",
    runId: second.id,
  });

  const secondToken = await store.claimAttempt({
    threadId,
    runId: second.id,
    owner: "worker-second",
    leaseMs: 30_000,
  });
  await store.finishAttempt(secondToken, "failed", {
    reason: "fixture model failed",
  });
  expect(await summary(threadId)).toEqual({
    phase: "failed",
    runId: second.id,
    reason: "fixture model failed",
  });
});

test("a cancelled run with its interrupted event reads as interrupted with the stored reason", async () => {
  const stopThread = thread();
  const { run: stopped } = await store.submit(submission(stopThread, "stop"));
  const stopToken = await store.claimAttempt({
    threadId: stopThread,
    runId: stopped.id,
    owner: "worker-stop",
    leaseMs: 30_000,
  });
  await store.finishAttempt(stopToken, "interrupted", {
    reason: "Stopped by user.",
  });
  expect(await summary(stopThread)).toEqual({
    phase: "interrupted",
    runId: stopped.id,
    reason: "Stopped by user.",
  });

  // The crash path settles the same pair at read time, with the lease reason.
  const crashThread = thread();
  const { run: crashed } = await store.submit(submission(crashThread, "crash"));
  await store.claimAttempt({
    threadId: crashThread,
    runId: crashed.id,
    owner: "worker-crash",
    leaseMs: 200,
  });
  await Bun.sleep(250);
  expect(await summary(crashThread)).toEqual({
    phase: "interrupted",
    runId: crashed.id,
    reason: "execution lease expired",
  });
});

test("a terminal pair that disagrees fails closed rather than guessing", async () => {
  const disagreeThread = thread();
  const { run: disagreed } = await store.submit(
    submission(disagreeThread, "disagree"),
  );
  const token = await store.claimAttempt({
    threadId: disagreeThread,
    runId: disagreed.id,
    owner: "worker-disagree",
    leaseMs: 30_000,
  });
  await store.finishAttempt(token, "succeeded");
  await database
    .update(localRuns)
    .set({ status: "failed", error: "forced" })
    .where(eq(localRuns.id, disagreed.id));
  const disagreeHistory = await store.readHistory({
    threadId: disagreeThread,
    actorId: ownerId,
    agentId,
  });
  expect(() => summarizeRunState(disagreeHistory)).toThrow(LocalRunStateError);

  // A terminal run with no terminal event is the same defect.
  const missingThread = thread();
  const { run: missing } = await store.submit(
    submission(missingThread, "missing"),
  );
  await store.claimAttempt({
    threadId: missingThread,
    runId: missing.id,
    owner: "worker-missing",
    leaseMs: 30_000,
  });
  await database
    .update(localRuns)
    .set({ status: "succeeded" })
    .where(eq(localRuns.id, missing.id));
  const missingHistory = await store.readHistory({
    threadId: missingThread,
    actorId: ownerId,
    agentId,
  });
  expect(() => summarizeRunState(missingHistory)).toThrow(LocalRunStateError);

  // A defect in an older run fails the whole read too, even with a clean newest
  // run: this derivation is the one place that sees runs and events together.
  const olderThread = thread();
  const { run: older } = await store.submit(submission(olderThread, "older"));
  const olderToken = await store.claimAttempt({
    threadId: olderThread,
    runId: older.id,
    owner: "worker-older",
    leaseMs: 30_000,
  });
  await store.finishAttempt(olderToken, "succeeded");
  await store.submit(submission(olderThread, "newer"));
  await database
    .update(localRuns)
    .set({ status: "cancelled" })
    .where(eq(localRuns.id, older.id));
  const olderHistory = await store.readHistory({
    threadId: olderThread,
    actorId: ownerId,
    agentId,
  });
  expect(olderHistory.runs.at(-1)?.status).toBe("queued");
  expect(() => summarizeRunState(olderHistory)).toThrow(LocalRunStateError);
});
