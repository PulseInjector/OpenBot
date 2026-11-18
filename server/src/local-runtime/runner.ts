import { createHash, randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  isRecognizedEvent,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { concatMap, endWith, from, lastValueFrom, Observable } from "rxjs";
import { z } from "zod";
import {
  currentLocalActorContext,
  type LocalActorContext,
} from "./actor-context";
import {
  type createLocalRuntimeStore,
  type ExecutionToken,
  LocalRuntimeConflictError,
} from "./store";

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

function actorContext(): LocalActorContext {
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

function eventCursor(request: AgentRunnerConnectRequest): number {
  const raw =
    request.headers?.["x-openbot-event-sequence"] ??
    request.headers?.["last-event-id"] ??
    "0";
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  private readonly activeAgents = new Map<string, AbstractAgent>();
  private readonly owner = `local-runner-${randomUUID()}`;

  constructor(
    private readonly store: LocalRuntimeStore,
    private readonly authorizeBot: LocalBotAuthorizer,
    private readonly leaseMs = 30_000,
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
          });
          if (
            submitted.run.status === "queued" ||
            submitted.run.status === "running"
          ) {
            void this.execute(request, submitted.run.id);
          }
          await this.follow({
            threadId,
            actor,
            runId: submitted.run.id,
            afterSequence: 0,
            subscriber,
          });
        })
        .catch((error: unknown) => subscriber.error(error));
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const actor = actorContext();
      void this.authorizeBot(actor)
        .then(async (allowed) => {
          if (!allowed)
            throw new LocalRuntimeConflictError("Bot access denied.");
          const history = await this.store.readHistory({
            threadId: request.threadId,
            actorId: actor.actorId,
          });
          if (history.binding.agentId !== actor.agentId) {
            throw new LocalRuntimeConflictError("Local thread was not found.");
          }
          const activeRun = [...history.runs]
            .reverse()
            .find((run) => run.status === "queued" || run.status === "running");
          await this.follow({
            threadId: request.threadId,
            actor,
            ...(activeRun ? { runId: activeRun.id } : {}),
            afterSequence: eventCursor(request),
            subscriber,
          });
        })
        .catch((error: unknown) => subscriber.error(error));
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const actor = actorContext();
    if (!(await this.authorizeBot(actor))) return false;
    const history = await this.store.readHistory({
      threadId: request.threadId,
      actorId: actor.actorId,
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
    if (!request.runId || !(await this.authorizeBot(actor))) return false;
    const stopped = await this.store.requestStopForActor({
      threadId: request.threadId,
      actorId: actor.actorId,
      agentId: actor.agentId,
      ...(request.runId ? { runId: request.runId } : {}),
    });
    if (stopped && request.runId) {
      this.activeAgents.get(`${request.threadId}:${request.runId}`)?.abortRun();
    }
    return stopped;
  }

  private async execute(
    request: AgentRunnerRunRequest,
    runId: string,
  ): Promise<void> {
    let token: ExecutionToken | undefined;
    const key = `${request.input.threadId}:${runId}`;
    try {
      token = await this.store.claimAttempt({
        threadId: request.input.threadId,
        runId,
        owner: this.owner,
        leaseMs: this.leaseMs,
      });
      const currentToken = token;
      this.activeAgents.set(key, request.agent);
      const snapshot = inputMessagesEvent(request);
      await this.store.append(currentToken, {
        kind: "event",
        type: snapshot.type,
        payload: eventRecord(snapshot),
      });
      for (const message of request.input.messages) {
        const projection = inputMessage.safeParse(message);
        if (!projection.success) continue;
        await this.store.append(currentToken, {
          kind: "message.upsert",
          messageId: projection.data.id,
          role: projection.data.role,
          content: { value: projection.data.content },
        });
      }
      const messageText = new Map<string, string>();

      let stopCheck: ReturnType<typeof setInterval> | undefined;
      stopCheck = setInterval(
        () => {
          void this.store
            .stopRequested(currentToken)
            .then((stopped) => (stopped ? request.agent.abortRun() : undefined))
            .catch(() => request.agent.abortRun());
          void this.store
            .renewLease(currentToken, this.leaseMs)
            .catch(() => request.agent.abortRun());
        },
        Math.max(100, Math.floor(this.leaseMs / 3)),
      );
      try {
        await lastValueFrom(
          request.agent.run(request.input).pipe(
            concatMap((event) =>
              from(
                this.store.append(currentToken, {
                  kind: "event",
                  type: event.type,
                  payload: eventRecord(event),
                }),
              ).pipe(
                concatMap(async () => {
                  switch (event.type) {
                    case "TEXT_MESSAGE_START": {
                      const start = textMessageStart.safeParse(event);
                      if (!start.success) break;
                      messageText.set(start.data.messageId, "");
                      await this.store.append(currentToken, {
                        kind: "message.upsert",
                        messageId: start.data.messageId,
                        role: start.data.role,
                        content: { text: "" },
                      });
                      break;
                    }
                    case "TEXT_MESSAGE_CONTENT": {
                      const content = textMessageContent.safeParse(event);
                      if (!content.success) break;
                      const text =
                        (messageText.get(content.data.messageId) ?? "") +
                        content.data.delta;
                      messageText.set(content.data.messageId, text);
                      await this.store.append(currentToken, {
                        kind: "message.upsert",
                        messageId: content.data.messageId,
                        role: "assistant",
                        content: { text },
                      });
                      break;
                    }
                  }
                  return event;
                }),
              ),
            ),
            endWith(undefined),
          ),
        );
        const stopped = await this.store.stopRequested(currentToken);
        await this.store.finishAttempt(
          currentToken,
          stopped ? "interrupted" : "succeeded",
        );
      } finally {
        clearInterval(stopCheck);
      }
    } catch (error) {
      if (token) {
        await this.store
          .finishAttempt(token, "failed", {
            reason:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Agent run failed.",
          })
          .catch(() => undefined);
      }
    } finally {
      if (this.activeAgents.get(key) === request.agent) {
        this.activeAgents.delete(key);
      }
    }
  }

  private async follow(input: {
    threadId: string;
    actor: LocalActorContext;
    runId?: string;
    afterSequence: number;
    subscriber: {
      closed: boolean;
      next: (event: BaseEvent) => void;
      complete: () => void;
    };
  }): Promise<void> {
    let cursor = input.afterSequence;
    while (!input.subscriber.closed) {
      const events = await this.store.readEventsAfter({
        threadId: input.threadId,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        afterSequence: cursor,
        ...(input.runId ? { runId: input.runId } : {}),
        limit: 100,
      });
      for (const row of events) {
        cursor = row.sequence;
        const event = eventFromRow(row);
        if (event) input.subscriber.next(event);
      }
      const active = input.runId
        ? await this.store.readRun({
            threadId: input.threadId,
            actorId: input.actor.actorId,
            agentId: input.actor.agentId,
            runId: input.runId,
          })
        : undefined;
      if (events.length === 100) continue;
      if (
        input.runId &&
        (!active || !["queued", "running"].includes(active.status))
      ) {
        input.subscriber.complete();
        return;
      }
      if (!input.runId) {
        if (events.length < 100) {
          input.subscriber.complete();
          return;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}
