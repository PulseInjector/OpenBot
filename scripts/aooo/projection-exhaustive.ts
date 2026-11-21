#!/usr/bin/env bun
import type {
  localEvents,
  localMessages,
  localRuns,
} from "../../server/src/db/schema";
/*
 * The bounded exhaustive check of the local history projection.
 *
 * WHY A SCRIPT. Two pure functions decide what a restored local thread shows after a reconnect.
 * `summarizeRunState` (server/src/local-runtime/summary.ts) turns the run rows and recorded events
 * into the one status the UI strip, the evidence scripts, and the reconnect journey read, and
 * `foldHistoryMessages` (server/src/local-runtime/history-fold.ts) rebuilds the tool turns the
 * message rows do not hold. The integration tests sample a handful of event orders; a silent
 * defect needs only one order nobody sampled — a disagreeing run/event pair that reads as "Run
 * succeeded", or a tool result landing before the message that holds its call. This script
 * enumerates every event sequence up to a stated bound and checks the documented invariants on
 * the real functions, so an order that breaks the projection is enumerated, not sampled.
 *
 *   bun scripts/aooo/projection-exhaustive.ts [--quick]
 *
 * No database, no `.env`, no network: both functions are pure over the rows passed in. Exit 0
 * when every enumerated case holds; exit 1 printing the first counterexamples otherwise.
 *
 * BOUNDS. The default run enumerates, for the status derivation, at most two runs carrying the
 * store's five statuses plus one unrecognized one, with event sequences up to length 4 (length 3
 * when two runs, which keeps the sweep under a minute); and, for the fold, at most two stored
 * rows, two tool-call ids, and event sequences up to length 4 over the runner's real event
 * shapes plus malformed variants. `--quick` drops every depth to 2 for a fast smoke pass.
 */
import {
  foldHistoryMessages,
  type HistoryMessage,
} from "../../server/src/local-runtime/history-fold";
import {
  type LocalHistory,
  LocalRunStateError,
  type LocalRunStatus,
  summarizeRunState,
} from "../../server/src/local-runtime/summary";

type StoredMessageRow = typeof localMessages.$inferSelect;
type RecordedEventRow = typeof localEvents.$inferSelect;
type RunRow = typeof localRuns.$inferSelect;

export type Violation = { check: string; detail: string };

const THREAD = "thread-1";
const EVENT_DATE = new Date(0);
const TERMINAL_BY_STATUS = {
  succeeded: "attempt.succeeded",
  failed: "attempt.failed",
  cancelled: "attempt.interrupted",
} as const;
const TERMINAL_TYPES = new Set<string>(Object.values(TERMINAL_BY_STATUS));
const KNOWN_STATUSES = new Set([
  "queued",
  "running",
  ...Object.keys(TERMINAL_BY_STATUS),
]);
const FALLBACK_FAILED = "Local Agent run failed.";
const FALLBACK_STOPPED = "Run stopped by user";

const asHistory = (runs: RunRow[], events: RecordedEventRow[]): LocalHistory =>
  // summarizeRunState reads runs and events only; the rest of the store's read is outside this
  // check's scope, so the case builders pass the two arrays the derivation reads.
  ({ runs, events }) as unknown as LocalHistory;

export const runRow = (
  id: string,
  status: string,
  error: string | null,
): RunRow => ({
  id,
  threadId: THREAD,
  actorId: "actor",
  source: "test",
  requestKey: `key-${id}`,
  requestHash: "hash",
  businessRef: null,
  status,
  resultRef: null,
  error,
  createdAt: EVENT_DATE,
  finishedAt: null,
});

export const eventRow = (fields: {
  runId: string | null;
  type: string;
  messageId?: string | null;
  payload: Record<string, unknown>;
}): RecordedEventRow => ({
  threadId: THREAD,
  sequence: 0,
  id: "e",
  runId: fields.runId,
  attemptId: fields.runId === null ? null : `attempt-${fields.runId}`,
  type: fields.type,
  messageId: fields.messageId ?? null,
  payload: fields.payload,
  createdAt: EVENT_DATE,
});

// ---------------------------------------------------------------------------
// The status derivation: summarizeRunState
// ---------------------------------------------------------------------------

export type SummaryOutcome = {
  thrown?: unknown;
  result?: LocalRunStatus;
};

