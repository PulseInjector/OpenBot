import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerRunRequest,
} from "@copilotkit/runtime/v2";
import type { MiddlewareHandler } from "hono";
import { lastValueFrom, of, toArray } from "rxjs";
import type { AppVariables } from "../src/auth/guards";
import { withLocalActorContext } from "../src/local-runtime/actor-context";
import { createLocalRuntimeRoutes } from "../src/local-runtime/routes";
import { LocalAgentRunner } from "../src/local-runtime/runner";

class TestAgent extends AbstractAgent {
  run(_input: RunAgentInput) {
    return of<BaseEvent>({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "message-1",
      delta: "unused",
    });
  }
}

const actor = { actorId: "person-1", role: "user", agentId: "bot-1" };

function runtimeStore(options?: {
  allowedAgentId?: string;
  eventCount?: number;
}) {
  const events = Array.from(
    { length: options?.eventCount ?? 1 },
    (_, index) => ({
      sequence: index + 4,
      type: "TEXT_MESSAGE_CONTENT",
      payload: { messageId: "message-1", delta: `persisted-${index}` },
    }),
  );
  const cursors: number[] = [];
  let claims = 0;
  const run = { id: "run-1", status: "succeeded" as const };
  const store = {
    submit: async () => ({ run, created: false }),
    claimAttempt: async () => {
      claims += 1;
      throw new Error("A completed duplicate must not execute.");
    },
    readHistory: async () => ({
      binding: { agentId: options?.allowedAgentId ?? "bot-1" },
      runs: [],
      attempts: [],
      messages: [],
      events: [],
      operations: [],
    }),
    readEventsAfter: async ({
      afterSequence,
      limit,
    }: {
      afterSequence: number;
      limit: number;
    }) => {
      cursors.push(afterSequence);
      return events
        .filter((event) => event.sequence > afterSequence)
        .slice(0, limit);
    },
    readRun: async () => run,
  };
  return {
    store: store as never,
    cursors,
    get claims() {
      return claims;
    },
  };
}

const runInput: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
};

test("a completed duplicate run replays persisted events without claiming an attempt", async () => {
  const fake = runtimeStore();
  const runner = new LocalAgentRunner(fake.store, async () => true);
  const request: AgentRunnerRunRequest = {
    threadId: runInput.threadId,
    input: runInput,
    agent: new TestAgent({ threadId: runInput.threadId }),
  };
  const events = await withLocalActorContext(actor, () =>
    lastValueFrom(runner.run(request)),
  );

  expect(events).toEqual({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "message-1",
    delta: "persisted-0",
  });
  expect(fake.claims).toBe(0);
});

test("a completed run replays every event across multiple history pages", async () => {
  const fake = runtimeStore({ eventCount: 101 });
  const runner = new LocalAgentRunner(fake.store, async () => true);
  const request: AgentRunnerRunRequest = {
    threadId: runInput.threadId,
    input: runInput,
    agent: new TestAgent({ threadId: runInput.threadId }),
  };
  const events = await withLocalActorContext(actor, () =>
    lastValueFrom(runner.run(request).pipe(toArray())),
  );

  expect(events).toHaveLength(101);
  expect(events.at(-1)).toEqual({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "message-1",
    delta: "persisted-100",
  });
  expect(fake.cursors).toEqual([0, 103]);
});

test("connect resumes strictly after the durable event sequence", async () => {
  const fake = runtimeStore();
  const runner = new LocalAgentRunner(fake.store, async () => true);
  const request: AgentRunnerConnectRequest = {
    threadId: "thread-1",
    headers: { "x-openbot-event-sequence": "3" },
  };
  const events = await withLocalActorContext(actor, () =>
    lastValueFrom(runner.connect(request)),
  );

  expect(events).toEqual({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "message-1",
    delta: "persisted-0",
  });
  expect(fake.cursors).toEqual([3]);
});

function historyRoutes(options?: { allowed?: boolean; agentId?: string }) {
  const actorRecord = {
    id: "person-1",
    email: "person@example.test",
    role: "user",
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actorRecord);
    await next();
  };
  let historyReads = 0;
  let eventReads = 0;
  const store = {
    readHistory: async () => {
      historyReads += 1;
      return {
        binding: { agentId: options?.agentId ?? "bot-1" },
        events: [],
      };
    },
    readEventsAfter: async () => {
      eventReads += 1;
      return [{ sequence: 5, type: "event", payload: {} }];
    },
  };
  return {
    app: createLocalRuntimeRoutes({
      store: store as never,
      requireUser,
      canUseBot: async () => options?.allowed ?? true,
    }),
    reads: () => ({ historyReads, eventReads }),
  };
}

test("history and events require access to the bound Bot", async () => {
  const { app, reads } = historyRoutes({ allowed: false });
  const history = await app.request("/threads/thread-1/history");
  const events = await app.request("/threads/thread-1/events");

  expect(history.status).toBe(404);
  expect(events.status).toBe(404);
  expect(reads()).toEqual({ historyReads: 2, eventReads: 0 });
});

test("event history validates the cursor before reading", async () => {
  const { app, reads } = historyRoutes();
  const response = await app.request("/threads/thread-1/events?after=-1");

  expect(response.status).toBe(400);
  expect(reads()).toEqual({ historyReads: 0, eventReads: 0 });
});

test("authorized event history returns only events after the requested cursor", async () => {
  const { app } = historyRoutes();
  const response = await app.request(
    "/threads/thread-1/events?after=4&limit=10",
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    events: [{ sequence: 5, type: "event", payload: {} }],
  });
});
