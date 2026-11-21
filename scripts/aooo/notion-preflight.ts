#!/usr/bin/env bun
/*
 * The write-barrier preflight for the unit 7 Notion chain.
 *
 * WHY A SCRIPT. An advertised tool name the reviewed `writeTools` list omits classifies as a read
 * (`classifyTool` in server/src/plugins/catalogue.ts), and Notion's entry has no vendor-side scope
 * behind it, so a refreshed tool that writes but is not on the list could be granted as a read. The
 * design therefore makes the classification check a guard that fails rather than a step a human
 * remembers, and this script is that guard's live half: it reads the refreshed tool listing and the
 * Bot's grants through the plugin store, prints a report, and exits nonzero on a problem.
 *
 * The offline half is `server/tests/notion-catalogue-coverage.test.ts`, which reads the sanitized
 * snapshot this script writes to `docs/aooo/evidence/unit-7-notion-tools.json` and fails when the
 * reviewed list and the snapshot disagree.
 *
 *   bun scripts/aooo/notion-preflight.ts --bot <agentId> [--out <snapshot.json>]
 *
 * DATABASE_URL comes from the environment (bun loads the repo root's `.env` automatically). The
 * script only reads: nothing here calls a vendor, touches the credential vault, or writes Notion.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditStore } from "../../server/src/audit";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../../server/src/credentials";
import { createDatabase } from "../../server/src/db/client";
import type { BrokerProvider } from "../../server/src/plugins/access";
import {
  catalogueEntry,
  classifyTool,
} from "../../server/src/plugins/catalogue";
import {
  type ServerRecord,
  unlistedAdvertisedTools,
} from "../../server/src/plugins/plugin-store/model";
import { createPluginStore } from "../../server/src/plugins/store";

/** The catalogue key of the one server this preflight is about. */
const SERVER = "notion";

/*
 * The chain's fixed order, as the plan states it: read the target page, update the compatibility
 * follow-up area, read again to verify. `notion-fetch` is the hosted server's page read, and the
 * operator's message carries the page url, so no search tool belongs to the chain.
 */
const CHAIN: { read: string[]; update: string } = {
  read: [`${SERVER}/notion-fetch`],
  update: `${SERVER}/notion-update-page`,
};

/** One advertised tool, as the plugin store reports it, narrowed to what the report needs. */
export type ListedNotionTool = {
  name: string;
  destructive: boolean;
  grantedTo: string[];
  inputSchema: Record<string, unknown>;
};

export type PreflightReport = {
  chain: { read: string[]; update: string };
  rows: Array<{
    ref: string;
    /** From the reviewed writeTools list, never the vendor: classifyTool consults review first. */
    classified: "read" | "write";
    inReviewedWriteList: boolean;
    /*
     * The vendor's own declaration, reconstructed from the destructive hint the MCP transport
     * records (`declaredEffect` in server/src/plugins/mcp.ts). That hint is the only effect a
     * first-party MCP listing ever declares here, because `readOnlyHint` is deliberately never
     * read: honouring it would let a server declare its own tools harmless.
     */
    vendorEffect: "write" | null;
    granted: boolean;
    schemaSha256: string;
  }>;
  /*
   * Advertised names the reviewed writeTools list omits, so each is offered to models as a read.
   * Reported, not exited on: a read the list omits is exactly what the list is supposed to omit.
   * The operator reviews these names at preparation, the same review the store's own refresh audit
   * (`unlisted_tools_advertised`) asks for.
   */
  unreviewedAdvertised: string[];
  problems: string[];
};

/**
 * The report, from a tool listing and the grants standing on it.
 *
 * Exits nonzero on every problem: a chain tool not advertised or not granted to the Bot, a write
 * tool granted beyond the chain's update, a grant that outlives its tool's advertisement, or an
 * advertised vendor-declared write missing from the reviewed writeTools list. Each of those breaks
 * the write barrier, so each is a refusal rather than a warning.
 */