/**
 * Check the documented invariants of one case against an observed outcome, so the enumerator can
 * pass a real call's result and a test can pass a fabricated one.
 *
 * S-total: the derivation either returns a LocalRunStatus or throws LocalRunStateError, never
 * anything else. S-agree: a returned status agrees with the newest run's status, and a terminal
 * newest run holds exactly one agreeing terminal attempt event. S-fail-closed: an agreeing
 * history never throws. S-map/S-reason: the phase and the reason sentence come from the rows and
 * the agreeing event, with the two documented fallbacks.
 *
 * An older run with an unrecognized status is deliberately not a throw: only terminal runs are
 * validated, and an unrecognized status is not terminal. The newest run's unrecognized status
 * does throw.
 */
export function checkSummaryCase(
  runs: readonly RunRow[],
  events: readonly RecordedEventRow[],
  outcome: SummaryOutcome,
): Violation[] {
  const violations: Violation[] = [];
  const terminalEvents = (runId: string) =>
    events.filter(
      (event) => event.runId === runId && TERMINAL_TYPES.has(event.type),
    );
  const newest = runs.at(-1);
  const mustThrow =
    runs.some((run) => {
      const expected =
        TERMINAL_BY_STATUS[run.status as keyof typeof TERMINAL_BY_STATUS];
      if (!expected) return false;
      const terminal = terminalEvents(run.id);
      return terminal.length !== 1 || terminal[0].type !== expected;
    }) ||
    (newest !== undefined && !KNOWN_STATUSES.has(newest.status));

  const thrown = outcome.thrown;
  if (thrown !== undefined && thrown !== null) {
    if (!(thrown instanceof LocalRunStateError)) {
      const thrownName =
        thrown instanceof Error ? thrown.constructor.name : String(thrown);
      violations.push({
        check: "S-total",
        detail: `threw ${thrownName}, not LocalRunStateError`,
      });
    } else if (!mustThrow) {
      violations.push({
        check: "S-fail-closed",
        detail: `threw on an agreeing history: ${thrown.message}`,
      });
    }
    return violations;
  }
  if (mustThrow) {
    violations.push({
      check: "S-agree",
      detail: `returned ${JSON.stringify(outcome.result)} on a disagreeing history`,
    });
    return violations;
  }
  const result = outcome.result;
  if (!result) {
    violations.push({
      check: "S-total",
      detail: "neither returned nor threw",
    });
    return violations;
  }
  if (!newest) {
    if (result.phase !== "idle") {
      violations.push({
        check: "S-map",
        detail: `returned ${result.phase} with no runs`,
      });
    }
    return violations;
  }
  const expectedPhase =
    newest.status === "cancelled" ? "interrupted" : newest.status;
  if (result.phase !== expectedPhase) {
    violations.push({
      check: "S-map",
      detail: `returned phase ${result.phase} but the newest run ${newest.id} is ${newest.status}`,
    });
    return violations;
  }
  if (result.phase !== "idle" && result.runId !== newest.id) {
    violations.push({
      check: "S-map",
      detail: `returned runId ${result.runId} but the newest run is ${newest.id}`,
    });
    return violations;
  }
  if (result.phase === "failed") {
    const expected = newest.error ?? FALLBACK_FAILED;
    if (result.reason !== expected) {
      violations.push({
        check: "S-reason",
        detail: `returned reason ${JSON.stringify(result.reason)} but the run's error is ${JSON.stringify(newest.error)}`,
      });
    }
  }
  if (result.phase === "interrupted") {
    const event = terminalEvents(newest.id)[0];
    const reason = event.payload.reason;
    const expected =
      typeof reason === "string" && reason ? reason : FALLBACK_STOPPED;
    if (result.reason !== expected) {
      violations.push({
        check: "S-reason",
        detail: `returned reason ${JSON.stringify(result.reason)} but the event's reason is ${JSON.stringify(expected)}`,
      });
    }
  }
  return violations;
}

type EnumerateOptions = {
  oneRunDepth: number;
  twoRunDepth: number;
  maxViolations: number;
};

/** The store's five statuses plus one unrecognized one, for the fail-closed branch. */
const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "misfiled",
] as const;

/**
 * Enumerate run rows and event sequences and check every case. Cases are every prefix of every
 * event sequence, so all lengths up to the bound are covered in one pass. Event objects are
 * prebuilt per position so the sweep allocates nothing per case.
 */
