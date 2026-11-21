import { createHash, randomUUID } from "node:crypto";
import {
  aggregateTokenUsage,
  type BaseEvent,
  EventType,
  isRecognizedEvent,
  type TokenUsage,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  currentLocalActorContext,
  type LocalActorContext,
} from "./actor-context";
import {
  type createLocalRuntimeStore,
  type ExecutionToken,
  LOCAL_LEASE_MS,
  LocalExecutionLeaseError,
  LocalRuntimeConflictError,
  type ReplayTarget,
} from "./store";
import { localToolOperationRecorder } from "./tool-operations";

type LocalRuntimeStore = ReturnType<typeof createLocalRuntimeStore>;
type LocalBotAuthorizer = (actor: LocalActorContext) => Promise<boolean>;

const persistedEvent = z.object({ type: z.string() }).passthrough();
const textMessageStart = z
  .object({
    type: z.literal("TEXT_MESSAGE_START"),
    messageId: z.string(),
    role: z.string(),
  })
  .passthrough();
const textMessageContent = z
  .object({
    type: z.literal("TEXT_MESSAGE_CONTENT"),
    messageId: z.string(),
    delta: z.string(),
  })
  .passthrough();
const inputMessage = z
  .object({ id: z.string(), role: z.string(), content: z.unknown() })
  .passthrough();
const tokenCount = z.number().int().nonnegative();
const modelUsage = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: tokenCount.optional(),
  outputTokens: tokenCount.optional(),
  totalTokens: tokenCount.optional(),
});
const runFinishedUsage = z
  .object({
    type: z.literal(EventType.RUN_FINISHED),
    usage: z.array(modelUsage).optional(),
  })
  .passthrough();

type ModelUsage = Pick<
  TokenUsage,
  "provider" | "model" | "inputTokens" | "outputTokens" | "totalTokens"
>;

function usageFromFinishedEvent(event: BaseEvent): ModelUsage | undefined {
  const parsed = runFinishedUsage.safeParse(event);
  if (!parsed.success) return undefined;
  const [usage] = aggregateTokenUsage(parsed.data.usage ?? []);
  if (!usage) return undefined;
  return {
    ...(usage.provider === undefined ? {} : { provider: usage.provider }),
    ...(usage.model === undefined ? {} : { model: usage.model }),
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
  };
}

function actorContext() {
  const actor = currentLocalActorContext();
  if (!actor?.actorId || !actor.agentId) {
    throw new LocalRuntimeConflictError("A signed-in actor is required.");
  }
  return actor;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventRecord(event: BaseEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "type"),
  );
}

function eventFromRow(row: {
  type: string;
  payload: Record<string, unknown>;
}): BaseEvent | undefined {
  const parsed = persistedEvent.safeParse({ type: row.type, ...row.payload });
  if (!parsed.success || !isRecognizedEvent(parsed.data)) return undefined;
  return parsed.data;
}

function requestHash(request: AgentRunnerRunRequest): string {
  return createHash("sha256")
    .update(canonicalJson(request.input))
    .digest("hex");
}

function inputMessagesEvent(request: AgentRunnerRunRequest): BaseEvent {
  const parsed = persistedEvent.parse({
    type: "MESSAGES_SNAPSHOT",
    messages: request.input.messages,
  });
  if (!isRecognizedEvent(parsed)) {
    throw new Error("The AG-UI client rejected the message snapshot event.");
  }
  return parsed;
}

/** Runs the existing AbstractAgent while using PostgreSQL as the shared event and lease store. */
export class LocalAgentRunner extends AgentRunner {
  private readonly activeAttempts = new Map<string, () => void>();
  private readonly owner = `local-runner-${randomUUID()}`;

