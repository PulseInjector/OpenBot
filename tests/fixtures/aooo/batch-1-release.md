Source ID: REL-24
Document: Alder Client 2.4 release notes
Published: 2026-10-12

## Compatibility

`createClient({ retryMode: "legacy" })` still works in 2.4, but `legacy` is deprecated. The planned removal is version 2.6. New integrations should use `retryMode: "standard"`.

The default `listDocuments` page size changes from 100 to 50 in 2.4. Calls that set `pageSize` explicitly keep their requested size.

## Other changes

The admin dashboard has a new color theme. This does not change the client API.