export function enumerateSummary(options: EnumerateOptions): {
  cases: number;
  violations: Violation[];
} {
  const violations: Violation[] = [];
  let cases = 0;

  const perRunTemplates = (runId: string) => [
    {
      label: `${runId} attempt.succeeded`,
      row: eventRow({ runId, type: "attempt.succeeded", payload: {} }),
    },
    {
      label: `${runId} attempt.failed`,
      row: eventRow({ runId, type: "attempt.failed", payload: {} }),
    },
    {
      label: `${runId} attempt.interrupted reason=cut`,
      row: eventRow({
        runId,
        type: "attempt.interrupted",
        payload: { reason: "cut" },
      }),
    },
    {
      label: `${runId} attempt.interrupted`,
      row: eventRow({ runId, type: "attempt.interrupted", payload: {} }),
    },
    {
      label: `${runId} run.queued`,
      row: eventRow({ runId, type: "run.queued", payload: {} }),
    },
    {
      label: `${runId} attempt.started`,
      row: eventRow({ runId, type: "attempt.started", payload: {} }),
    },
    {
      label: `${runId} attempt.stop_requested`,
      row: eventRow({ runId, type: "attempt.stop_requested", payload: {} }),
    },
    {
      label: `${runId} RUN_ERROR`,
      row: eventRow({
        runId,
        type: "RUN_ERROR",
        payload: { code: "STOPPED", message: "stopped" },
      }),
    },
  ];
  const globalTemplates = [
    {
      label: "message.upsert",
      row: eventRow({
        runId: null,
        type: "message.upsert",
        messageId: "m1",
        payload: { text: "hi" },
      }),
    },
    {
      label: "message.delete",
      row: eventRow({
        runId: null,
        type: "message.delete",
        messageId: "m1",
        payload: {},
      }),
    },
    {
      label: "orphan attempt.succeeded",
      row: eventRow({ runId: null, type: "attempt.succeeded", payload: {} }),
    },
  ];

  const sweep = (
    runs: RunRow[],
    templates: Array<{ label: string; row: RecordedEventRow }>,
    depth: number,
  ) => {
    // One prebuilt event object per (template, position): sequence and id are the position.
    const byPosition = Array.from({ length: depth }, (_, position) =>
      templates.map((template) => ({
        label: template.label,
        row: {
          ...template.row,
          sequence: position + 1,
          id: `e${position}`,
        },
      })),
    );
    const events: RecordedEventRow[] = [];
    const labels: string[] = [];

    const visit = (position: number): boolean => {
      cases++;
      let thrown: unknown;
      let result: LocalRunStatus | undefined;
      try {
        result = summarizeRunState(asHistory(runs, events));
      } catch (error) {
        thrown = error;
      }
      const caseViolations = checkSummaryCase(runs, events, { thrown, result });
      if (caseViolations.length > 0) {
        violations.push(
          ...caseViolations.map((violation) => ({
            check: violation.check,
            detail: `${violation.detail}\n    runs: ${runs.map((run) => `${run.id}=${run.status}${run.error ? ` error=${run.error}` : ""}`).join(", ") || "(none)"}\n    events: ${labels.join(" ") || "(none)"}`,
          })),
        );
      }
      if (violations.length >= options.maxViolations) return false;
      if (position === depth) return true;
      for (const template of byPosition[position]) {
        events.push(template.row);
        labels.push(template.label);
        const keepGoing = visit(position + 1);
        events.pop();
        labels.pop();
        if (!keepGoing) return false;
      }
      return true;
    };
    visit(0);
  };

  for (const runCount of [0, 1, 2]) {
    const depth =
      runCount === 2 ? options.twoRunDepth : Math.max(options.oneRunDepth, 1);
    const ids = ["r1", "r2"].slice(0, runCount);
    const templates = [
      ...ids.flatMap((id) => perRunTemplates(id)),
      ...globalTemplates,
    ];
    if (runCount === 0) {
      sweep([], templates, depth);
      continue;
    }
    if (runCount === 1) {
      for (const status of RUN_STATUSES) {
        for (const error of [null, "boom"]) {
          if (violations.length >= options.maxViolations) {
            return { cases, violations };
          }
          sweep([runRow("r1", status, error)], templates, depth);
        }
      }
      continue;
    }
    for (const olderStatus of RUN_STATUSES) {
      for (const newestStatus of RUN_STATUSES) {
        // The returned reason reads only the newest run's error; older errors stay fixed.
        for (const newestError of [null, "boom"]) {
          if (violations.length >= options.maxViolations) {
            return { cases, violations };
          }
          sweep(
            [
              runRow("r1", olderStatus, "boom"),
              runRow("r2", newestStatus, newestError),
            ],
            templates,
            depth,
          );
        }
      }
    }
  }
  return { cases, violations };
}

