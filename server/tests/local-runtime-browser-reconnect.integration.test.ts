import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { makeSignature } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

/*
 * Low on purpose: the crash phase waits one lease window past a SIGKILL, and the production default
 * of half a minute would spend the harness's whole drive budget on that single wait. The runner
 * renews at a third of the window, so live runs never come near lapsing.
 */
const LEASE_MS = 3_000;

const ARTIFACT_LINK = "the fixture artifact page";
const ARTIFACT_URL = "https://example.test/unit6-artifact";
const FINAL_REPLY = `unit6 deterministic reply with [${ARTIFACT_LINK}](${ARTIFACT_URL})`;

const channelSchema = z.object({
  channel: z.object({ id: z.string(), threadId: z.string() }),
});

const historySchema = z.object({
  events: z
    .array(z.object({ sequence: z.number(), type: z.string() }).passthrough())
    .min(1),
  attempts: z.array(
    z.object({ id: z.string(), status: z.string() }).passthrough(),
  ),
  runs: z.array(
    z
      .object({
        id: z.string(),
        status: z.string(),
        error: z.string().nullable(),
      })
      .passthrough(),
  ),
  messages: z.array(
    z
      .object({
        messageId: z.string(),
        role: z.string(),
        toolCalls: z
          .array(z.object({ id: z.string(), name: z.string() }).passthrough())
          .optional(),
      })
      .passthrough(),
  ),
});

type LocalHistory = z.infer<typeof historySchema>;

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  deadlineMs = 30_000,
): Promise<T> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= until)
      throw new Error("Timed out waiting for fixture state.");
    await Bun.sleep(30);
  }
}

async function unusedPort() {
  await using socket = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  if (!socket.port) throw new Error("No fixture port allocated.");
  return socket.port;
}

async function reached(gate: Promise<void>, what: string) {
  await Promise.race([
    gate,
    Bun.sleep(45_000).then(() => {
      throw new Error(`The run never reached ${what}.`);
    }),
  ]);
}

