# Project instructions

OpenBot is the upstream project; this fork ("aooo bot") adds a local runtime. `README.md` and
`docs/` describe the product. `CONTRIBUTING.md` describes how to change it. Read those for
anything about how the code works.

## Where work is written

The stage plan lives in `docs/aooo/plan.md`. Read it before starting or continuing work. It holds
the goals, the work sequence, the acceptance criteria, and each unit's completion record. It is
the only copy. Do not keep a second plan anywhere.

Check records and sanitized evidence live in `docs/aooo/evidence/`. Acceptance inputs (frozen
source material, expected facts, the Notion page's initial copy) live in `tests/fixtures/aooo/`.
Those are inputs, not results; do not mix them.

Put a new document in the first directory that matches what it answers:

| A reader asking | Goes in |
| --- | --- |
| What is the plan, what is done, why this design | `docs/aooo/plan.md` |
| What is the detailed design of a unit before it is built | `docs/aooo/designs/` |
| What did a unit prove, what did it measure | `docs/aooo/evidence/` |
| What input does the acceptance case use | `tests/fixtures/aooo/` |
| How do I run, configure, or understand this project | `docs/` or `CONTRIBUTING.md` |
| Private, machine-local, or not for publication | `.local/` (not tracked) |
| Raw output: logs, database directories | `.logs/aooo/<id>/` (not tracked) |

Do not create a new top-level directory, a new README, or a second plan for work this table
already covers. If none of these rows fits, ask before creating a path.

`.local/` and `.logs/` are not tracked. This repository is public, so no credential, token,
session, personal note, or unredacted customer data goes into a tracked file.

## Unit design docs

Before a unit's implementation starts, its design doc under `docs/aooo/designs/` settles the
following points.

- The real call path, with the contract at each boundary.
- Which record is authoritative and which is a rebuildable projection.
- The state transitions for stop, timeout, and late results.
- How external schemas and tool listings are refreshed and verified, not assumed.
- What each acceptance layer proves and does not prove.
- Which existing gates the change reaches.

Keep a design doc free of incident references and counts. State the rules. The evidence for the
rules stays where it was recorded.

## Boundaries

- Do not modify frozen input under `tests/fixtures/aooo/`. Changing an input changes what the
  acceptance run proves.
- Do not write a completion record before its checks have run. Record passed, failed, and not run
  separately; a passing startup check is not acceptance.
- Run each plan segment on its own feature branch, created from `main`. Open one pull request
  per segment to `main` after the segment passes its acceptance. Do not merge the pull
  request before that acceptance.
