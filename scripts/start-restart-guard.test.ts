import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/**
 * How this run differs from the ordinary one, which is the whole vocabulary these tests need.
 *
 * `shell` IS A PARAMETER BECAUSE THE INVOCATION IS PART OF WHAT IS UNDER TEST. `bash` is the
 * supported one and the one the docs name; `sh` is the one somebody reaches for out of habit, and
 * what it produced was exit 1 with no output at all.
 *
 * `omitFromEnv` IS THE OTHER HALF. Every key below has a default in the script, so a `.env` without
 * one is an ordinary `.env` rather than a broken one — `.env.example` does not list `APP_PORT` at
 * all.
 */
type Run = {
  shell?: "bash" | "sh";
  omitFromEnv?: readonly string[];
  settings?: Record<string, string>;
  processEnvironment?: Record<string, string>;
  unavailableHealthPorts?: readonly number[];
  /** What a listener answers at /api/capabilities, or nothing when unset. */
  capabilities?: string;
  /** What the server answers at /api/copilotkit/info; the Intelligence licence JSON by default. */
  infoPayload?: string;
  /** Ports the fake `lsof` reports as free, so the script launches a service instead of keeping one. */
  freePorts?: readonly number[];
  /**
   * The fake listener answers only after the script has launched the server, which is what a real
   * port does: nothing answers `/info` or `/api/capabilities` before the process exists, so the
   * script must actually start one for the run to get past its own probes.
   */
  serverAnswersOnlyOnceLaunched?: boolean;
};

