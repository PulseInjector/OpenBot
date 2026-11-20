# Update the Notion work page

The Bot reads fixed source material, changes only the dedicated compatibility section of the independent Notion test page, and reads the page back. This is planned stage-one work unit 7 and requires explicit live acceptance.

## Sub-features

- `source-update`: add the required compatibility findings with source references.
- `protected-content`: preserve the project profile, owner notes, and every section outside the Bot-editable area.
- `duplicate-input`: treat the mirrored release note as one source and avoid a repeated write.
- `read-back`: verify final page content, target identity, and actual external write count.

## How to get to it (user POV)

- Open the project-tracking Bot conversation and provide the fixed batch materials plus the independent test page URL.
- Read the Bot's resulting page link and open that page to check the saved content.
- Repeat with batch 2 in the same thread and check the same page again.

## Driving it with verify-aooo

Preconditions:

- Use only the test page identified in ignored `.local/aooo-pr1-test-page.md`; never use the plan page or a production work page.
- Follow `tests/fixtures/aooo/README.md` to establish the initial page copy, real model, Notion connection, exact tool grants, callback origins, and fixed material.
- The real model and Notion connection are explicitly configured for this acceptance. The runner itself never reads `.env` and never performs the external write.

- **Check fixture inputs.** Run `bun test tests/aooo-fixtures.test.ts`. This validates frozen source references, duplicate identity, expected facts, and the protected-area boundary; it does not prove the live write.
- **Live acceptance.** Drive the conversation through the browser using the fixture README's two-batch prompts. Record the user action and the Bot run/attempt/operation references. Read the Notion page back after each batch and compare it with `case.json`; count actual page writes, not queue or test assertions.
- **Verify no collateral change.** Compare all content outside `Compatibility follow-up (Bot editable)` with `initial-page.md`, and retain the actual before/after page read-backs in the private run record. No write is successful until the page read-back confirms it.

## Gotchas

- The current local-runtime test uses fixture model/MCP boundaries and cannot be counted as a Notion result.
- If the independent page URL, model, grants, or seed state are missing, report the unmet precondition and do not substitute a local file or mock.
- A resolved tool response, queued operation, or matching operation marker alone is not proof of the final page. Read the exact target back.
- Keep URLs containing private workspace identity and all credentials out of tracked artifacts.
