// The unit 7 live-run judge, proven against synthetic evidence directories.
//
// `scripts/aooo/live-check.ts` turns the artifacts the operator's live run saves into a repeatable
// pass, fail, or inconclusive verdict. The live artifacts themselves exist only on the operator's
// machine after her run, so this suite builds synthetic directories in the shapes the artifacts
// really have: the saved `GET /threads/:threadId/history` body (server/src/local-runtime/routes.ts
// and store.ts), the mcp-call trace lines the connector logs (server/src/plugins/mcp.ts), and page
// exports diffed against the frozen initial page. Every case runs the script as a subprocess and
// asserts its exit code and report, because the exit code is the contract the acceptance records.
//
// No database, no Notion account, no model: the judge is a comparison, and a comparison is proven
// with controlled inputs.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCase } from "../../scripts/aooo/live-check";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureDir = join(repoRoot, "tests/fixtures/aooo");
const scriptPath = join(repoRoot, "scripts/aooo/live-check.ts");

const parsedCase = parseCase(
  JSON.parse(readFileSync(join(fixtureDir, "case.json"), "utf8")),
);
if (!parsedCase)
  throw new Error(
    "the frozen case no longer holds the shape this suite reads.",
  );
const caseData = parsedCase;
const initialPage = readFileSync(join(fixtureDir, "initial-page.md"), "utf8");

const findingsLines = (batch: "afterBatch1" | "afterBatch2"): string =>
  caseData.expected[batch]
    .flatMap((fact) =>
      fact.evidence.map((entry) => `- [${entry.sourceId}] ${entry.quote}`),
    )
    .join("\n");

const exportAfter = (batch: "afterBatch1" | "afterBatch2"): string =>
  initialPage.replace(
    "No compatibility findings recorded yet.",
    findingsLines(batch),
  );

const threadId = "thread-1";
const actorId = "user-1";
/*
 * The post-fix channel topology (issue #6): one message is several runs. The announce run ends on
 * the model's tool call, the continuation run carries the executed result back and holds the write.
 * So each batch is a set of runs, and the judge scopes by set, never by a single run id.
 */
const runIds = {
  batch1Read: "run-batch-1-read",
  batch1Write: "run-batch-1-write",
  batch2Read: "run-batch-2-read",
  batch2Write: "run-batch-2-write",
} as const;

const runRow = (id: string, createdAt: string) => ({
  id,
  threadId,
  actorId,
  source: "manual",
  requestKey: `submission-${id}`,
  requestHash: "hash-of-the-submitted-message",
  businessRef: null,
  status: "succeeded",
  resultRef: null,
  error: null,
  createdAt,
  finishedAt: createdAt,
});

const attemptRow = (runId: string, createdAt: string) => ({
  id: `attempt-${runId}`,
  runId,
  threadId,
  generation: runId.startsWith("run-batch-1") ? 1 : 2,
  owner: "local-runtime",
  leaseUntil: createdAt,
  status: "succeeded",
  stopRequested: false,
  endReason: null,
  createdAt,
  finishedAt: createdAt,
});

const operationRow = (
  runId: string,
  toolCallId: string,
  toolName:
    | "mcp__notion__notion-fetch"
    | "mcp__notion__notion-update-page",
) => ({
  id: `operation-${toolCallId}`,
  threadId,
  runId,
  attemptId: `attempt-${runId}`,
  toolCallId,
  toolName,
  target: toolName.endsWith("update-page") ? "compass-alder page" : null,
  parameters: {},
  actorId,
  dispatched: true,
  status: "succeeded",
  result: { value: "ok" },
  createdAt: "2026-11-21T10:00:01.000Z",
  dispatchedAt: "2026-11-21T10:00:01.000Z",
  settledAt: "2026-11-21T10:00:02.000Z",
});

const eventRow = (
  sequence: number,
  runId: string,
  type: string,
  payload: Record<string, unknown>,
) => ({
  id: `event-${sequence}`,
  threadId,
  sequence,
  runId,
  attemptId: `attempt-${runId}`,
  type,
  messageId: null,
  payload,
  createdAt: "2026-11-21T10:00:00.000Z",
});

