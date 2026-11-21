import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Durable ownership and serialization point for one locally-run Copilot thread. */
export const localThreadBindings = pgTable("local_thread_bindings", {
  threadId: text("thread_id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  historyVersion: integer("history_version").notNull().default(1),
  nextEventSequence: bigint("next_event_sequence", { mode: "number" })
    .notNull()
    .default(1),
  executionGeneration: bigint("execution_generation", { mode: "number" })
    .notNull()
    .default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const localRuns = pgTable(
  "local_runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => localThreadBindings.threadId, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    businessRef: text("business_ref"),
    status: text("status").notNull().default("queued"),
    resultRef: text("result_ref"),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("local_runs_thread_request_key_idx").on(
      table.threadId,
      table.requestKey,
    ),
    index("local_runs_thread_created_idx").on(table.threadId, table.createdAt),
  ],
);

export const localAttempts = pgTable(
  "local_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => localRuns.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => localThreadBindings.threadId, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("running"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    endReason: text("end_reason"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("local_attempts_thread_generation_idx").on(
      table.threadId,
      table.generation,
    ),
    index("local_attempts_run_created_idx").on(table.runId, table.createdAt),
    index("local_attempts_expired_idx")
      .on(table.leaseUntil)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const localEvents = pgTable(
  "local_events",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => localThreadBindings.threadId, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    id: text("id").notNull().unique(),
    runId: text("run_id").references(() => localRuns.id, {
      onDelete: "cascade",
    }),
    attemptId: text("attempt_id").references(() => localAttempts.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    messageId: text("message_id"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.sequence] })],
);

export const localMessages = pgTable(
  "local_messages",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => localThreadBindings.threadId, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.messageId] })],
);

export const localOperations = pgTable(
  "local_operations",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => localThreadBindings.threadId, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => localRuns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => localAttempts.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    target: text("target"),
    parameters: jsonb("parameters").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dispatched: boolean("dispatched").notNull().default(false),
    status: text("status").notNull().default("intent"),
    result: jsonb("result"),
    createdAt: createdAt(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("local_operations_attempt_tool_call_idx").on(
      table.attemptId,
      table.toolCallId,
    ),
    index("local_operations_run_created_idx").on(table.runId, table.createdAt),
  ],
);
