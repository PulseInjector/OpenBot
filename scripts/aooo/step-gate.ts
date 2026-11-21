#!/usr/bin/env bun
// The per-step verification battery for aooo development steps.
//
// WHY ONE COMMAND. Every fanned-out step in the stage-one run ended with the coordinator rerunning
// the same checks by hand and transcribing the results into .local/dev-log.md. That hand-work was
// the slowest repeated cost of the run, and it drifted twice: `biome check` catches import sorting
// that `lint` and `format` do not, and a piped command masked a non-zero exit once. This script runs
// the battery the same way every step, prints one table, and appends one result line to the dev log
// when asked.
//
// WHAT IT RUNS, in order, all of them even when one fails:
//   typecheck      `bun run --filter '*' typecheck` across the root workspaces.
//   tests-tsc      `bun scripts/typecheck-tests.ts`, against the frozen error baseline.
//   lint           `biome lint --error-on-warnings` over the whole repository.
//   format         `biome format` over the whole repository. The raw directories .logs/,
//                  .demo-logs/, and .local/ are excluded in biome.json, so the check covers
//                  tracked source plus a step's new files and never the ignored dumps.
//   test <file>    `bun test <file>` for every positional argument, in the order given.
//   files          only with --files: `biome check` over the named files, the import-sort and
//                  assist rules the whole-repo commands do not gate on. Pass the step's own new
//                  or edited files. Everything after --files belongs to that list.
//   journey        only with --journey: `bun run verify:aooo <name>`, the isolated acceptance
//                  runner with its own database and cleanup.
//
// EXIT 0 when every check passes, 1 when any fails, 2 on a usage error. The table names each failed
// check; nothing is retried, and the only write is the optional dev-log line.
//
// Usage:
//   bun scripts/aooo/step-gate.ts server/tests/my-step.test.ts
//   bun scripts/aooo/step-gate.ts server/tests/my-step.test.ts --files app/src/lib/new.ts --note
//   bun scripts/aooo/step-gate.ts --journey local-runtime
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const tests: string[] = [];
const biomeFiles: string[] = [];
let journey: string | null = null;
let note = false;

function bail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--note") note = true;
  else if (arg === "--journey") {
    journey = args[++i] ?? bail("--journey needs a journey name.");
  } else if (arg === "--files") {
    // Everything after --files belongs to the biome-check scope, flags excepted.
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      biomeFiles.push(args[++i]);
    }
  } else if (arg.startsWith("--")) {
    bail(`unknown flag ${arg}`);
  } else {
    tests.push(arg);
  }
}

const missing = tests.filter((t) => !existsSync(resolve(repoRoot, t)));
if (missing.length > 0) bail(`no such test file(s): ${missing.join(", ")}`);
const missingBiome = biomeFiles.filter(
  (f) => !existsSync(resolve(repoRoot, f)),
);
if (missingBiome.length > 0)
  bail(`no such --files path(s): ${missingBiome.join(", ")}`);

type Check = { name: string; cmd: string[] };

const checks: Check[] = [
  { name: "typecheck", cmd: ["bun", "run", "--filter", "*", "typecheck"] },
  { name: "tests-tsc", cmd: ["bun", "scripts/typecheck-tests.ts"] },
  { name: "lint", cmd: ["bunx", "biome", "lint", "--error-on-warnings", "."] },
  { name: "format", cmd: ["bunx", "biome", "format", "."] },
  ...tests.map((t) => ({ name: `test ${t}`, cmd: ["bun", "test", t] })),
];
if (biomeFiles.length > 0) {
  checks.push({
    name: "biome check (named files)",
    cmd: ["bunx", "biome", "check", ...biomeFiles],
  });
}
if (journey) {
  checks.push({
    name: `journey ${journey}`,
    cmd: ["bun", "run", "verify:aooo", journey],
  });
}

const results: Array<{ name: string; ok: boolean }> = [];
for (const check of checks) {
  console.log(`\n--- step-gate: ${check.name}`);
  const run = spawnSync(check.cmd[0], check.cmd.slice(1), {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
  results.push({ name: check.name, ok: run.status === 0 });
}

const failed = results.filter((r) => !r.ok);
const width = Math.max(...results.map((r) => r.name.length));
console.log("\nstep-gate result:");
for (const r of results) {
  console.log(`  ${r.name.padEnd(width)}  ${r.ok ? "PASS" : "FAIL"}`);
}

if (note) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const verdict =
    failed.length === 0
      ? `step-gate ${stamp}: all ${results.length} checks PASS (${tests.join(" ") || "no test files"}).`
      : `step-gate ${stamp}: FAIL ${failed.map((f) => f.name).join(", ")}; ran ${results.length} checks.`;
  appendFileSync(resolve(repoRoot, ".local/dev-log.md"), `- ${verdict}\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
