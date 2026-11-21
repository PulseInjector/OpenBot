import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { makeSignature } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import {
  agentCreationRequests,
  agentProfiles,
  agents,
  attachments,
  mcpServers,
  mcpTools,
  pluginGrants,
  sessions,
  userRoles,
  users,
} from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

/*
 * The six workbench phases the verification map's audit named as gaps: creating a Bot through
 * each of its two UI entry points, finding a conversation through the sidebar rather than its URL,
 * the home composer and the direct `/bot` conversation, the composer's attachments, and the admin
 * connector page where tools are refreshed and granted. Each is driven the way a person drives it,
 * in a real system browser against the production server, and each assertion lands on the stored
 * state the drive is supposed to produce — the roster row, the deduplication record, the attachment
 * row, the grant — not only on what the page happens to show.
 *
 * The built-in creation path requires a configured managed Agent endpoint because app.ts falls
 * back to it when no per-Bot endpoint is supplied. This harness serves an AG-UI fixture at that
 * external boundary, as LLMock and MCPMock serve the model and tool-server boundaries.
 *
 * One harness, six phases: the server, the app, the browser, and the three fixture boundaries are
 * all expensive to start, and no phase's observation leaks into another's state beyond the rows it
 * creates under its own unique name. The fixture model answers every plain message with one
 * deterministic reply and answers one marked message with the `save_bot` tool call the conversation
 * card is built to surface. Its test Bot holds the `bot-creator` skill, which makes that card an
 * available conversation tool.
 */

const REPLY = "workbench deterministic reply";
const ALPHA_REPLY = "workbench alpha deterministic reply";
const BETA_REPLY = "workbench beta deterministic reply";

const channelSchema = z.object({
  channel: z.object({ id: z.string(), threadId: z.string() }),
});
const managedRunSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
});

async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() >= until) throw new Error("Condition never became true.");
    await Bun.sleep(100);
  }
}

async function unusedPort(): Promise<number> {
  await using socket = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  if (!socket.port) throw new Error("No fixture port allocated.");
  return socket.port;
}