  constructor(
    private readonly store: LocalRuntimeStore,
    private readonly authorizeBot: LocalBotAuthorizer,
    private readonly leaseMs = LOCAL_LEASE_MS,
    private readonly pollMs = 250,
  ) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const actor = actorContext();
      void this.authorizeBot(actor)
        .then(async (allowed) => {
          if (!allowed)
            throw new LocalRuntimeConflictError("Bot access denied.");
          if (!request.input.runId?.trim()) {
            throw new LocalRuntimeConflictError("A stable runId is required.");
          }
          const threadId = request.input.threadId;
          const submitted = await this.store.submit({
            threadId,
            ownerUserId: actor.actorId,
            agentId: actor.agentId,
            actorId: actor.actorId,
            source: "manual",
            requestKey: request.input.runId,
            requestHash: requestHash(request),
            requireIdleThread: true,
          });
          if (submitted.created) {
            void this.execute(request, submitted.run.id, actor).catch(
              (error: unknown) => subscriber.error(error),
            );
          }
          await this.follow({
            threadId,
            actor,
            target: { kind: "run", runId: submitted.run.id },
            subscriber,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof LocalRuntimeConflictError))
            return subscriber.error(error);
          const event = {
            type: EventType.RUN_ERROR,
            code: "LOCAL_RUN_CONFLICT",
            message: error.message,
          };
          subscriber.next(event);
          subscriber.complete();
        });
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const actor = actorContext();
      void this.authorizeBot(actor)
        .then(async (allowed) => {
          if (!allowed)
            throw new LocalRuntimeConflictError("Bot access denied.");
          const target = await this.store.openThreadReplay({
            threadId: request.threadId,
            actorId: actor.actorId,
            agentId: actor.agentId,
          });
          await this.follow({
            threadId: request.threadId,
            actor,
            target,
            subscriber,
          });
        })
        .catch((error: unknown) => {
          if (!(error instanceof LocalRuntimeConflictError))
            return subscriber.error(error);
          // A new thread has no binding yet; inaccessible threads look the same to connect.
          subscriber.complete();
        });
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const actor = actorContext();
    if (!(await this.authorizeBot(actor))) return false;
    const history = await this.store.readHistory({
      threadId: request.threadId,
      actorId: actor.actorId,
      agentId: actor.agentId,
    });
    return (
      history.binding.agentId === actor.agentId &&
      history.attempts.some(
        (attempt) =>
          attempt.status === "running" && attempt.leaseUntil > new Date(),
      )
    );
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const actor = actorContext();
    if (!request.runId?.trim() || !(await this.authorizeBot(actor)))
      return false;
    const stopped = await this.store.requestStopForActor({
      threadId: request.threadId,
      actorId: actor.actorId,
      agentId: actor.agentId,
      clientRunId: request.runId,
    });
    if (!stopped) return false;
    this.activeAttempts.get(stopped.attemptId)?.();
    return true;
  }

  private async execute(
    request: AgentRunnerRunRequest,
    runId: string,
    actor: ReturnType<typeof actorContext>,
  ): Promise<void> {
    let token: ExecutionToken | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      token = await this.store.claimAttempt({
        threadId: request.input.threadId,
        runId,
        owner: this.owner,
        leaseMs: this.leaseMs,
      });
      const currentToken = token;
      const recorder = localToolOperationRecorder({
        store: this.store,
        token: currentToken,
        actorId: actor.actorId,
        authorize: async () => {
          if (await this.store.stopRequested(currentToken)) {
            throw new LocalExecutionLeaseError(
              "This run no longer admits tool operations.",
            );
          }
          if (!(await this.authorizeBot(actor))) {
            throw new LocalRuntimeConflictError("Bot access denied.");
          }
        },
      });
      actor.operations.bind(recorder);
      let stopped = false;
      const stop = () => {
        stopped = true;
        request.agent.abortRun();
        void request.agent.detachActiveRun().catch(() => undefined);
      };
      this.activeAttempts.set(token.attemptId, stop);
      let checking = false;
      let renewAt = 0;
      poll = setInterval(
        () => {
          if (checking) return;
          checking = true;
          void (async () => {
            if (await this.store.stopRequested(currentToken)) stop();
            if (Date.now() >= renewAt) {
              await this.store.renewLease(currentToken, this.leaseMs);
              renewAt = Date.now() + this.leaseMs / 3;
            }
          })()
            .catch(stop)
            .finally(() => {
              checking = false;
            });
        },
        Math.min(this.pollMs, this.leaseMs / 3),
      );
      let errorAlreadyEmitted = false;
      let failure: string | undefined;
      let usage: ModelUsage | undefined;
      try {
        await this.prepareInput(request, currentToken);
        if (stopped || (await this.store.stopRequested(currentToken))) {
          throw new LocalExecutionLeaseError();
        }
        const messageText = new Map<string, string>();
        await request.agent.runAgent(request.input, {
          onEvent: async ({ event }) => {
            if (stopped) return;
            try {
              await this.persistAgentEvent(currentToken, event, messageText);
            } catch (error) {
              if (!(error instanceof LocalExecutionLeaseError)) {
                failure = "Local Agent event could not be persisted.";
              }
              stop();
              return;
            }
            if (event.type === EventType.RUN_FINISHED) {
              usage ??= usageFromFinishedEvent(event);
            }
            if (event.type === "RUN_ERROR") {
              errorAlreadyEmitted = true;
              failure = "Agent reported a run error.";
            }
          },
        });
        if (usage) {
          await this.store.append(currentToken, {
            kind: "event",
            type: "model.usage",
            payload: usage,
          });
        }
      } catch (error) {
        failure =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Agent run failed.";
      }
      await recorder.drain();
      await this.store.finishAttempt(
        currentToken,
        failure === undefined ? "succeeded" : "failed",
        {
          reason: failure,
          clientRunId: request.input.runId,
          errorAlreadyEmitted,
        },
      );
    } finally {
      if (poll !== undefined) clearInterval(poll);
      if (token) this.activeAttempts.delete(token.attemptId);
    }
  }

  private async prepareInput(
    request: AgentRunnerRunRequest,
    token: ExecutionToken,
  ) {
    const snapshot = inputMessagesEvent(request);
    await this.store.append(token, {
      kind: "event",
      type: snapshot.type,
      payload: eventRecord(snapshot),
    });
    await this.store.append(token, {
      kind: "event",
      type: "STATE_SNAPSHOT",
      payload: { snapshot: request.input.state },
    });
    for (const message of request.input.messages) {
      const projection = inputMessage.safeParse(message);
      if (!projection.success) continue;
      await this.store.append(token, {
        kind: "message.upsert",
        messageId: projection.data.id,
        role: projection.data.role,
        content: { value: projection.data.content },
      });
    }
  }

  private async persistAgentEvent(
    token: ExecutionToken,
    event: BaseEvent,
    messageText: Map<string, string>,
  ) {
    await this.store.append(token, {
      kind: "event",
      type: event.type,
      payload: eventRecord(event),
    });
    const start = textMessageStart.safeParse(event);
    if (start.success) {
      const { messageId, role } = start.data;
      messageText.set(messageId, "");
      await this.store.append(token, {
        kind: "message.upsert",
        messageId,
        role,
        content: { text: "" },
      });
    }
    const content = textMessageContent.safeParse(event);
    if (content.success) {
      const { messageId, delta } = content.data;
      const text = (messageText.get(messageId) ?? "") + delta;
      messageText.set(messageId, text);
      await this.store.append(token, {
        kind: "message.upsert",
        messageId,
        role: "assistant",
        content: { text },
      });
    }
  }

  private async follow(input: {
    threadId: string;
    actor: LocalActorContext;
    target: ReplayTarget;
    subscriber: {
      closed: boolean;
      next: (event: BaseEvent) => void;
      complete: () => void;
    };
  }): Promise<void> {
    let cursor = 0;
    while (!input.subscriber.closed) {
      const page = await this.store.readReplayPage({
        threadId: input.threadId,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        afterSequence: cursor,
        target: input.target,
      });
      for (const row of page.events) {
        if (input.subscriber.closed) return;
        const event = eventFromRow(row);
        if (event) input.subscriber.next(event);
        cursor = row.sequence;
      }
      if (page.more) continue;
      if (page.terminal) {
        input.subscriber.complete();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
