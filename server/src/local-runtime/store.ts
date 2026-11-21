import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  or,
} from "drizzle-orm";
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
type ThreadScope = { threadId: string; actorId: string; agentId: string };
export type ReplayTarget =
  | { kind: "snapshot"; through: number }
  | { kind: "run" | "thread-through-run"; runId: string };

const defaultLeaseMs = 30_000;
const leaseExpiredReason = "execution lease expired";

function leaseWindowMs(environment: Record<string, string | undefined>) {
  const raw = environment.OPENBOT_LOCAL_LEASE_MS?.trim();
  if (!raw) return defaultLeaseMs;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : defaultLeaseMs;
}

/**
 * One lease window for both the runner's default claim lease and crash settlement, so a run a
 * holder can still renew is never mistaken for a crashed one. `OPENBOT_LOCAL_LEASE_MS` shortens
 * both together for crash-journey speed.
 */
export const LOCAL_LEASE_MS = leaseWindowMs(process.env);

const replaySnapshot = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

async function scopedBinding(db: Database | Transaction, scope: ThreadScope) {
  const [binding] = await db
    .select()
    .from(localThreadBindings)
    .where(
      and(
        eq(localThreadBindings.threadId, scope.threadId),
        eq(localThreadBindings.ownerUserId, scope.actorId),
        eq(localThreadBindings.agentId, scope.agentId),
      ),
    );
  if (!binding)
    throw new LocalRuntimeConflictError("Local thread was not found.");
  return binding;
}

