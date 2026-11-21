# Development Workflow

This guide covers changes to the aooo bot fork. The repository and environment setup are described
in [README.md](README.md) and [docs/configuration.md](docs/configuration.md).

Before starting a project task, read [AGENTS.md](AGENTS.md) and the stage plan it points to. That
plan holds the goals, work sequence, acceptance criteria, and completion records. Keep credentials
and personal notes in `.local/`, which Git ignores; never put them in a tracked file.

## Start a Change

Use `aooo/main` as the fork's integration baseline. It starts at the OpenBot commit selected by the
aooo bot implementation plan. Do not use the upstream `main` as the base for aooo bot work unless the
project explicitly decides to update its upstream baseline.

Integrate each plan segment on its own feature branch, created from `aooo/main`. Make each logical
change as a focused commit on that branch, in dependency order. Push the branch as work progresses.
After the segment passes its acceptance, open one pull request from that branch to `aooo/main`. Do
not merge the pull request before that acceptance.

Check the working tree before starting. When a separate branch is needed, use a short lowercase name
with a purpose prefix such as `feat/`, `fix/`, `docs/`, or `chore/`. Name the behavior or artifact, not
the phase number. Do not include agent names, generated identifiers, or temporary status words in
branch names.

## Make and Check the Change

Keep each change focused. Stage only related files. Use a commit subject in the form
`feat: describe the result`, `fix: describe the result`, `docs: describe the result`, or
`chore: describe the result`. State what changed; omit agent names, generated identifiers, and
progress notes. Never commit `.env`, local configuration, or credentials.

Run the checks relevant to the changed behavior and state exactly what ran:

- `bun run typecheck` for TypeScript changes.
- Relevant targeted tests for changed behavior; inspect the command and expected runtime before
  running a broad suite.
- Rust formatting, checks, or tests when changing `desktop/src-tauri`.
- A real model or Notion check only when that integration changes or its feature acceptance requires
  it. Identify live calls and external writes before running them.

Review the diff and working tree before committing. Keep a record of checks, skipped checks, and
known limitations for the final pull request.

## Share and Review

After a segment passes its acceptance, open the segment's pull request in `PulseInjector/aooo-bot`
with the feature branch as head and `aooo/main` as base. Use the repository's existing pull request
template. Answer the template's questions even when the answer is that nothing applies.

File issues through the repository's issue templates. A defect uses the bug report form with the
`[BUG]` prefix and the `bug` label. Plan-aligned work uses the feature request form with the
`[FEATURE]` prefix and the `enhancement` label. Fill every field, even when the answer is that
nothing applies. The repository refuses blank issues in the web UI. An issue created through the
API or the command line follows the same forms.
Address review feedback on the feature branch, and merge only after applicable checks and review are
complete.

The inherited CI workflow runs on the final pull request. Its `test:ci` step runs the root test suite
with a minimum test-count check. The desktop workflow is limited to changes under its configured
paths. Run relevant checks during development rather than waiting for the final pull request.