export function buildPreflightReport(input: {
  botId: string;
  /** The advertised tools, or null when the server has no refreshed listing at all. */
  listing: ListedNotionTool[] | null;
  /** Grants on tools the last listing no longer advertises, from the server record's `withdrawn`. */
  withdrawn?: Array<{ ref: string; grantedTo: string[] }>;
}): PreflightReport {
  const entry = catalogueEntry(SERVER);
  const chainRefs = [...CHAIN.read, CHAIN.update];
  if (!entry) {
    return {
      chain: CHAIN,
      rows: [],
      unreviewedAdvertised: [],
      problems: [
        `the catalogue has no ${SERVER} entry, so no tool of that server can be classified.`,
      ],
    };
  }
  if (!input.listing) {
    return {
      chain: CHAIN,
      rows: [],
      unreviewedAdvertised: [],
      problems: [
        `the ${SERVER} server has no refreshed tool listing. Connect the account and press Refresh tools first.`,
      ],
    };
  }

  const reviewed = new Set(entry.writeTools);
  const rows = [...input.listing]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      const vendorEffect: "write" | null = tool.destructive ? "write" : null;
      return {
        ref: `${SERVER}/${tool.name}`,
        classified: classifyTool(entry, tool.name, true, vendorEffect),
        inReviewedWriteList: reviewed.has(tool.name),
        vendorEffect,
        granted: tool.grantedTo.includes(input.botId),
        schemaSha256: createHash("sha256")
          .update(JSON.stringify(tool.inputSchema))
          .digest("hex"),
      };
    });

  const problems: string[] = [];
  const byRef = new Map(rows.map((row) => [row.ref, row]));
  for (const ref of chainRefs) {
    const row = byRef.get(ref);
    if (!row)
      problems.push(
        `chain tool ${ref} is not advertised by the ${SERVER} server. Refresh tools.`,
      );
    else if (!row.granted)
      problems.push(`chain tool ${ref} is not granted to ${input.botId}.`);
  }
  for (const row of rows) {
    if (row.ref === CHAIN.update) continue;
    if (row.granted && row.classified === "write")
      problems.push(
        `write tool ${row.ref} is granted to ${input.botId} beyond the chain update ${CHAIN.update}. Revoke it.`,
      );
  }
  for (const gone of input.withdrawn ?? []) {
    if (chainRefs.includes(gone.ref)) continue;
    if (!gone.grantedTo.includes(input.botId)) continue;
    problems.push(
      `${gone.ref} is still granted to ${input.botId} but no longer advertised, so nothing can classify it as a read. Revoke it or refresh tools.`,
    );
  }
  for (const row of rows) {
    if (row.vendorEffect === "write" && !row.inReviewedWriteList)
      problems.push(
        `${row.ref} carries a vendor-declared write effect and is missing from the reviewed writeTools list. A human must review it before any grant.`,
      );
  }

  return {
    chain: CHAIN,
    rows,
    unreviewedAdvertised: unlistedAdvertisedTools(
      entry,
      rows.map((row) => row.ref.slice(SERVER.length + 1)),
    ),
    problems,
  };
}

/**
 * What a report leaves in the repository, sanitized to what a review needs.
 *
 * Names, classifications and schema digests only: no descriptions, no raw schemas, no account
 * identity, no tokens, and no grants, which are the operator's own state rather than a fact about
 * the vendor's listing.
 */
export type NotionSnapshot = {
  server: "notion";
  generatedAt: string;
  /** How this snapshot was produced, so a reader never mistakes a placeholder for a live refresh. */
  origin: string;
  reviewedWriteTools: string[];
  advertised: Array<{
    name: string;
    classified: "read" | "write";
    vendorEffect: "write" | null;
    schemaSha256: string;
  }>;
};