async function runStartWithStaleServerProbe(
  status: 401 | 404,
  {
    shell = "bash",
    omitFromEnv = [],
    settings = {},
    processEnvironment = {},
    unavailableHealthPorts = [],
    capabilities = "",
    infoPayload = '{"licenseStatus":"valid","mode":"test","agents":{"analyst":{}}}',
    freePorts = [],
    serverAnswersOnlyOnceLaunched = false,
  }: Run = {},
) {
  const root =
    await Bun.$`mktemp -d ${tmpdir()}/openbot-start-guard-XXXXXX`.text();
  const directory = root.trim();
  const fakeBin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logPath = join(directory, "pkill.log");
  const dockerLogPath = join(directory, "docker.log");
  const curlLogPath = join(directory, "curl.log");
  const modeLogPath = join(directory, "mode.log");
  const serverUpPath = join(directory, "server-up");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  // The server launch is `(cd server && bun ...)`, so the directory has to exist for a run that
  // starts one. Runs that keep an answering server never reach the `cd`.
  await mkdir(join(directory, "server"), { recursive: true });
  const environment = [
    "APP_PORT=3010",
    "SERVER_PORT=3001",
    "COMPUTER_PORT=4100",
    "BOT_PORT=4200",
    "LANGGRAPH_PORT=4201",
    "SUPERVISOR_PORT=4500",
    "SUPERVISOR_TOKEN=supervisor-token",
    "COMPUTER_TOKEN=computer-token",
    "WORKER_SHARED_SECRET=worker-secret",
    "MANAGED_AGENT_TOKEN=managed-token",
    "AGENT_TOOL_TOKEN=agent-tool-token",
    "MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui",
    "OPENBOT_ONE_COMPUTER_EACH=true",
    "DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot",
  ].filter(
    (line) =>
      ![...omitFromEnv, ...Object.keys(settings)].some((key) =>
        line.startsWith(`${key}=`),
      ),
  );
  environment.push(
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
  );
  await writeFile(join(directory, ".env"), `${environment.join("\n")}\n`);
  await writeFile(
    join(scripts, "start.sh"),
    await readFile("scripts/start.sh"),
  );
  await chmod(join(scripts, "start.sh"), 0o755);
  // Copied beside it because `start.sh` sources it by its own directory, so a temp root without it
  // would fail on a missing file rather than on whatever the test is about.
  await writeFile(
    join(scripts, "require-bash.sh"),
    await readFile("scripts/require-bash.sh"),
  );
  await writeFile(
    join(scripts, "processes.sh"),
    await readFile("scripts/processes.sh"),
  );

  await writeExecutable(
    join(fakeBin, "lsof"),
    `#!/usr/bin/env bash
args="$*"
for port in $FREE_PORTS; do
  if [[ "$args" == *"TCP:$port "* ]]; then exit 0; fi
done
echo "p123"
echo "cbun"
echo "n*:3001"
`,
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$CURL_LOG"
for port in ${unavailableHealthPorts.join(" ")}; do
  if [[ "$args" == *"http://localhost:$port/health"* ]]; then exit 7; fi
done
if [[ "$args" == *"/internal/routines/run"* ]]; then
  printf '${status}'
  exit 0
fi
if [[ "$args" == *"/api/copilotkit/info"* || "$args" == *"/api/capabilities"* ]]; then
  if [ -n "$GATE_UNTIL_LAUNCH" ] && [ ! -f "$SERVER_UP" ]; then exit 0; fi
fi
if [[ "$args" == *"/api/capabilities"* ]]; then
  printf '%s' "$CAPABILITIES"
  exit 0
fi
if [[ "$args" == *"/api/copilotkit/info"* ]]; then
  printf '%s' "$INFO_PAYLOAD"
  exit 0
fi
if [[ "$args" == *"http://localhost:3010/"* ]]; then
  printf '<title>OpenBot</title>'
  exit 0
fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$DOCKER_LOG"
if [[ "$args" == *"to_regclass('public.agent_profiles')"* ]]; then echo agent_profiles; fi
if [[ "$args" == *"to_regclass('public.agent_preferences')"* ]]; then echo agent_preferences; fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "pgrep"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(
    join(fakeBin, "pkill"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PKILL_LOG"\nexit 0\n',
  );
  await writeExecutable(
    join(fakeBin, "sleep"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  // The runtime health check is a script piped into `bun run -`, so that one invocation is the real
  // Bun: it is what decides whether the run carries on. Everything else Bun would start is faked.
  // The Learning container check answers with one line, which start.sh relays.
  await writeExecutable(
    join(fakeBin, "bun"),
    '#!/usr/bin/env bash\nif [ "$1" = run ] && [ "$2" = - ]; then exec "$REAL_BUN" "$@"; fi\nif [ "$1" = scripts/setup-learning.ts ]; then echo "noise"; echo "LEARNING-CHECK $*"; fi\nif [ "$1" = "--env-file=../.env" ]; then printf "%s\\n" "$OPENBOT_RUNTIME_MODE" >> "$MODE_LOG"; touch "$SERVER_UP"; fi\nexit 0\n',
  );
  // What `python3` is on a stock Windows machine: the Microsoft Store alias, which runs nothing. A
  // script that still needed it would stop at the health check in every test in this file.
  await writeExecutable(
    join(fakeBin, "python3"),
    '#!/usr/bin/env bash\necho "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2\nexit 49\n',
  );

  try {
    const child = Bun.spawn({
      cmd: [shell, "scripts/start.sh"],
      cwd: directory,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        REAL_BUN: process.execPath,
        PKILL_LOG: logPath,
        DOCKER_LOG: dockerLogPath,
        CURL_LOG: curlLogPath,
        MODE_LOG: modeLogPath,
        CAPABILITIES: capabilities,
        INFO_PAYLOAD: infoPayload,
        FREE_PORTS: freePorts.join(" "),
        GATE_UNTIL_LAUNCH: serverAnswersOnlyOnceLaunched ? "1" : "",
        SERVER_UP: serverUpPath,
        ...processEnvironment,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const pkillLog = await Bun.file(logPath)
      .text()
      .catch(() => "");
    const dockerLog = await Bun.file(dockerLogPath)
      .text()
      .catch(() => "");
    const curlLog = await Bun.file(curlLogPath)
      .text()
      .catch(() => "");
    const modeLog = await Bun.file(modeLogPath)
      .text()
      .catch(() => "");
    return { exitCode, stdout, stderr, pkillLog, dockerLog, curlLog, modeLog };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("start.sh server restart guard", () => {
  test.each([401, 404] as const)(
    "stops both current and legacy server launch patterns after handoff probe %s",
    async (status) => {
      const result = await runStartWithStaleServerProbe(status);

      expect({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        pkillLog: result.pkillLog,
      }).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.pkillLog).toContain(
        "bun --env-file=../.env src/production-entry.ts",
      );
      expect(result.pkillLog).toContain("bun --env-file=../.env src/index.ts");
    },
  );
});

describe("start.sh runtime health", () => {
  /**
   * THE LICENCE IS CHECKED WITHOUT PYTHON.
   *
   * The check used to be a `python3` heredoc. On Windows `python3` is usually the Microsoft Store
   * alias, which exits 49, so `set -e` ended the run at "3/4 Runtime health" with the server and
   * worker already up and the app never started. The fake `python3` beside this file's other fakes
   * is that alias; the line below is only printed if the check ran, in Bun, and passed.
   */
  test("checks the licence and names the Bots without python3", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain(
      "licence valid · mode test · Bots: analyst",
    );
  });
});

describe("start.sh under the wrong shell", () => {
  /**
   * THE WRONG INVOCATION SAYS SO, AND SAYING NOTHING IS THE DEFECT.
   *
   * CRITERION. `sh scripts/start.sh` exits non-zero having named bash and the command to run
   * instead, on stderr.
   *
   * REASON. The shebang says bash and `sh` overrides it. On macOS `sh` IS bash, in POSIX mode,
   * where a failed assignment inside a function is fatal instead of survivable — so the script died
   * at the first setting it read out of `.env` and printed NOTHING: no line number, no failing
   * command, no exit message. The whole of what somebody had to go on was `1`, which reads as "this
   * script is broken" rather than "run it the other way", and it cost an afternoon.
   *
   * THE SENTENCE NAMES THE FIX AND NOT ONLY THE FAULT, because "wrong shell" is not actionable to
   * somebody who typed the only invocation they knew.
   */
  test("sh refuses with a sentence naming bash, rather than exiting in silence", async () => {
    const result = await runStartWithStaleServerProbe(401, { shell: "sh" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/bash/);
    expect(result.stderr).toMatch(/bash scripts\/start\.sh/);
    // On stderr rather than stdout, so it survives a caller that is reading the progress output.
    expect(result.stdout).toBe("");
  });
});

describe("start.sh settings with no line in .env", () => {
  /**
   * A KEY THIS SCRIPT HAS A DEFAULT FOR IS ALLOWED TO BE ABSENT, WHICH IS WHAT THE DEFAULT IS FOR.
   *
   * CRITERION. With no `APP_PORT` line in `.env` at all, the run completes exactly as it does with
   * one — the app is probed on 3010, the port the script falls back to.
   *
   * THIS ONE PASSED BEFORE THE CHANGE IT GUARDS, AND THAT IS SAID PLAINLY RATHER THAN DRESSED UP.
   * `setting` reads the key with a `grep` pipeline, `grep` finding nothing is an exit status of 1,
   * and `pipefail` makes it the pipeline's — but under bash that status does not escape the command
   * substitution, so the fallback won and this run was already green. It was fatal only under `sh`,
   * where the sibling test now keeps anybody from arriving at all. So there is no invocation left
   * that can watch this fail, and what it does instead is pin the CONTRACT: the second argument to
   * `setting` is the value an absent key takes, and nothing about which shell is reading the script
   * may decide otherwise.
   *
   * THE `|| true` IN THE SCRIPT IS WHAT MAKES THAT TRUE BY CONSTRUCTION rather than by a subtlety
   * of where `set -e` applies. Both halves are worth having: the refusal stops the invocation that
   * was silently fatal, and this stops the fallback depending on a detail nobody should have to
   * know to add a setting.
   *
   * `APP_PORT` IS THE ONE OMITTED BECAUSE IT IS THE REAL CASE. `.env.example` lists `PORT` and
   * `SERVER_PORT` and not this one, so every `.env` copied from it is missing exactly this key, and
   * it is the first setting the script reads — which is why the silent exit under `sh` happened
   * before any output at all.
   *
   * THE ASSERTION IS THE WHOLE RUN rather than a printed port: the faked `curl` answers the app
   * probe for `http://localhost:3010/` and nothing else, so a fallback that produced any other port
   * fails the run instead of quietly reporting a different number.
   */
  test("a .env with no APP_PORT still starts, on the default port", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      omitFromEnv: ["APP_PORT"],
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("http://localhost:3010");
  });
});

describe("start.sh one computer each", () => {
  /**
   * `OPENBOT_ONE_COMPUTER_EACH=false` IN `.env` TURNS THE SUPERVISOR OFF, AS THE DOCS SAY.
   *
   * The key was read from the environment alone, so a `.env` line was ignored: the supervisor was
   * still started and the server still told to use it. docs/configuration.md says to set it "in
   * `.env` or in the environment", and every other setting in this script is read that way.
   *
   * THE SUPERVISOR IS WHAT GIVES EACH BOT ITS OWN COMPUTER, so its absence from the services handed
   * to `docker compose up` is the observable half; the shared computer stays.
   */
  test("false in .env starts no supervisor", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres agent-computer agent-bot agent-langgraph",
    );
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("false in the process environment starts no supervisor either", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "true" },
      processEnvironment: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("true, or absent, still starts it", async () => {
    for (const omitFromEnv of [[], ["OPENBOT_ONE_COMPUTER_EACH"]] as const) {
      const result = await runStartWithStaleServerProbe(401, { omitFromEnv });

      expect(result.exitCode).toBe(0);
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
      );
    }
  });
});

describe("start.sh Learning container check", () => {
  /**
   * The server assigns `openbot` once it exists, but its runtime key cannot create it. start.sh asks
   * the setup helper, without a browser or a prompt, to make sure it exists, and relays its last line.
   */
  test("runs the non-interactive check when a key is set and nothing is assigned", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { INTELLIGENCE_API_KEY: "cpk-synthetic" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "LEARNING-CHECK scripts/setup-learning.ts --non-interactive",
    );
    expect(result.stdout).not.toContain("noise");
  });

  test.each([
    [
      "a container is named",
      { CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "mine" },
    ],
    ["it is switched off", { OPENBOT_LEARNING_AUTO_ASSIGN: "false" }],
    ["it is switched off with 0", { OPENBOT_LEARNING_AUTO_ASSIGN: "0" }],
  ])("is skipped when %s", async (_, settings) => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { INTELLIGENCE_API_KEY: "cpk-synthetic", ...settings },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });

  test("is skipped without a runtime key", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });
});

describe("start.sh selected provider services", () => {
  test.each([".env", "process environment"])(
    "an Anthropic-only %s selection starts the managed Bot without the OpenAI-only sample",
    async (source) => {
      const selected = {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      };
      const result = await runStartWithStaleServerProbe(401, {
        settings: source === ".env" ? selected : { BOT_PROVIDER: "openai" },
        processEnvironment: source === "process environment" ? selected : {},
        unavailableHealthPorts: [4200],
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-langgraph",
      );
      expect(result.dockerLog).not.toContain("agent-bot");
      expect(result.dockerLog).toContain("compose run --rm --build migrate");
      expect(result.curlLog).toContain("http://localhost:4100/health");
      expect(result.curlLog).toContain("http://localhost:4201/health");
      expect(result.curlLog).not.toContain("http://localhost:4200/health");
      expect(result.stdout).toContain("agent-bot: skipped for Anthropic");
      expect(result.stdout).not.toContain("agent-bot ready");
      expect(result.stdout).toContain("agent-langgraph ready");
      expect(result.stdout).toContain(
        "managed coworker endpoint: http://localhost:4201/ag-ui",
      );
      expect(result.stdout).toContain("Ready. http://localhost:3010");
    },
  );

  test("the default OpenAI startup still starts and checks the legacy sample", async () => {
    const result = await runStartWithStaleServerProbe(401);
    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
    );
    expect(result.curlLog).toContain("http://localhost:4200/health");
    expect(result.stdout).toContain("agent-bot ready");
    expect(result.stdout).not.toContain("agent-bot: skipped");
  });

  test("Anthropic startup still fails if its managed LangGraph Bot is unavailable", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      },
      unavailableHealthPorts: [4200, 4201],
    });
    expect(result.exitCode).toBe(1);
    expect(result.curlLog).not.toContain("http://localhost:4200/health");
    expect(result.curlLog).toContain("http://localhost:4201/health");
    expect(result.stdout).toContain("agent-langgraph never became ready");
    expect(result.stdout).not.toContain("Ready. http://localhost:3010");
  });
});

