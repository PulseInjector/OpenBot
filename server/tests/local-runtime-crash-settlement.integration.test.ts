import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  localAttempts,
  localEvents,
  localRuns,
  localThreadBindings,
  users,
} from "../src/db/schema";
import {
  createLocalRuntimeStore,
  LOCAL_LEASE_MS,
  LocalRuntimeConflictError,
} from "../src/local-runtime/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `local-crash-${randomUUID()}`;
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
    name: "Crash settlement integration Bot",
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

/**
 * Leaves exactly the rows a killed executor leaves: a running attempt whose 200 ms lease has
 * lapsed, with committed work before it and no finishAttempt ever run.
 */
async function crashedRun(threadId: string, requestKey: string) {
  const { run } = await store.submit(submission(threadId, requestKey));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: `crashed-${requestKey}`,
    leaseMs: 200,
  });
  await store.append(token, {
    kind: "message.upsert",
    messageId: `pre-crash-${requestKey}`,
    role: "assistant",
    content: { text: "committed before the crash" },
  });
  await Bun.sleep(250);
  return { run, token };
}

test("reconnect settles a crashed run through each reader and never claims it again", async () => {
  const replayThread = thread();
  const settleThread = thread();
  const historyThread = thread();
  const replayCrash = await crashedRun(replayThread, "replay");
  const settleCrash = await crashedRun(settleThread, "settle");
  const historyCrash = await crashedRun(historyThread, "history");
  const crashes = [
    { threadId: replayThread, ...replayCrash },
    { threadId: settleThread, ...settleCrash },
    { threadId: historyThread, ...historyCrash },
  ];

  for (const crash of crashes) {
    const [row] = await database
      .select({ status: localRuns.status })
      .from(localRuns)
      .where(eq(localRuns.id, crash.run.id));
    expect(row?.status).toBe("running");
  }

  const target = await store.openThreadReplay({
    threadId: replayThread,
    actorId: ownerId,
    agentId,
  });
  expect(target.kind).toBe("snapshot");
  const settled = await store.settleLapsedThreadWork({
    threadId: settleThread,
    actorId: ownerId,
    agentId,
  });
  expect(settled).toEqual([
    { runId: settleCrash.run.id, attemptId: settleCrash.token.attemptId },
  ]);
  const history = await store.readHistory({
    threadId: historyThread,
    actorId: ownerId,
    agentId,
  });
  expect(history.runs[0]?.status).toBe("cancelled");

  for (const crash of crashes) {
    const [runRow] = await database
      .select()
      .from(localRuns)
      .where(eq(localRuns.id, crash.run.id));
    expect(runRow?.status).toBe("cancelled");
    expect(runRow?.finishedAt).not.toBeNull();
    const [attemptRow] = await database
      .select()
      .from(localAttempts)
      .where(eq(localAttempts.id, crash.token.attemptId));
    expect(attemptRow?.status).toBe("interrupted");
    expect(attemptRow?.endReason).toBe("execution lease expired");
    expect(attemptRow?.finishedAt).not.toBeNull();
    const events = await database
      .select()
      .from(localEvents)
      .where(eq(localEvents.runId, crash.run.id))
      .orderBy(asc(localEvents.sequence));
    expect(events.map((event) => event.type)).toEqual([
      "run.queued",
      "attempt.started",
      "message.upsert",
      "RUN_ERROR",
      "attempt.interrupted",
    ]);
    expect(events.at(-1)).toMatchObject({
      attemptId: crash.token.attemptId,
      type: "attempt.interrupted",
      payload: { reason: "execution lease expired" },
    });
    expect(events.at(-2)?.payload).toMatchObject({
      threadId: crash.threadId,
      runId: crash.run.requestKey,
      code: "STOPPED",
    });
    const terminal = events.filter((event) =>
      ["attempt.succeeded", "attempt.failed", "attempt.interrupted"].includes(
        event.type,
      ),
    );
    expect(terminal).toHaveLength(1);
  }

  expect(
    await store.settleLapsedThreadWork({
      threadId: settleThread,
      actorId: ownerId,
      agentId,
    }),
  ).toEqual([]);
  const settleEvents = await database
    .select({ id: localEvents.id })
    .from(localEvents)
    .where(eq(localEvents.runId, settleCrash.run.id));
  expect(settleEvents).toHaveLength(5);
  await expect(
    store.claimAttempt({
      threadId: settleThread,
      runId: settleCrash.run.id,
      owner: "after-crash",
      leaseMs: 30_000,
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);

  const resumed = await store.submit({
    ...submission(replayThread, "after-crash"),
    requireIdleThread: true,
  });
  expect(resumed.created).toBe(true);
  const replayHistory = await store.readHistory({
    threadId: replayThread,
    actorId: ownerId,
    agentId,
  });
  expect(replayHistory.messages).toMatchObject([
    {
      messageId: "pre-crash-replay",
      content: { text: "committed before the crash" },
    },
  ]);

  if (process.env.AOOO_EVIDENCE_DIR) {
    await Bun.write(
      join(process.env.AOOO_EVIDENCE_DIR, "crash-settlement.json"),
      JSON.stringify(
        {
          threads: { replayThread, settleThread, historyThread },
          leaseMs: LOCAL_LEASE_MS,
          settled: crashes.map((crash) => ({
            runId: crash.run.id,
            attemptId: crash.token.attemptId,
            runStatus: "cancelled",
            attemptStatus: "interrupted",
            endReason: "execution lease expired",
            eventsPerRun: 5,
          })),
        },
        null,
        2,
      ),
    );
  }
});

test("settlement spares live work and orphans only queued runs older than the lease window", async () => {
  let currentTime = new Date("2026-11-21T08:00:00.000Z");
  const timedStore = createLocalRuntimeStore(database, {
    now: () => currentTime,
  });
  const orphanThread = thread();
  const { run: orphanRun } = await timedStore.submit(
    submission(orphanThread, "orphan"),
  );
  const freshThread = thread();
  const { run: freshRun } = await timedStore.submit(
    submission(freshThread, "fresh"),
  );
  const liveThread = thread();
  const { run: liveRun } = await timedStore.submit(
    submission(liveThread, "live"),
  );
  await timedStore.claimAttempt({
    threadId: liveThread,
    runId: liveRun.id,
    owner: "live-worker",
    leaseMs: LOCAL_LEASE_MS * 2,
  });

  currentTime = new Date(currentTime.getTime() + LOCAL_LEASE_MS + 1);

  expect(
    await timedStore.settleLapsedThreadWork({
      threadId: orphanThread,
      actorId: ownerId,
      agentId,
    }),
  ).toEqual([]);
  const [orphanRow] = await database
    .select()
    .from(localRuns)
    .where(eq(localRuns.id, orphanRun.id));
  expect(orphanRow?.status).toBe("cancelled");
  const orphanEvents = await database
    .select()
    .from(localEvents)
    .where(eq(localEvents.runId, orphanRun.id))
    .orderBy(asc(localEvents.sequence));
  expect(orphanEvents.map((event) => event.type)).toEqual([
    "run.queued",
    "RUN_ERROR",
    "attempt.interrupted",
  ]);
  expect(orphanEvents.at(-1)).toMatchObject({
    attemptId: null,
    payload: { reason: "execution lease expired" },
  });
  expect(
    await timedStore.settleLapsedThreadWork({
      threadId: orphanThread,
      actorId: ownerId,
      agentId,
    }),
  ).toEqual([]);
  expect(
    (
      await database
        .select({ id: localEvents.id })
        .from(localEvents)
        .where(eq(localEvents.runId, orphanRun.id))
    ).length,
  ).toBe(3);

  const [freshRow] = await database
    .select({ status: localRuns.status })
    .from(localRuns)
    .where(eq(localRuns.id, freshRun.id));
  expect(freshRow?.status).toBe("queued");
  expect(
    await database
      .select({ id: localEvents.id })
      .from(localEvents)
      .where(eq(localEvents.runId, freshRun.id)),
  ).toHaveLength(1);

  expect(
    await timedStore.settleLapsedThreadWork({
      threadId: liveThread,
      actorId: ownerId,
    }),
  ).toEqual([]);
  const [liveRow] = await database
    .select({ status: localRuns.status })
    .from(localRuns)
    .where(eq(localRuns.id, liveRun.id));
  expect(liveRow?.status).toBe("running");
  expect(
    await database
      .select({ id: localEvents.id })
      .from(localEvents)
      .where(eq(localEvents.runId, liveRun.id)),
  ).toHaveLength(2);

  await expect(
    timedStore.settleLapsedThreadWork({
      threadId: orphanThread,
      actorId: `${ownerId}-other`,
      agentId,
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
  await expect(
    timedStore.settleLapsedThreadWork({
      threadId: orphanThread,
      actorId: ownerId,
      agentId: `${agentId}-other`,
    }),
  ).rejects.toBeInstanceOf(LocalRuntimeConflictError);
});

test("the shared lease window keeps the production default unless the environment overrides it", () => {
  expect(Number.isSafeInteger(LOCAL_LEASE_MS)).toBe(true);
  expect(LOCAL_LEASE_MS).toBeGreaterThan(0);
  if (process.env.OPENBOT_LOCAL_LEASE_MS === undefined) {
    expect(LOCAL_LEASE_MS).toBe(30_000);
  }
});
