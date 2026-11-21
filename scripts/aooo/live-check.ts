#!/usr/bin/env bun
/*
 * The judge for the unit 7 live Notion run.
 *
 * WHY A SCRIPT. Unit 7's acceptance is a set of comparisons a human could do by hand: every
 * expected fact present with its citations, no forbidden finding, the protected paragraphs intact,
 * one recorded write and one physical mutation per batch. Done by hand, a failure is a judgment
 * call. This script reads the artifacts the operator's run saves plus the frozen case, prints one
 * line per check, and exits on the verdict, so the same artifacts always give the same answer
 * (docs/aooo/designs/unit-7-notion-chain.md, "The live check").
 *
 *   bun scripts/aooo/live-check.ts <evidence-dir>
 *
 * The evidence directory holds the five artifacts the run saves; nothing else is read:
 *
 *   page-export-batch-1.md  the page read-back saved after batch 1
 *   page-export-batch-2.md  the page read-back saved after batch 2
 *   history-batch-1.json    the saved GET /threads/:threadId/history body after batch 1
 *   history-batch-2.json    the same body, saved after batch 2 in the same thread
 *   connector-trace.log     the saved server log holding one mcp-call JSON line per physical
 *                           callTool (server/src/plugins/mcp.ts, traceCall)
 *
 * The frozen case and the initial page copy come from tests/fixtures/aooo, resolved relative to
 * this script, never from the evidence directory.
 *
 * VERDICTS. Pass exits 0. Any miss exits 1. A physical mutation no recorded operation explains
 * exits 2, the design's third answer: the trace then carries too little trust to call the run
 * either way, so the verdict says so instead of letting a pass stand on it. A miss already proven
 * stays a failure even when the trace is also untrustworthy, because the miss did not need the
 * trace to be true.
 *
 * The script reads no environment variable (never .env), contacts no vendor, and writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDITABLE_HEADING = "## Compatibility follow-up (Bot editable)";

/*
 * The chain's tools, as the model is offered them (`GrantedTool.name`, which is also what
 * `local_operations.tool_name` records). The trace's `tool` field carries the same spelling,
 * because the physical callTool sits under the same wrapper. `reads` is a plain string list so
 * membership checks accept any advertised name, not just the ones spelled here.
 */
const CHAIN: { reads: readonly string[]; update: string } = {
  reads: ["notion-fetch"],
  update: "notion-update-page",
};

/*
 * The parse guards below read only the fields the check uses and fail the whole parse when any of
 * them is absent or misshapen, so a fixture or a saved history that changes shape fails loudly
 * rather than silently. They are hand-written rather than zod because root `scripts/` is in no
 * workspace and bun's isolated linker installs each workspace's dependencies inside that
 * workspace, so `zod` does not resolve from this directory; the frozen package manifests are
 * outside this script's change.
 */
export type CaseSource = { id: string; duplicateOf?: string };
export type EvidenceExcerpt = { sourceId: string; quote: string };
export type ExpectedFact = { id: string; evidence: EvidenceExcerpt[] };

export type FrozenCase = {
  caseId: string;
  sources: CaseSource[];
  expected: { afterBatch1: ExpectedFact[]; afterBatch2: ExpectedFact[] };
  mustNotAppearAsFindings: string[];
  protectedText: string[];
};

export type HistoryRun = { id: string; createdAt: string };
export type HistoryOperation = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
};
export type HistoryEvent = {
  type: string;
  runId: string | null;
  payload: Record<string, unknown>;
};
export type HistoryRows = {
  runs: HistoryRun[];
  operations: HistoryOperation[];
  events: HistoryEvent[];
};

export type TraceLine = {
  server: string;
  tool: string;
  toolCallId?: string;
  outcome: "succeeded" | "failed";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length === value.length ? strings : null;
}

function parseFact(value: unknown): ExpectedFact | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (!Array.isArray(value.evidence)) return null;
  const evidence: EvidenceExcerpt[] = [];
  for (const entry of value.evidence) {
    if (!isRecord(entry)) return null;
    if (typeof entry.sourceId !== "string" || typeof entry.quote !== "string")
      return null;
    evidence.push({ sourceId: entry.sourceId, quote: entry.quote });
  }
  return { id: value.id, evidence };
}