// ---------------------------------------------------------------------------
// The tool-turn fold: foldHistoryMessages
// ---------------------------------------------------------------------------

type RefCall = { name: string; parent?: string; seq: number; args: string };
type RefResult = { content: unknown; seq: number };

/**
 * The fold's input spec, read from the AG-UI event shapes the doc comment states, not from the
 * zod lines: which recorded events describe a call, its deltas, and its result. If the fold's
 * parsing ever disagrees with this spec, a coverage check fires and names the event.
 */
function foldReference(events: readonly RecordedEventRow[]) {
  const calls = new Map<string, RefCall>();
  const results = new Map<string, RefResult>();
  const firstUpsert = new Map<string, number>();
  for (const event of events) {
    if (event.type === "message.upsert") {
      if (
        typeof event.messageId === "string" &&
        !firstUpsert.has(event.messageId)
      ) {
        firstUpsert.set(event.messageId, event.sequence);
      }
      continue;
    }
    const payload = event.payload;
    if (event.type === "TOOL_CALL_START") {
      if (
        typeof payload.toolCallId === "string" &&
        typeof payload.toolCallName === "string"
      ) {
        calls.set(payload.toolCallId, {
          name: payload.toolCallName,
          ...(typeof payload.parentMessageId === "string"
            ? { parent: payload.parentMessageId }
            : {}),
          seq: event.sequence,
          args: "",
        });
      }
      continue;
    }
    if (event.type === "TOOL_CALL_ARGS") {
      const call = calls.get(payload.toolCallId as string);
      if (call && typeof payload.delta === "string") call.args += payload.delta;
      continue;
    }
    if (event.type === "TOOL_CALL_RESULT") {
      if (
        typeof payload.toolCallId === "string" &&
        (typeof payload.content === "string" || Array.isArray(payload.content))
      ) {
        results.set(payload.toolCallId, {
          content: payload.content,
          seq: event.sequence,
        });
      }
    }
  }
  return { calls, results, firstUpsert };
}

/**
 * Check the documented invariants of the fold against one output.
 *
 * F-call-once/F-call-shape/F-call-parent: every recorded call folds into exactly one row with the
 * last start's name and parent and the deltas after it, attached to the stored row its parent
 * names. F-result-once/F-result-shape: every recorded result mints exactly one tool row with the
 * derived id and the last result's content. F-preserve: every stored row survives unchanged.
 * F-order-*: the rows keep the recorded order — stored rows by the sequence of their first
 * upsert, a call's row before its later result, and result rows by their own sequences.
 */
