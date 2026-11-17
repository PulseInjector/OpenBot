Source ID: INV-02
Document: Compass project deployment update
Recorded: 2026-10-30

The import worker uses `retryMode: "standard"` in staging. Production still uses `retryMode: "legacy"`; no production deployment of the change has been confirmed.

The search reconciliation job still passes `pageSize: 100` explicitly.
