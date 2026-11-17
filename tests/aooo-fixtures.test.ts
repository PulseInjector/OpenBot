import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "fixtures/aooo");

type Source = {
  id: string;
  batch: number;
  file: string;
  duplicateOf?: string;
};
type Evidence = { sourceId: string; quote: string };
type ExpectedFact = { id: string; claim: string; evidence: Evidence[] };
type Case = {
  fictional: boolean;
  sources: Source[];
  expected: { afterBatch1: ExpectedFact[]; afterBatch2: ExpectedFact[] };
  mustNotAppearAsFindings: string[];
  protectedText: string[];
};

const readFixture = (file: string) =>
  readFileSync(join(fixtureDir, file), "utf8");
const fixture = JSON.parse(readFixture("case.json")) as Case;

test("the two-batch acceptance case has traceable evidence and one exact duplicate", () => {
  expect(fixture.fictional).toBe(true);
  expect(fixture.sources.map((source) => source.batch)).toContain(1);
  expect(fixture.sources.map((source) => source.batch)).toContain(2);

  const sources = new Map(fixture.sources.map((source) => [source.id, source]));
  expect(sources.size).toBe(fixture.sources.length);

  for (const source of fixture.sources) {
    expect(source.file).toMatch(/^[a-z0-9-]+\.md$/);
    const content = readFixture(source.file);
    const canonical = source.duplicateOf
      ? sources.get(source.duplicateOf)
      : source;
    expect(canonical).toBeDefined();
    expect(content).toContain(`Source ID: ${canonical!.id}`);
    if (source.duplicateOf) expect(content).toBe(readFixture(canonical!.file));
  }

  for (const [batch, facts] of [
    [1, fixture.expected.afterBatch1],
    [2, fixture.expected.afterBatch2],
  ] as const) {
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.claim.length).toBeGreaterThan(0);
      expect(fact.evidence.length).toBeGreaterThan(0);
      for (const evidence of fact.evidence) {
        const source = sources.get(evidence.sourceId);
        expect(source).toBeDefined();
        expect(source!.batch).toBeLessThanOrEqual(batch);
        expect(readFixture(source!.file)).toContain(evidence.quote);
      }
    }
  }

  expect(fixture.sources.filter((source) => source.duplicateOf)).toHaveLength(
    1,
  );
  expect(fixture.mustNotAppearAsFindings.length).toBeGreaterThan(0);
  const initialPage = readFixture("initial-page.md");
  expect(initialPage).toContain("## Compatibility follow-up (Bot editable)");
  for (const protectedText of fixture.protectedText) {
    expect(initialPage).toContain(protectedText);
  }
});
