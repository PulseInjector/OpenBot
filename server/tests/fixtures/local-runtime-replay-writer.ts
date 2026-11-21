import { z } from "zod";
import { createDatabase } from "../../src/db/client";
import { createLocalRuntimeStore } from "../../src/local-runtime/store";
import { testDatabaseUrl } from "../support/database";

const { actorId, agentId, requestKey, token } = z
  .object({
    actorId: z.string(),
    agentId: z.string(),
    requestKey: z.string(),
    token: z.object({
      threadId: z.string(),
      runId: z.string(),
      attemptId: z.string(),
      owner: z.string(),
      generation: z.number(),
    }),
  })
  .parse(await Bun.stdin.json());
const database = createDatabase(testDatabaseUrl());
const store = createLocalRuntimeStore(database);
try {
  // What an agent writes, not bare bookkeeping: the wire a protocol-following reader consumes
  // carries only the agent's own run envelope, so the fixture's synthetic events are wrapped in
  // one. See `LocalAgentRunner.follow` for the rule and the run it comes from.
  const { threadId } = token;
  await store.append(token, {
    kind: "event",
    type: "CUSTOM",
    payload: { name: "last", value: "committed" },
  });
  await store.append(token, {
    kind: "event",
    type: "RUN_FINISHED",
    payload: { threadId, runId: requestKey },
  });
  await store.finishAttempt(token, "succeeded");
  const next = await store.submit({
    threadId,
    agentId,
    actorId,
    ownerUserId: actorId,
    source: "manual",
    requestKey: "later",
    requestHash: "later",
  });
  const laterToken = await store.claimAttempt({
    threadId,
    runId: next.run.id,
    owner: "later",
    leaseMs: 30_000,
  });
  await store.append(laterToken, {
    kind: "event",
    type: "RUN_STARTED",
    payload: { threadId, runId: next.run.requestKey },
  });
  await store.append(laterToken, {
    kind: "event",
    type: "CUSTOM",
    payload: { name: "later", value: "excluded" },
  });
  await store.append(laterToken, {
    kind: "event",
    type: "RUN_FINISHED",
    payload: { threadId, runId: next.run.requestKey },
  });
  await store.finishAttempt(laterToken, "succeeded");
} finally {
  await database.$client.close();
}