test("a person drives the workbench surfaces the map named as gaps", async () => {
  const url = testDatabaseUrl();
  const db = createDatabase(url);
  const suffix = randomUUID().slice(0, 8);
  const owner = `surfaces-owner-${suffix}`;
  const bot = `surfaces-bot-${suffix}`;
  const toolServer = `surfaces_${suffix}`;
  const tool = "read_fixture";
  const ref = `${toolServer}/${tool}`;
  const secret = randomBytes(32).toString("hex");
  const keyEncryptionKey = randomBytes(32).toString("base64");
  const evidence = process.env.AOOO_EVIDENCE_DIR;
  const llm = new LLMock();
  const mcp = new MCPMock();
  const stops: (() => Promise<unknown>)[] = [];
  const facts: Record<string, unknown> = {};

  async function session(userId: string) {
    const token = randomUUID();
    await db.insert(sessions).values({
      id: randomUUID(),
      userId,
      token,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return encodeURIComponent(`${token}.${await makeSignature(token, secret)}`);
  }

  try {
    await db.insert(users).values({
      id: owner,
      email: `${owner}@example.test`,
      emailVerified: true,
      onboardingStep: 1,
      onboardingCompletedAt: new Date(),
    });
    // The connector page this journey drives is an administrator screen.
    await db.insert(userRoles).values({ userId: owner, role: "user" });
    await db.insert(userRoles).values({ userId: owner, role: "admin" });
    await db.insert(agents).values({
      id: bot,
      name: bot,
      type: "built_in",
      configuration: { systemPrompt: "Handle the synthetic fixture." },
    });
    await db.insert(agentProfiles).values({
      agentId: bot,
      title: bot,
      roleDescription: "Surfaces journey Bot",
      ownerUserId: owner,
      avatarSeed: bot,
      visibility: "private",
    });
    await db.insert(pluginGrants).values({
      kind: "skill",
      ref: "bot-creator",
      agentId: bot,
      grantedBy: "test-fixture",
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
    mcp.onToolCall(tool, () => "fixture receipt");
    const mcpUrl = await mcp.start();
    stops.push(() => mcp.stop());
    await db.insert(mcpServers).values({
      id: toolServer,
      title: "Surfaces fixture connector",
      vendor: "fixture",
      provenance: "custom",
      url: mcpUrl,
    });
    llm.onMessage(/workbench-/, async (req) => {
      const body = JSON.stringify(req);
      if (body.includes("workbench-propose")) {
        return {
          toolCalls: [
            {
              name: "save_bot",
              arguments: JSON.stringify({
                name: `Card Bot ${suffix}`,
                title: "Card-created surfaces Bot",
                roleDescription: "Created from the conversation card.",
              }),
            },
          ],
        };
      }
      if (body.includes("workbench-alpha")) return { content: ALPHA_REPLY };
      if (body.includes("workbench-beta")) return { content: BETA_REPLY };
      return { content: REPLY };
    });
    const llmBase = await llm.start();
    stops.push(() => llm.stop());
    const sessionValue = await session(owner);
    const ownerCookie = `better-auth.session_token=${sessionValue}`;

    const serverPort = await unusedPort();
    const appPort = await unusedPort();
    const managedAgentPort = await unusedPort();
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const appUrl = `http://127.0.0.1:${appPort}`;
    const managedAgentToken = randomBytes(32).toString("hex");
    const managedAgent = Bun.serve({
      hostname: "127.0.0.1",
      port: managedAgentPort,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return new Response("ok");
        }
        if (request.method !== "POST" || url.pathname !== "/ag-ui") {
          return new Response(null, { status: 404 });
        }
        if (
          request.headers.get("x-openbot-agent-token") !== managedAgentToken
        ) {
          return new Response(null, { status: 401 });
        }

        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return new Response("Invalid JSON request.", { status: 400 });
        }
        const parsed = managedRunSchema.safeParse(input);
        if (!parsed.success) {
          return new Response("Invalid AG-UI run input.", { status: 400 });
        }

        const messageId = `managed-fixture-${randomUUID()}`;
        const events = [
          {
            type: "RUN_STARTED",
            threadId: parsed.data.threadId,
            runId: parsed.data.runId,
          },
          { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: "managed Agent fixture reply",
          },
          { type: "TEXT_MESSAGE_END", messageId },
          {
            type: "RUN_FINISHED",
            threadId: parsed.data.threadId,
            runId: parsed.data.runId,
          },
        ];
        return new Response(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    stops.push(async () => managedAgent.stop(true));

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
          COPILOTKIT_TELEMETRY_DISABLED: "1",
          BETTER_AUTH_SECRET: secret,
          BETTER_AUTH_URL: serverUrl,
          GOOGLE_OAUTH_CLIENT_ID: "fixture-client",
          GOOGLE_OAUTH_CLIENT_SECRET: "fixture-secret",
          INITIAL_ADMIN_EMAILS: `${owner}@example.test`,
          MANAGED_AGENT_AG_UI_URL: `http://127.0.0.1:${managedAgentPort}/ag-ui`,
          MANAGED_AGENT_TOKEN: managedAgentToken,
          OPENAI_API_KEY: "fixture-key",
          OPENAI_BASE_URL: llmBase,
          BOT_MODEL: "gpt-5.6-terra",
        },
        stdout: evidence
          ? Bun.file(join(evidence, "surfaces-server.log"))
          : "ignore",
        stderr: evidence
          ? Bun.file(join(evidence, "surfaces-server.stderr.log"))
          : "ignore",
      },
    );
    stops.push(() => {
      child.kill();
      return child.exited;
    });
    await eventually(
      () => fetch(`${serverUrl}/health`).catch(() => undefined),
      (response) => response?.ok ?? false,
    );

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
        stdout: evidence
          ? Bun.file(join(evidence, "surfaces-app.log"))
          : "ignore",
        stderr: evidence
          ? Bun.file(join(evidence, "surfaces-app.stderr.log"))
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
      { name: "better-auth.session_token", value: sessionValue, url: appUrl },
    ]);

    async function shoot(page: Page, name: string) {
      if (!evidence) return;
      await page.screenshot({ path: join(evidence, name), fullPage: true });
    }

    async function makeChannel() {
      const response = await fetch(`${serverUrl}/api/channels`, {
        method: "POST",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        body: JSON.stringify({ agentIds: [bot] }),
        signal: AbortSignal.timeout(12_000),
      });
      expect(response.status).toBe(201);
      return channelSchema.parse(await response.json()).channel;
    }

    async function open(path: string): Promise<Page> {
      const page = await context.newPage();
      await page.goto(`${appUrl}${path}`);
      return page;
    }

    async function say(page: Page, text: string) {
      const composer = page.getByRole("textbox", { name: "Message" }).first();
      await composer.waitFor({ state: "visible", timeout: 45_000 });
      await composer.fill(text);
      const entered = await composer.evaluate((element) =>
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement
          ? element.value
          : element.textContent,
      );
      expect(entered).toBe(text);
      await page.keyboard.press("Enter");
    }

    async function waitForReply(page: Page, reply: string) {
      try {
        await page
          .getByRole("main")
          .getByText(reply, { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 45_000 });
      } catch (error) {
        await shoot(page, "surfaces-reply-missing.png");
        throw error;
      }
    }

    /*
     * Phase 1 — create a Bot through the New Bot sheet, one of the two UI entry points the map
     * lists. The sheet is a wizard: choose the built-in runtime, name the Bot, create.
     * This path requires a deployment-managed Bot endpoint. The fixture endpoint above supplies
     * that external boundary so the product reports the configured capability and can exercise
     * real creation; it does not replace or bypass the product's availability check.
     */
    {
      const page = await open("/bots");
      await page.getByRole("button", { name: "New Bot" }).click();
      await shoot(page, "surfaces-sheet-runtime-choice.png");
      // The built-in runtime opens already chosen ("Run it here" pressed), so the wizard's
      // first actionable control is Continue.
      const continueButton = page.getByRole("button", {
        name: "Continue",
        exact: true,
      });
      await continueButton.waitFor({ state: "visible" });
      expect(await continueButton.isEnabled()).toBe(true);
      await continueButton.click();
      const name = page.getByRole("textbox", { name: "Name" });
      await name.waitFor({ state: "visible", timeout: 20_000 });
      await name.fill(`Sheet Bot ${suffix}`);
      await page.getByRole("button", { name: "Create" }).click();
      await eventually(
        async () => page.url(),
        (value) => /\/bots\/[^/]+$/.test(value) && !value.endsWith("/bots"),
      );
      const created = await db
        .select({ agentId: agents.id, ownerUserId: agentProfiles.ownerUserId })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(eq(agents.name, `Sheet Bot ${suffix}`));
      expect(created).toHaveLength(1);
      expect(created[0]?.ownerUserId).toBe(owner);
      const sheetRows = await db
        .select()
        .from(agentCreationRequests)
        .where(eq(agentCreationRequests.actorId, owner));
      expect(sheetRows).toHaveLength(1);
      facts.sheet = {
        name: `Sheet Bot ${suffix}`,
        agentId: created[0]?.agentId,
        requestId: sheetRows[0]?.requestId,
      };
      await shoot(page, "surfaces-sheet-created.png");
      await page.close();
    }

    /*
     * Phase 2 — create a Bot through the conversation card, the other entry point. The fixture
     * model proposes; the card is a human-in-the-loop surface, so nothing is written until the
     * Create it button is pressed.
     */
    {
      const channel = await makeChannel();
      const page = await open(`/channel/${channel.id}`);
      await say(page, "workbench-propose a bot");
      const create = page.getByText("Create it", { exact: true }).first();
      await create.waitFor({ state: "visible", timeout: 45_000 });
      await shoot(page, "surfaces-card-proposed.png");
      await create.click();
      await eventually(
        () =>
          db
            .select()
            .from(agentProfiles)
            .where(eq(agentProfiles.title, "Card-created surfaces Bot"))
            .then((rows) => rows),
        (rows) => rows.length === 1,
      );
      const cardRows = await db
        .select()
        .from(agentCreationRequests)
        .where(eq(agentCreationRequests.actorId, owner));
      // Two creations, two deduplication records: one through the sheet, one through the card.
      expect(cardRows).toHaveLength(2);
      facts.card = { title: "Card-created surfaces Bot" };
      await shoot(page, "surfaces-card-created.png");
      await page.close();
    }

    /*
     * Phase 3 — find the original conversation through the sidebar. Typing a URL proves
     * reconnection; discovering the thread in the list proves the surface a person actually
     * uses to go back to work.
     */
    {
      const first = await makeChannel();
      const second = await makeChannel();
      const pageA = await open(`/channel/${first.id}`);
      await say(pageA, "workbench-alpha topic");
      await waitForReply(pageA, ALPHA_REPLY);
      await pageA.close();
      const pageB = await open(`/channel/${second.id}`);
      await say(pageB, "workbench-beta topic");
      await waitForReply(pageB, BETA_REPLY);
      // Standing on the second conversation, the first one is only a sidebar entry away.
      await shoot(pageB, "surfaces-sidebar-list.png");
      await eventually(
        () =>
          pageB
            .getByRole("link")
            .filter({ hasText: ALPHA_REPLY })
            .first()
            .isVisible()
            .catch(() => false),
        (visible) => visible === true,
      );
      await pageB
        .getByRole("link")
        .filter({ hasText: ALPHA_REPLY })
        .first()
        .click();
      await eventually(
        async () => pageB.url(),
        (value) => value.includes(`/channel/${first.id}`),
      );
      await pageB
        .getByRole("main")
        .getByText(ALPHA_REPLY, { exact: true })
        .waitFor({ state: "visible", timeout: 20_000 });
      facts.sidebar = { found: first.id };
      await shoot(pageB, "surfaces-sidebar-found.png");
      await pageB.close();
    }

    /*
     * Phase 4 — the home composer and the direct /bot conversation: the two chat entry points
     * besides channels. Each must start real work and show the reply.
     */
    {
      const home = await open("/");
      await say(home, "workbench-home hello");
      await eventually(
        async () => home.url(),
        (value) => /\/channel\//.test(value),
      );
      await waitForReply(home, REPLY);
      facts.homeComposer = { landed: home.url() };
      await shoot(home, "surfaces-home-composer-sent.png");
      await home.close();

      const direct = await open(`/bot?agent=${bot}`);
      await say(direct, "workbench-direct hello");
      await waitForReply(direct, REPLY);
      const directThread = await direct.evaluate(() =>
        window.localStorage.getItem(
          `openbot.bot-thread.${new URLSearchParams(window.location.search).get("agent")}`,
        ),
      );
      expect(typeof directThread).toBe("string");
      const history = await fetch(
        `${serverUrl}/api/local-runtime/threads/${directThread}/history`,
        {
          headers: { cookie: ownerCookie },
          signal: AbortSignal.timeout(12_000),
        },
      );
      expect(history.status).toBe(200);
      const body = (await history.json()) as {
        runs: Array<{ status: string }>;
      };
      expect(body.runs.at(-1)?.status).toBe("succeeded");
      facts.directChat = { threadId: directThread };
      await shoot(direct, "surfaces-direct-chat.png");
      await direct.close();
    }

    /*
     * Phase 5 — the composer's attachments. A staged upload writes its row before any message is
     * sent, and sending speaks for it: attachedAt goes from null to the send's moment.
     */
    {
      const channel = await makeChannel();
      const page = await open(`/channel/${channel.id}`);
      const bytes = "surfaces fixture attachment\n";
      await page
        .locator("input[type=file]")
        .first()
        .setInputFiles({
          name: `surfaces-note-${suffix}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from(bytes, "utf8"),
        });
      const staged = await eventually(
        () =>
          db
            .select()
            .from(attachments)
            .where(eq(attachments.name, `surfaces-note-${suffix}.txt`))
            .then((rows) => rows),
        (rows) => rows.length === 1,
      );
      expect(staged[0]?.uploadedBy).toBe(owner);
      expect(staged[0]?.attachedAt).toBeNull();
      await say(page, "workbench-attachment sends with the file");
      await waitForReply(page, REPLY);
      const spoken = await db
        .select()
        .from(attachments)
        .where(eq(attachments.name, `surfaces-note-${suffix}.txt`));
      expect(spoken).toHaveLength(1);
      expect(spoken[0]?.attachedAt).not.toBeNull();
      facts.attachment = {
        name: `surfaces-note-${suffix}.txt`,
        sizeBytes: spoken[0]?.sizeBytes,
      };
      await shoot(page, "surfaces-attachment-sent.png");
      await page.close();
    }

    /*
     * Phase 6 — the admin connector page and the Bot's grant screen: where an administrator
     * refreshes an advertised listing and grants exactly the tool this Bot needs.
     */
    {
      const admin = await open(`/admin/plugins/${toolServer}`);
      const refresh = admin.getByRole("button", { name: /refresh/i }).first();
      await refresh.waitFor({ state: "visible", timeout: 45_000 });
      await refresh.click();
      const listed = await eventually(
        () =>
          db
            .select()
            .from(mcpTools)
            .where(eq(mcpTools.serverId, toolServer))
            .then((rows) => rows),
        (rows) => rows.some((row) => row.name === tool),
      );
      expect(listed.length).toBeGreaterThan(0);
      await shoot(admin, "surfaces-admin-refreshed.png");

      const grantsBefore = await db
        .select()
        .from(pluginGrants)
        .where(
          and(eq(pluginGrants.agentId, bot), eq(pluginGrants.kind, "mcp")),
        );
      expect(grantsBefore).toHaveLength(0);
      const botRow = admin.getByRole("link").filter({ hasText: bot }).first();
      await botRow.waitFor({ state: "visible", timeout: 45_000 });
      await botRow.click();
      await eventually(
        async () => admin.url(),
        (value) => value.includes(`/admin/plugins/${toolServer}/bots/${bot}`),
      );
      await shoot(admin, "surfaces-admin-grant-screen.png");
      const toggle = admin.getByRole("switch", {
        name: `Let ${bot} call ${tool}`,
      });
      await toggle.waitFor({ state: "visible", timeout: 45_000 });
      await toggle.click();
      await shoot(admin, "surfaces-admin-grant-result.png");
      await eventually(
        () =>
          db
            .select()
            .from(pluginGrants)
            .where(
              and(eq(pluginGrants.agentId, bot), eq(pluginGrants.kind, "mcp")),
            )
            .then((rows) => rows),
        (rows) => rows.length === 1 && rows[0]?.ref === ref,
      );
      const granted = await db
        .select()
        .from(pluginGrants)
        .where(
          and(eq(pluginGrants.agentId, bot), eq(pluginGrants.kind, "mcp")),
        );
      expect(granted[0]?.ref).toBe(ref);
      facts.connectorGrant = { ref };
      await shoot(admin, "surfaces-grant-toggled.png");
      await admin.close();
    }

    if (evidence) {
      await Bun.write(
        join(evidence, "workbench-surfaces.json"),
        JSON.stringify({ phases: facts, bun: Bun.version }, null, 2),
      );
    }
  } finally {
    for (const stop of stops.reverse()) await stop();
    await db.$client.close();
  }
}, 240_000);
