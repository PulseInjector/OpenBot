import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/client";
import type {
  TextMessageContentEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, localThreadBindings, users } from "../src/db/schema";
import {
  createLocalRuntimeStore,
  type ExecutionToken,
} from "../src/local-runtime/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `local-fold-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const agentId = `${prefix}-agent`;
const threadIds: string[] = [];
const store = createLocalRuntimeStore(database);

beforeAll(async () => {
  await database.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
  });
  await database.insert(agents).values({
    id: agentId,
    name: "History fold integration Bot",
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

function submission(threadId: string) {
  return {
    threadId,
    ownerUserId: ownerId,
    agentId,
    actorId: ownerId,
    source: "manual" as const,
    requestKey: "request-1",
    requestHash: "hash-1",
  };
}

/** The runner's `eventRecord`: every field except the discriminator the row's type column holds. */
function eventRecord(event: BaseEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "type"),
  );
}

async function record(token: ExecutionToken, event: BaseEvent) {
  await store.append(token, {
    kind: "event",
    type: event.type,
    payload: eventRecord(event),
  });
}

/** The runner's text path: the streamed event, then the `message.upsert` it projects. */
async function recordAssistantText(
  token: ExecutionToken,
  input: { messageId: string; text: string },
) {
  await record(token, {
    type: EventType.TEXT_MESSAGE_START,
    messageId: input.messageId,
    role: "assistant",
  } satisfies TextMessageStartEvent);
  await store.append(token, {
    kind: "message.upsert",
    messageId: input.messageId,
    role: "assistant",
    content: { text: "" },
  });
  await record(token, {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: input.messageId,
    delta: input.text,
  } satisfies TextMessageContentEvent);
  await store.append(token, {
    kind: "message.upsert",
    messageId: input.messageId,
    role: "assistant",
    content: { text: input.text },
  });
}

/** A user question, an assistant answer, and one complete tool call with its result. */
async function seedThreadWithToolTurn() {
  const threadId = thread();
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "fold-writer",
    leaseMs: 30_000,
  });
  await store.append(token, {
    kind: "message.upsert",
    messageId: "question",
    role: "user",
    content: { value: "List the top three stories." },
  });
  await recordAssistantText(token, {
    messageId: "assistant-1",
    text: "Checking the front page.",
  });
  await record(token, {
    type: EventType.TOOL_CALL_START,
    toolCallId: "call-1",
    toolCallName: "web_browse",
    parentMessageId: "assistant-1",
  } satisfies ToolCallStartEvent);
  await record(token, {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "call-1",
    delta: '{"url":',
  } satisfies ToolCallArgsEvent);
  await record(token, {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "call-1",
    delta: ' "https://example.com"}',
  } satisfies ToolCallArgsEvent);
  await record(token, {
    type: EventType.TOOL_CALL_END,
    toolCallId: "call-1",
  } satisfies ToolCallEndEvent);
  await record(token, {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "tool-message-1",
    toolCallId: "call-1",
    content: "Top stories: one, two, three.",
  } satisfies ToolCallResultEvent);
  return threadId;
}

test("a recorded tool call and result fold into the message projection in sequence order", async () => {
  const threadId = await seedThreadWithToolTurn();
  const history = await store.readHistory({
    threadId,
    actorId: ownerId,
    agentId,
  });

  expect(
    history.messages.filter((row) => row.messageId === "assistant-1"),
  ).toHaveLength(1);
  expect(history.messages).toMatchObject([
    {
      threadId,
      messageId: "question",
      role: "user",
      content: { value: "List the top three stories." },
    },
    {
      messageId: "assistant-1",
      role: "assistant",
      content: { text: "Checking the front page." },
      toolCalls: [
        {
          id: "call-1",
          name: "web_browse",
          args: '{"url": "https://example.com"}',
        },
      ],
    },
    {
      messageId: "tool-result:call-1",
      role: "tool",
      toolCallId: "call-1",
      content: { value: "Top stories: one, two, three." },
    },
  ]);
});

test("a call no stored row holds mints an assistant row carrying it", async () => {
  const threadId = thread();
  const { run } = await store.submit(submission(threadId));
  const token = await store.claimAttempt({
    threadId,
    runId: run.id,
    owner: "fold-orphan",
    leaseMs: 30_000,
  });
  await record(token, {
    type: EventType.TOOL_CALL_START,
    toolCallId: "orphan-1",
    toolCallName: "web_browse",
  } satisfies ToolCallStartEvent);
  await record(token, {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "orphan-1",
    delta: '{"url": "https://example.net"}',
  } satisfies ToolCallArgsEvent);
  await record(token, {
    type: EventType.TOOL_CALL_START,
    toolCallId: "orphan-2",
    toolCallName: "web_search",
    parentMessageId: "never-persisted",
  } satisfies ToolCallStartEvent);
  await record(token, {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "tool-message-2",
    toolCallId: "orphan-2",
    content: "Found nothing.",
  } satisfies ToolCallResultEvent);

  const history = await store.readHistory({
    threadId,
    actorId: ownerId,
    agentId,
  });
  expect(history.messages).toMatchObject([
    {
      messageId: "tool-call:orphan-1",
      role: "assistant",
      content: {},
      toolCalls: [
        {
          id: "orphan-1",
          name: "web_browse",
          args: '{"url": "https://example.net"}',
        },
      ],
    },
    {
      messageId: "never-persisted",
      role: "assistant",
      content: {},
      toolCalls: [{ id: "orphan-2", name: "web_search", args: "" }],
    },
    {
      messageId: "tool-result:orphan-2",
      role: "tool",
      toolCallId: "orphan-2",
      content: { value: "Found nothing." },
    },
  ]);
});

test("reading history twice yields the same folded projection", async () => {
  const threadId = await seedThreadWithToolTurn();
  const first = await store.readHistory({
    threadId,
    actorId: ownerId,
    agentId,
  });
  const reopened = createLocalRuntimeStore(database);
  const second = await reopened.readHistory({
    threadId,
    actorId: ownerId,
    agentId,
  });

  expect(second.messages).toEqual(first.messages);
  expect(second.messages.map((row) => row.messageId)).toEqual([
    "question",
    "assistant-1",
    "tool-result:call-1",
  ]);
});
