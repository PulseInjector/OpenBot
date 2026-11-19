import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventType, type RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { makeSignature } from "better-auth/crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  approvalRules,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

const event = z.object({ type: z.string() }).passthrough();
const row = z.object({ sequence: z.number(), type: z.string() }).passthrough();
const historySchema = z.object({
  events: z.array(row),
  attempts: z.array(z.object({ id: z.string(), status: z.string() })),
  runs: z.array(
    z.object({ id: z.string(), requestKey: z.string(), status: z.string() }),
  ),
  operations: z.array(
    z
      .object({ attemptId: z.string(), runId: z.string(), status: z.string() })
      .passthrough(),
  ),
});

async function sse(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => event.parse(JSON.parse(line.slice(6))));
}

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 10_000;
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

test("two real local servers share authenticated run, Stop, history, replay and tool records", async () => {
  const url = testDatabaseUrl();
  const db = createDatabase(url);
  const suffix = randomUUID().slice(0, 8);
  const owner = `unit5-owner-${suffix}`;
  const peer = `unit5-peer-${suffix}`;
  const bot = `unit5-private-${suffix}`;
  const publicBot = `unit5-public-${suffix}`;
  const toolServer = `unit5_${suffix}`;
  const tool = "read_fixture";
  const ref = `${toolServer}/${tool}`;
  const toolName = `mcp__${toolServer}__${tool}`;
  const secret = randomBytes(32).toString("hex");
  const llm = new LLMock();
  const mcp = new MCPMock();
  const calls: unknown[] = [];
  const pending = Promise.withResolvers<void>();
  const allowResult = Promise.withResolvers<void>();
  const revokeAtModel = Promise.withResolvers<void>();
  const allowRevokedCall = Promise.withResolvers<void>();
  const processes: (() => Promise<unknown>)[] = [];
  const logDir = process.env.UNIT5_LOG_DIR;
  let requests = 0;

  async function session(userId: string) {
    const token = randomUUID();
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      token,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, secret)}`)}`;
  }

  try {
    for (const id of [owner, peer]) {
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, emailVerified: true });
      await db.insert(userRoles).values({ userId: id, role: "user" });
    }
    for (const id of [bot, publicBot]) {
      await db.insert(agents).values({
        id,
        name: id,
        type: "built_in",
        configuration: { systemPrompt: "Handle the synthetic fixture." },
      });
      await db.insert(agentProfiles).values({
        agentId: id,
        title: id,
        roleDescription: "Fixture Bot",
        ownerUserId: owner,
        avatarSeed: id,
        visibility: id === bot ? "private" : "public",
      });
    }
    const ownerCookie = await session(owner);
    const peerCookie = await session(peer);
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
      calls.push(args);
      if (JSON.stringify(args).includes("pause-tool")) {
        pending.resolve();
        await allowResult.promise;
      }
      return "fixture receipt";
    });
    await db.insert(mcpServers).values({
      id: toolServer,
      title: "Unit 5 fixture",
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
    let toolTurns = 0;
    let pausedTurns = 0;
    let revokedTurns = 0;
    let approvalTurns = 0;
    llm.onMessage(/unit5-/, async (req) => {
      requests++;
      const body = JSON.stringify(req);
      if (body.includes("unit5-revoke")) {
        if (revokedTurns++ === 0) {
          revokeAtModel.resolve();
          await allowRevokedCall.promise;
          return {
            toolCalls: [{ name: toolName, arguments: '{"query":"revoked"}' }],
          };
        }
      } else if (body.includes("unit5-approval") && approvalTurns++ === 0) {
        return {
          toolCalls: [
            { name: toolName, arguments: '{"query":"needs-approval"}' },
          ],
        };
      } else if (body.includes("unit5-pause") && pausedTurns++ === 0) {
        return {
          toolCalls: [{ name: toolName, arguments: '{"query":"pause-tool"}' }],
        };
      } else if (
        body.includes("unit5-tool") &&
        !body.includes("unit5-pause") &&
        toolTurns++ === 0
      ) {
        return {
          toolCalls: [{ name: toolName, arguments: '{"query":"granted"}' }],
        };
      }
      return { content: "unit5 deterministic reply" };
    });
    const base = await llm.start();
    const firstPort = await unusedPort();
    const secondPort = await unusedPort();
    const urls = [firstPort, secondPort].map(
      (port) => `http://127.0.0.1:${port}`,
    );
    for (const [i, port] of [firstPort, secondPort].entries()) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "src/index.ts"],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH,
            PORT: String(port),
            DATABASE_URL: url,
            KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
            OPENBOT_RUNTIME_MODE: "local",
            COPILOTKIT_TELEMETRY_DISABLED: "1",
            BETTER_AUTH_SECRET: secret,
            BETTER_AUTH_URL: urls[i],
            GOOGLE_OAUTH_CLIENT_ID: "fixture-client",
            GOOGLE_OAUTH_CLIENT_SECRET: "fixture-secret",
            INITIAL_ADMIN_EMAILS: "unit5-admin@example.test",
            OPENAI_API_KEY: "fixture-key",
            OPENAI_BASE_URL: base,
            BOT_MODEL: "gpt-5.6-terra",
          },
          stdout: logDir
            ? Bun.file(join(logDir, `service-${i + 1}.log`))
            : "ignore",
          stderr: logDir
            ? Bun.file(join(logDir, `service-${i + 1}.stderr.log`))
            : "ignore",
        },
      );
      processes.push(() => {
        child.kill();
        return child.exited;
      });
    }

    function request(
      replica: number,
      path: string,
      options: {
        data?: unknown;
        cookie?: string;
        headers?: Record<string, string>;
      } = {},
    ) {
      return fetch(`${urls[replica]}${path}`, {
        method: options.data === undefined ? "GET" : "POST",
        headers: {
          ...options.headers,
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.data === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body:
          options.data === undefined ? undefined : JSON.stringify(options.data),
        signal: AbortSignal.timeout(12_000),
      });
    }
    for (const [i] of urls.entries()) {
      const ready = await eventually(
        () => request(i, "/health").catch(() => undefined),
        (response) => response?.ok ?? false,
      );
      await ready?.body?.cancel();
    }
    const threadId = randomUUID();
    const agentRoute = (id: string, action: string) =>
      `/api/copilotkit/agent/${id}/${action}`;
    const threadRoute = `/api/local-runtime/threads/${threadId}`;
    const makeInput = (id: string, prompt: string): RunAgentInput => ({
      threadId,
      runId: id,
      messages: [{ id, role: "user", content: prompt }],
      state: { unit5: true },
      tools: [],
      context: [],
      forwardedProps: {},
    });
    const first = makeInput("fixture-first", "unit5-tool");
    const run = (replica: number, data: RunAgentInput, id = bot) =>
      request(replica, agentRoute(id, "run"), {
        data,
        cookie: ownerCookie,
      }).then(sse);
    const stop = (data: unknown, cookie = ownerCookie) =>
      request(1, agentRoute(bot, `stop/${threadId}`), { data, cookie });
    const history = async () => {
      const response = await request(1, `${threadRoute}/history`, {
        cookie: ownerCookie,
      });
      expect(response.status).toBe(200);
      return historySchema.parse(await response.json());
    };
    for (const [path, data] of [
      [agentRoute(bot, "run"), first],
      [agentRoute(bot, "connect"), first],
      [agentRoute(bot, `stop/${threadId}`), { runId: first.runId }],
      [`${threadRoute}/history`, undefined],
      [`${threadRoute}/events`, undefined],
    ] as const) {
      const response = await request(0, path, {
        data,
        headers: { "x-user-id": owner },
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    expect(
      await request(1, agentRoute(bot, "connect"), {
        data: first,
        cookie: ownerCookie,
      }).then(sse),
    ).toEqual([]);
    const initialEvents = await run(0, first);
    expect(initialEvents.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    const firstRequests = requests;
    expect(await run(1, first)).toEqual(initialEvents);
    expect(requests).toBe(firstRequests);
    expect(
      await run(1, { ...first, state: { different: true } }),
    ).toMatchObject([
      { type: EventType.RUN_ERROR, code: "LOCAL_RUN_CONFLICT" },
    ]);
    expect(calls).toEqual([{ query: "granted" }]);
    const saved = await history();
    expect(saved.runs).toMatchObject([
      { requestKey: first.runId, status: "succeeded" },
    ]);
    expect(saved.operations).toMatchObject([
      {
        runId: saved.runs[0]?.id,
        attemptId: saved.attempts[0]?.id,
        toolName,
        status: "succeeded",
      },
    ]);
    expect(
      (
        await db.select().from(auditEvents).where(eq(auditEvents.targetId, ref))
      ).some((audit) => audit.eventType === "mcp.call_succeeded"),
    ).toBe(true);
    for (const path of [`${threadRoute}/history`, `${threadRoute}/events`]) {
      expect((await request(1, path, { cookie: peerCookie })).status).toBe(404);
    }
    for (const [action, data] of [
      ["run", first],
      ["connect", first],
      [`stop/${threadId}`, { runId: first.runId }],
    ] as const) {
      expect(
        (
          await request(1, agentRoute(bot, action), {
            data,
            cookie: peerCookie,
          })
        ).status,
      ).toBe(404);
    }
    expect(await run(1, first, publicBot)).toMatchObject([
      { code: "LOCAL_RUN_CONFLICT" },
    ]);
    const other = await request(1, agentRoute(publicBot, "run"), {
      data: first,
      cookie: peerCookie,
    }).then(sse);
    expect(other).toMatchObject([{ code: "LOCAL_RUN_CONFLICT" }]);
    expect(
      await request(1, agentRoute(publicBot, "connect"), {
        data: first,
        cookie: ownerCookie,
      }).then(sse),
    ).toEqual([]);

    const second = makeInput("fixture-active", "unit5-pause");
    const running = run(0, second);
    await Promise.race([
      pending.promise,
      running.then((events) => {
        throw new Error(
          `Tool did not start: ${JSON.stringify(events.map(({ type }) => type))}`,
        );
      }),
    ]);
    const reconnect = request(1, agentRoute(bot, "connect"), {
      data: second,
      cookie: ownerCookie,
      headers: { "x-openbot-event-sequence": "9999" },
    }).then(sse);
    const during = await history();
    expect(during.operations.at(-1)?.status).toBe("dispatched");
    const duplicate = run(1, second);
    expect(
      await run(1, makeInput("competing-run", "must not execute")),
    ).toMatchObject([{ code: "LOCAL_RUN_CONFLICT" }]);
    expect((await history()).runs).toHaveLength(2);
    expect(
      await (
        await request(1, agentRoute(publicBot, `stop/${threadId}`), {
          data: { runId: second.runId },
          cookie: ownerCookie,
        })
      ).json(),
    ).toMatchObject({ stopped: false });
    expect((await stop({ runId: second.runId }, peerCookie)).status).toBe(404);
    for (const data of [
      {},
      { runId: first.runId },
      { runId: saved.runs[0]?.id },
      { runId: "missing" },
    ]) {
      expect(await (await stop(data)).json()).toMatchObject({ stopped: false });
    }
    expect(await (await stop({ runId: second.runId })).json()).toMatchObject({
      stopped: true,
    });
    expect((await history()).attempts.at(-1)?.status).toBe("running");
    allowResult.resolve();
    const stopped = await running;
    expect(await duplicate).toEqual(stopped);
    expect(stopped.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "STOPPED",
      runId: second.runId,
    });
    const complete = await reconnect;
    expect(complete.slice(0, initialEvents.length)).toEqual(initialEvents);
    expect(complete.at(-1)).toMatchObject({ code: "STOPPED" });
    const after = await history();
    expect(after.runs.at(-1)?.status).toBe("cancelled");
    expect(after.operations.at(-1)?.status).toBe("succeeded");

    let cursor = 0;
    const sequences = [];
    for (;;) {
      const response = await request(
        1,
        `${threadRoute}/events?after=${cursor}&limit=3`,
        { cookie: ownerCookie },
      );
      expect(response.status).toBe(200);
      const page = z
        .object({ events: z.array(row) })
        .parse(await response.json()).events;
      if (!page.length) break;
      for (const applied of page) {
        sequences.push(applied.sequence);
        cursor = applied.sequence;
      }
    }
    expect(sequences).toEqual(after.events.map(({ sequence }) => sequence));

    await db.insert(approvalRules).values({
      id: randomUUID(),
      ownerUserId: owner,
      botId: bot,
      toolRef: ref,
      effect: "*",
      scope: "*",
      behaviour: "ask",
    });
    const awaitingApproval = await run(
      1,
      makeInput("fixture-approval", "unit5-approval"),
    );
    expect(awaitingApproval).toContainEqual(
      expect.objectContaining({
        type: EventType.CUSTOM,
        name: "openbot.headless.waiting",
      }),
    );
    expect(
      await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, owner)),
    ).toHaveLength(1);
    expect(calls).toEqual([{ query: "granted" }, { query: "pause-tool" }]);
    await db.delete(approvalRules).where(eq(approvalRules.ownerUserId, owner));

    const revoked = run(0, makeInput("fixture-revoke", "unit5-revoke"));
    await Promise.race([
      revokeAtModel.promise,
      revoked.then(() => {
        throw new Error("Model did not reach revoke barrier.");
      }),
    ]);
    await db.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
    allowRevokedCall.resolve();
    await revoked;
    expect(calls).toEqual([{ query: "granted" }, { query: "pause-tool" }]);
    expect(
      (
        await db.select().from(auditEvents).where(eq(auditEvents.targetId, ref))
      ).some((audit) => audit.eventType === "mcp.call_rejected"),
    ).toBe(true);
  } finally {
    allowResult.resolve();
    allowRevokedCall.resolve();
    await Promise.allSettled(processes.map((stop) => stop()));
    await Promise.allSettled([llm.stop(), mcp.stop()]);
    await db.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
    await db.delete(mcpServers).where(eq(mcpServers.id, toolServer));
    await db.delete(agents).where(inArray(agents.id, [bot, publicBot]));
    await db.delete(users).where(inArray(users.id, [owner, peer]));
    await db.$client.close();
  }
}, 35_000);
