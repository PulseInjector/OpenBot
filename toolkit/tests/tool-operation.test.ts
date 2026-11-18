import { expect, test } from "bun:test";
import {
  executeRecordedTool,
  type ToolOperationRecorder,
} from "../src/tool-operation";

function recorder(
  events: string[],
  canRun = () => true,
): ToolOperationRecorder {
  return {
    async authorize(intent) {
      events.push(`authorize:${intent.toolName}:${intent.toolCallId}`);
      if (!canRun()) throw new Error("Stopped before dispatch.");
    },
    async begin(intent) {
      events.push(
        `intent:${intent.toolCallId}:${JSON.stringify(intent.parameters)}`,
      );
      return intent.toolCallId;
    },
    async dispatch(id) {
      events.push(`dispatched:${id}`);
    },
    async settle(id, outcome) {
      events.push(`${outcome}:${id}`);
    },
  };
}

test("records authorization, complete intent, dispatch, and durable result before returning", async () => {
  const events: string[] = [];
  const result = await executeRecordedTool({
    recorder: recorder(events),
    toolCallId: "call-1",
    toolName: "write_page",
    parameters: { pageId: "p1", content: "complete" },
    execute: async () => ({ accepted: true }),
  });
  expect(result).toEqual({ accepted: true });
  expect(events).toEqual([
    "authorize:write_page:call-1",
    'intent:call-1:{"pageId":"p1","content":"complete"}',
    "authorize:write_page:call-1",
    "dispatched:call-1",
    "succeeded:call-1",
  ]);
});

test("rejects partial or missing call identity before dispatch", async () => {
  const events: string[] = [];
  await expect(
    executeRecordedTool({
      recorder: recorder(events),
      toolName: "write_page",
      parameters: { pageId: "p1" },
      execute: async () => "must not run",
    }),
  ).rejects.toThrow("Tool call id is required");
  await expect(
    executeRecordedTool({
      recorder: recorder(events),
      toolCallId: "call-partial",
      toolName: "write_page",
      parameters: undefined,
      execute: async () => "must not run",
    }),
  ).rejects.toThrow("complete JSON object");
  await expect(
    executeRecordedTool({
      recorder: recorder(events),
      toolCallId: "call-missing-required",
      toolName: "write_page",
      parameters: { pageId: "p1" },
      validate: (parameters) => {
        if (!(parameters as Record<string, unknown>).content)
          throw new Error("content is required");
        return parameters;
      },
      execute: async () => "must not run",
    }),
  ).rejects.toThrow("content is required");
  expect(events).toEqual([]);
});

test("a stop between calls closes admission before a second intent is created", async () => {
  const events: string[] = [];
  let admitted = true;
  await executeRecordedTool({
    recorder: recorder(events, () => admitted),
    toolCallId: "call-1",
    toolName: "first",
    parameters: {},
    execute: async () => {
      admitted = false;
      return "saved";
    },
  });
  await expect(
    executeRecordedTool({
      recorder: recorder(events, () => admitted),
      toolCallId: "call-2",
      toolName: "second",
      parameters: {},
      execute: async () => "must not run",
    }),
  ).rejects.toThrow("Stopped before dispatch");
  expect(events).toEqual([
    "authorize:first:call-1",
    "intent:call-1:{}",
    "authorize:first:call-1",
    "dispatched:call-1",
    "succeeded:call-1",
    "authorize:second:call-2",
  ]);
});

test("a dispatched call without a verifiable result settles unknown", async () => {
  const events: string[] = [];
  await expect(
    executeRecordedTool({
      recorder: recorder(events),
      toolCallId: "call-disconnected",
      toolName: "write_page",
      parameters: { pageId: "p1" },
      disconnected: () => true,
      execute: async () => {
        throw new Error("socket closed");
      },
    }),
  ).rejects.toThrow("socket closed");
  expect(events.at(-1)).toBe("unknown:call-disconnected");
});

test("a timed-out operation is unknown first and a late receipt settles that same call", async () => {
  const events: string[] = [];
  let finish: ((value: string) => void) | undefined;
  const result = executeRecordedTool({
    recorder: recorder(events),
    toolCallId: "call-late",
    toolName: "write_page",
    parameters: { pageId: "p1" },
    settlementTimeoutMs: 1,
    execute: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  await expect(result).rejects.toThrow("Tool settlement timed out");
  expect(events.at(-1)).toBe("unknown:call-late");
  finish?.("verified receipt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events.at(-1)).toBe("succeeded:call-late");
});

test("parallel tool calls each have an independent durable operation lifecycle", async () => {
  const events: string[] = [];
  await Promise.all(
    ["left", "right"].map((toolCallId) =>
      executeRecordedTool({
        recorder: recorder(events),
        toolCallId,
        toolName: "read_page",
        parameters: { pageId: toolCallId },
        execute: async (parameters) => ({ pageId: parameters.pageId }),
      }),
    ),
  );
  for (const id of ["left", "right"]) {
    expect(events).toContain(`intent:${id}:{"pageId":"${id}"}`);
    expect(events).toContain(`dispatched:${id}`);
    expect(events).toContain(`succeeded:${id}`);
  }
});