/*
 * The chain's real shape: the announce run reads the page, the continuation run writes it once
 * and reads it back. Exactly like the live run the evidence record holds. The recorded
 * `tool_name` carries the granted (server-prefixed) spelling; the trace's `tool` field carries
 * the vendor spelling — both are pinned here, because a judge that only knew one would count
 * zero writes on the other's evidence.
 */
const readOperations = (runId: string) => [
  operationRow(runId, `call-${runId}-fetch-1`, "mcp__notion__notion-fetch"),
];
const writeOperations = (runId: string) => [
  operationRow(
    runId,
    `call-${runId}-update`,
    "mcp__notion__notion-update-page",
  ),
  operationRow(runId, `call-${runId}-fetch-2`, "mcp__notion__notion-fetch"),
];

const runEvents = (runId: string, from: number) => [
  eventRow(from, runId, "run.queued", {
    requestKey: `submission-${runId}`,
    source: "manual",
  }),
  eventRow(from + 1, runId, "attempt.started", {
    generation: 1,
    owner: "local-runtime",
  }),
  eventRow(from + 2, runId, "operation.intent", {
    operationId: `operation-call-${runId}-update`,
    toolName: "notion-update-page",
  }),
  eventRow(from + 3, runId, "model.usage", {
    model: "deepseek/deepseek-v4.1-flash",
    provider: "openai",
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
  }),
  eventRow(from + 4, runId, "attempt.succeeded", {}),
];

const historyBody = (
  runs: Array<ReturnType<typeof runRow>>,
  operations: Array<ReturnType<typeof operationRow>>,
  events: Array<ReturnType<typeof eventRow>>,
) => ({
  binding: {
    threadId,
    ownerUserId: actorId,
    agentId: "agent-1",
    historyVersion: 1,
    nextEventSequence: events.length + 1,
    executionGeneration: runs.length,
    createdAt: "2026-11-21T09:00:00.000Z",
    updatedAt: "2026-11-21T12:00:00.000Z",
  },
  events,
  messages: [],
  runs,
  attempts: runs.map((run) => attemptRow(run.id, run.createdAt)),
  operations,
});

const batch1Runs = [
  runRow(runIds.batch1Read, "2026-11-21T10:00:00.000Z"),
  runRow(runIds.batch1Write, "2026-11-21T10:00:10.000Z"),
];
const batch2NewRuns = [
  runRow(runIds.batch2Read, "2026-11-21T11:00:00.000Z"),
  runRow(runIds.batch2Write, "2026-11-21T11:00:10.000Z"),
];
const batch1History = historyBody(
  batch1Runs,
  [...readOperations(runIds.batch1Read), ...writeOperations(runIds.batch1Write)],
  [...runEvents(runIds.batch1Read, 1), ...runEvents(runIds.batch1Write, 6)],
);
const batch2History = historyBody(
  [...batch1Runs, ...batch2NewRuns],
  [
    ...readOperations(runIds.batch1Read),
    ...writeOperations(runIds.batch1Write),
    ...readOperations(runIds.batch2Read),
    ...writeOperations(runIds.batch2Write),
  ],
  [
    ...runEvents(runIds.batch1Read, 1),
    ...runEvents(runIds.batch1Write, 6),
    ...runEvents(runIds.batch2Read, 11),
    ...runEvents(runIds.batch2Write, 16),
  ],
);

const traceLine = (
  tool: string,
  toolCallId?: string,
  outcome: "succeeded" | "failed" = "succeeded",
): string =>
  JSON.stringify({
    type: "mcp-call",
    server: "https://mcp.notion.com/mcp",
    tool,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    outcome,
  });

const readTrace = (runId: string): string[] => [
  traceLine("notion-fetch", `call-${runId}-fetch-1`),
];
const writeTrace = (runId: string): string[] => [
  traceLine("notion-update-page", `call-${runId}-update`),
  traceLine("notion-fetch", `call-${runId}-fetch-2`),
];

