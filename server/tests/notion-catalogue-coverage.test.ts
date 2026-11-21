// The offline half of the Notion write-barrier guard for work unit 7.
//
// It reads the sanitized snapshot docs/aooo/evidence/unit-7-notion-tools.json and the catalogue's
// reviewed writeTools list, and fails when the two disagree in either direction: an advertised
// write the reviewed list omits, or a reviewed write the listing no longer advertises. A failure
// means a human reviews the named tool and, if it writes, extends the reviewed list before any
// grant.
//
// Regenerate the snapshot after the operator's live Refresh tools:
//
//   bun scripts/aooo/notion-preflight.ts --bot <agentId>
//
// That script reads the refreshed listing and the Bot's grants through the plugin store, prints the
// preflight report, and rewrites the snapshot. The buildPreflightReport cases below pin the
// script's exit-nonzero conditions against seeded listings, so no database or Notion account is
// needed here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  buildPreflightReport,
  type NotionSnapshot,
  snapshotFromReport,
} from "../../scripts/aooo/notion-preflight";
import { catalogueEntry } from "../src/plugins/catalogue";

const notion = catalogueEntry("notion");
if (!notion)
  throw new Error(
    "the catalogue has no notion entry, so nothing below can run.",
  );

const snapshotSchema = z.object({
  server: z.literal("notion"),
  generatedAt: z.string(),
  origin: z.string(),
  reviewedWriteTools: z.array(z.string()),
  advertised: z.array(
    z.object({
      name: z.string(),
      classified: z.enum(["read", "write"]),
      vendorEffect: z.union([z.literal("write"), z.null()]),
      schemaSha256: z.string(),
    }),
  ),
});

const snapshotUrl = new URL(
  "../../docs/aooo/evidence/unit-7-notion-tools.json",
  import.meta.url,
);
const snapshot: NotionSnapshot = snapshotSchema.parse(
  JSON.parse(readFileSync(snapshotUrl, "utf8")),
);

describe("catalogue coverage against the saved snapshot", () => {
  test("every advertised write in the snapshot is on the reviewed writeTools list", () => {
    const unreviewed = snapshot.advertised
      .filter(
        (row) =>
          row.vendorEffect === "write" && !notion.writeTools.includes(row.name),
      )
      .map((row) => row.name);
    expect(unreviewed).toEqual([]);
  });

  test("every write the snapshot classified is still on the reviewed list", () => {
    // The vendor scoping above cannot see a plain write, because first-party MCP listings carry no
    // destructive hint. The snapshot's own classification is the record of what the last review
    // decided, so a name dropping off the live list while the tool is still advertised is the
    // dangerous direction: the tool silently reclassifies as a read and the vendor check stays
    // green. Verified by breaking: blanking one reviewed name in catalogue.ts passed the two
    // original checks and failed only this one.
    const dropped = snapshot.advertised
      .filter(
        (row) =>
          row.classified === "write" && !notion.writeTools.includes(row.name),
      )
      .map((row) => row.name);
    expect(dropped).toEqual([]);
  });

  test("every reviewed writeTools name is still advertised in the snapshot", () => {
    const advertised = new Set(snapshot.advertised.map((row) => row.name));
    expect(notion.writeTools.filter((name) => !advertised.has(name))).toEqual(
      [],
    );
  });
});