/**
 * LOCAL RUNTIME MODE.
 *
 * The mode arrives the way every other setting does — the environment, then `.env`, then
 * `intelligence` — and the run branches on it in three places: the identity probe, the
 * port-holder refusal, and stage 3. The fake listener answers `/api/capabilities` with
 * `capabilities` and `/api/copilotkit/info` with `infoPayload`, so each test names exactly what
 * the port is holding.
 */
describe("start.sh local runtime mode", () => {
  const LOCAL_CAPABILITIES =
    '{"mode":"local","durableHistory":true,"product":"openbot"}';

  /**
   * THE MODE IS EXPORTED, NOT JUST READ.
   *
   * `RUNTIME_MODE` decides the probe and stage 3 inside this script, but the server child decides
   * its own runtime from `OPENBOT_RUNTIME_MODE` in its environment. The export is what makes the
   * two agree when the value came from `.env`: the fake `bun` records what the launch passed, so
   * the assertion is on what the server would have started as, not on what the script printed.
   */
  test.each([".env", "process environment"])(
    "OPENBOT_RUNTIME_MODE=local from %s reaches the server the script launches",
    async (source) => {
      const result = await runStartWithStaleServerProbe(401, {
        ...(source === ".env"
          ? { settings: { OPENBOT_RUNTIME_MODE: "local" } }
          : { processEnvironment: { OPENBOT_RUNTIME_MODE: "local" } }),
        capabilities: LOCAL_CAPABILITIES,
        freePorts: [3001],
        serverAnswersOnlyOnceLaunched: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.modeLog).toContain("local");
    },
  );

  test("without the setting, the launched server still defaults to intelligence", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      capabilities: LOCAL_CAPABILITIES,
      freePorts: [3001],
      serverAnswersOnlyOnceLaunched: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.modeLog).toContain("intelligence");
  });

  /**
   * A MATCHING LISTENER IS KEPT, AND STAGE 3 REPORTS THE LOCAL RUN.
   *
   * The port is held and answers the local capabilities, so the probe accepts it and the run
   * finishes. The local mode line replaces the licence line, and the Intelligence login hint is
   * absent — that hint names a product this mode is not running.
   */
  test("keeps a local-mode listener and prints the local mode line, never the login hint", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_RUNTIME_MODE: "local" },
      capabilities: LOCAL_CAPABILITIES,
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("server: already up on 3001");
    expect(result.stdout).toContain("local mode · Bots: analyst");
    expect(result.stdout).not.toContain("licence valid");
    expect(result.stdout).not.toContain("Check INTELLIGENCE_API_KEY");
  });

  /**
   * THE WRONG-MODE PRODUCT LISTENER IS NAMED AND REFUSED, NOT KILLED.
   *
   * An OpenBot in Intelligence mode on the port is this product answering the wrong runtime, which
   * the old probe could only call "something that is not OpenBot". The refusal names the mode the
   * listener is in, and `pkill` is never invoked: killing is for processes this checkout started.
   */
  test("refuses an Intelligence-mode listener when the run is local, naming its mode", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_RUNTIME_MODE: "local" },
      capabilities:
        '{"mode":"intelligence","durableHistory":true,"product":"openbot"}',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "port 3001 is held by OpenBot in 'intelligence' mode, and this run is 'local'",
    );
    expect(result.stdout).toContain(
      "start this script with OPENBOT_RUNTIME_MODE=intelligence",
    );
    expect(result.pkillLog).toBe("");
  });

  test("refuses a local-mode listener when the run is intelligence, naming its mode", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      // What a local server actually answers: /info carries no licenseStatus, because local mode
      // has no licence to report, and /api/capabilities carries the local runtime.
      capabilities: LOCAL_CAPABILITIES,
      infoPayload: '{"mode":"local","agents":{"analyst":{}}}',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "port 3001 is held by OpenBot in 'local' mode, and this run is 'intelligence'",
    );
    expect(result.pkillLog).toBe("");
  });

  /**
   * A LISTENER WITHOUT THE PRODUCT MARKER IS NOT THIS PRODUCT, HOWEVER IT ANSWERS.
   *
   * The marker is the whole difference between "an OpenBot in the wrong mode" and "an unrelated
   * dashboard that happens to say mode local". Without it the refusal stays the generic one, and
   * still nothing is killed.
   */
  test("refuses a listener with no product marker, without killing it", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_RUNTIME_MODE: "local" },
      capabilities: '{"mode":"local","durableHistory":true}',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("held by something that is not OpenBot");
    expect(result.pkillLog).toBe("");
  });

  /**
   * STAGE 3 KEEPS THE TWO CHECKS THE LICENCE GATE USED TO CARRY.
   *
   * The probe accepts marker plus mode; durable history is first verified here, and the Bots
   * roster still comes from `/info`, so a local run with no Bots stops exactly where the
   * Intelligence one does.
   */
  test("refuses a local listener without durable history", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_RUNTIME_MODE: "local" },
      capabilities:
        '{"mode":"local","durableHistory":false,"product":"openbot"}',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "the server answered mode 'local' with durableHistory false",
    );
  });

  test("refuses a local run with no Bots registered", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_RUNTIME_MODE: "local" },
      capabilities: LOCAL_CAPABILITIES,
      infoPayload: '{"mode":"local","agents":{}}',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No Bots registered.");
    expect(result.stdout).not.toContain("Check INTELLIGENCE_API_KEY");
  });
});

describe("start.sh intelligence branches unchanged", () => {
  /**
   * THE INTELLIGENCE PROBE READS `/info`, NOT `/api/capabilities`.
   *
   * A listener answering the local capabilities alongside the Intelligence `/info` is kept on the
   * licence answer alone, and no intelligence run ever consults `/api/capabilities`. That is the
   * "byte for byte" contract: the new branch is additive, and the old path cannot have picked up
   * a new input.
   */
  test("identifies a listener by /info alone and never consults /api/capabilities", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.curlLog).toContain("/api/copilotkit/info");
    expect(result.curlLog).not.toContain("/api/capabilities");
    expect(result.stdout).toContain(
      "licence valid · mode test · Bots: analyst",
    );
  });
});
