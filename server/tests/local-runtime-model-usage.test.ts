import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
  type TokenUsage,
} from "@ag-ui/client";
import type { AgentRunnerRunRequest } from "@copilotkit/runtime/v2";
import { finalize, lastValueFrom, of, toArray } from "rxjs";
import { withLocalActorContext } from "../src/local-runtime/actor-context";
import { LocalAgentRunner } from "../src/local-runtime/runner";
import type {
  AttemptOutcome,
  ExecutionToken,
  RuntimeEventInput,
} from "../src/local-runtime/store";

const actor = { actorId: "person-1", role: "user", agentId: "bot-1" };
const runInput: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
};

type StoreCall =
  | { kind: "append"; type: string; payload: Record<string, unknown> }
  | { kind: "finish"; outcome: AttemptOutcome };

function executingStore() {
  const calls: StoreCall[] = [];
  let settled = false;
  const token: ExecutionToken = {
    threadId: runInput.threadId,
    runId: "run-1",
    attemptId: "attempt-1",
    owner: "test-owner",
    generation: 0,
  };
  const store = {
    async submit() {
      return { created: true, run: { id: "run-1" } };
    },
    async claimAttempt() {
      return token;
    },
    async stopRequested() {
      return false;
    },
    async renewLease() {
      return new Date(Date.now() + 30_000);
    },
    async append(_token: ExecutionToken, input: RuntimeEventInput) {
      calls.push(
        input.kind === "event"
          ? { kind: "append", type: input.type, payload: input.payload }
          : { kind: "append", type: input.kind, payload: {} },
      );
      return { sequence: calls.length };
    },
    async finishAttempt(_token: ExecutionToken, outcome: AttemptOutcome) {
      settled = true;
      calls.push({ kind: "finish", outcome });
    },
    async readReplayPage() {
      return { events: [], more: false, terminal: settled };
    },
  };
  return { store: store as never, calls };
}

class UsageAgent extends AbstractAgent {
  finished = false;

  constructor(private readonly events: BaseEvent[]) {
    super({ threadId: runInput.threadId });
  }

  run(_input: RunAgentInput) {
    return of(...this.events).pipe(
      finalize(() => {
        this.finished = true;
      }),
    );
  }
}

function finishedEvent(usage?: TokenUsage[]): BaseEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: runInput.threadId,
    runId: runInput.runId,
    ...(usage === undefined ? {} : { usage }),
  };
}

function runEvents(usage?: TokenUsage[]): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: runInput.threadId,
      runId: runInput.runId,
    },
    finishedEvent(usage),
  ];
}

async function runAgent(events: BaseEvent[]) {
  const agent = new UsageAgent(events);
  const fake = executingStore();
  const runner = new LocalAgentRunner(fake.store, async () => true, 30_000, 1);
  const request: AgentRunnerRunRequest = {
    threadId: runInput.threadId,
    input: runInput,
    agent,
  };
  await withLocalActorContext(actor, () =>
    lastValueFrom(runner.run(request).pipe(toArray())),
  );
  return { agent, calls: fake.calls };
}

function usageCalls(calls: StoreCall[]) {
  return calls.filter(
    (call): call is Extract<StoreCall, { kind: "append" }> =>
      call.kind === "append" && call.type === "model.usage",
  );
}

test("records one model.usage event after the finished event and before the attempt settles", async () => {
  const { agent, calls } = await runAgent(
    runEvents([
      {
        provider: "openai",
        model: "gpt-test",
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    ]),
  );

  expect(agent.finished).toBe(true);
  expect(
    calls.map((call) =>
      call.kind === "append" ? call.type : `finish:${call.outcome}`,
    ),
  ).toEqual([
    "MESSAGES_SNAPSHOT",
    "STATE_SNAPSHOT",
    "RUN_STARTED",
    "RUN_FINISHED",
    "model.usage",
    "finish:succeeded",
  ]);
  expect(usageCalls(calls)).toEqual([
    {
      kind: "append",
      type: "model.usage",
      payload: {
        provider: "openai",
        model: "gpt-test",
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    },
  ]);
});

test("keeps fields absent when the provider reports no value for them", async () => {
  const { calls } = await runAgent(
    runEvents([{ inputTokens: 7, totalTokens: 7 }]),
  );

  const [usage] = usageCalls(calls);
  expect(Object.keys(usage?.payload ?? {})).toEqual([
    "inputTokens",
    "totalTokens",
  ]);
  expect(usage?.payload).toEqual({ inputTokens: 7, totalTokens: 7 });
});

test("writes no usage event when the finished event carries no usage", async () => {
  const { calls } = await runAgent(runEvents());

  expect(usageCalls(calls)).toEqual([]);
  expect(calls.at(-1)).toEqual({ kind: "finish", outcome: "succeeded" });
});

test("sums repeated calls for one model into a single usage event", async () => {
  const { calls } = await runAgent(
    runEvents([
      {
        provider: "openai",
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      { provider: "openai", model: "gpt-test", inputTokens: 5, totalTokens: 6 },
    ]),
  );

  expect(usageCalls(calls)).toEqual([
    {
      kind: "append",
      type: "model.usage",
      payload: {
        provider: "openai",
        model: "gpt-test",
        inputTokens: 15,
        outputTokens: 2,
        totalTokens: 18,
      },
    },
  ]);
});