function parseFactList(value: unknown): ExpectedFact[] | null {
  if (!Array.isArray(value)) return null;
  const facts: ExpectedFact[] = [];
  for (const fact of value) {
    const parsed = parseFact(fact);
    if (!parsed) return null;
    facts.push(parsed);
  }
  return facts;
}

export function parseCase(value: unknown): FrozenCase | null {
  if (!isRecord(value) || typeof value.caseId !== "string") return null;
  if (!Array.isArray(value.sources)) return null;
  const sources: CaseSource[] = [];
  for (const source of value.sources) {
    if (!isRecord(source) || typeof source.id !== "string") return null;
    const duplicateOf = source.duplicateOf;
    if (duplicateOf !== undefined && typeof duplicateOf !== "string")
      return null;
    sources.push({
      id: source.id,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
    });
  }
  const expected = value.expected;
  if (!isRecord(expected)) return null;
  const afterBatch1 = parseFactList(expected.afterBatch1);
  const afterBatch2 = parseFactList(expected.afterBatch2);
  if (!afterBatch1 || !afterBatch2) return null;
  const mustNotAppearAsFindings = stringArray(value.mustNotAppearAsFindings);
  const protectedText = stringArray(value.protectedText);
  if (!mustNotAppearAsFindings || !protectedText) return null;
  return {
    caseId: value.caseId,
    sources,
    expected: { afterBatch1, afterBatch2 },
    mustNotAppearAsFindings,
    protectedText,
  };
}

export function parseHistory(value: unknown): HistoryRows | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.runs) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.events)
  ) {
    return null;
  }
  const runs: HistoryRun[] = [];
  for (const run of value.runs) {
    if (!isRecord(run) || typeof run.id !== "string") return null;
    if (typeof run.createdAt !== "string") return null;
    runs.push({ id: run.id, createdAt: run.createdAt });
  }
  const operations: HistoryOperation[] = [];
  for (const operation of value.operations) {
    if (!isRecord(operation)) return null;
    if (
      typeof operation.id !== "string" ||
      typeof operation.runId !== "string" ||
      typeof operation.toolCallId !== "string" ||
      typeof operation.toolName !== "string"
    ) {
      return null;
    }
    operations.push({
      id: operation.id,
      runId: operation.runId,
      toolCallId: operation.toolCallId,
      toolName: operation.toolName,
    });
  }
  const events: HistoryEvent[] = [];
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.type !== "string") return null;
    const runId = event.runId;
    if (runId !== null && typeof runId !== "string") return null;
    if (!isRecord(event.payload)) return null;
    events.push({ type: event.type, runId, payload: event.payload });
  }
  return { runs, operations, events };
}

export function parseTraceLine(value: unknown): TraceLine | null {
  if (!isRecord(value) || value.type !== "mcp-call") return null;
  if (typeof value.server !== "string" || typeof value.tool !== "string")
    return null;
  const toolCallId = value.toolCallId;
  if (toolCallId !== undefined && typeof toolCallId !== "string") return null;
  const outcome = value.outcome;
  if (outcome !== "succeeded" && outcome !== "failed") return null;
  return {
    server: value.server,
    tool: value.tool,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    outcome,
  };
}

export type LiveCheckVerdict = "pass" | "fail" | "inconclusive";
export type CheckOutcome = "pass" | "fail" | "inconclusive" | "note";
export type CheckLine = { outcome: CheckOutcome; text: string };
export type LiveCheckReport = { verdict: LiveCheckVerdict; lines: CheckLine[] };

export type LiveCheckInput = {
  caseData: FrozenCase;
  initialPage: string;
  batch1Export: string;
  batch2Export: string;
  batch1History: HistoryRows;
  batch2History: HistoryRows;
  trace: TraceLine[];
};

type SectionArea = {
  kind: "section";
  body: string;
  headingLine: number;
  nextHeading: number;
};
type EditableArea =
  | SectionArea
  | { kind: "missing" }
  | { kind: "ambiguous"; count: number };

function editableArea(page: string): EditableArea {
  const lines = page.split("\n");
  const headings: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trimEnd() === EDITABLE_HEADING) headings.push(index);
  }
  if (headings.length === 0) return { kind: "missing" };
  if (headings.length > 1) return { kind: "ambiguous", count: headings.length };
  const headingLine = headings[0];
  let nextHeading = lines.length;
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s/.test(lines[index])) {
      nextHeading = index;
      break;
    }
  }
  return {
    kind: "section",
    body: lines.slice(headingLine + 1, nextHeading).join("\n"),
    headingLine,
    nextHeading,
  };
}

