Source ID: INV-01
Document: Compass project integration inventory
Recorded: 2026-10-14

The production import worker constructs Alder Client with `retryMode: "legacy"`. The team has not scheduled a production migration.

The search reconciliation job calls `listDocuments` with `pageSize: 100` explicitly.
