import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  executeRecordedTool,
  type ToolOperationRecorder,
} from "@openbot/toolkit/tool-operation";
import { inArray } from "drizzle-orm";
import { lastValueFrom, Observable, tap, toArray } from "rxjs";
import { createDatabase } from "../src/db/client";
import { agents, localThreadBindings, users } from "../src/db/schema";
import {
  currentLocalActorContext,
  withLocalActorContext,
} from "../src/local-runtime/actor-context";
import { LocalAgentRunner } from "../src/local-runtime/runner";
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
  expect(left.run.id).not.toBe(left.run.requestKey);
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

test("a reader follows only the observed run through commits from a separate process", async () => {
  const threadId = thread();
  const scope = { threadId, actorId: ownerId, agentId };
  const { run: previous } = await store.submit(
    submission(threadId, "previous"),
  );
  const previousToken = await store.claimAttempt({
    threadId,
    runId: previous.id,
    owner: "previous",
    leaseMs: 30_000,
  });
  // The wire carries only the agent's own run envelope, so the fixture writes what an agent
  // writes: a RUN_STARTED, its events, a RUN_FINISHED. Bare bookkeeping would never reach a
  // protocol-following reader and would prove nothing about the replay it is meant to exercise.
  await store.append(previousToken, {
    kind: "event",
    type: "RUN_STARTED",
    payload: { threadId, runId: previous.requestKey },
  });
  await store.append(previousToken, {
    kind: "event",
    type: "CUSTOM",
    payload: { name: "previous" },
  });
  await store.append(previousToken, {
    kind: "event",
    type: "RUN_FINISHED",
    payload: { threadId, runId: previous.requestKey },
  });
  await store.finishAttempt(previousToken, "succeeded");
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "active",
    leaseMs: 30_000,
  });
  await store.append(token, {
    kind: "event",
    type: "RUN_STARTED",
    payload: { threadId, runId: run.requestKey },
  });
  for (let i = 0; i < 101; i++) {
    await store.append(token, {
      kind: "event",
      type: "CUSTOM",
      payload: { name: `page-${i}` },
    });
  }
  const target = await store.openThreadReplay(scope);
  const first = await store.readReplayPage({
    ...scope,
    target,
    afterSequence: 0,
    limit: 100,
  });
  expect(first).toMatchObject({ more: true, terminal: false });
  const applied = first.events.at(-2)?.sequence ?? 0;
  const interruptedBeforeApplying = first.events.at(-1)?.sequence ?? 0;

  const runner = new LocalAgentRunner(store, async () => true, 30_000, 10);
  const sawExisting = Promise.withResolvers<void>();
  const replay = withLocalActorContext({ ...scope, role: "user" }, () =>
    lastValueFrom(
      runner.connect({ threadId }).pipe(
        tap(() => sawExisting.resolve()),
        toArray(),
      ),
    ),
  );
  await sawExisting.promise;
  const writer = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `${import.meta.dir}/fixtures/local-runtime-replay-writer.ts`,
    ],
    {
      stdin: Buffer.from(
      JSON.stringify({
        token,
        agentId,
        actorId: ownerId,
        requestKey: run.requestKey,
      }),
    ),
      stderr: "inherit",
      stdout: "ignore",
    },
  );
  expect(await writer.exited).toBe(0);
  const events = await replay;
  // The reader's wire: both envelopes of the thread so far, the second closing on the writer's
  // commit. The `later` run the writer opens afterwards is past the observed run's terminal and
  // never reaches this reader.
  expect(
    events.map((event) => [
      event.type as string,
      (Reflect.get(event, "name") as string | undefined) ?? null,
    ]),
  ).toEqual([
    ["RUN_STARTED", null],
    ["CUSTOM", "previous"],
    ["RUN_FINISHED", null],
    ["RUN_STARTED", null],
    ...Array.from(
      { length: 101 },
      (_, i) => ["CUSTOM", `page-${i}`] as (string | null)[],
    ),
    ["CUSTOM", "last"],
    ["RUN_FINISHED", null],
  ]);

  const tail = await store.readReplayPage({
    ...scope,
    target,
    afterSequence: applied,
  });
  expect(tail).toMatchObject({ more: false, terminal: true });
  expect(tail.events[0]?.sequence).toBe(interruptedBeforeApplying);
  expect(tail.events.at(-3)).toMatchObject({
    type: "CUSTOM",
    payload: { name: "last" },
  });
  expect(tail.events.at(-2)).toMatchObject({
    type: "RUN_FINISHED",
    payload: { threadId, runId: run.requestKey },
  });
  expect(tail.events.at(-1)).toMatchObject({
    runId: run.id,
    type: "attempt.succeeded",
  });
  expect(
    [...first.events.slice(0, -1), ...tail.events].map((row) => row.sequence),
  ).toEqual(Array.from({ length: 113 }, (_, i) => i + 1));
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

test("only the current client run ID on the owned Bot thread can request Stop", async () => {
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
  const scope = { threadId, actorId: ownerId, agentId };
  for (const wrong of [
    scope,
    { ...scope, clientRunId: first.run.requestKey },
    { ...scope, clientRunId: second.run.id },
    { ...scope, clientRunId: "missing" },
    { ...scope, clientRunId: second.run.requestKey, actorId: "another-user" },
    { ...scope, clientRunId: second.run.requestKey, agentId: "another-bot" },
    {
      ...scope,
      clientRunId: second.run.requestKey,
      threadId: "another-thread",
    },
  ]) {
    expect(await store.requestStopForActor(wrong)).toBeUndefined();
  }
  await expect(store.stopRequested(currentAttempt)).resolves.toBe(false);
  const stop = { ...scope, clientRunId: second.run.requestKey };
  expect(await store.requestStopForActor(stop)).toEqual({
    runId: second.run.id,
    attemptId: currentAttempt.attemptId,
  });
  await expect(store.stopRequested(currentAttempt)).resolves.toBe(true);
  expect(await store.requestStopForActor(stop)).toBeUndefined();
  expect(
    (await store.readHistory(scope)).events
      .filter((event) => event.type === "attempt.stop_requested")
      .map((event) => event.attemptId),
  ).toEqual([currentAttempt.attemptId]);
});

