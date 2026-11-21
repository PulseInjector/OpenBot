import { expect, test } from "bun:test";
import { AbstractAgent, EventType, type RunAgentInput } from "@ag-ui/client";
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
    return of({
      type: EventType.TEXT_MESSAGE_CONTENT,
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
    openThreadReplay: async () => ({
      kind: "snapshot",
      through: events.at(-1)?.sequence,
    }),
    readReplayPage: async ({ afterSequence }: { afterSequence: number }) => {
      cursors.push(afterSequence);
      const remaining = events.filter(
        (event) => event.sequence > afterSequence,
      );
      return {
        events: remaining.slice(0, 100),
        more: remaining.length > 100,
        terminal: true,
      };
    },
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
    type: EventType.TEXT_MESSAGE_CONTENT,
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
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "message-1",
    delta: "persisted-100",
  });
  expect(fake.cursors).toEqual([0, 103]);
});

test("ordinary connect replays from zero even if a sequence header is present", async () => {
  const fake = runtimeStore();
  const runner = new LocalAgentRunner(fake.store, async () => true);
  const request: AgentRunnerConnectRequest = {
    threadId: "thread-1",
    headers: { "x-openbot-event-sequence": "4", "last-event-id": "4" },
  };
  const events = await withLocalActorContext(actor, () =>
    lastValueFrom(runner.connect(request)),
  );

  expect(events).toEqual({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "message-1",
    delta: "persisted-0",
  });
  expect(fake.cursors).toEqual([0]);
});

function historyRoutes(options?: {
  allowed?: boolean;
  agentId?: string;
  runs?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
}) {
  const actorRecord: AppVariables["actor"] = {
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
  let bindingReads = 0;
  const store = {
    readBinding: async () => {
      bindingReads += 1;
      return { agentId: options?.agentId ?? "bot-1" };
    },
    readHistory: async () => {
      historyReads += 1;
      return {
        binding: { agentId: options?.agentId ?? "bot-1" },
        events: options?.events ?? [],
        runs: options?.runs ?? [],
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
    reads: () => ({ bindingReads, historyReads, eventReads }),
  };
}

test("history, events, and status require access to the bound Bot", async () => {
  const { app, reads } = historyRoutes({ allowed: false });
  const history = await app.request("/threads/thread-1/history");
  const events = await app.request("/threads/thread-1/events");
  const status = await app.request("/threads/thread-1/status");

  expect(history.status).toBe(404);
  expect(events.status).toBe(404);
  expect(status.status).toBe(404);
  expect(reads()).toEqual({ bindingReads: 3, historyReads: 0, eventReads: 0 });
});

test("status returns the derivation over the newest run of the bound thread", async () => {
  const { app } = historyRoutes({
    runs: [{ id: "run-9", status: "succeeded", error: null }],
    events: [{ runId: "run-9", type: "attempt.succeeded", payload: {} }],
  });
  const response = await app.request("/threads/thread-1/status");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: { phase: "succeeded", runId: "run-9" },
  });
});

test("a disagreeing stored pair surfaces as the app's own failure, not a not-found", async () => {
  const { app } = historyRoutes({
    runs: [{ id: "run-9", status: "succeeded", error: null }],
    events: [{ runId: "run-9", type: "attempt.failed", payload: {} }],
  });
  const response = await app.request("/threads/thread-1/status");

  expect(response.status).toBe(500);
});

test("event history validates the cursor before reading", async () => {
  const { app, reads } = historyRoutes();
  const response = await app.request("/threads/thread-1/events?after=-1");

  expect(response.status).toBe(400);
  expect(reads()).toEqual({ bindingReads: 0, historyReads: 0, eventReads: 0 });
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
