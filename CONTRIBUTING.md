# Development Workflow

This guide covers changes to the aooo bot fork. The repository and environment setup are described
in [README.md](README.md) and [docs/configuration.md](docs/configuration.md).

Before starting a project task, read `.local/project-context.md` if it exists. It points to private
planning material and local working conventions; keep its links and any credentials out of tracked
repository files.

## Start a Change

Use `aooo/main` as the fork's integration baseline. It starts at the OpenBot commit selected by the
aooo bot implementation plan. Do not use the upstream `main` as the base for aooo bot work unless the
project explicitly decides to update its upstream baseline.

Stage one is integrated on `feat/local-bot-workbench`, created from `aooo/main`. Create each stage-one
change branch from the current tip of `feat/local-bot-workbench` and target that branch in its pull
request. Merge the internal pull requests in dependency order. After the complete local Bot workbench
passes stage-one acceptance, open the final pull request from `feat/local-bot-workbench` to
`aooo/main`. Do not merge stage-one work directly into `aooo/main` before that acceptance.

Check the working tree before starting. Use one branch per logical change, with a short lowercase
name and a purpose prefix such as `feat/`, `fix/`, `docs/`, or `chore/`. Name the behavior or artifact,
not the phase number. Do not include agent names, generated identifiers, or temporary status words in
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

Review the diff and working tree before committing. Record skipped checks and known limitations in
the pull request description.

## Share and Review

Push the change branch and open a pull request in `PulseInjector/OpenBot` with the base described
above: `feat/local-bot-workbench` for internal stage-one changes, then `aooo/main` for the accepted
workbench. Use the repository's existing pull request template. Keep each pull request focused on one
logical change, address review feedback on the same branch, and merge only after applicable checks
and review are complete.

The inherited CI workflow runs on every pull request, including documentation-only changes. Its
`test:ci` step runs the root test suite with a minimum test-count check. The desktop workflow is
limited to changes under its configured paths. Local targeted checks do not prevent GitHub Actions
from running the inherited CI workflow.
