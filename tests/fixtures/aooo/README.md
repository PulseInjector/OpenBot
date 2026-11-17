# Stage-one acceptance case

This is a fictional, fixed compatibility case for exercising a real model and a real Notion
connection. Alder Client and Compass are not product claims. The source text is intentionally short
so a reviewer can compare every finding with its evidence.

## Files and expected result

- `batch-1-release.md` and `batch-1-project.md` establish the 2.4 release behavior and Compass's
  production usage.
- `batch-2-release.md`, its byte-identical `batch-2-release-mirror.md`, and
  `batch-2-project.md` add an earlier-than-planned removal, an irrelevant UI change, and a staging
  change that has not reached production.
- `case.json` lists the facts expected after each batch, exact evidence excerpts, claims that must
  not become compatibility findings, and text that must stay untouched.
- `initial-page.md` is the checked-in initial copy of the independent Notion test page. Only the
  section headed `Compatibility follow-up (Bot editable)` may change. The project profile and owner
  notes are protected.

Check fixture consistency without a model, database, or Notion account:

```sh
bun test tests/aooo-fixtures.test.ts
```

This command verifies source references, quoted evidence, the exact duplicate, and the initial page
boundary. It does not claim that a Bot completed the live workflow.

## Reproduce the live case

1. Use Bun 1.4.3, the version pinned in the root `package.json`, and install with
   `bun install --frozen-lockfile`. Use an isolated PostgreSQL database for this deployment and a
   separate `TEST_DATABASE_URL` for integration tests. Follow `docs/development.md` for Docker and
   `bash scripts/start.sh`. The inherited OpenBot stack still needs Intelligence configuration;
   running without it is a later stage-one PR, not a property of this fixture PR.
2. Configure one real model through the existing provider settings. Keep model keys, database URLs,
   session cookies, and OAuth credentials in the ignored `.env` or local environment, never in this
   directory. Record the model name and relevant configuration names in local run notes, without
   recording secret values.
3. For Notion, set the public callback origin and app origin as described in
   `docs/plugins/notion.md` and `docs/configuration.md`. Enable the connector, connect the account
   that will run the Bot, refresh the advertised tools, and grant that Bot only the required page-read
   and page-update actions after checking the live tool names against the catalogue write list. Share
   the independent test page with that Notion connection. Do not use the implementation plan as the
   writable target.
4. Create or reset the independent Notion test page to `initial-page.md` before a run. Keep its URL
   in `.local/aooo-pr1-test-page.md` (ignored by Git). Save a read-back of the initial page there or
   beside it. The checked-in initial copy is the reference for the protected text.
5. In one Bot thread, provide the two batch-1 files and the test page URL. Ask: "Read the test page
   and these two sources. Update only Compatibility follow-up with Compass compatibility findings,
   cite source IDs, then read the page back and return its link. Do not change protected sections."
   Compare the read-back with `expected.afterBatch1` and `mustNotAppearAsFindings` in `case.json`.
6. In the same thread, provide all three batch-2 files. Ask the Bot to incorporate the new evidence
   into the same section, identify what supersedes the 2.6 plan, cite source IDs, and read the page
   back. Compare with `expected.afterBatch2`. The mirrored REL-25 text is one source, not a second
   independent change. Verify both protected sections against `initial-page.md`.

For each live run, retain the thread and page links, model name, start/end times, tool/action names,
the read-back content after each batch, and a pass/fail note per expected fact outside tracked files.
Do not report an accepted or queued write as success until the page read-back confirms it.

The desktop development shell later needs Rust/Cargo and its own dependencies (`cd desktop && bun
install`), then `bun run tauri dev` from `desktop/`. It points at a development stack; signing and
installer acceptance are outside stage one. Record the OS, Bun, Docker, PostgreSQL, Rust/Cargo, model
configuration, callback origins, and chosen ports in the local run notes so another developer can
reproduce the environment without sharing credentials.
