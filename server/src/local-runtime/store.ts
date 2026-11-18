import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  localAttempts,
  localEvents,
  localMessages,
  localOperations,
  localRuns,
  localThreadBindings,
} from "../db/schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type LocalRunSource = "manual" | "routine" | "event" | "internal";
export type AttemptOutcome = "succeeded" | "failed" | "interrupted";

export type ExecutionToken = {
  threadId: string;
  runId: string;
  attemptId: string;
  owner: string;
  generation: number;
};

export type RuntimeEventInput =
  | {
      kind: "message.upsert";
      messageId: string;
      role: string;
      content: Record<string, unknown>;
    }
  | { kind: "message.delete"; messageId: string }
  | { kind: "event"; type: string; payload: Record<string, unknown> };

export class LocalRuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRuntimeConflictError";
  }
}

export class LocalExecutionLeaseError extends Error {
  constructor(message = "The local thread execution lease is not current.") {
    super(message);
    this.name = "LocalExecutionLeaseError";
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function appendEvent(
  transaction: Transaction,
  input: {
    threadId: string;
    runId?: string;
    attemptId?: string;
    type: string;
    messageId?: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  },
) {
  const [binding] = await transaction
    .select({ nextEventSequence: localThreadBindings.nextEventSequence })
    .from(localThreadBindings)
    .where(eq(localThreadBindings.threadId, input.threadId));
  if (!binding) throw new LocalRuntimeConflictError("Unknown local thread.");

  const sequence = binding.nextEventSequence;
  await transaction
    .update(localThreadBindings)
    .set({
      nextEventSequence: sequence + 1,
      updatedAt: input.createdAt,
    })
    .where(eq(localThreadBindings.threadId, input.threadId));
  const [event] = await transaction
    .insert(localEvents)
    .values({
      id: randomUUID(),
      threadId: input.threadId,
      sequence,
      runId: input.runId,
      attemptId: input.attemptId,
      type: input.type,
      messageId: input.messageId,
      payload: input.payload,
      createdAt: input.createdAt,
    })
    .returning();
  return event;
}

async function lockBinding(transaction: Transaction, threadId: string) {
  const [binding] = await transaction
    .select()
    .from(localThreadBindings)
    .where(eq(localThreadBindings.threadId, threadId))
    .for("update");
  return binding;
}

async function assertExecutionToken(
  transaction: Transaction,
  token: ExecutionToken,
  now: Date,
  allowStopRequested = false,
) {
  const binding = await lockBinding(transaction, token.threadId);
  if (!binding || binding.executionGeneration !== token.generation) {
    throw new LocalExecutionLeaseError();
  }
  const [attempt] = await transaction
    .select()
    .from(localAttempts)
    .where(
      and(
        eq(localAttempts.id, token.attemptId),
        eq(localAttempts.threadId, token.threadId),
        eq(localAttempts.runId, token.runId),
        eq(localAttempts.generation, token.generation),
        eq(localAttempts.owner, token.owner),
        eq(localAttempts.status, "running"),
        ...(allowStopRequested ? [] : [eq(localAttempts.stopRequested, false)]),
        gt(localAttempts.leaseUntil, now),
      ),
    );
  if (!attempt) throw new LocalExecutionLeaseError();
}

export function createLocalRuntimeStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  async function recordMessageProjection(
    transaction: Transaction,
    threadId: string,
    sequence: number,
    event: RuntimeEventInput,
    at: Date,
  ) {
    if (event.kind === "message.upsert") {
      await transaction
        .insert(localMessages)
        .values({
          threadId,
          messageId: event.messageId,
          role: event.role,
          content: event.content,
          lastSequence: sequence,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [localMessages.threadId, localMessages.messageId],
          set: {
            role: event.role,
            content: event.content,
            lastSequence: sequence,
            updatedAt: at,
          },
        });
    } else if (event.kind === "message.delete") {
      await transaction
        .delete(localMessages)
        .where(
          and(
            eq(localMessages.threadId, threadId),
            eq(localMessages.messageId, event.messageId),
          ),
        );
    }
  }

  return {
    async submit(input: {
      threadId: string;
      ownerUserId: string;
      agentId: string;
      actorId: string;
      source: LocalRunSource;
      requestKey: string;
      requestHash: string;
      businessRef?: string;
    }) {
      return database.transaction(async (transaction) => {
        const at = now();
        await transaction
          .insert(localThreadBindings)
          .values({
            threadId: input.threadId,
            ownerUserId: input.ownerUserId,
            agentId: input.agentId,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoNothing();
        const [binding] = await transaction
          .select()
          .from(localThreadBindings)
          .where(eq(localThreadBindings.threadId, input.threadId));
        if (
          !binding ||
          binding.ownerUserId !== input.ownerUserId ||
          binding.agentId !== input.agentId
        ) {
          throw new LocalRuntimeConflictError(
            "The thread is already bound to a different owner or Bot.",
          );
        }
        if (binding.ownerUserId !== input.actorId) {
          throw new LocalRuntimeConflictError(
            "The actor cannot submit work to this thread.",
          );
        }

        const runId = randomUUID();
        const [inserted] = await transaction
          .insert(localRuns)
          .values({
            id: runId,
            threadId: input.threadId,
            actorId: input.actorId,
            source: input.source,
            requestKey: input.requestKey,
            requestHash: input.requestHash,
            businessRef: input.businessRef,
            status: "queued",
            createdAt: at,
          })
          .onConflictDoNothing({
            target: [localRuns.threadId, localRuns.requestKey],
          })
          .returning();
        if (!inserted) {
          const [existing] = await transaction
            .select()
            .from(localRuns)
            .where(
              and(
                eq(localRuns.threadId, input.threadId),
                eq(localRuns.requestKey, input.requestKey),
              ),
            );
          if (!existing) {
            throw new LocalRuntimeConflictError("Run deduplication failed.");
          }
          if (existing.requestHash !== input.requestHash) {
            throw new LocalRuntimeConflictError(
              "The request key was already used for different work.",
            );
          }
          return { run: existing, created: false };
        }
        await lockBinding(transaction, input.threadId);
        const run = inserted;
        if (!run) throw new LocalRuntimeConflictError("Run was not created.");
        await appendEvent(transaction, {
          threadId: input.threadId,
          runId,
          type: "run.queued",
          payload: { requestKey: input.requestKey, source: input.source },
          createdAt: at,
        });
        return { run, created: true };
      });
    },

    async claimAttempt(input: {
      threadId: string;
      runId: string;
      owner: string;
      leaseMs: number;
    }): Promise<ExecutionToken> {
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
        throw new TypeError("leaseMs must be a positive safe integer.");
      }
      return database.transaction(async (transaction) => {
        const at = now();
        const binding = await lockBinding(transaction, input.threadId);
        if (!binding)
          throw new LocalRuntimeConflictError("Unknown local thread.");
        const [run] = await transaction
          .select()
          .from(localRuns)
          .where(
            and(
              eq(localRuns.id, input.runId),
              eq(localRuns.threadId, input.threadId),
            ),
          );
        if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) {
          throw new LocalRuntimeConflictError(
            "Run is not eligible for execution.",
          );
        }
        const [active] = await transaction
          .select({ id: localAttempts.id })
          .from(localAttempts)
          .where(
            and(
              eq(localAttempts.threadId, input.threadId),
              eq(localAttempts.status, "running"),
              gt(localAttempts.leaseUntil, at),
            ),
          );
        if (active) {
          throw new LocalRuntimeConflictError(
            "Another attempt holds the thread execution lease.",
          );
        }
        await transaction
          .update(localAttempts)
          .set({
            status: "lease_expired",
            endReason: "lease expired",
            finishedAt: at,
          })
          .where(
            and(
              eq(localAttempts.threadId, input.threadId),
              eq(localAttempts.status, "running"),
              lte(localAttempts.leaseUntil, at),
            ),
          );
        const generation = binding.executionGeneration + 1;
        await transaction
          .update(localThreadBindings)
          .set({ executionGeneration: generation, updatedAt: at })
          .where(eq(localThreadBindings.threadId, input.threadId));
        const attemptId = randomUUID();
        await transaction.insert(localAttempts).values({
          id: attemptId,
          runId: input.runId,
          threadId: input.threadId,
          generation,
          owner: input.owner,
          leaseUntil: new Date(at.getTime() + input.leaseMs),
          status: "running",
          createdAt: at,
        });
        await transaction
          .update(localRuns)
          .set({ status: "running" })
          .where(eq(localRuns.id, input.runId));
        await appendEvent(transaction, {
          threadId: input.threadId,
          runId: input.runId,
          attemptId,
          type: "attempt.started",
          payload: { generation, owner: input.owner },
          createdAt: at,
        });
        return {
          threadId: input.threadId,
          runId: input.runId,
          attemptId,
          owner: input.owner,
          generation,
        };
      });
    },

    async renewLease(token: ExecutionToken, leaseMs: number): Promise<Date> {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new TypeError("leaseMs must be a positive safe integer.");
      }
      return database.transaction(async (transaction) => {
        const at = now();
        await assertExecutionToken(transaction, token, at);
        const leaseUntil = new Date(at.getTime() + leaseMs);
        await transaction
          .update(localAttempts)
          .set({ leaseUntil })
          .where(eq(localAttempts.id, token.attemptId));
        return leaseUntil;
      });
    },

    async append(token: ExecutionToken, input: RuntimeEventInput) {
      return database.transaction(async (transaction) => {
        const at = now();
        await assertExecutionToken(transaction, token, at);
        const type = input.kind === "event" ? input.type : input.kind;
        const messageId = input.kind === "event" ? undefined : input.messageId;
        const payload =
          input.kind === "message.upsert"
            ? { role: input.role, content: input.content }
            : input.kind === "message.delete"
              ? {}
              : input.payload;
        const event = await appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type,
          messageId,
          payload,
          createdAt: at,
        });
        await recordMessageProjection(
          transaction,
          token.threadId,
          event.sequence,
          input,
          at,
        );
        return event;
      });
    },

    async beginOperation(
      token: ExecutionToken,
      input: {
        toolCallId: string;
        toolName: string;
        target?: string;
        parameters: Record<string, unknown>;
        actorId: string;
      },
    ) {
      return database.transaction(async (transaction) => {
        const at = now();
        await assertExecutionToken(transaction, token, at);
        const [run] = await transaction
          .select({ actorId: localRuns.actorId })
          .from(localRuns)
          .where(eq(localRuns.id, token.runId));
        if (!run || run.actorId !== input.actorId) {
          throw new LocalRuntimeConflictError(
            "The operation actor does not match the submitted run.",
          );
        }
        const [existing] = await transaction
          .select()
          .from(localOperations)
          .where(
            and(
              eq(localOperations.attemptId, token.attemptId),
              eq(localOperations.toolCallId, input.toolCallId),
            ),
          );
        if (existing) {
          const sameIntent =
            existing.toolName === input.toolName &&
            existing.target === (input.target ?? null) &&
            existing.actorId === input.actorId &&
            stableJson(existing.parameters) === stableJson(input.parameters);
          if (!sameIntent) {
            throw new LocalRuntimeConflictError(
              "The tool call id was reused for a different operation.",
            );
          }
          return { operation: existing, created: false };
        }
        const [operation] = await transaction
          .insert(localOperations)
          .values({
            id: randomUUID(),
            threadId: token.threadId,
            runId: token.runId,
            attemptId: token.attemptId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            target: input.target,
            parameters: input.parameters,
            actorId: input.actorId,
            createdAt: at,
          })
          .returning();
        if (!operation)
          throw new LocalRuntimeConflictError("Operation was not created.");
        await appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: "operation.intent",
          payload: { operationId: operation.id, toolName: input.toolName },
          createdAt: at,
        });
        return { operation, created: true };
      });
    },

    async markOperationDispatched(token: ExecutionToken, operationId: string) {
      return database.transaction(async (transaction) => {
        const at = now();
        await assertExecutionToken(transaction, token, at);
        const [operation] = await transaction
          .update(localOperations)
          .set({ dispatched: true, status: "dispatched", dispatchedAt: at })
          .where(
            and(
              eq(localOperations.id, operationId),
              eq(localOperations.threadId, token.threadId),
              eq(localOperations.runId, token.runId),
              eq(localOperations.attemptId, token.attemptId),
              eq(localOperations.status, "intent"),
              eq(localOperations.dispatched, false),
            ),
          )
          .returning();
        if (!operation) {
          throw new LocalRuntimeConflictError(
            "Operation is absent, already dispatched, or already settled.",
          );
        }
        await appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: "operation.dispatched",
          payload: { operationId },
          createdAt: at,
        });
        return operation;
      });
    },

    async requestStop(token: ExecutionToken, reason = "user") {
      return database.transaction(async (transaction) => {
        const at = now();
        const binding = await lockBinding(transaction, token.threadId);
        if (!binding || binding.executionGeneration !== token.generation) {
          throw new LocalExecutionLeaseError();
        }
        const [attempt] = await transaction
          .update(localAttempts)
          .set({ stopRequested: true })
          .where(
            and(
              eq(localAttempts.id, token.attemptId),
              eq(localAttempts.threadId, token.threadId),
              eq(localAttempts.runId, token.runId),
              eq(localAttempts.generation, token.generation),
              eq(localAttempts.owner, token.owner),
              eq(localAttempts.status, "running"),
              eq(localAttempts.stopRequested, false),
            ),
          )
          .returning();
        if (!attempt) return false;
        await appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: "attempt.stop_requested",
          payload: { reason },
          createdAt: at,
        });
        return true;
      });
    },

    async settleOperation(
      token: ExecutionToken,
      operationId: string,
      outcome: "succeeded" | "failed" | "unknown",
      result: Record<string, unknown>,
    ) {
      return database.transaction(async (transaction) => {
        const at = now();
        // A result belongs to the already-dispatched operation. It must settle even after stop
        // or lease expiry; the exact operation identity prevents it from advancing a new attempt.
        await lockBinding(transaction, token.threadId);
        const [operation] = await transaction
          .update(localOperations)
          .set({ status: outcome, result, settledAt: at })
          .where(
            and(
              eq(localOperations.id, operationId),
              eq(localOperations.threadId, token.threadId),
              eq(localOperations.runId, token.runId),
              eq(localOperations.attemptId, token.attemptId),
              inArray(localOperations.status, ["dispatched", "unknown"]),
            ),
          )
          .returning();
        if (!operation) {
          throw new LocalRuntimeConflictError(
            "Only a dispatched operation can receive a result.",
          );
        }
        await appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: `operation.${outcome}`,
          payload: { operationId, result },
          createdAt: at,
        });
        return operation;
      });
    },

    async finishAttempt(
      token: ExecutionToken,
      outcome: AttemptOutcome,
      detail?: { reason?: string; resultRef?: string },
    ) {
      return database.transaction(async (transaction) => {
        const at = now();
        await assertExecutionToken(transaction, token, at, true);
        await transaction
          .update(localAttempts)
          .set({ status: outcome, endReason: detail?.reason, finishedAt: at })
          .where(eq(localAttempts.id, token.attemptId));
        if (outcome === "succeeded" || outcome === "failed") {
          await transaction
            .update(localRuns)
            .set({
              status: outcome,
              resultRef: detail?.resultRef,
              error: outcome === "failed" ? detail?.reason : null,
              finishedAt: at,
            })
            .where(eq(localRuns.id, token.runId));
        }
        return appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: `attempt.${outcome}`,
          payload: detail ?? {},
          createdAt: at,
        });
      });
    },

    async readHistory(input: { threadId: string; actorId: string }) {
      return database.transaction(
        async (transaction) => {
          const [binding] = await transaction
            .select()
            .from(localThreadBindings)
            .where(eq(localThreadBindings.threadId, input.threadId));
          if (!binding || binding.ownerUserId !== input.actorId) {
            throw new LocalRuntimeConflictError("Local thread was not found.");
          }
          const [events, messages, runs] = await Promise.all([
            transaction
              .select()
              .from(localEvents)
              .where(eq(localEvents.threadId, input.threadId))
              .orderBy(asc(localEvents.sequence)),
            transaction
              .select()
              .from(localMessages)
              .where(eq(localMessages.threadId, input.threadId))
              .orderBy(asc(localMessages.lastSequence)),
            transaction
              .select()
              .from(localRuns)
              .where(eq(localRuns.threadId, input.threadId))
              .orderBy(asc(localRuns.createdAt)),
          ]);
          const runIds = runs.map((run) => run.id);
          const [attempts, operations] = runIds.length
            ? await Promise.all([
                transaction
                  .select()
                  .from(localAttempts)
                  .where(inArray(localAttempts.runId, runIds))
                  .orderBy(asc(localAttempts.createdAt)),
                transaction
                  .select()
                  .from(localOperations)
                  .where(inArray(localOperations.runId, runIds))
                  .orderBy(asc(localOperations.createdAt)),
              ])
            : [[], []];
          return { binding, events, messages, runs, attempts, operations };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
