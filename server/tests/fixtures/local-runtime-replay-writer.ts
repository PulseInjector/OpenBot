import { z } from "zod";
import { createDatabase } from "../../src/db/client";
import { createLocalRuntimeStore } from "../../src/local-runtime/store";
import { testDatabaseUrl } from "../support/database";

const { actorId, agentId, token } = z
  .object({
    actorId: z.string(),
    agentId: z.string(),
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
  await store.append(token, {
    kind: "event",
    type: "CUSTOM",
    payload: { name: "last", value: "committed" },
  });
  await store.finishAttempt(token, "succeeded");
  const { threadId } = token;
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
    type: "CUSTOM",
    payload: { name: "later", value: "excluded" },
  });
  await store.finishAttempt(laterToken, "succeeded");
} finally {
  await database.$client.close();
}