function eventPage(
  db: Database | Transaction,
  input: {
    threadId: string;
    afterSequence: number;
    through: number;
    limit?: number;
    runId?: string;
  },
) {
  return db
    .select()
    .from(localEvents)
    .where(
      and(
        eq(localEvents.threadId, input.threadId),
        gt(localEvents.sequence, input.afterSequence),
        lte(localEvents.sequence, input.through),
        input.runId ? eq(localEvents.runId, input.runId) : undefined,
      ),
    )
    .orderBy(asc(localEvents.sequence))
    .limit(input.limit ?? 100);
}

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
  return attempt;
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
      requireIdleThread?: boolean;
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
        const binding = await lockBinding(transaction, input.threadId);
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

        const [existing] = await transaction
          .select()
          .from(localRuns)
          .where(
            and(
              eq(localRuns.threadId, input.threadId),
              eq(localRuns.requestKey, input.requestKey),
            ),
          );
        if (existing) {
          if (existing.requestHash !== input.requestHash) {
            throw new LocalRuntimeConflictError(
              "The request key was already used for different work.",
            );
          }
          return { run: existing, created: false };
        }
        if (input.requireIdleThread) {
          const [busy] = await transaction
            .select({ id: localRuns.id })
            .from(localRuns)
            .leftJoin(
              localAttempts,
              and(
                eq(localAttempts.runId, localRuns.id),
                eq(localAttempts.generation, binding.executionGeneration),
                eq(localAttempts.status, "running"),
                gt(localAttempts.leaseUntil, now()),
              ),
            )
            .where(
              and(
                eq(localRuns.threadId, input.threadId),
                or(eq(localRuns.status, "queued"), isNotNull(localAttempts.id)),
              ),
            )
            .limit(1);
          if (busy)
            throw new LocalRuntimeConflictError(
              "A run already occupies this local thread.",
            );
        }
        const runId = randomUUID();
        const [run] = await transaction
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
          .returning();
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
        await assertExecutionToken(transaction, token, at, true);
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
              gt(localAttempts.leaseUntil, at),
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

    async requestStopForActor(input: {
      threadId: string;
      actorId: string;
      agentId: string;
      clientRunId?: string;
    }) {
      const clientRunId = input.clientRunId;
      if (!clientRunId?.trim()) return undefined;
      return database.transaction(async (transaction) => {
        const binding = await lockBinding(transaction, input.threadId);
        if (
          !binding ||
          binding.ownerUserId !== input.actorId ||
          binding.agentId !== input.agentId
        ) {
          return undefined;
        }
        const at = now();
        const [active] = await transaction
          .select({ attemptId: localAttempts.id, runId: localRuns.id })
          .from(localAttempts)
          .innerJoin(localRuns, eq(localRuns.id, localAttempts.runId))
          .where(
            and(
              eq(localAttempts.threadId, input.threadId),
              eq(localAttempts.generation, binding.executionGeneration),
              eq(localAttempts.status, "running"),
              eq(localAttempts.stopRequested, false),
              gt(localAttempts.leaseUntil, at),
              eq(localRuns.threadId, input.threadId),
              eq(localRuns.actorId, input.actorId),
              eq(localRuns.requestKey, clientRunId),
              eq(localRuns.status, "running"),
            ),
          )
          .limit(1);
        if (!active) return undefined;
        await transaction
          .update(localAttempts)
          .set({ stopRequested: true })
          .where(eq(localAttempts.id, active.attemptId));
        await appendEvent(transaction, {
          threadId: input.threadId,
          runId: active.runId,
          attemptId: active.attemptId,
          type: "attempt.stop_requested",
          payload: { reason: "user" },
          createdAt: at,
        });
        return active;
      });
    },

    async stopRequested(token: ExecutionToken) {
      const [attempt] = await database
        .select({ stopRequested: localAttempts.stopRequested })
        .from(localAttempts)
        .where(
          and(
            eq(localAttempts.id, token.attemptId),
            eq(localAttempts.threadId, token.threadId),
            eq(localAttempts.runId, token.runId),
            eq(localAttempts.generation, token.generation),
            eq(localAttempts.owner, token.owner),
            eq(localAttempts.status, "running"),
          ),
        );
      return attempt?.stopRequested ?? true;
    },

    async settleLapsedThreadWork(input: {
      threadId: string;
      actorId: string;
      agentId?: string;
    }): Promise<Array<{ runId: string; attemptId: string }>> {
      return database.transaction(async (transaction) => {
        const at = now();
        const binding = await lockBinding(transaction, input.threadId);
        if (
          !binding ||
          binding.ownerUserId !== input.actorId ||
          (input.agentId !== undefined && binding.agentId !== input.agentId)
        ) {
          throw new LocalRuntimeConflictError("Local thread was not found.");
        }
        const candidates = await transaction
          .select()
          .from(localRuns)
          .where(
            and(
              eq(localRuns.threadId, input.threadId),
              inArray(localRuns.status, ["running", "queued"]),
            ),
          )
          .orderBy(asc(localRuns.createdAt));
        const settled: Array<{ runId: string; attemptId: string }> = [];
        for (const run of candidates) {
          const attempts = await transaction
            .select()
            .from(localAttempts)
            .where(eq(localAttempts.runId, run.id))
            .orderBy(asc(localAttempts.createdAt));
          if (
            attempts.some(
              (attempt) =>
                attempt.status === "running" && attempt.leaseUntil > at,
            )
          ) {
            continue;
          }
          const lapsed = attempts.filter(
            (attempt) => attempt.status === "running",
          );
          // A queued run with no attempt may still be moments from its first claim.
          if (
            lapsed.length === 0 &&
            run.createdAt.getTime() > at.getTime() - LOCAL_LEASE_MS
          ) {
            continue;
          }
          if (lapsed.length > 0) {
            await transaction
              .update(localAttempts)
              .set({
                status: "interrupted",
                endReason: leaseExpiredReason,
                finishedAt: at,
              })
              .where(
                and(
                  eq(localAttempts.runId, run.id),
                  eq(localAttempts.status, "running"),
                ),
              );
          }
          await transaction
            .update(localRuns)
            .set({ status: "cancelled", finishedAt: at })
            .where(eq(localRuns.id, run.id));
          const attemptId = lapsed.at(-1)?.id;
          await appendEvent(transaction, {
            threadId: input.threadId,
            runId: run.id,
            attemptId,
            type: "RUN_ERROR",
            payload: {
              threadId: input.threadId,
              runId: run.requestKey,
              code: "STOPPED",
              message: `Run stopped: ${leaseExpiredReason}.`,
            },
            createdAt: at,
          });
          await appendEvent(transaction, {
            threadId: input.threadId,
            runId: run.id,
            attemptId,
            type: "attempt.interrupted",
            payload: { reason: leaseExpiredReason },
            createdAt: at,
          });
          if (attemptId) settled.push({ runId: run.id, attemptId });
        }
        return settled;
      });
    },

    async openThreadReplay(scope: ThreadScope): Promise<ReplayTarget> {
      await this.settleLapsedThreadWork(scope);
      return database.transaction(async (tx) => {
        const binding = await scopedBinding(tx, scope);
        const [active] = await tx
          .select({ id: localRuns.id })
          .from(localRuns)
          .where(
            and(
              eq(localRuns.threadId, scope.threadId),
              inArray(localRuns.status, ["running", "queued"]),
            ),
          )
          .orderBy(
            desc(localRuns.status),
            desc(localRuns.createdAt),
            desc(localRuns.id),
          )
          .limit(1);
        return active
          ? { kind: "thread-through-run", runId: active.id }
          : { kind: "snapshot", through: binding.nextEventSequence - 1 };
      }, replaySnapshot);
    },

    async readReplayPage(
      input: ThreadScope & {
        target: ReplayTarget;
        afterSequence: number;
        limit?: number;
      },
    ) {
      return database.transaction(async (tx) => {
        const binding = await scopedBinding(tx, input);
        const { target } = input;
        let through = binding.nextEventSequence - 1;
        let terminal = target.kind === "snapshot";
        if (target.kind === "snapshot") {
          through = target.through;
        } else {
          const [run] = await tx
            .select({ status: localRuns.status })
            .from(localRuns)
            .where(
              and(
                eq(localRuns.threadId, input.threadId),
                eq(localRuns.id, target.runId),
              ),
            );
          if (!run)
            throw new LocalRuntimeConflictError("Local run was not found.");
          terminal = run.status !== "running" && run.status !== "queued";
          if (terminal && target.kind === "thread-through-run") {
            const [end] = await tx
              .select({ sequence: localEvents.sequence })
              .from(localEvents)
              .where(
                and(
                  eq(localEvents.threadId, input.threadId),
                  eq(localEvents.runId, target.runId),
                  inArray(localEvents.type, [
                    "attempt.succeeded",
                    "attempt.failed",
                    "attempt.interrupted",
                  ]),
                ),
              )
              .orderBy(desc(localEvents.sequence))
              .limit(1);
            if (!end)
              throw new LocalRuntimeConflictError(
                "Local run has no terminal event.",
              );
            through = end.sequence;
          }
        }
        const limit = input.limit ?? 100;
        const rows = await eventPage(tx, {
          ...input,
          through,
          limit: limit + 1,
          runId: target.kind === "run" ? target.runId : undefined,
        });
        return {
          events: rows.slice(0, limit),
          more: rows.length > limit,
          terminal,
        };
      }, replaySnapshot);
    },

    async readEventsAfter(
      input: ThreadScope & { afterSequence: number; limit?: number },
    ) {
      return database.transaction(async (tx) => {
        const binding = await scopedBinding(tx, input);
        return eventPage(tx, {
          ...input,
          through: binding.nextEventSequence - 1,
        });
      }, replaySnapshot);
    },

    async readBinding(input: { threadId: string; actorId: string }) {
      const [binding] = await database
        .select()
        .from(localThreadBindings)
        .where(
          and(
            eq(localThreadBindings.threadId, input.threadId),
            eq(localThreadBindings.ownerUserId, input.actorId),
          ),
        );
      if (!binding)
        throw new LocalRuntimeConflictError("Local thread was not found.");
      return binding;
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
      detail?: {
        reason?: string;
        resultRef?: string;
        clientRunId?: string;
        errorAlreadyEmitted?: boolean;
      },
    ) {
      return database.transaction(async (transaction) => {
        const at = now();
        const attempt = await assertExecutionToken(
          transaction,
          token,
          at,
          true,
        );
        outcome = attempt.stopRequested ? "interrupted" : outcome;
        if (
          detail?.clientRunId &&
          (outcome === "interrupted" ||
            (outcome === "failed" && !detail.errorAlreadyEmitted))
        ) {
          await appendEvent(transaction, {
            threadId: token.threadId,
            runId: token.runId,
            attemptId: token.attemptId,
            type: "RUN_ERROR",
            createdAt: at,
            payload: {
              threadId: token.threadId,
              runId: detail.clientRunId,
              code: outcome === "interrupted" ? "STOPPED" : "LOCAL_RUN_FAILED",
              message:
                outcome === "interrupted"
                  ? "Run stopped by user"
                  : "Local Agent run failed.",
            },
          });
        }
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
        } else {
          await transaction
            .update(localRuns)
            .set({ status: "cancelled", finishedAt: at })
            .where(eq(localRuns.id, token.runId));
        }
        return appendEvent(transaction, {
          threadId: token.threadId,
          runId: token.runId,
          attemptId: token.attemptId,
          type: `attempt.${outcome}`,
          payload: {
            ...(detail?.reason ? { reason: detail.reason } : {}),
            ...(detail?.resultRef ? { resultRef: detail.resultRef } : {}),
          },
          createdAt: at,
        });
      });
    },

    async readHistory(input: {
      threadId: string;
      actorId: string;
      agentId?: string;
    }) {
      await this.settleLapsedThreadWork(input);
      return database.transaction(
        async (transaction) => {
          const [binding] = await transaction
            .select()
            .from(localThreadBindings)
            .where(
              and(
                eq(localThreadBindings.threadId, input.threadId),
                eq(localThreadBindings.ownerUserId, input.actorId),
                input.agentId === undefined
                  ? undefined
                  : eq(localThreadBindings.agentId, input.agentId),
              ),
            );
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
