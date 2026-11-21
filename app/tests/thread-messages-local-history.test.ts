import { describe, expect, test } from "bun:test";
import { readThreadMessages } from "../src/lib/copilot/thread-messages";

/**
 * The local history route returns `local_messages` rows, not messages.
 *
 * `readHistory` selects each row the store's message projection wrote: `messageId`, `role`, and a
 * `content` that holds either `text` (the runner's accumulated answer) or `value` (the content a
 * message came in with). These fixtures are that shape, including the row an assistant turn that
 * only called a tool leaves behind: an empty content object after JSON.
 *
 * A folded row carries the tool turns the store derives at read time: `toolCalls` in its
 * `{id, name, args}` dialect on an assistant row, `toolCallId` on a row a tool result minted.
 */
const threadId = "local-thread";
const agentId = "local-bot";

function projectionRow(input: {
  messageId: string;
  role: string;
  content: Record<string, unknown>;
  lastSequence: number;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  toolCallId?: string;
}) {
  return {
    threadId,
    ...input,
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}

function historyResponse(messages: unknown[]) {
  return Response.json({
    binding: { threadId, agentId },
    events: [],
    messages,
    runs: [],
    attempts: [],
    operations: [],
  });
}

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

async function withFetch(handler: FetchHandler, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, {
    preconnect: original.preconnect,
  });
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function pathOf(input: Parameters<typeof fetch>[0]) {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  ).pathname;
}

describe("restoring a local thread", () => {
  test("a stored run's projection restores through readableTurns", async () => {
    const rows = [
      projectionRow({
        messageId: "question",
        role: "user",
        content: { value: "open hackernews.com and tell me the top 3 stories" },
        lastSequence: 2,
      }),
      projectionRow({
        messageId: "tool-turn",
        role: "assistant",
        content: {},
        lastSequence: 3,
      }),
      projectionRow({
        messageId: "follow-up",
        role: "user",
        content: { value: [{ type: "text", text: "Which one is first?" }] },
        lastSequence: 4,
      }),
      projectionRow({
        messageId: "answer",
        role: "assistant",
        content: { text: "Top 3 stories: one, two, three." },
        lastSequence: 7,
      }),
    ];

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "local", durableHistory: true });
        }
        if (path === `/api/local-runtime/threads/${threadId}/history`) {
          return historyResponse(rows);
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const read = await readThreadMessages(threadId, agentId);

        expect(read.availability).toBe("ready");
        expect(read.unreadable).toBe(0);
        expect(read.messages.map((message) => message.id)).toEqual([
          "question",
          "tool-turn",
          "follow-up",
          "answer",
        ]);
        expect(read.messages[0]?.content).toBe(
          "open hackernews.com and tell me the top 3 stories",
        );
        expect(read.messages[2]?.content).toEqual([
          { type: "text", text: "Which one is first?" },
        ]);
        expect(read.messages[3]?.content).toBe(
          "Top 3 stories: one, two, three.",
        );
        expect(read.messages[1]).toEqual({
          id: "tool-turn",
          role: "assistant",
        });
      },
    );
  });

  test("folded tool rows restore as AG-UI tool call and tool messages", async () => {
    const rows = [
      projectionRow({
        messageId: "question",
        role: "user",
        content: { value: "List the top three stories." },
        lastSequence: 2,
      }),
      projectionRow({
        messageId: "assistant-1",
        role: "assistant",
        content: { text: "Checking the front page." },
        lastSequence: 6,
        toolCalls: [
          {
            id: "call-1",
            name: "web_browse",
            args: '{"url": "https://example.com"}',
          },
        ],
      }),
      projectionRow({
        messageId: "tool-result:call-1",
        role: "tool",
        content: { value: "Top stories: one, two, three." },
        lastSequence: 9,
        toolCallId: "call-1",
      }),
      projectionRow({
        messageId: "tool-only-turn",
        role: "assistant",
        content: {},
        lastSequence: 12,
        toolCalls: [{ id: "call-2", name: "web_search", args: "" }],
      }),
    ];

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "local", durableHistory: true });
        }
        if (path === `/api/local-runtime/threads/${threadId}/history`) {
          return historyResponse(rows);
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const read = await readThreadMessages(threadId, agentId);

        expect(read.availability).toBe("ready");
        expect(read.unreadable).toBe(0);
        expect(read.messages).toEqual([
          {
            id: "question",
            role: "user",
            content: "List the top three stories.",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Checking the front page.",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "web_browse",
                  arguments: '{"url": "https://example.com"}',
                },
              },
            ],
          },
          {
            id: "tool-result:call-1",
            role: "tool",
            content: "Top stories: one, two, three.",
            toolCallId: "call-1",
          },
          {
            id: "tool-only-turn",
            role: "assistant",
            toolCalls: [
              {
                id: "call-2",
                type: "function",
                function: { name: "web_search", arguments: "" },
              },
            ],
          },
        ]);
      },
    );
  });

  test("the mode is read once and the SDK thread endpoint is never called", async () => {
    const paths: string[] = [];

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        paths.push(path);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "local", durableHistory: true });
        }
        if (path === `/api/local-runtime/threads/${threadId}/history`) {
          return historyResponse([
            projectionRow({
              messageId: "answer",
              role: "assistant",
              content: { text: "Restored" },
              lastSequence: 1,
            }),
          ]);
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const first = await readThreadMessages(threadId, agentId);
        const second = await readThreadMessages(threadId, agentId);

        expect(first.messages).toHaveLength(1);
        expect(second.messages).toHaveLength(1);
      },
    );

    expect(paths.filter((path) => path === "/api/capabilities")).toHaveLength(
      1,
    );
    expect(
      paths.filter(
        (path) => path === `/api/local-runtime/threads/${threadId}/history`,
      ),
    ).toHaveLength(2);
    expect(paths.some((path) => path.includes("/api/copilotkit/"))).toBe(false);
  });

  test("intelligence mode keeps reading the SDK thread endpoint", async () => {
    const paths: string[] = [];

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        paths.push(path);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "intelligence" });
        }
        if (path === `/api/copilotkit/threads/${threadId}/messages`) {
          return Response.json({
            messages: [{ id: "m1", role: "user", content: "Hello" }],
          });
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const read = await readThreadMessages(threadId, agentId);

        expect(read.availability).toBe("ready");
        expect(read.messages).toEqual([
          { id: "m1", role: "user", content: "Hello" },
        ]);
      },
    );

    expect(paths).toContain(`/api/copilotkit/threads/${threadId}/messages`);
    expect(paths.some((path) => path.includes("/api/local-runtime/"))).toBe(
      false,
    );
  });
});
