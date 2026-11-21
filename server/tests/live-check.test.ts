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
const runIds = { batch1: "run-batch-1", batch2: "run-batch-2" } as const;

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
  generation: runId === runIds.batch1 ? 1 : 2,
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
  toolName: "notion-fetch" | "notion-update-page",
) => ({
  id: `operation-${toolCallId}`,
  threadId,
  runId,
  attemptId: `attempt-${runId}`,
  toolCallId,
  toolName,
  target: toolName === "notion-update-page" ? "compass-alder page" : null,
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

const chainOperations = (runId: string) => [
  operationRow(runId, `call-${runId}-fetch-1`, "notion-fetch"),
  operationRow(runId, `call-${runId}-update`, "notion-update-page"),
  operationRow(runId, `call-${runId}-fetch-2`, "notion-fetch"),
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

const batch1History = historyBody(
  [runRow(runIds.batch1, "2026-11-21T10:00:00.000Z")],
  chainOperations(runIds.batch1),
  runEvents(runIds.batch1, 1),
);
const batch2History = historyBody(
  [
    runRow(runIds.batch1, "2026-11-21T10:00:00.000Z"),
    runRow(runIds.batch2, "2026-11-21T11:00:00.000Z"),
  ],
  [...chainOperations(runIds.batch1), ...chainOperations(runIds.batch2)],
  [...runEvents(runIds.batch1, 1), ...runEvents(runIds.batch2, 6)],
);

const traceLine = (tool: string, toolCallId?: string): string =>
  JSON.stringify({
    type: "mcp-call",
    server: "https://mcp.notion.com/mcp",
    tool,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    outcome: "succeeded",
  });

const chainTrace = (runId: string): string[] => [
  traceLine("notion-fetch", `call-${runId}-fetch-1`),
  traceLine("notion-update-page", `call-${runId}-update`),
  traceLine("notion-fetch", `call-${runId}-fetch-2`),
];

// A saved server log: mcp-call JSON lines between ordinary log noise, and one call from another
// connector that the Notion check must ignore.
const passingTrace = [
  "[2026-11-21T09:59:00Z] local runtime listening on port 3000",
  ...chainTrace(runIds.batch1),
  ...chainTrace(runIds.batch2),
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

type EvidenceOverrides = {
  batch2Export?: string;
  batch2Operations?: Array<ReturnType<typeof operationRow>>;
  extraTraceLines?: string[];
};

function writeEvidenceDirectory(overrides: EvidenceOverrides = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "live-check-"));
  writeFileSync(
    join(dir, "page-export-batch-1.md"),
    exportAfter("afterBatch1"),
  );
  writeFileSync(
    join(dir, "page-export-batch-2.md"),
    overrides.batch2Export ?? exportAfter("afterBatch2"),
  );
  writeFileSync(
    join(dir, "history-batch-1.json"),
    JSON.stringify(batch1History, null, 2),
  );
  writeFileSync(
    join(dir, "history-batch-2.json"),
    JSON.stringify(
      {
        ...batch2History,
        operations: [
          ...batch2History.operations,
          ...(overrides.batch2Operations ?? []),
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "connector-trace.log"),
    [passingTrace, ...(overrides.extraTraceLines ?? [])].join("\n"),
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
        "batch-1 history run run-batch-1: exactly 1 notion-update-page operation",
      );
      expect(stdout).toContain(
        "batch-2 run run-batch-2: exactly 1 notion-update-page operation",
      );
      expect(stdout).toContain("exactly 1 physical mutation");
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
          runIds.batch2,
          "call-run-batch-2-update-2",
          "notion-update-page",
        ),
      ],
      extraTraceLines: [
        traceLine("notion-update-page", "call-run-batch-2-update-2"),
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
        "batch-2 run run-batch-2: 2 notion-update-page operations, expected exactly 1",
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