// A saved server log: mcp-call JSON lines between ordinary log noise, and one call from another
// connector that the Notion check must ignore.
const passingTrace = [
  "[2026-11-21T09:59:00Z] local runtime listening on port 3000",
  ...readTrace(runIds.batch1Read),
  ...writeTrace(runIds.batch1Write),
  ...readTrace(runIds.batch2Read),
  ...writeTrace(runIds.batch2Write),
  JSON.stringify({
    type: "mcp-call",
    server: "https://mcp.example.com/mcp",
    tool: "search",
    toolCallId: "call-unrelated-server",
    outcome: "succeeded",
  }),
].join("\n");

const rel25 = caseData.expected.afterBatch2
  .flatMap((fact) => fact.evidence)
  .find((entry) => entry.sourceId === "REL-25");
if (!rel25)
  throw new Error(
    "the frozen case has no REL-25 excerpt for the mirror to repeat.",
  );

const failingBatch2Export = initialPage
  .replace(
    "No compatibility findings recorded yet.",
    [
      ...caseData.expected.afterBatch2.map((fact) =>
        fact.evidence
          .filter(
            (entry) =>
              !(
                fact.id === "production-still-exposed" &&
                entry.quote.includes("Production still uses")
              ),
          )
          .map((entry) => `- [${entry.sourceId}] ${entry.quote}`)
          .join("\n"),
      ),
      `- [REL-25-MIRROR] The mirror repeats it: ${rel25.quote}`,
      "The admin dashboard color theme is a Compass compatibility issue.",
    ].join("\n"),
  )
  .replace("Owner: Integration team.", "Owner: The Bot.");

/*
 * What a real Notion read-back looks like: the page the model wrote renders back with <code> for
 * inline code and escaped square brackets, while the frozen case fixes its excerpts in the
 * source's own markdown. The judge has to compare through that rendering or no live run can ever
 * carry its evidence verbatim.
 */
