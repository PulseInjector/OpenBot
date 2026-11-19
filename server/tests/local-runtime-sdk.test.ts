import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { from, Observable } from "rxjs";

const threadId = "thread-sdk";
const agentId = "bot-sdk";
const runId = "client-run-sdk";
const input = {
  threadId,
  runId,
  messages: [{ id: "question", role: "user", content: "Hello" }],
  state: { restored: true },
  tools: [],
  context: [],
  forwardedProps: {},
} satisfies RunAgentInput;

function answer(run: RunAgentInput, delta: string) {
  return [
    { type: EventType.RUN_STARTED, threadId: run.threadId, runId: run.runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: run.runId,
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: run.runId, delta },
    { type: EventType.TEXT_MESSAGE_END, messageId: run.runId },
    { type: EventType.RUN_FINISHED, threadId: run.threadId, runId: run.runId },
  ];
}

class ContractAgent extends AbstractAgent {
  run(request: RunAgentInput) {
    return from(
      answer(request, String(request.forwardedProps?.middleware ?? "raw")),
    );
  }
}

class ContractRunner extends AgentRunner {
  constructor(private readonly events: BaseEvent[] = []) {
    super();
  }

  readonly stops = Promise.withResolvers<AgentRunnerStopRequest>();
  readonly started = Promise.withResolvers<AgentRunnerRunRequest>();

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this.started.resolve(request);
      void request.agent
        .runAgent(request.input, {
          onEvent: ({ event }) => subscriber.next(event),
        })
        .then(
          () => subscriber.complete(),
          (error: unknown) => subscriber.error(error),
        );
    });
  }

  connect() {
    return from(this.events);
  }

  async isRunning() {
    return false;
  }

  async stop(request: AgentRunnerStopRequest) {
    this.stops.resolve(request);
    return true;
  }
}

function serve(runner: AgentRunner, agent: AbstractAgent) {
  const runtime = new CopilotRuntime({ agents: { [agentId]: agent }, runner });
  const routes = createCopilotHonoHandler({ runtime, basePath: "/copilot" });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
}

// Resolve the same public core package the app's locked React SDK imports.
async function loadBrowserSDK(): Promise<{
  CopilotKitCore: new (config: {
    deferInitialConnection: boolean;
  }) => {
    connectAgent: (input: { agent: AbstractAgent }) => Promise<unknown>;
  };
  ProxiedCopilotRuntimeAgent: new (config: {
    agentId: string;
    threadId: string;
    runtimeUrl: string;
    runtimeMode: "sse";
    transport: "rest";
  }) => AbstractAgent;
}> {
  const appRequire = createRequire(
    new URL("../../app/package.json", import.meta.url),
  );
  const reactRequire = createRequire(
    appRequire.resolve("@copilotkit/react-core"),
  );
  return import(reactRequire.resolve("@copilotkit/core"));
}

test("the runtime-prepared Agent runs its middleware and configured callbacks through runAgent", async () => {
  const calls: string[] = [];
  const agent = new ContractAgent().use((request, next) =>
    next.run({
      ...request,
      forwardedProps: { ...request.forwardedProps, middleware: "configured" },
    }),
  );
  agent.subscribe({
    onRunInitialized: ({ input }) => {
      calls.push(input.runId);
      expect(input.messages).toEqual([
        { id: "question", role: "user", content: "Hello" },
      ]);
      expect(input.state).toEqual({ restored: true });
    },
    onRunFinalized: () => {
      calls.push("finalized");
    },
  });
  const runner = new ContractRunner();
  await using server = serve(runner, agent);
  const response = await fetch(
    new URL(`/copilot/agent/${agentId}/run`, server.url),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"delta":"configured"');
  expect(calls).toEqual([runId, "finalized"]);
  expect((await runner.started.promise).agent).not.toBe(agent);
});

test("ordinary local chat resets state on restore and reconstructs it via the existing connect route", async () => {
  const { CopilotKitCore, ProxiedCopilotRuntimeAgent } = await loadBrowserSDK();
  const snapshot = [
    { type: EventType.MESSAGES_SNAPSHOT, messages: input.messages },
    { type: EventType.STATE_SNAPSHOT, snapshot: input.state },
    ...answer(input, "First"),
    ...answer({ ...input, runId: "later-run" }, "Second"),
  ];
  const runner = new ContractRunner(snapshot);
  await using server = serve(runner, new ContractAgent());
  const agent = new ProxiedCopilotRuntimeAgent({
    agentId,
    threadId,
    runtimeUrl: new URL("/copilot", server.url).href,
    runtimeMode: "sse",
    transport: "rest",
  });
  agent.setMessages([{ id: "stale", role: "assistant", content: "Stale" }]);
  agent.setState({ stale: true });
  const beforeReplay: unknown[] = [];
  agent.subscribe({
    onRunInitialized: ({ input }) => {
      beforeReplay.push(input.messages, input.state);
    },
  });
  await new CopilotKitCore({ deferInitialConnection: true }).connectAgent({
    agent,
  });
  expect(beforeReplay).toEqual([[], {}]);
  expect(
    agent.messages.map((message) => [message.id, message.content]),
  ).toEqual([
    ["question", "Hello"],
    [runId, "First"],
    ["later-run", "Second"],
  ]);
  expect(agent.state).toEqual({ restored: true });
});

test("the browser's Stop supplies the exact client run ID to the existing Stop route", async () => {
  const { ProxiedCopilotRuntimeAgent } = await loadBrowserSDK();
  class WaitingAgent extends AbstractAgent {
    run(request: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        const started = {
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        };
        subscriber.next(started);
      });
    }
  }
  const runner = new ContractRunner();
  await using server = serve(runner, new WaitingAgent());
  const agent = new ProxiedCopilotRuntimeAgent({
    agentId,
    threadId,
    runtimeUrl: new URL("/copilot", server.url).href,
    runtimeMode: "sse",
    transport: "rest",
  });
  const running = agent.runAgent(input);
  try {
    const request = await runner.started.promise;
    expect(request.input.runId).toBe(runId);
    agent.abortRun();
    expect(await runner.stops.promise).toEqual({ threadId, runId });
  } finally {
    await (await runner.started.promise).agent.detachActiveRun();
    await running;
  }
});
