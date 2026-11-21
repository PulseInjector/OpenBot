import { z } from "zod";
import type { localEvents, localMessages } from "../db/schema";

type StoredMessageRow = typeof localMessages.$inferSelect;
type RecordedEventRow = typeof localEvents.$inferSelect;

/**
 * One row of the history projection `readHistory` returns.
 *
 * A stored `local_messages` row, plus the tool turns the recorded events hold: `toolCalls` is the
 * store's `{id, name, args}` dialect (the one the client's `withNormalisedToolCalls` translates),
 * and `toolCallId` marks a row a `TOOL_CALL_RESULT` minted rather than a `message.upsert` wrote.
 * `local_messages` has no tool columns by design, so these fields exist only in this derivation.
 */
export type HistoryMessage = StoredMessageRow & {
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  toolCallId?: string;
};

// The payload shapes the AG-UI declarations state, parsed at this boundary because a recorded
// payload is jsonb, not a typed event. An event that does not parse is ignored rather than thrown:
// history must stay readable when one producer event is malformed.
const toolCallStart = z
  .object({
    toolCallId: z.string(),
    toolCallName: z.string(),
    parentMessageId: z.string().optional(),
  })
  .passthrough();
const toolCallArgs = z
  .object({ toolCallId: z.string(), delta: z.string() })
  .passthrough();
const toolCallResult = z
  .object({
    toolCallId: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
  })
  .passthrough();

type FoldedCall = {
  toolCallId: string;
  name: string;
  args: string;
  parentMessageId?: string;
  sequence: number;
  threadId: string;
  createdAt: Date;
};

/**
 * Fold the thread's recorded tool events into the stored message rows, at read time.
 *
 * The runner persists every agent event but only text and input content as message rows, so a
 * reloaded thread without this fold restores its text without its tool turns. Calls attach to the
 * row their `parentMessageId` names; a call no row holds mints an assistant row; a result mints a
 * tool row. Row ids are derived from the `toolCallId` rather than taken from the event, so a
 * replayed or repeated event folds into the same row instead of duplicating one, and reading twice
 * yields the same projection.
 *
 * Rows take their place at the sequence where they first appeared (a stored row at its first
 * `message.upsert`, a folded row at its own event), not at their last update: a parent message
 * always starts before the call that names it, so the assistant row keeps its calls and its result
 * after it even when the agent streamed text and tool use interleaved.
 */
export function foldHistoryMessages(
  messages: readonly StoredMessageRow[],
  events: readonly RecordedEventRow[],
): HistoryMessage[] {
  const firstSeen = new Map<string, number>();
  const calls = new Map<string, FoldedCall>();
  const folded = new Map<string, { row: HistoryMessage; sequence: number }>();

  for (const event of events) {
    if (event.type === "message.upsert") {
      if (
        typeof event.messageId === "string" &&
        !firstSeen.has(event.messageId)
      ) {
        firstSeen.set(event.messageId, event.sequence);
      }
      continue;
    }
    if (event.type === "TOOL_CALL_START") {
      const start = toolCallStart.safeParse(event.payload);
      if (start.success) {
        calls.set(start.data.toolCallId, {
          toolCallId: start.data.toolCallId,
          name: start.data.toolCallName,
          args: "",
          ...(start.data.parentMessageId === undefined
            ? {}
            : { parentMessageId: start.data.parentMessageId }),
          sequence: event.sequence,
          threadId: event.threadId,
          createdAt: event.createdAt,
        });
      }
      continue;
    }
    if (event.type === "TOOL_CALL_ARGS") {
      // Args concatenate from the deltas, exactly as the runner accumulates text deltas.
      const args = toolCallArgs.safeParse(event.payload);
      if (args.success) {
        const call = calls.get(args.data.toolCallId);
        if (call) call.args += args.data.delta;
      }
      continue;
    }
    if (event.type === "TOOL_CALL_RESULT") {
      const result = toolCallResult.safeParse(event.payload);
      if (result.success) {
        const messageId = `tool-result:${result.data.toolCallId}`;
        folded.set(messageId, {
          sequence: event.sequence,
          row: {
            threadId: event.threadId,
            messageId,
            role: "tool",
            content: { value: result.data.content },
            lastSequence: event.sequence,
            updatedAt: event.createdAt,
            toolCallId: result.data.toolCallId,
          },
        });
      }
    }
  }

  const rows: HistoryMessage[] = messages.map((row) => ({ ...row }));
  const stored = new Map(rows.map((row) => [row.messageId, row]));

  const foldedAssistantRow = (call: FoldedCall): HistoryMessage => {
    const row: HistoryMessage = {
      threadId: call.threadId,
      messageId: call.parentMessageId ?? `tool-call:${call.toolCallId}`,
      role: "assistant",
      content: {},
      lastSequence: call.sequence,
      updatedAt: call.createdAt,
    };
    folded.set(row.messageId, { row, sequence: call.sequence });
    return row;
  };

  for (const call of calls.values()) {
    const target =
      (call.parentMessageId === undefined
        ? undefined
        : stored.get(call.parentMessageId)) ??
      (call.parentMessageId === undefined
        ? undefined
        : folded.get(call.parentMessageId)?.row) ??
      foldedAssistantRow(call);
    target.toolCalls ??= [];
    target.toolCalls.push({
      id: call.toolCallId,
      name: call.name,
      args: call.args,
    });
  }

  const anchored = [
    ...rows.map((row) => ({
      row,
      sequence: firstSeen.get(row.messageId) ?? row.lastSequence,
    })),
    ...folded.values(),
  ];
  anchored.sort((left, right) => left.sequence - right.sequence);
  return anchored.map((entry) => entry.row);
}