export function snapshotFromReport(
  report: PreflightReport,
  meta: { generatedAt: string; origin: string },
): NotionSnapshot {
  const entry = catalogueEntry(SERVER);
  return {
    server: SERVER,
    generatedAt: meta.generatedAt,
    origin: meta.origin,
    reviewedWriteTools: entry ? [...entry.writeTools] : [],
    advertised: report.rows.map(
      ({ ref, classified, vendorEffect, schemaSha256 }) => ({
        name: ref.slice(SERVER.length + 1),
        classified,
        vendorEffect,
        schemaSha256,
      }),
    ),
  };
}

const LIVE_ORIGIN = `written by scripts/aooo/notion-preflight.ts from the plugin store's refreshed listing`;
const DEFAULT_SNAPSHOT = "docs/aooo/evidence/unit-7-notion-tools.json";

function listingOf(server: ServerRecord): ListedNotionTool[] {
  return server.tools.map((tool) => ({
    name: tool.name,
    destructive: tool.destructive,
    grantedTo: tool.grantedTo,
    inputSchema: tool.inputSchema,
  }));
}

async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number | string> {
  let botId = "";
  let out = DEFAULT_SNAPSHOT;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined)
      return `usage: bun scripts/aooo/notion-preflight.ts --bot <agentId> [--out <snapshot.json>]`;
    if (flag === "--bot") botId = value;
    else if (flag === "--out") out = value;
    else
      return `unknown argument ${flag}. usage: bun scripts/aooo/notion-preflight.ts --bot <agentId> [--out <snapshot.json>]`;
  }
  if (!botId)
    return `usage: bun scripts/aooo/notion-preflight.ts --bot <agentId> [--out <snapshot.json>]`;

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl)
    return `DATABASE_URL is not set, so there is no store to read. Run from the repo root, where bun loads .env.`;

  const database = createDatabase(databaseUrl);
  const store = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: refusingCredentials(),
    // Never used: the preflight only reads listings and grants, which decrypt nothing.
    encryptionKey: "notion-preflight-never-decrypts",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    brokerProvider: brokerProviderOf(env),
  });
  const notion = (await store.listServers()).find(
    (server) => server.id === SERVER,
  );
  const report = buildPreflightReport({
    botId,
    listing: notion ? listingOf(notion) : null,
    withdrawn: notion?.withdrawn,
  });
  console.log(JSON.stringify(report, null, 2));

  if (report.rows.length > 0) {
    const snapshot = snapshotFromReport(report, {
      generatedAt: new Date().toISOString(),
      origin: LIVE_ORIGIN,
    });
    const target = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
      out,
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return report.problems.length > 0 ? 1 : 0;
}

/*
 * The preflight never touches the vault, and a stub that says so beats a live credential reader:
 * the store's shape demands a credential interface, and every method on it stays refused so a
 * future edit cannot quietly turn this read-only script into one that decrypts.
 */
function refusingCredentials(): CredentialSecretReader & CredentialStore {
  const refused = (method: string) => async (): Promise<never> => {
    throw new Error(
      `notion-preflight never touches the credential vault, so ${method} must never be called.`,
    );
  };
  return {
    create: refused("create"),
    updateSecret: refused("updateSecret"),
    rotate: refused("rotate"),
    revoke: refused("revoke"),
    isLive: refused("isLive"),
    findLiveByKey: refused("findLiveByKey"),
    readSecret: refused("readSecret"),
  };
}

/*
 * The brokered rows the store filters by provider are not this server's, and a notion-only
 * deployment usually has no broker configured at all, so the value only has to be one of the two
 * the type admits rather than the one index.ts derives from configuration and rows.
 */
function brokerProviderOf(
  env: Record<string, string | undefined>,
): BrokerProvider {
  return env.OPENBOT_BROKER_PROVIDER === "arcade" ? "arcade" : "composio";
}

if (import.meta.main) {
  try {
    const outcome = await main(process.argv.slice(2), process.env);
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