function outsideEditable(page: string, area: SectionArea): string {
  const lines = page.split("\n");
  return [
    ...lines.slice(0, area.headingLine + 1),
    ...lines.slice(area.nextHeading),
  ].join("\n");
}

function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const count = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < count; index += 1) {
    const left = expectedLines[index] ?? "<end of page>";
    const right = actualLines[index] ?? "<end of page>";
    if (left !== right) {
      return `line ${index + 1}: expected "${shorten(left)}" got "${shorten(right)}"`;
    }
  }
  return "no difference found";
}

function shorten(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

/*
 * A citation is the source id as a whole token: "REL-25-MIRROR" must not count as a citation of
 * REL-25, or the duplicate rule could be satisfied by citing the mirror.
 */
function citedIn(text: string, sourceId: string): boolean {
  const boundary = sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${boundary}(?![\\w-])`).test(text);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function usageSummary(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["provider", "model"] as const) {
    if (typeof payload[key] === "string") parts.push(`${key} ${payload[key]}`);
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (typeof payload[key] === "number") parts.push(`${key} ${payload[key]}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no fields the SDK returned";
}

export function buildLiveCheckReport(input: LiveCheckInput): LiveCheckReport {
  const lines: CheckLine[] = [];
  const add = (outcome: CheckOutcome, text: string): void => {
    lines.push({ outcome, text });
  };

  const exportsByBatch = {
    1: input.batch1Export,
    2: input.batch2Export,
  };
  const areas = {
    1: editableArea(input.batch1Export),
    2: editableArea(input.batch2Export),
  };
  const sectionOf = (batch: 1 | 2): string | null =>
    areas[batch].kind === "section" ? areas[batch].body : null;

  for (const batch of [1, 2] as const) {
    const area = areas[batch];
    if (area.kind === "missing") {
      add(
        "fail",
        `the batch-${batch} page export has no "${EDITABLE_HEADING}" heading, so nothing on that page is Bot-editable.`,
      );
    } else if (area.kind === "ambiguous") {
      add(
        "fail",
        `the batch-${batch} page export carries ${area.count} "${EDITABLE_HEADING}" headings, so the editable area is not one area.`,
      );
    }
  }

  const initialArea = editableArea(input.initialPage);
  if (initialArea.kind !== "section") {
    add(
      "fail",
      `the initial page copy has no single "${EDITABLE_HEADING}" heading, so no area of the saved pages can be treated as protected.`,
    );
  } else {
    const initialOutside = outsideEditable(input.initialPage, initialArea);
    for (const batch of [1, 2] as const) {
      const area = areas[batch];
      if (area.kind !== "section") continue;
      const outside = outsideEditable(exportsByBatch[batch], area);
      if (outside === initialOutside) {
        add(
          "pass",
          `batch-${batch} page export: everything outside the Bot-editable section matches the initial page.`,
        );
      } else {
        add(
          "fail",
          `batch-${batch} page export: content outside the Bot-editable section differs from the initial page at ${firstDifference(initialOutside, outside)}`,
        );
      }
    }
  }

  for (const [index, paragraph] of input.caseData.protectedText.entries()) {
    const brokenIn = ([1, 2] as const)
      .filter((batch) => !exportsByBatch[batch].includes(paragraph))
      .map((batch) => `batch-${batch}`);
    if (brokenIn.length === 0) {
      add(
        "pass",
        `protected paragraph ${index + 1} is intact in both page exports: "${shorten(paragraph)}"`,
      );
    } else {
      add(
        "fail",
        `protected paragraph ${index + 1} is not intact in the ${brokenIn.join(" and ")} page export: "${shorten(paragraph)}"`,
      );
    }
  }

  /*
   * A fact's identity is checked through its cited evidence, not by matching the claim's prose:
   * the model words the claim itself, while the case fixes the excerpts and the source ids that
   * must carry it. Anything looser would put a judgment call back into the check.
   */
  const factsByBatch = {
    1: input.caseData.expected.afterBatch1,
    2: input.caseData.expected.afterBatch2,
  };
  for (const batch of [1, 2] as const) {
    const body = sectionOf(batch);
    for (const fact of factsByBatch[batch]) {
      if (body === null) {
        add(
          "fail",
          `batch-${batch} fact ${fact.id} cannot be verified: the page export has no single Bot-editable section.`,
        );
        continue;
      }
      const cited = [...new Set(fact.evidence.map((entry) => entry.sourceId))];
      const misses: string[] = [];
      for (const evidence of fact.evidence) {
        if (!body.includes(evidence.quote)) {
          misses.push(
            `the ${evidence.sourceId} excerpt "${shorten(evidence.quote)}" is absent`,
          );
        }
      }
      for (const sourceId of cited) {
        if (!citedIn(body, sourceId)) {
          misses.push(`source ${sourceId} is not cited`);
        }
      }
      if (misses.length === 0) {
        add(
          "pass",
          `batch-${batch} fact ${fact.id}: every cited excerpt present (${cited.join(", ")}).`,
        );
      } else {
        for (const miss of misses) {
          add("fail", `batch-${batch} fact ${fact.id}: ${miss}.`);
        }
      }
    }
  }

  const normalized = (text: string): string =>
    text.replace(/\s+/g, " ").trim().toLowerCase();
  for (const forbidden of input.caseData.mustNotAppearAsFindings) {
    const foundIn = ([1, 2] as const)
      .filter((batch) => {
        const body = sectionOf(batch);
        return (
          body !== null && normalized(body).includes(normalized(forbidden))
        );
      })
      .map((batch) => `batch-${batch}`);
    if (foundIn.length === 0) {
      add(
        "pass",
        `forbidden finding absent from both page exports: "${shorten(forbidden)}"`,
      );
    } else {
      add(
        "fail",
        `forbidden finding is present in the ${foundIn.join(" and ")} page export: "${shorten(forbidden)}"`,
      );
    }
  }

  const duplicate = input.caseData.sources.find(
    (source): source is CaseSource & { duplicateOf: string } =>
      source.duplicateOf !== undefined,
  );
  if (duplicate) {
    const body = sectionOf(2);
    if (body === null) {
      add(
        "fail",
        "the duplicate rule cannot be checked: the batch-2 page export has no single Bot-editable section.",
      );
    } else {
      if (body.includes(duplicate.id)) {
        add(
          "fail",
          `the batch-2 read-back carries a ${duplicate.id} citation, so the mirror was treated as its own source.`,
        );
      } else {
        add("pass", `no ${duplicate.id} citation in the batch-2 read-back.`);
      }
      /*
       * A second entry for the canonical source shows up as its excerpt carried twice: the mirror
       * is byte-identical, so a finding built from it repeats the canonical quote word for word.
       */
      let repeated = false;
      for (const fact of factsByBatch[2]) {
        for (const evidence of fact.evidence) {
          if (evidence.sourceId !== duplicate.duplicateOf) continue;
          const occurrences = countOccurrences(body, evidence.quote);
          if (occurrences > 1) {
            repeated = true;
            add(
              "fail",
              `a second ${duplicate.duplicateOf} entry: the excerpt "${shorten(evidence.quote)}" appears ${occurrences} times in the batch-2 read-back.`,
            );
          }
        }
      }
      if (!repeated) {
        add(
          "pass",
          `each ${duplicate.duplicateOf} excerpt appears once in the batch-2 read-back, so the mirror wrote no second entry.`,
        );
      }
    }
  }

  const updateOperations = (history: HistoryRows, runId: string) =>
    history.operations.filter(
      (operation) =>
        operation.runId === runId && operation.toolName === CHAIN.update,
    );

  const batch1Runs = input.batch1History.runs;
  const batch2Runs = input.batch2History.runs;
  if (batch1Runs.length !== 1) {
    add(
      "fail",
      `the batch-1 history holds ${batch1Runs.length} runs; the case drives one thread once, so it must hold exactly the batch-1 run.`,
    );
  }
  if (batch2Runs.length !== 2) {
    add(
      "fail",
      `the batch-2 history holds ${batch2Runs.length} runs; the case drives one thread twice, so it must hold exactly the batch-1 and batch-2 runs.`,
    );
  }
  const sameThread =
    batch1Runs.length === 1 &&
    batch2Runs.length === 2 &&
    batch1Runs[0].id === batch2Runs[0].id;
  if (batch1Runs.length === 1 && batch2Runs.length === 2 && !sameThread) {
    add(
      "fail",
      `the batch-1 history's run ${batch1Runs[0].id} is not the batch-2 history's first run ${batch2Runs[0].id}; the two files are not the same thread read at two moments.`,
    );
  }

  if (batch1Runs.length === 1) {
    const run = batch1Runs[0];
    const count = updateOperations(input.batch1History, run.id).length;
    add(
      count === 1 ? "pass" : "fail",
      count === 1
        ? `batch-1 history run ${run.id}: exactly 1 ${CHAIN.update} operation.`
        : `batch-1 history run ${run.id}: ${count} ${CHAIN.update} operations, expected exactly 1.`,
    );
  }
  if (sameThread) {
    for (const [index, run] of batch2Runs.entries()) {
      const count = updateOperations(input.batch2History, run.id).length;
      add(
        count === 1 ? "pass" : "fail",
        count === 1
          ? `batch-${index + 1} run ${run.id}: exactly 1 ${CHAIN.update} operation.`
          : `batch-${index + 1} run ${run.id}: ${count} ${CHAIN.update} operations, expected exactly 1.`,
      );
    }
  }

  /*
   * The trace line carries no run identity: the join to a run is the tool call id, the same id
   * `local_operations` records. The line names its server by URL, which is how one server's calls
   * are filtered out of a shared log; the tool-name prefix catches a connection whose URL no
   * longer names the vendor.
   */
  const notionTrace = input.trace.filter(
    (line) =>
      line.server.toLowerCase().includes("notion") ||
      line.tool.startsWith("notion-"),
  );
  if (notionTrace.length === 0) {
    add(
      "fail",
      "the connector trace holds no call to the Notion server, so no physical write can be counted.",
    );
  }

  const operationsByCallId = new Map<string, string>();
  for (const operation of [
    ...input.batch1History.operations,
    ...input.batch2History.operations,
  ]) {
    operationsByCallId.set(operation.toolCallId, operation.runId);
  }

  const mutationsByRun = new Map<string, TraceLine[]>();
  for (const line of notionTrace) {
    if (CHAIN.reads.includes(line.tool)) continue;
    if (line.tool === CHAIN.update) {
      if (line.outcome !== "succeeded") {
        add(
          "note",
          `a physical ${CHAIN.update} failed (tool call id ${line.toolCallId ?? "absent"}); it is not counted as a mutation.`,
        );
        continue;
      }
      if (line.toolCallId === undefined) {
        add(
          "inconclusive",
          `a physical ${CHAIN.update} succeeded with no tool call id, so no recorded operation can explain it.`,
        );
        continue;
      }
      const runId = operationsByCallId.get(line.toolCallId);
      if (runId === undefined) {
        add(
          "inconclusive",
          `a physical ${CHAIN.update} succeeded for tool call id ${line.toolCallId}, which no recorded operation holds.`,
        );
        continue;
      }
      const attributed = mutationsByRun.get(runId) ?? [];
      attributed.push(line);
      mutationsByRun.set(runId, attributed);
    } else {
      if (line.outcome === "succeeded") {
        add(
          "inconclusive",
          `the trace shows a succeeded physical call to ${line.tool}, which the chain does not include; the check cannot bound what it mutated.`,
        );
      } else {
        add(
          "note",
          `the trace shows a failed physical call to ${line.tool}, which the chain does not include; a failed call is not a mutation.`,
        );
      }
    }
  }

  if (sameThread) {
    for (const [index, run] of batch2Runs.entries()) {
      const mutations = mutationsByRun.get(run.id) ?? [];
      if (mutations.length === 1) {
        add(
          "pass",
          `batch-${index + 1} run ${run.id}: exactly 1 physical mutation (${CHAIN.update}, tool call id ${mutations[0].toolCallId}).`,
        );
      } else if (mutations.length === 0) {
        add(
          "fail",
          `batch-${index + 1} run ${run.id}: no physical ${CHAIN.update} succeeded in the trace, so the recorded write cannot be confirmed.`,
        );
      } else {
        add(
          "fail",
          `batch-${index + 1} run ${run.id}: ${mutations.length} physical ${CHAIN.update} calls succeeded, so the batch wrote more than once.`,
        );
      }
    }
    for (const run of batch2Runs) {
      for (const operation of updateOperations(input.batch2History, run.id)) {
        const traced = notionTrace.some(
          (line) =>
            line.tool === CHAIN.update &&
            line.toolCallId === operation.toolCallId,
        );
        if (!traced) {
          add(
            "fail",
            `run ${run.id} records a ${CHAIN.update} operation (tool call id ${operation.toolCallId}) with no physical call in the trace; the trace saved is not the whole run.`,
          );
        }
      }
    }

    /*
     * Reported, never a verdict: the design accepts the event's absence when the locked SDK
     * exposes no usage, and only the operator knows which of the two she is looking at.
     */
    for (const [index, run] of batch2Runs.entries()) {
      const usage = input.batch2History.events.find(
        (event) => event.type === "model.usage" && event.runId === run.id,
      );
      add(
        "note",
        usage
          ? `batch-${index + 1} run ${run.id}: model.usage present (${usageSummary(usage.payload)}).`
          : `batch-${index + 1} run ${run.id}: no model.usage event; honest only if the locked SDK exposed no usage.`,
      );
    }
  }

  const verdict: LiveCheckVerdict = lines.some(
    (line) => line.outcome === "fail",
  )
    ? "fail"
    : lines.some((line) => line.outcome === "inconclusive")
      ? "inconclusive"
      : "pass";
  return { verdict, lines };
}

const EVIDENCE_FILES = [
  "page-export-batch-1.md",
  "page-export-batch-2.md",
  "history-batch-1.json",
  "history-batch-2.json",
  "connector-trace.log",
] as const;

/*
 * The trace file is a saved server log, not a JSON document: only the mcp-call lines are the
 * trace, and every other line is noise to skip rather than a parse error.
 */
function readTraceLines(path: string): TraceLine[] {
  const traced: TraceLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const candidate = raw.trim();
    if (!candidate.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const line = parseTraceLine(parsed);
    if (line) traced.push(line);
  }
  return traced;
}

function main(argv: string[]): number | string {
  if (argv.length !== 1) {
    return "usage: bun scripts/aooo/live-check.ts <evidence-dir>";
  }
  const evidenceDir = resolve(argv[0]);
  if (!existsSync(evidenceDir)) {
    return `the evidence directory ${evidenceDir} does not exist.`;
  }
  const missing = EVIDENCE_FILES.filter(
    (name) => !existsSync(join(evidenceDir, name)),
  );
  for (const name of missing) {
    console.log(
      `${"FAIL".padEnd(13)}missing evidence file ${name}, expected at ${join(evidenceDir, name)}.`,
    );
  }
  if (missing.length > 0) return 1;

  const fixtureDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../tests/fixtures/aooo",
  );
  const parsedCase = parseCase(
    JSON.parse(readFileSync(join(fixtureDir, "case.json"), "utf8")),
  );
  if (!parsedCase) {
    return "the frozen case could not be parsed: it no longer holds the shape this check reads (caseId, sources with ids and the declared duplicate, expected facts with evidence excerpts, mustNotAppearAsFindings, protectedText).";
  }
  const initialPage = readFileSync(join(fixtureDir, "initial-page.md"), "utf8");

  const readHistory = (name: (typeof EVIDENCE_FILES)[number]): HistoryRows => {
    const parsed = parseHistory(
      JSON.parse(readFileSync(join(evidenceDir, name), "utf8")),
    );
    if (!parsed) {
      throw new Error(
        `${name} is not a saved history read: it must hold runs, operations, and events with the columns the route returns.`,
      );
    }
    return parsed;
  };

  const report = buildLiveCheckReport({
    caseData: parsedCase,
    initialPage,
    batch1Export: readFileSync(
      join(evidenceDir, "page-export-batch-1.md"),
      "utf8",
    ),
    batch2Export: readFileSync(
      join(evidenceDir, "page-export-batch-2.md"),
      "utf8",
    ),
    batch1History: readHistory("history-batch-1.json"),
    batch2History: readHistory("history-batch-2.json"),
    trace: readTraceLines(join(evidenceDir, "connector-trace.log")),
  });

  console.log(
    `live check of ${evidenceDir} against frozen case ${parsedCase.caseId}`,
  );
  for (const line of report.lines) {
    console.log(`${line.outcome.toUpperCase().padEnd(13)} ${line.text}`);
  }
  const verdict =
    report.verdict === "pass"
      ? "PASS"
      : report.verdict === "fail"
        ? "FAIL"
        : "INCONCLUSIVE (insufficient trust in the trace: neither pass nor fail)";
  console.log(`VERDICT: ${verdict}`);
  return report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 2;
}

if (import.meta.main) {
  try {
    const outcome = main(process.argv.slice(2));
    if (typeof outcome === "string") {
      console.error(outcome);
      process.exit(1);
    }
    process.exit(outcome);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
