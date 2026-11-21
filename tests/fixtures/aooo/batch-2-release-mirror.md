Source ID: REL-25
Document: Alder Client 2.5 release notes
Published: 2026-10-28

## Compatibility

Version 2.5 removes `retryMode: "legacy"` earlier than the 2.6 plan in the 2.4 notes. `createClient` now rejects that setting with `UNSUPPORTED_RETRY_MODE`. Use `retryMode: "standard"`.

The default `listDocuments` page size remains 50. Explicit `pageSize` values are still honored.

## Other changes

The admin dashboard adds a CSV export button. This does not change the client API.