export function checkFoldCase(
  rows: readonly StoredMessageRow[],
  events: readonly RecordedEventRow[],
  out: readonly HistoryMessage[],
): Violation[] {
  const violations: Violation[] = [];
  const reference = foldReference(events);
  const storedIds = new Set(rows.map((row) => row.messageId));
  const indexOf = (messageId: string) =>
    out.findIndex((row) => row.messageId === messageId);

  for (const [id, call] of reference.calls) {
    const occurrences = out.reduce(
      (count, row) =>
        count + (row.toolCalls?.filter((entry) => entry.id === id).length ?? 0),
      0,
    );
    if (occurrences !== 1) {
      violations.push({
        check: "F-call-once",
        detail: `call ${id} appears ${occurrences} times, expected exactly 1`,
      });
      continue;
    }
    const row = out.find((entry) =>
      entry.toolCalls?.some((tool) => tool.id === id),
    );
    const toolCall = row?.toolCalls?.find((tool) => tool.id === id);
    if (!row || !toolCall) continue; // unreachable after the count check
    if (toolCall.name !== call.name || toolCall.args !== call.args) {
      violations.push({
        check: "F-call-shape",
        detail: `call ${id} folded as name=${toolCall.name} args=${JSON.stringify(toolCall.args)}, expected name=${call.name} args=${JSON.stringify(call.args)}`,
      });
    }
    if (
      call.parent !== undefined &&
      storedIds.has(call.parent) &&
      row.messageId !== call.parent
    ) {
      violations.push({
        check: "F-call-parent",
        detail: `call ${id} attached to row ${row.messageId}, its parent names stored row ${call.parent}`,
      });
    }
  }

  for (const [id, result] of reference.results) {
    const messageId = `tool-result:${id}`;
    const rowsForId = out.filter((row) => row.messageId === messageId);
    if (rowsForId.length !== 1) {
      violations.push({
        check: "F-result-once",
        detail: `result ${id} produced ${rowsForId.length} rows, expected exactly 1`,
      });
      continue;
    }
    const row = rowsForId[0];
    if (
      row.role !== "tool" ||
      row.toolCallId !== id ||
      JSON.stringify(row.content.value) !== JSON.stringify(result.content)
    ) {
      violations.push({
        check: "F-result-shape",
        detail: `result ${id} folded as role=${row.role} toolCallId=${row.toolCallId} content=${JSON.stringify(row.content.value)}, expected the recorded content ${JSON.stringify(result.content)}`,
      });
    }
  }

  for (const row of rows) {
    const copies = out.filter(
      (entry) =>
        entry.messageId === row.messageId && entry.toolCallId === undefined,
    );
    if (copies.length !== 1) {
      violations.push({
        check: "F-preserve",
        detail: `stored row ${row.messageId} appears ${copies.length} times, expected exactly 1`,
      });
      continue;
    }
    const copy = copies[0];
    if (
      copy.role !== row.role ||
      JSON.stringify(copy.content) !== JSON.stringify(row.content) ||
      copy.lastSequence !== row.lastSequence
    ) {
      violations.push({
        check: "F-preserve",
        detail: `stored row ${row.messageId} was rewritten by the fold`,
      });
    }
  }

  // Stored rows keep, in the output, the order of the sequence they first appeared at, or of
  // their last write when no upsert event exists, with the input order breaking ties.
  const storedAnchor = (row: StoredMessageRow) =>
    reference.firstUpsert.get(row.messageId) ?? row.lastSequence;
  const storedInputIndex = new Map(
    rows.map((row, index) => [row.messageId, index]),
  );
  const storedInOutputOrder = [...rows]
    .map((row) => ({
      row,
      outIndex: indexOf(row.messageId),
      anchor: storedAnchor(row),
      inputIndex: storedInputIndex.get(row.messageId) ?? 0,
    }))
    .sort((left, right) => left.outIndex - right.outIndex);
  let previousKey: { anchor: number; inputIndex: number } | undefined;
  for (const stored of storedInOutputOrder) {
    if (stored.outIndex < 0) continue; // already reported by F-preserve
    if (
      previousKey &&
      (stored.anchor < previousKey.anchor ||
        (stored.anchor === previousKey.anchor &&
          stored.inputIndex < previousKey.inputIndex))
    ) {
      violations.push({
        check: "F-order-stored",
        detail: `stored row ${stored.row.messageId} (anchor ${stored.anchor}) sorted out of order against the previous stored row (anchor ${previousKey.anchor})`,
      });
    }
    previousKey = { anchor: stored.anchor, inputIndex: stored.inputIndex };
  }

  // A call's row never lands after the result that follows it, under the stream shape the runner
  // records: the parent row starts (its upsert) before the call that names it, and a parentless
  // call mints a row at its own sequence. A stored row whose upsert event is missing from the
  // read anchors at its last write, which can fall after the result; real reads carry the upsert,
  // so that row's position is not promised here (the reachability of an upsertless stored row is
  // unconfirmed either way).
  for (const [id, call] of reference.calls) {
    const result = reference.results.get(id);
    if (!result || result.seq <= call.seq) continue;
    const callRow = out.find((row) =>
      row.toolCalls?.some((tool) => tool.id === id),
    );
    const resultIndex = indexOf(`tool-result:${id}`);
    if (!callRow || resultIndex < 0) continue;
    if (callRow.messageId === `tool-result:${id}`) continue; // same row
    let rowAnchor: number | undefined;
    if (callRow.toolCallId === undefined && storedIds.has(callRow.messageId)) {
      const storedRow = rows.find((row) => row.messageId === callRow.messageId);
      if (storedRow) {
        rowAnchor =
          reference.firstUpsert.get(storedRow.messageId) ??
          storedRow.lastSequence;
      }
    } else if (callRow.messageId === `tool-call:${id}`) {
      rowAnchor = call.seq; // the parentless call's own mint
    }
    // A named-parent mint (a row minted by another call's sequence) is skipped: its anchor
    // belongs to the minting call, not this one.
    if (rowAnchor !== undefined && rowAnchor < result.seq) {
      if (out.indexOf(callRow) > resultIndex) {
        violations.push({
          check: "F-order-call-result",
          detail: `call ${id} landed after its own result row although its row starts at ${rowAnchor}, before the result at ${result.seq}`,
        });
      }
    }
  }

  // Result rows keep their own recorded order, and a stored row keeps its place against them.
  const resultRows = [...reference.results]
    .map(([id, result]) => ({ id, seq: result.seq }))
    .sort((left, right) => left.seq - right.seq);
  let previousResultIndex = -1;
  for (const result of resultRows) {
    const index = indexOf(`tool-result:${result.id}`);
    if (index < 0) continue; // already reported by F-result-once
    if (index < previousResultIndex) {
      violations.push({
        check: "F-order-results",
        detail: `result ${result.id} landed before the earlier result at sequence ${previousResultIndex}`,
      });
    }
    previousResultIndex = index;
    for (const row of rows) {
      const outIndex = indexOf(row.messageId);
      if (outIndex < 0) continue;
      const anchor = storedAnchor(row);
      if (result.seq < anchor && outIndex < index) {
        violations.push({
          check: "F-order-stored-result",
          detail: `stored row ${row.messageId} landed before result ${result.id} although its anchor ${anchor} is later`,
        });
      }
      if (result.seq > anchor && outIndex > index) {
        violations.push({
          check: "F-order-stored-result",
          detail: `stored row ${row.messageId} landed after result ${result.id} although its anchor ${anchor} is earlier`,
        });
      }
    }
  }
  return violations;
}