test("an expired attempt cannot be stopped even with its exact client run ID", async () => {
  let time = 0;
  const timedStore = createLocalRuntimeStore(database, {
    now: () => new Date(time),
  });
  const threadId = thread();
  const { run } = await timedStore.submit(submission(threadId));
  await timedStore.claimAttempt({
    threadId,
    runId: run.id,
    owner: "expired",
    leaseMs: 1,
  });
  time = 1;
  expect(
    await timedStore.requestStopForActor({
      threadId,
      actorId: ownerId,
      agentId,
      clientRunId: run.requestKey,
    }),
  ).toBeUndefined();
  expect(
    (await timedStore.readHistory({ threadId, actorId: ownerId })).attempts[0]
      ?.stopRequested,
  ).toBe(false);
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

test("configured Agents isolate tool operations across overlapping runs and Stop fences late results", async () => {
  const leftThread = thread();
  const rightThread = thread();
  const leftStarted = Promise.withResolvers<void>();
  const lateResult = Promise.withResolvers<string>();
  const stopObserved = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<unknown>();
  const actor = { actorId: ownerId, role: "user", agentId };
  const runner = new LocalAgentRunner(store, async () => true, 30_000, 5);

  class ToolAgent extends AbstractAgent {
    constructor(
      threadId: string,
      private readonly recorder: ToolOperationRecorder,
    ) {
      super({ threadId });
    }

    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable((subscriber) => {
        const scope = { threadId: input.threadId, runId: input.runId };
        const start = { type: EventType.RUN_STARTED, ...scope };
        const end = { type: EventType.RUN_FINISHED, ...scope };
        subscriber.next(start);
        void (async () => {
          const left = input.runId === "left";
          await executeRecordedTool({
            recorder: this.recorder,
            toolName: "fixture_tool",
            toolCallId: "same-call-id",
            parameters: { marker: input.forwardedProps.fixture },
            settlementTimeoutMs: left ? 500 : 30_000,
            execute: async () => {
              if (!left) return input.runId;
              leftStarted.resolve();
              await stopObserved.promise;
              try {
                await executeRecordedTool({
                  recorder: this.recorder,
                  toolName: "fixture_tool",
                  toolCallId: "must-not-dispatch",
                  parameters: {},
                  execute: async () => "unexpected",
                });
                blocked.resolve("unexpected");
              } catch (error) {
                blocked.resolve(error);
              }
              return lateResult.promise;
            },
          });
          subscriber.next(end);
          subscriber.complete();
        })().catch((error: unknown) => subscriber.error(error));
      });
    }
    abortRun() {
      stopObserved.resolve();
    }
  }

  const run = (threadId: string, runId: string) =>
    withLocalActorContext(actor, () => {
      const operations = currentLocalActorContext()?.operations;
      if (!operations) throw new Error("Missing fixture request context.");
      const agent = new ToolAgent(threadId, operations.recorder).use(
        (input, next) =>
          next.run({
            ...input,
            forwardedProps: { fixture: `via-middleware-${runId}` },
          }),
      );
      return lastValueFrom(
        runner
          .run({
            threadId,
            agent,
            input: {
              threadId,
              runId,
              messages: [],
              state: {},
              tools: [],
              context: [],
              forwardedProps: {},
            },
          })
          .pipe(toArray()),
      );
    });
  const left = run(leftThread, "left");
  await leftStarted.promise;
  await run(rightThread, "right");
  expect(
    await withLocalActorContext(actor, () =>
      runner.stop({ threadId: leftThread, runId: "left" }),
    ),
  ).toBe(true);
  expect(await blocked.promise).toBeInstanceOf(LocalExecutionLeaseError);
  expect((await left).at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    code: "STOPPED",
  });
  const leftHistory = () =>
    store.readHistory({ threadId: leftThread, actorId: ownerId });
  const rightHistory = await store.readHistory({
    threadId: rightThread,
    actorId: ownerId,
  });
  const stopped = await leftHistory();
  expect(stopped.attempts[0]?.status).toBe("interrupted");
  expect(stopped.operations).toMatchObject([
    {
      attemptId: stopped.attempts[0]?.id,
      toolCallId: "same-call-id",
      status: "unknown",
      parameters: { marker: "via-middleware-left" },
    },
  ]);
  expect(rightHistory.operations).toMatchObject([
    {
      attemptId: rightHistory.attempts[0]?.id,
      toolCallId: "same-call-id",
      status: "succeeded",
      parameters: { marker: "via-middleware-right" },
      result: { value: "right" },
    },
  ]);

  await run(leftThread, "next");
  lateResult.resolve("late receipt");
  for (let i = 0; i < 100; i++) {
    if ((await leftHistory()).operations[0]?.status === "succeeded") break;
    await Bun.sleep(5);
  }
  expect((await leftHistory()).operations).toMatchObject([
    {
      id: stopped.operations[0]?.id,
      status: "succeeded",
      result: { value: "late receipt", late: true },
    },
    { status: "succeeded", result: { value: "next" } },
  ]);
});