const notionRendered = (markdown: string): string =>
  markdown
    .replace(/`([^`]*)`/g, "<code>$1</code>")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

/*
 * What a compliant run may still write: a provenance note that NAMES the mirror to say it is a
 * copy — the duplicate rule forbids citing the mirror as a source, not mentioning what it is.
 */
const proseMirrorNote = (markdown: string): string =>
  markdown.replace(
    "## Owner notes (protected)",
    "Source note: REL-25-MIRROR is a byte-identical copy of REL-25 and is cited under the single source ID REL-25. It is one source, not a second independent change.\n\n## Owner notes (protected)",
  );

/*
 * A synthesis paragraph may reuse a short technical token the sources introduced; that is not a
 * second entry. The mirror could only build a second entry by repeating its byte-identical
 * sentences, which the long excerpts cover.
 */
const synthesisRepeatingShortToken = (markdown: string): string =>
  markdown.replace(
    "## Owner notes (protected)",
    "Synthesis: on 2.5 `createClient` rejects the legacy setting with `UNSUPPORTED_RETRY_MODE`, so production must migrate.\n\n## Owner notes (protected)",
  );

type EvidenceOverrides = {
  batch2Export?: string;
  batch2Operations?: Array<ReturnType<typeof operationRow>>;
  extraTraceLines?: string[];
  /** The batch-1 file names a run the batch-2 file does not open with: not the same thread. */
  batch1RunsFromAnotherThread?: boolean;
  /** The batch-2 file holds no run beyond the batch-1 runs: the second message never ran. */
  batch2AddsNoRuns?: boolean;
  /** Both page exports are written as a real Notion read-back renders them. */
  notionRenderedExports?: boolean;
  /** The batch-2 body carries a prose note naming the mirror as a copy, not citing it. */
  batch2ProseMirrorNote?: boolean;
  /** The batch-2 synthesis paragraph reuses the short `UNSUPPORTED_RETRY_MODE` token. */
  batch2SynthesisRepeatsShortToken?: boolean;
  /** The batch-2 run first attempted a write the vendor rejected, then wrote successfully. */
  batch2RejectedWriteAttempt?: boolean;
};

function writeEvidenceDirectory(overrides: EvidenceOverrides = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "live-check-"));
  const renderIfAsked = (text: string): string =>
    overrides.notionRenderedExports ? notionRendered(text) : text;
  writeFileSync(
    join(dir, "page-export-batch-1.md"),
    renderIfAsked(exportAfter("afterBatch1")),
  );
  writeFileSync(
    join(dir, "page-export-batch-2.md"),
    renderIfAsked(
      overrides.batch2ProseMirrorNote
        ? proseMirrorNote(exportAfter("afterBatch2"))
        : overrides.batch2SynthesisRepeatsShortToken
          ? synthesisRepeatingShortToken(exportAfter("afterBatch2"))
          : (overrides.batch2Export ?? exportAfter("afterBatch2")),
    ),
  );
  const savedBatch1History = overrides.batch1RunsFromAnotherThread
    ? {
        ...batch1History,
        runs: batch1History.runs.map((run, index) =>
          index === 0 ? { ...run, id: "run-from-another-thread" } : run,
        ),
      }
    : batch1History;
  writeFileSync(
    join(dir, "history-batch-1.json"),
    JSON.stringify(savedBatch1History, null, 2),
  );
  const savedBatch2History = overrides.batch2AddsNoRuns
    ? {
        ...batch2History,
        runs: batch2History.runs.slice(0, batch1Runs.length),
        operations: batch2History.operations.filter((operation) =>
          batch1Runs.some((run) => operation.runId === run.id),
        ),
        events: batch2History.events.filter((event) =>
          event.runId === null
            ? true
            : batch1Runs.some((run) => event.runId === run.id),
        ),
      }
    : batch2History;
  const rejectedAttemptOperations = overrides.batch2RejectedWriteAttempt
    ? [
        operationRow(
          runIds.batch2Write,
          "call-run-batch-2-write-update-rejected",
          "mcp__notion__notion-update-page",
        ),
      ]
    : [];
  writeFileSync(
    join(dir, "history-batch-2.json"),
    JSON.stringify(
      {
        ...savedBatch2History,
        operations: [
          ...savedBatch2History.operations,
          ...(overrides.batch2Operations ?? []),
          ...rejectedAttemptOperations,
        ],
      },
      null,
      2,
    ),
  );
  const rejectedAttemptTrace = overrides.batch2RejectedWriteAttempt
    ? [
        traceLine(
          "notion-update-page",
          "call-run-batch-2-write-update-rejected",
          "failed",
        ),
      ]
    : [];
  writeFileSync(
    join(dir, "connector-trace.log"),
    [
      passingTrace,
      ...rejectedAttemptTrace,
      ...(overrides.extraTraceLines ?? []),
    ].join("\n"),
  );
  return dir;
}

async function runLiveCheck(
  dir: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, scriptPath, dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, stdout };
}

describe("live-check against synthetic evidence directories", () => {
  test("a passing run exits zero with every check passing", async () => {
    const dir = writeEvidenceDirectory();
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("VERDICT: PASS");
      expect(stdout).not.toContain("FAIL");
      expect(stdout).toContain(
        "batch-1 fact legacy-deprecated: every cited excerpt present (REL-24, INV-01)",
      );
      expect(stdout).toContain(
        "batch-2 fact page-size-still-unaffected: every cited excerpt present (REL-25, INV-02)",
      );
      expect(stdout).toContain(
        "everything outside the Bot-editable section matches the initial page",
      );
      expect(stdout).toContain("protected paragraph 1 is intact");
      expect(stdout).toContain("protected paragraph 2 is intact");
      expect(stdout).toContain(
        "forbidden finding absent from both page exports",
      );
      expect(stdout).toContain(
        "no REL-25-MIRROR citation in the batch-2 read-back",
      );
      expect(stdout).toContain(
        "each REL-25 excerpt appears once in the batch-2 read-back",
      );
      expect(stdout).toContain(
        "batch-1 history: exactly 1 notion-update-page operation physically wrote across its 2 runs.",
      );
      expect(stdout).toContain(
        "batch-2 history: exactly 1 notion-update-page operation physically wrote across the 2 runs the second message added.",
      );
      expect(stdout).toContain(
        "batch-1 runs: exactly 1 physical mutation (notion-update-page, tool call id call-run-batch-1-write-update).",
      );
      expect(stdout).toContain(
        "batch-2 runs: exactly 1 physical mutation (notion-update-page, tool call id call-run-batch-2-write-update).",
      );
      expect(stdout).toContain("model.usage present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run that breaks every rule exits one naming each violation", async () => {
    const dir = writeEvidenceDirectory({
      batch2Export: failingBatch2Export,
      batch2Operations: [
        operationRow(
          runIds.batch2Write,
          "call-run-batch-2-write-update-2",
          "mcp__notion__notion-update-page",
        ),
      ],
      extraTraceLines: [
        traceLine("notion-update-page", "call-run-batch-2-write-update-2"),
      ],
    });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("VERDICT: FAIL");
      expect(stdout).toContain("batch-2 fact production-still-exposed");
      expect(stdout).toContain("is absent");
      expect(stdout).toContain(
        "the batch-2 read-back carries a REL-25-MIRROR citation",
      );
      expect(stdout).toContain("a second REL-25 entry");
      expect(stdout).toContain("forbidden finding is present");
      expect(stdout).toContain(
        "content outside the Bot-editable section differs",
      );
      expect(stdout).toContain("protected paragraph 1 is not intact");
      expect(stdout).toContain(
        "batch-2 history: 2 notion-update-page operations physically wrote across the 2 runs the second message added, expected exactly 1.",
      );
      expect(stdout).toContain("wrote more than once");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unattributable mutation is inconclusive, neither pass nor fail", async () => {
    const dir = writeEvidenceDirectory({
      extraTraceLines: [traceLine("notion-update-page")],
    });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(2);
      expect(stdout).toContain("VERDICT: INCONCLUSIVE");
      expect(stdout).toContain(
        "succeeded with no tool call id, so no recorded operation can explain it",
      );
      expect(stdout).toContain(
        "batch-1 fact legacy-deprecated: every cited excerpt present",
      );
      expect(stdout).not.toContain("VERDICT: PASS");
      expect(stdout).not.toContain("VERDICT: FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("histories from two different threads fail the identity check", async () => {
    const dir = writeEvidenceDirectory({
      batch1RunsFromAnotherThread: true,
    });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("VERDICT: FAIL");
      expect(stdout).toContain(
        "are not the batch-2 history's opening runs; the two files are not the same thread read at two moments.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a batch-2 history with no run beyond the batch-1 runs fails", async () => {
    const dir = writeEvidenceDirectory({
      batch2AddsNoRuns: true,
    });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("VERDICT: FAIL");
      expect(stdout).toContain(
        "the batch-2 history holds no run beyond the batch-1 runs; the second message never ran in this thread.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Notion-rendered read-back still carries its excerpts verbatim", async () => {
    const dir = writeEvidenceDirectory({ notionRenderedExports: true });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("VERDICT: PASS");
      expect(stdout).not.toContain("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a vendor-rejected write attempt is a note, not a second write", async () => {
    const dir = writeEvidenceDirectory({ batch2RejectedWriteAttempt: true });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("VERDICT: PASS");
      expect(stdout).toContain(
        "a physical notion-update-page failed (tool call id call-run-batch-2-write-update-rejected)",
      );
      expect(stdout).not.toContain("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prose note naming the mirror as a copy is not a mirror citation", async () => {
    const dir = writeEvidenceDirectory({ batch2ProseMirrorNote: true });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("VERDICT: PASS");
      expect(stdout).toContain(
        "no REL-25-MIRROR citation in the batch-2 read-back.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a synthesis paragraph reusing a short token is not a second entry", async () => {
    const dir = writeEvidenceDirectory({
      batch2SynthesisRepeatsShortToken: true,
    });
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("VERDICT: PASS");
      expect(stdout).toContain(
        "each REL-25 excerpt appears once in the batch-2 read-back",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each missing evidence file is named on its own line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-check-"));
    try {
      const { exitCode, stdout } = await runLiveCheck(dir);
      expect(exitCode).toBe(1);
      for (const name of [
        "page-export-batch-1.md",
        "page-export-batch-2.md",
        "history-batch-1.json",
        "history-batch-2.json",
        "connector-trace.log",
      ]) {
        expect(stdout).toContain(`missing evidence file ${name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