export const messageRow = (
  messageId: string,
  role: string,
  lastSequence: number,
): StoredMessageRow => ({
  threadId: THREAD,
  messageId,
  role,
  content: { text: `text of ${messageId}` },
  lastSequence,
  updatedAt: EVENT_DATE,
});

const foldTemplates = [
  {
    label: "upsert m1",
    row: eventRow({
      runId: null,
      type: "message.upsert",
      messageId: "m1",
      payload: { text: "hi" },
    }),
  },
  {
    label: "upsert m2",
    row: eventRow({
      runId: null,
      type: "message.upsert",
      messageId: "m2",
      payload: { text: "yo" },
    }),
  },
  {
    label: "start c1 parent=m1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: {
        toolCallId: "c1",
        toolCallName: "notion-fetch",
        parentMessageId: "m1",
      },
    }),
  },
  {
    label: "start c1 parent=m2",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: {
        toolCallId: "c1",
        toolCallName: "notion-fetch",
        parentMessageId: "m2",
      },
    }),
  },
  {
    label: "start c1 parentless",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: { toolCallId: "c1", toolCallName: "notion-fetch" },
    }),
  },
  {
    label: "start c1 parent=result-c1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: {
        toolCallId: "c1",
        toolCallName: "notion-fetch",
        parentMessageId: "tool-result:c1",
      },
    }),
  },
  {
    label: "start c2 parent=m1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: {
        toolCallId: "c2",
        toolCallName: "notion-update-page",
        parentMessageId: "m1",
      },
    }),
  },
  {
    label: "start c2 parentless",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: { toolCallId: "c2", toolCallName: "notion-update-page" },
    }),
  },
  {
    label: "args c1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_ARGS",
      payload: { toolCallId: "c1", delta: "x" },
    }),
  },
  {
    label: "args c2",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_ARGS",
      payload: { toolCallId: "c2", delta: "y" },
    }),
  },
  {
    label: "result c1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_RESULT",
      payload: { toolCallId: "c1", content: "ok" },
    }),
  },
  {
    label: "result c2",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_RESULT",
      payload: { toolCallId: "c2", content: ["block"] },
    }),
  },
  {
    label: "end c1",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_END",
      payload: { toolCallId: "c1" },
    }),
  },
  {
    label: "RUN_ERROR",
    row: eventRow({
      runId: "r1",
      type: "RUN_ERROR",
      payload: { code: "STOPPED", message: "stopped" },
    }),
  },
  {
    label: "malformed start",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_START",
      payload: { toolCallId: 7, toolCallName: "broken" },
    }),
  },
  {
    label: "malformed result",
    row: eventRow({
      runId: "r1",
      type: "TOOL_CALL_RESULT",
      payload: { toolCallId: "c3" },
    }),
  },
];