describe("preflight report on a seeded listing", () => {
  const bot = "unit7-bot";
  const placeholderSchema = { type: "object", properties: {} };
  const seed = (names: readonly string[], grantedTo: string[] = []) =>
    names.map((name) => ({
      name,
      destructive: false,
      grantedTo,
      inputSchema: placeholderSchema,
    }));
  // The writes other than the chain's own update, advertised but deliberately not granted.
  const otherWrites = notion.writeTools.filter(
    (name) => name !== "notion-update-page",
  );

  test("the chain's exact grants report no problems", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch", "notion-update-page"], [bot]),
        ...seed(otherWrites),
      ],
    });
    expect(report.problems).toEqual([]);
    expect(report.chain).toEqual({
      read: ["notion/notion-fetch"],
      update: "notion/notion-update-page",
    });

    const fetchRow = report.rows.find(
      (row) => row.ref === "notion/notion-fetch",
    );
    expect(fetchRow?.classified).toBe("read");
    expect(fetchRow?.granted).toBe(true);

    const updateRow = report.rows.find(
      (row) => row.ref === "notion/notion-update-page",
    );
    expect(updateRow?.classified).toBe("write");
    expect(updateRow?.inReviewedWriteList).toBe(true);
    expect(updateRow?.granted).toBe(true);
  });

  test("a reviewed write stays a write when the vendor declares nothing", () => {
    // Notion's listing carries no per-action effect, so `vendorEffect` is null for every row and
    // the reviewed list alone decides. That is the codebase's deliberate stance: a vendor's read
    // hint is never honored, and the preflight report records the declaration without obeying it.
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch"], [bot]),
        ...seed(["notion-update-page"]),
      ],
    });
    const updateRow = report.rows.find(
      (row) => row.ref === "notion/notion-update-page",
    );
    expect(updateRow?.vendorEffect).toBeNull();
    expect(updateRow?.classified).toBe("write");
  });

  test("a chain tool the Bot lacks is a problem", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch"]),
        ...seed(["notion-update-page"], [bot]),
        ...seed(otherWrites),
      ],
    });
    expect(report.problems).toEqual([
      "chain tool notion/notion-fetch is not granted to unit7-bot.",
    ]);
  });

  test("a chain tool the listing omits is a problem", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [...seed(["notion-fetch"], [bot]), ...seed(otherWrites)],
    });
    expect(report.problems).toContain(
      "chain tool notion/notion-update-page is not advertised by the notion server. Refresh tools.",
    );
  });

  test("a granted write beyond the chain update is a problem", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(
          ["notion-fetch", "notion-update-page", "notion-duplicate-page"],
          [bot],
        ),
        ...seed(otherWrites),
      ],
    });
    expect(report.problems).toContain(
      "write tool notion/notion-duplicate-page is granted to unit7-bot beyond the chain update notion/notion-update-page. Revoke it.",
    );
  });

  test("an advertised vendor-declared write off the reviewed list is a problem", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch", "notion-update-page"], [bot]),
        ...seed(otherWrites),
        {
          name: "notion-vendor-new-write",
          destructive: true,
          grantedTo: [],
          inputSchema: placeholderSchema,
        },
      ],
    });
    expect(report.problems).toContain(
      "notion/notion-vendor-new-write carries a vendor-declared write effect and is missing from the reviewed writeTools list. A human must review it before any grant.",
    );
    expect(
      report.rows.find((row) => row.ref === "notion/notion-vendor-new-write")
        ?.classified,
    ).toBe("write");
  });

  test("a grant that outlives its tool's advertisement is a problem", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch", "notion-update-page"], [bot]),
        ...seed(otherWrites),
      ],
      withdrawn: [{ ref: "notion/create-pages", grantedTo: [bot] }],
    });
    expect(report.problems).toContain(
      "notion/create-pages is still granted to unit7-bot but no longer advertised, so nothing can classify it as a read. Revoke it or refresh tools.",
    );
  });

  test("a server with no refreshed listing refuses rather than guessing", () => {
    const report = buildPreflightReport({ botId: bot, listing: null });
    expect(report.problems).toEqual([
      "the notion server has no refreshed tool listing. Connect the account and press Refresh tools first.",
    ]);
  });

  test("advertised names the reviewed list omits are reported, not problems", () => {
    const report = buildPreflightReport({
      botId: bot,
      listing: [
        ...seed(["notion-fetch", "notion-update-page"], [bot]),
        ...seed(otherWrites),
        ...seed(["notion-search"]),
      ],
    });
    expect(report.problems).toEqual([]);
    expect(report.unreviewedAdvertised).toEqual([
      "notion-fetch",
      "notion-search",
    ]);
  });

  test("the sanitized snapshot carries names, classifications and digests only", () => {
    const fromReport = snapshotFromReport(
      buildPreflightReport({
        botId: bot,
        listing: [
          ...seed(["notion-fetch", "notion-update-page"], [bot]),
          ...seed(otherWrites),
        ],
      }),
      { generatedAt: "2026-11-21T00:00:00.000Z", origin: "test" },
    );
    expect(Object.keys(fromReport).sort()).toEqual([
      "advertised",
      "generatedAt",
      "origin",
      "reviewedWriteTools",
      "server",
    ]);
    for (const row of fromReport.advertised) {
      expect(Object.keys(row).sort()).toEqual([
        "classified",
        "name",
        "schemaSha256",
        "vendorEffect",
      ]);
      expect(row.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(fromReport.reviewedWriteTools).toEqual([...notion.writeTools]);
  });
});
