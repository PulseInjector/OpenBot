import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executeRecordedTool } from "@openbot/toolkit/tool-operation";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, localThreadBindings, users } from "../src/db/schema";
import {
  createLocalRuntimeStore,
  LocalExecutionLeaseError,
  LocalRuntimeConflictError,
} from "../src/local-runtime/store";
import { localToolOperationRecorder } from "../src/local-runtime/tool-operations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `local-runtime-${randomUUID()}`;
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
    name: "Local runtime integration Bot",
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

test("concurrent identical submissions create one durable run", async () => {
  const threadId = thread();
  const [left, right] = await Promise.all([
    store.submit(submission(threadId)),
    store.submit(submission(threadId)),
  ]);

  expect(left.run.id).toBe(right.run.id);
  expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
  expect(
    (await store.readHistory({ threadId, actorId: ownerId })).runs,
  ).toHaveLength(1);
  await expect(
    store.submit(submission(threadId, "request-1", "different-hash")),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
});

test("event order, message projection, and history survive a fresh store instance", async () => {
  const threadId = thread();
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "worker-a",
    leaseMs: 30_000,
  });
  const first = await store.append(token, {
    kind: "message.upsert",
    messageId: "assistant-1",
    role: "assistant",
    content: { text: "first" },
  });
  const second = await store.append(token, {
    kind: "message.upsert",
    messageId: "assistant-1",
    role: "assistant",
    content: { text: "final" },
  });

  const restartedStore = createLocalRuntimeStore(database);
  const history = await restartedStore.readHistory({
    threadId,
    actorId: ownerId,
  });
  expect(history.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  expect([first.sequence, second.sequence]).toEqual([3, 4]);
  expect(history.messages).toMatchObject([
    {
      messageId: "assistant-1",
      content: { text: "final" },
      lastSequence: second.sequence,
    },
  ]);
  expect(history.runs[0]?.id).toBe(run.id);
  expect(history.attempts[0]?.generation).toBe(token.generation);
  const resumed = await restartedStore.readEventsAfter({
    threadId,
    actorId: ownerId,
    agentId,
    afterSequence: first.sequence,
    limit: 1,
  });
  expect(resumed.map((event) => event.sequence)).toEqual([second.sequence]);
  await expect(
    restartedStore.readEventsAfter({
      threadId,
      actorId: `${ownerId}-other`,
      agentId,
      afterSequence: 0,
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
});

test("one current attempt wins and an expired generation cannot append or start an operation", async () => {
  let currentTime = new Date("2026-11-18T07:00:00.000Z");
  const timedStore = createLocalRuntimeStore(database, {
    now: () => currentTime,
  });
  const threadId = thread();
  const { run } = await timedStore.submit(submission(threadId));
  const claims = await Promise.allSettled([
    timedStore.claimAttempt({
      threadId,
      runId: run.id,
      owner: "worker-a",
      leaseMs: 100,
    }),
    timedStore.claimAttempt({
      threadId,
      runId: run.id,
      owner: "worker-b",
      leaseMs: 100,
    }),
  ]);
  const current = claims.find((result) => result.status === "fulfilled");
  const competing = claims.find((result) => result.status === "rejected");
  expect(current?.status).toBe("fulfilled");
  expect(competing?.status).toBe("rejected");
  if (current?.status !== "fulfilled") throw new Error("No lease was claimed.");
  const staleToken = current.value;

  currentTime = new Date(currentTime.getTime() + 101);
  const nextToken = await timedStore.claimAttempt({
    threadId,
    runId: run.id,
    owner: "worker-c",
    leaseMs: 1_000,
  });
  expect(nextToken.generation).toBeGreaterThan(staleToken.generation);
  await expect(
    timedStore.append(staleToken, {
      kind: "message.upsert",
      messageId: "stale-message",
      role: "assistant",
      content: { text: "must not be saved" },
    }),
  ).rejects.toBeInstanceOf(LocalExecutionLeaseError);
  await expect(
    timedStore.beginOperation(staleToken, {
      toolCallId: "stale-tool-call",
      toolName: "write_document",
      parameters: { pageId: "page-1", content: "must not be dispatched" },
      actorId: ownerId,
    }),
  ).rejects.toBeInstanceOf(LocalExecutionLeaseError);
  await expect(
    timedStore.beginOperation(nextToken, {
      toolCallId: "wrong-actor-tool-call",
      toolName: "write_document",
      parameters: { pageId: "page-1" },
      actorId: "another-actor",
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
  const started = await timedStore.beginOperation(nextToken, {
    toolCallId: "tool-call-1",
    toolName: "write_document",
    target: "page-1",
    parameters: { pageId: "page-1", content: "expected" },
    actorId: ownerId,
  });
  expect(started.created).toBe(true);
  const dispatched = await timedStore.markOperationDispatched(
    nextToken,
    started.operation.id,
  );
  expect(dispatched.dispatched).toBe(true);
  const settled = await timedStore.settleOperation(
    nextToken,
    started.operation.id,
    "succeeded",
    { pageId: "page-1", receipt: "verified" },
  );
  expect(settled.status).toBe("succeeded");
  const finished = await timedStore.finishAttempt(nextToken, "succeeded", {
    resultRef: "result-1",
  });
  expect(finished.type).toBe("attempt.succeeded");

  const history = await timedStore.readHistory({ threadId, actorId: ownerId });
  expect(history.events.map((event) => event.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(history.messages).toHaveLength(0);
  expect(history.runs[0]?.status).toBe("succeeded");
  expect(history.attempts[1]?.status).toBe("succeeded");
  expect(history.operations).toMatchObject([
    {
      toolCallId: "tool-call-1",
      status: "succeeded",
      dispatched: true,
      result: { pageId: "page-1", receipt: "verified" },
    },
  ]);
});

test("stop closes operation admission while a dispatched late result still settles", async () => {
  const threadId = thread();
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "worker-stop",
    leaseMs: 30_000,
  });
  const recorder = localToolOperationRecorder({
    store,
    token,
    actorId: ownerId,
    authorize: async () => undefined,
  });
  let complete:
    | ((value: { pageId: string; verified: boolean }) => void)
    | undefined;
  let start: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const inFlight = executeRecordedTool({
    recorder,
    toolCallId: "already-running",
    toolName: "write_page",
    parameters: { pageId: "p1", content: "complete" },
    execute: () =>
      new Promise((resolve) => {
        complete = resolve;
        start?.();
      }),
  });
  await started;
  let stopSettled = false;
  const stopping = recorder.stop?.("acceptance-test").then(() => {
    stopSettled = true;
  });
  expect(stopping).toBeDefined();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await store.stopRequested(token)) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(await store.stopRequested(token)).toBe(true);
  await expect(
    executeRecordedTool({
      recorder,
      toolCallId: "must-not-start",
      toolName: "write_page",
      parameters: { pageId: "p1" },
      execute: async () => ({ pageId: "p1", verified: false }),
    }),
  ).rejects.toBeInstanceOf(LocalExecutionLeaseError);
  await Promise.resolve();
  expect(stopSettled).toBe(false);
  complete?.({ pageId: "p1", verified: true });
  await expect(inFlight).resolves.toEqual({ pageId: "p1", verified: true });
  await stopping;
  expect(stopSettled).toBe(true);
  await store.finishAttempt(token, "interrupted", {
    reason: "Stopped after in-flight operation settlement.",
  });
  const history = await store.readHistory({ threadId, actorId: ownerId });
  expect(history.events.map((event) => event.type)).toEqual([
    "run.queued",
    "attempt.started",
    "operation.intent",
    "operation.dispatched",
    "attempt.stop_requested",
    "operation.succeeded",
    "attempt.interrupted",
  ]);
  expect(history.operations).toMatchObject([
    {
      toolCallId: "already-running",
      status: "succeeded",
      result: { value: { pageId: "p1", verified: true } },
    },
  ]);
});

test("an old run stop cannot mark the next attempt for the same thread", async () => {
  const threadId = thread();
  const first = await store.submit(submission(threadId, "request-old", "old"));
  const oldAttempt = await store.claimAttempt({
    threadId,
    runId: first.run.id,
    owner: "worker-old",
    leaseMs: 30_000,
  });
  await store.finishAttempt(oldAttempt, "succeeded");

  const second = await store.submit(submission(threadId, "request-new", "new"));
  const currentAttempt = await store.claimAttempt({
    threadId,
    runId: second.run.id,
    owner: "worker-new",
    leaseMs: 30_000,
  });
  await expect(
    store.requestStopForActor({
      threadId,
      actorId: ownerId,
      agentId,
      runId: first.run.id,
    }),
  ).resolves.toBe(false);
  await expect(store.stopRequested(currentAttempt)).resolves.toBe(false);
  await expect(
    store.requestStopForActor({
      threadId,
      actorId: ownerId,
      agentId,
      runId: second.run.id,
    }),
  ).resolves.toBe(true);
  await expect(store.stopRequested(currentAttempt)).resolves.toBe(true);
  await expect(
    store.requestStopForActor({
      threadId,
      actorId: `${ownerId}-other`,
      agentId,
      runId: second.run.id,
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
});

test("the shared execution adapter writes intent, dispatch, and result to the local timeline", async () => {
  const threadId = thread();
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "worker-adapter",
    leaseMs: 30_000,
  });
  let permissionChecks = 0;
  const recorder = localToolOperationRecorder({
    store,
    token,
    actorId: ownerId,
    authorize: async () => {
      permissionChecks += 1;
    },
  });
  const result = await executeRecordedTool({
    recorder,
    toolCallId: "adapter-call",
    toolName: "write_page",
    parameters: { pageId: "page-1", content: "reviewed" },
    execute: async (parameters) => ({
      pageId: parameters.pageId,
      receipt: "tool-returned",
    }),
  });
  expect(result).toEqual({ pageId: "page-1", receipt: "tool-returned" });
  expect(permissionChecks).toBe(2);
  const history = await store.readHistory({ threadId, actorId: ownerId });
  expect(history.events.map((event) => event.type)).toEqual([
    "run.queued",
    "attempt.started",
    "operation.intent",
    "operation.dispatched",
    "operation.succeeded",
  ]);
  expect(history.operations).toMatchObject([
    {
      toolCallId: "adapter-call",
      toolName: "write_page",
      parameters: { pageId: "page-1", content: "reviewed" },
      status: "succeeded",
      dispatched: true,
      result: { value: { pageId: "page-1", receipt: "tool-returned" } },
    },
  ]);
});