export function enumerateFold(
  depth: number,
  maxViolations: number,
): { cases: number; violations: Violation[] } {
  const violations: Violation[] = [];
  let cases = 0;
  const rowConfigs: StoredMessageRow[][] = [
    [],
    [messageRow("m1", "assistant", 5)],
    [messageRow("m2", "user", 9)],
    [messageRow("m1", "assistant", 5), messageRow("m2", "user", 9)],
  ];
  const byPosition = Array.from({ length: depth }, (_, position) =>
    foldTemplates.map((template) => ({
      label: template.label,
      row: {
        ...template.row,
        sequence: position + 1,
        id: `e${position}`,
      },
    })),
  );

  for (const rows of rowConfigs) {
    const events: RecordedEventRow[] = [];
    const labels: string[] = [];
    const visit = (position: number): boolean => {
      cases++;
      let thrown: unknown;
      let out: HistoryMessage[] | undefined;
      let outAgain: HistoryMessage[] | undefined;
      try {
        out = foldHistoryMessages(rows, events);
        outAgain = foldHistoryMessages(rows, events);
      } catch (error) {
        thrown = error;
      }
      if (thrown !== undefined) {
        violations.push({
          check: "F-total",
          detail: `fold threw ${(thrown as Error).constructor.name} on events: ${labels.join(" ") || "(none)"}`,
        });
      } else if (
        JSON.stringify(out) !== JSON.stringify(outAgain) ||
        out === undefined
      ) {
        violations.push({
          check: "F-determinism",
          detail: `two folds of the same events differ, events: ${labels.join(" ") || "(none)"}`,
        });
      } else {
        const caseViolations = checkFoldCase(rows, events, out);
        if (caseViolations.length > 0) {
          violations.push(
            ...caseViolations.map((violation) => ({
              check: violation.check,
              detail: `${violation.detail}\n    rows: ${rows.map((row) => row.messageId).join(", ") || "(none)"}\n    events: ${labels.join(" ") || "(none)"}`,
            })),
          );
        }
      }
      if (violations.length >= maxViolations) return false;
      if (position === depth) return true;
      for (const template of byPosition[position]) {
        events.push(template.row);
        labels.push(template.label);
        const keepGoing = visit(position + 1);
        events.pop();
        labels.pop();
        if (!keepGoing) return false;
      }
      return true;
    };
    visit(0);
    if (violations.length >= maxViolations) break;
  }
  return { cases, violations };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runProjectionExhaustive(options: { quick: boolean }): {
  summary: { cases: number; violations: Violation[] };
  fold: { cases: number; violations: Violation[] };
} {
  const summaryOptions: EnumerateOptions = options.quick
    ? { oneRunDepth: 2, twoRunDepth: 2, maxViolations: 3 }
    : { oneRunDepth: 4, twoRunDepth: 3, maxViolations: 3 };
  const foldDepth = options.quick ? 2 : 4;
  return {
    summary: enumerateSummary(summaryOptions),
    fold: enumerateFold(foldDepth, 3),
  };
}

if (import.meta.main) {
  const quick = process.argv.includes("--quick");
  const report = runProjectionExhaustive({ quick });
  const fail = (section: "summary" | "fold") => {
    console.error(`${section}: FAILED`);
    for (const violation of report[section].violations) {
      console.error(`  ${violation.check}: ${violation.detail}`);
    }
  };
  let failed = false;
  if (report.summary.violations.length > 0) {
    fail("summary");
    failed = true;
  } else {
    console.log(
      `summary: ${report.summary.cases} cases — all invariants hold (bound: ${quick ? 2 : "at most 2 runs, sequences of at most 4 (3 with two runs)"})`,
    );
  }
  if (report.fold.violations.length > 0) {
    fail("fold");
    failed = true;
  } else {
    console.log(
      `fold: ${report.fold.cases} cases — all invariants hold (bound: ${quick ? 2 : "at most 2 stored rows, 2 tool-call ids, sequences of at most 4"})`,
    );
  }
  process.exit(failed ? 1 : 0);
}