test("a browser reconnects to the original local run across close, refresh, restart, and a crash", async () => {
  const url = testDatabaseUrl();
  const db = createDatabase(url);
  const suffix = randomUUID().slice(0, 8);
  const owner = `unit6-owner-${suffix}`;
  const bot = `unit6-private-${suffix}`;
  const toolServer = `unit6_${suffix}`;
  const tool = "read_fixture";
  const ref = `${toolServer}/${tool}`;
  const toolName = `mcp__${toolServer}__${tool}`;
  const secret = randomBytes(32).toString("hex");
  const keyEncryptionKey = randomBytes(32).toString("base64");
  const evidence = process.env.AOOO_EVIDENCE_DIR;
  const llm = new LLMock();
  const mcp = new MCPMock();
  let requests = 0;
  let closeToolTurns = 0;
  let refreshToolTurns = 0;
  let crashToolTurns = 0;
  const sawCloseTool = Promise.withResolvers<void>();
  const releaseCloseTool = Promise.withResolvers<void>();
  const sawRefreshTool = Promise.withResolvers<void>();
  const releaseRefreshTool = Promise.withResolvers<void>();
  const sawCrashTool = Promise.withResolvers<void>();
  const releaseCrashTool = Promise.withResolvers<void>();
  const stops: (() => Promise<unknown>)[] = [];
  const facts: Record<string, unknown> = { leaseMs: LEASE_MS };

  async function session(userId: string) {
    const token = randomUUID();
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      token,
      // Long enough for a journey that spans restarts, not just one request.
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return encodeURIComponent(`${token}.${await makeSignature(token, secret)}`);
  }

  try {
    await db.insert(users).values({
      id: owner,
      email: `${owner}@example.test`,
      emailVerified: true,
      // The channel conversation is the destination, so the fixture owner arrives past onboarding.
      onboardingStep: 1,
      onboardingCompletedAt: new Date(),
    });
    await db.insert(userRoles).values({ userId: owner, role: "user" });
    await db.insert(agents).values({
      id: bot,
      name: bot,
      type: "built_in",
      configuration: { systemPrompt: "Handle the synthetic fixture." },
    });
    await db.insert(agentProfiles).values({
      agentId: bot,
      title: bot,
      roleDescription: "Reconnect journey Bot",
      ownerUserId: owner,
      avatarSeed: bot,
      visibility: "private",
    });
    mcp.addTool({
      name: tool,
      description: "Read a fixture.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
    mcp.onToolCall(tool, async (args) => {
      const query =
        typeof args === "object" &&
        args !== null &&
        "query" in args &&
        typeof args.query === "string"
          ? args.query
          : "";
      if (query === "pause-close") {
        sawCloseTool.resolve();
        await releaseCloseTool.promise;
      } else if (query === "pause-refresh") {
        sawRefreshTool.resolve();
        await releaseRefreshTool.promise;
      } else if (query === "pause-crash") {
        sawCrashTool.resolve();
        // Released only in teardown: the executor is killed while this call is in flight.
        await releaseCrashTool.promise;
      }
      return "fixture receipt";
    });
    await db.insert(mcpServers).values({
      id: toolServer,
      title: "Unit 6 reconnect fixture",
      vendor: "fixture",
      provenance: "custom",
      url: await mcp.start(),
    });
    await db.insert(mcpTools).values({
      serverId: toolServer,
      name: tool,
      vendorName: tool,
      description: "Read a fixture.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
    await db.insert(pluginGrants).values({ kind: "mcp", ref, agentId: bot });
    llm.onMessage(/unit6-/, async (req) => {
      requests++;
      const body = JSON.stringify(req);
      if (body.includes("unit6-fail")) {
        return {
          status: 500,
          error: { message: "fixture model unavailable", code: "fixture" },
        };
      }
      if (body.includes("unit6-close") && closeToolTurns++ === 0) {
        return {
          toolCalls: [{ name: toolName, arguments: '{"query":"pause-close"}' }],
        };
      }
      if (body.includes("unit6-refresh") && refreshToolTurns++ === 0) {
        return {
          toolCalls: [
            { name: toolName, arguments: '{"query":"pause-refresh"}' },
          ],
        };
      }
      if (body.includes("unit6-crash") && crashToolTurns++ === 0) {
        return {
          toolCalls: [{ name: toolName, arguments: '{"query":"pause-crash"}' }],
        };
      }
      return { content: FINAL_REPLY };
    });
    const llmBase = await llm.start();
    const sessionValue = await session(owner);
    const ownerCookie = `better-auth.session_token=${sessionValue}`;

    const serverPort = await unusedPort();
    const appPort = await unusedPort();
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const appUrl = `http://127.0.0.1:${appPort}`;

    function startServer(name: string) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "src/index.ts"],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH,
            PORT: String(serverPort),
            DATABASE_URL: url,
            KEY_ENCRYPTION_KEY: keyEncryptionKey,
            OPENBOT_RUNTIME_MODE: "local",
            OPENBOT_LOCAL_LEASE_MS: String(LEASE_MS),
            COPILOTKIT_TELEMETRY_DISABLED: "1",
            BETTER_AUTH_SECRET: secret,
            BETTER_AUTH_URL: serverUrl,
            GOOGLE_OAUTH_CLIENT_ID: "fixture-client",
            GOOGLE_OAUTH_CLIENT_SECRET: "fixture-secret",
            INITIAL_ADMIN_EMAILS: "unit6-admin@example.test",
            OPENAI_API_KEY: "fixture-key",
            OPENAI_BASE_URL: llmBase,
            BOT_MODEL: "gpt-5.6-terra",
          },
          stdout: evidence ? Bun.file(join(evidence, `${name}.log`)) : "ignore",
          stderr: evidence
            ? Bun.file(join(evidence, `${name}.stderr.log`))
            : "ignore",
        },
      );
      stops.push(() => {
        child.kill();
        return child.exited;
      });
      return child;
    }

    async function waitHealthy() {
      await eventually(
        () => fetch(`${serverUrl}/health`).catch(() => undefined),
        (response) => response?.ok ?? false,
      );
    }

    async function historyOf(threadId: string): Promise<LocalHistory> {
      const response = await fetch(
        `${serverUrl}/api/local-runtime/threads/${threadId}/history`,
        {
          headers: { cookie: ownerCookie },
          signal: AbortSignal.timeout(12_000),
        },
      );
      expect(response.status).toBe(200);
      return historySchema.parse(await response.json());
    }

    // A run submitted from the browser takes a moment to create the thread binding, so a 404 is
    // "not yet", not a failure, while this poll waits for the run to reach its terminal status.
    async function awaitRunStatus(
      threadId: string,
      status: string,
    ): Promise<LocalHistory> {
      const until = Date.now() + 30_000;
      for (;;) {
        const response = await fetch(
          `${serverUrl}/api/local-runtime/threads/${threadId}/history`,
          {
            headers: { cookie: ownerCookie },
            signal: AbortSignal.timeout(12_000),
          },
        );
        if (response.ok) {
          const history = historySchema.parse(await response.json());
          if (history.runs.at(-1)?.status === status) return history;
        }
        if (Date.now() >= until)
          throw new Error(`Timed out waiting for the run to reach ${status}.`);
        await Bun.sleep(30);
      }
    }

    async function makeChannel() {
      const response = await fetch(`${serverUrl}/api/channels`, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentIds: [bot] }),
        signal: AbortSignal.timeout(12_000),
      });
      expect(response.status).toBe(201);
      return channelSchema.parse(await response.json()).channel;
    }

    let currentServer = startServer("local-server-1");
    await waitHealthy();
    const capabilities = await fetch(`${serverUrl}/api/capabilities`);
    expect(await capabilities.json()).toMatchObject({
      mode: "local",
      durableHistory: true,
    });

    const app = Bun.spawn(
      [process.execPath, "--bun", "node_modules/vite/bin/vite.js"],
      {
        cwd: join(import.meta.dir, "../../app"),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          APP_PORT: String(appPort),
          SERVER_PORT: String(serverPort),
        },
        stdout: evidence ? Bun.file(join(evidence, "app-dev.log")) : "ignore",
        stderr: evidence
          ? Bun.file(join(evidence, "app-dev.stderr.log"))
          : "ignore",
      },
    );
    stops.push(() => {
      app.kill();
      return app.exited;
    });
    await eventually(
      () => fetch(appUrl).catch(() => undefined),
      (response) => response?.ok ?? false,
      60_000,
    );

    // The upstream Playwright convention: drive an installed system browser, never a download.
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    for (const channel of ["chrome", "msedge"] as const) {
      browser = await chromium
        .launch({ channel, headless: true, timeout: 20_000 })
        .catch(() => undefined);
      if (browser) break;
    }
    if (!browser) {
      throw new Error(
        "Neither Chrome nor Edge is installed; this journey drives a real system browser.",
      );
    }
    stops.push(() => browser!.close());
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: sessionValue,
        url: appUrl,
      },
    ]);

    async function openThread(channelId: string) {
      const page = await context.newPage();
      await page.goto(`${appUrl}/channel/${channelId}`);
      try {
        await page
          .getByRole("textbox", { name: "Message" })
          .first()
          .waitFor({ state: "visible", timeout: 45_000 });
      } catch (error) {
        await shoot(page, "boot-failure.png");
        const body = await page.textContent("body");
        const me = await page
          .evaluate(() =>
            fetch("/api/me")
              .then(
                async (response) =>
                  `${response.status} ${await response.text()}`,
              )
              .catch((failure: unknown) => String(failure)),
          )
          .catch(() => "the page could not be evaluated");
        // Names and a wiring verdict only: a session fragment has no business in a log file.
        const jar = await context
          .cookies()
          .then((rows) =>
            rows.map(
              (row) =>
                `${row.name} (${row.value.startsWith(`${row.name}=`) ? "miswired: the value holds the whole header line" : "wired"})`,
            ),
          )
          .catch(() => "the cookie jar could not be read");
        throw new Error(
          `The channel conversation never opened at ${page.url()}; jar: ${JSON.stringify(jar)}; /api/me says: ${me}; the page says: ${body?.slice(0, 300)}`,
          { cause: error },
        );
      }
      return page;
    }

    async function say(page: Page, text: string) {
      await page.getByRole("textbox", { name: "Message" }).first().click();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    }

    async function awaitStrip(page: Page, text: string) {
      const strip = page.getByText(text, { exact: true }).first();
      await strip.waitFor({ state: "visible", timeout: 45_000 });
      return (await strip.textContent()) ?? "";
    }

    async function shoot(page: Page, name: string) {
      if (!evidence) return;
      await page.screenshot({
        path: join(evidence, name),
        fullPage: true,
      });
    }

    const queued = (history: LocalHistory) =>
      history.events.filter((event) => event.type === "run.queued");

    // Close-reopen: the tab dies mid-run, the run finishes alone, and the reopened thread is the
    // same work rather than a second dispatch.
    const closeChannel = await makeChannel();
    const closePage = await openThread(closeChannel.id);
    await say(closePage, "unit6-close");
    await reached(sawCloseTool.promise, "the close-phase tool call");
    await closePage.close();
    releaseCloseTool.resolve();
    const closeHistory = await awaitRunStatus(
      closeChannel.threadId,
      "succeeded",
    );
    expect(closeHistory.runs).toHaveLength(1);
    expect(queued(closeHistory)).toHaveLength(1);
    expect(
      closeHistory.messages.some((message) =>
        message.toolCalls?.some((call) => call.name === toolName),
      ),
    ).toBe(true);
    const requestsAfterClose = requests;
    const closeReopened = await openThread(closeChannel.id);
    expect(await awaitStrip(closeReopened, "Run succeeded")).toBe(
      "Run succeeded",
    );
    await closeReopened
      .getByText("unit6-close")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await closeReopened
      .getByText("Read fixture")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await closeReopened
      .getByRole("link", { name: ARTIFACT_LINK })
      .waitFor({ state: "visible", timeout: 30_000 });
    expect(requests).toBe(requestsAfterClose);
    await shoot(closeReopened, "close-reopen.png");
    await closeReopened.close();
    facts.closeReopen = {
      channelId: closeChannel.id,
      runs: closeHistory.runs.length,
      queuedEvents: queued(closeHistory).length,
      strip: "Run succeeded",
      modelRequestsAfterReopen: requests - requestsAfterClose,
      toolTurnRestored: true,
    };

    // Refresh: the same mid-run hold, recovered by reloading the page instead of leaving it.
    const refreshChannel = await makeChannel();
    const refreshPage = await openThread(refreshChannel.id);
    await say(refreshPage, "unit6-refresh");
    await reached(sawRefreshTool.promise, "the refresh-phase tool call");
    await refreshPage.reload();
    expect(await awaitStrip(refreshPage, "Run is active")).toBe(
      "Run is active",
    );
    // Mid-run the primary composer action is Stop; unlocked means Send takes the place back.
    await refreshPage
      .getByTestId("composer-stop")
      .waitFor({ state: "visible", timeout: 30_000 });
    releaseRefreshTool.resolve();
    await awaitStrip(refreshPage, "Run succeeded");
    expect(await refreshPage.getByTestId("composer-stop").count()).toBe(0);
    await refreshPage.getByRole("textbox", { name: "Message" }).first().click();
    await refreshPage.keyboard.type("typed after terminal, never sent");
    const send = refreshPage.getByRole("button", { name: "Send message" });
    await send.waitFor({ state: "visible", timeout: 30_000 });
    expect(await send.isEnabled()).toBe(true);
    const refreshHistory = await awaitRunStatus(
      refreshChannel.threadId,
      "succeeded",
    );
    expect(refreshHistory.runs).toHaveLength(1);
    expect(queued(refreshHistory)).toHaveLength(1);
    await shoot(refreshPage, "refresh.png");
    await refreshPage.close();
    facts.refresh = {
      channelId: refreshChannel.id,
      runs: refreshHistory.runs.length,
      queuedEvents: queued(refreshHistory).length,
      strip: "Run succeeded",
      stopVisibleMidRun: true,
      composerAcceptsInputAfterTerminal: true,
    };

    // Service restart: a completed run is still readable from a fresh server process on the same
    // port and database.
    const restartChannel = await makeChannel();
    const restartPage = await openThread(restartChannel.id);
    await say(restartPage, "unit6-restart");
    await awaitRunStatus(restartChannel.threadId, "succeeded");
    await restartPage.close();
    currentServer.kill();
    await currentServer.exited;
    currentServer = startServer("local-server-2");
    await waitHealthy();
    const restartReopened = await openThread(restartChannel.id);
    expect(await awaitStrip(restartReopened, "Run succeeded")).toBe(
      "Run succeeded",
    );
    await restartReopened
      .getByText("unit6-restart")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await restartReopened
      .getByRole("link", { name: ARTIFACT_LINK })
      .waitFor({ state: "visible", timeout: 30_000 });
    const restartHistory = await historyOf(restartChannel.threadId);
    expect(restartHistory.runs.map((run) => run.status)).toEqual(["succeeded"]);
    await shoot(restartReopened, "service-restart.png");
    await restartReopened.close();
    facts.serviceRestart = {
      channelId: restartChannel.id,
      serverRestarted: true,
      runs: restartHistory.runs.length,
      strip: "Run succeeded",
    };

    // Crash-interrupt: SIGKILL mid-run, wait one lease window, and the reopened thread settles to
    // an interrupt at read time without starting anything new.
    const crashChannel = await makeChannel();
    const crashPage = await openThread(crashChannel.id);
    await say(crashPage, "unit6-crash");
    await reached(sawCrashTool.promise, "the crash-phase tool call");
    // SIGKILL, so no finishAttempt runs: the store is left holding a live-looking run.
    currentServer.kill(9);
    await currentServer.exited;
    await crashPage.close();
    await Bun.sleep(LEASE_MS + 1_500);
    currentServer = startServer("local-server-3");
    await waitHealthy();
    const crashReopened = await openThread(crashChannel.id);
    expect(
      await awaitStrip(
        crashReopened,
        "Run was interrupted: execution lease expired",
      ),
    ).toBe("Run was interrupted: execution lease expired");
    await shoot(crashReopened, "crash-interrupt.png");
    const crashHistory = await historyOf(crashChannel.threadId);
    expect(crashHistory.runs.map((run) => run.status)).toEqual(["cancelled"]);
    expect(crashHistory.attempts).toHaveLength(1);
    expect(crashHistory.attempts[0]?.status).toBe("interrupted");
    expect(
      crashHistory.events.filter(
        (event) => event.type === "attempt.interrupted",
      ),
    ).toHaveLength(1);
    expect(queued(crashHistory)).toHaveLength(1);
    expect(JSON.stringify(crashHistory.messages)).toContain("unit6-crash");
    // No auto-recovery: nothing new starts once the thread has been read.
    await Bun.sleep(1_500);
    const settledAgain = await historyOf(crashChannel.threadId);
    expect(settledAgain.runs).toHaveLength(1);
    expect(settledAgain.attempts).toHaveLength(1);
    await crashReopened.close();
    facts.crashInterrupt = {
      channelId: crashChannel.id,
      runStatus: "cancelled",
      attemptStatus: "interrupted",
      reason: "execution lease expired",
      attempts: crashHistory.attempts.length,
      preCrashTranscriptMessages: crashHistory.messages.length,
      newAttemptsAfterSettle:
        settledAgain.attempts.length - crashHistory.attempts.length,
    };

    // Visible state: a fixture-model failure carries its stored reason onto the strip.
    const failChannel = await makeChannel();
    const failPage = await openThread(failChannel.id);
    await say(failPage, "unit6-fail");
    const failHistory = await awaitRunStatus(failChannel.threadId, "failed");
    const storedReason = failHistory.runs.at(-1)?.error ?? "";
    expect(storedReason).not.toBe("");
    // The status read happens on mount and polls only while a run is live, so the failed strip is
    // surfaced the way a person returns to it: read the thread again after the turn ended.
    await failPage.reload();
    expect(await awaitStrip(failPage, `Run failed: ${storedReason}`)).toBe(
      `Run failed: ${storedReason}`,
    );
    await shoot(failPage, "visible-failed.png");
    await failPage.close();
    facts.visibleFailure = {
      channelId: failChannel.id,
      runStatus: "failed",
      storedReason,
      strip: `Run failed: ${storedReason}`,
    };

    if (evidence) {
      await Bun.write(
        join(evidence, "browser-reconnect.json"),
        JSON.stringify(facts, null, 2),
      );
    }
  } finally {
    releaseCloseTool.resolve();
    releaseRefreshTool.resolve();
    releaseCrashTool.resolve();
    await Promise.allSettled(stops.map((stop) => stop()));
    await Promise.allSettled([llm.stop(), mcp.stop()]);
    await db.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
    await db.delete(mcpServers).where(inArray(mcpServers.id, [toolServer]));
    await db.delete(agents).where(inArray(agents.id, [bot]));
    await db.delete(users).where(inArray(users.id, [owner]));
    await db.$client.close();
  }
}, 150_000);
