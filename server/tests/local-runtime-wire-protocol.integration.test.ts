import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { inArray } from "drizzle-orm";
import { from, lastValueFrom, type Observable } from "rxjs";
import { toArray } from "rxjs/operators";
import { createDatabase } from "../src/db/client";
import { agents, localThreadBindings, users } from "../src/db/schema";
import { withLocalActorContext } from "../src/local-runtime/actor-context";
import { LocalAgentRunner } from "../src/local-runtime/runner";
import { createLocalRuntimeStore } from "../src/local-runtime/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The wire replay against the REAL browser SDK.
 *
 * Everything else in this suite pins rows: what the runner persists, what the fold reconstructs.
 * None of that can catch a stream the consumer rejects, because the consumer — the AG-UI client the
 * app's locked React SDK rides on — enforces protocol order on its own: a run stream must open with
 * RUN_STARTED (or RUN_ERROR) or the client throws the WHOLE stream away at its first event. That is
 * exactly how a run could end `succeeded` with an announced `computer_navigate` that nothing
 * answered (issue #6): the server persisted a legal-looking log, and the browser's live half never
 * received an event. So this file consumes the served endpoint with the same client class the
 * browser uses, and asserts on what that client accepted — not on what the server stored.
 *
 * A surface-owned tool call is the sharpest probe. The agent announces it (TOOL_CALL_START, ARGS,
 * END) and finishes the run with no result; the surface is supposed to receive the call, execute
 * it, and open the follow-up run. If the replay carries anything outside the agent's own run
 * envelope, this test sees a client that owns no tool call at all — the run as the person
 * experienced it: `succeeded`, and a browser action nobody performed.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `local-wire-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const agentId = `${prefix}-agent`;
const store = createLocalRuntimeStore(database);
const threadIds: string[] = [];

beforeAll(async () => {
  await database.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
  });
  await database.insert(agents).values({
    id: agentId,
    name: "Wire protocol integration Bot",
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

/** The agent's own stream: everything the wire is allowed to carry, in order. */
function announcedRun(request: Pick<RunAgentInput, "threadId" | "runId">) {
  const call = "call_wire_1";
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: request.threadId,
      runId: request.runId,
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg_wire_1",
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg_wire_1",
      delta: "I'll open that page now.",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: "msg_wire_1" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: call,
      toolCallName: "computer_navigate",
      parentMessageId: "msg_wire_1",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: call,
      delta: '{"url":"https://example.com"}',
    },
    { type: EventType.TOOL_CALL_END, toolCallId: call },
    {
      type: EventType.RUN_FINISHED,
      threadId: request.threadId,
      runId: request.runId,
    },
  ] as BaseEvent[];
}

/**
 * The Bot as the runtime sees it: one run that says a line, announces a surface-owned call, and
 * finishes. Deliberately identical in shape to what the built-in agent streamed in the reported
 * run — including the detail that made the defect invisible server-side: no TOOL_CALL_RESULT, and
 * a clean finish. The missing half is the consumer's to notice.
 */
class AnnouncingAgent extends AbstractAgent {
  run(request: RunAgentInput): Observable<BaseEvent> {
    return from(announcedRun(request));
  }
}

/**
 * Resolve the same public core package the app's locked React SDK imports, so this suite exercises
 * the identical client the browser runs rather than whatever the server happens to depend on.
 */
async function loadBrowserSDK(): Promise<{
  ProxiedCopilotRuntimeAgent: new (config: {
    agentId: string;
    threadId: string;
    runtimeUrl: string;
    runtimeMode: "sse";
    transport: "rest";
  }) => AbstractAgent & {
    messages: RunAgentInput["messages"];
    runAgent: (input: RunAgentInput) => Promise<unknown>;
    subscribe: (handlers: {
      onRunErrorEvent: (input: { event?: { message?: unknown } }) => void;
    }) => { unsubscribe: () => void };
  };
}> {
  const appRequire = createRequire(
    new URL("../../app/package.json", import.meta.url),
  );
  const reactRequire = createRequire(
    appRequire.resolve("@copilotkit/react-core"),
  );
  return import(reactRequire.resolve("@copilotkit/core"));
}

/**
 * The durable stack exactly as local mode mounts it, with the actor context the routes would wrap
 * the request in. One runner for the process, like the server; a fresh port per test.
 */
function serveLocalRuntime() {
  const runner = new LocalAgentRunner(store, async () => true, 30_000, 10);
  const runtime = new CopilotRuntime({
    agents: { [agentId]: new AnnouncingAgent() },
    runner,
  });
  const routes = createCopilotHonoHandler({ runtime, basePath: "/copilot" });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      withLocalActorContext(
        { actorId: ownerId, role: "user", agentId },
        () => routes.fetch(request),
      ),
  });
}

function runInput(threadId: string): RunAgentInput {
  return {
    threadId,
    runId: `wire-run-${randomUUID()}`,
    messages: [{ id: "question", role: "user", content: "Open the page." }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

test("the real browser SDK receives a run that announces a surface-owned call", async () => {
  const threadId = thread();
  const { ProxiedCopilotRuntimeAgent } = await loadBrowserSDK();
  await using server = serveLocalRuntime();
  const agent = new ProxiedCopilotRuntimeAgent({
    agentId,
    threadId,
    runtimeUrl: new URL("/copilot", server.url).href,
    runtimeMode: "sse",
    transport: "rest",
  });
  const rejected: string[] = [];
  const subscription = agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      rejected.push(String(event?.message));
    },
  });
  try {
    await agent.runAgent(runInput(threadId));
  } finally {
    subscription.unsubscribe();
  }
  // The whole point: what the client ACCEPTED, not what the server stored.
  expect(rejected).toEqual([]);
  const announced = agent.messages.find(
    (message) =>
      message.role === "assistant" &&
      Array.isArray((message as { toolCalls?: unknown[] }).toolCalls),
  ) as
    | {
        toolCalls: {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }[];
      }
    | undefined;
  expect(announced?.toolCalls).toEqual([
    {
      id: "call_wire_1",
      type: "function",
      function: {
        name: "computer_navigate",
        arguments: '{"url":"https://example.com"}',
      },
    },
  ]);
  expect(
    agent.messages.find((message) => message.id === "msg_wire_1")?.content,
  ).toBe("I'll open that page now.");
});

test("the run replay carries only the agent's own run envelope", async () => {
  const threadId = thread();
  const actor = { actorId: ownerId, role: "user", agentId };
  const runner = new LocalAgentRunner(store, async () => true, 30_000, 10);
  const events = await withLocalActorContext(actor, () =>
    lastValueFrom(
      runner
        .run({
          threadId,
          agent: new AnnouncingAgent(),
          input: runInput(threadId),
        })
        .pipe(toArray()),
    ),
  );
  // The envelope and nothing else: no bookkeeping before RUN_STARTED, no verdict after
  // RUN_FINISHED, no input projections either side of the agent's stream. Exactly what the
  // protocol-following consumer is allowed to see, in the order it requires.
  expect(events.map((event) => event.type as string)).toEqual([
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "RUN_FINISHED",
  ]);
});
