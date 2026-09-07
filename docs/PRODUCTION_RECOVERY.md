# Production diagnosis and rollback

Use this runbook when a first deployment or later production change fails its smoke checks. The priority is to diagnose shared bindings without making the shared `book-reader` D1 or `book-reader-documents` R2 state worse.

## 1. Start with the non-destructive check

While authenticated through Cloudflare Access, request:

```text
GET /api/readiness
```

Do not begin by seeding, recreating, deleting, or manually rewriting shared storage.

Interpret the response at the binding/schema level:

- `database.available=false`: inspect `migrationTableAvailable`, `migrationRows`, `expectedMigrations`, and `missingTables`.
- `coldArchive.available=false`: verify the `COLD_ARCHIVE` binding and the existing `book-reader-documents` bucket. Readiness itself never creates or deletes an R2 object.
- `ok=true` but product behavior is wrong: the problem is above the shared-binding readiness layer; continue with `/api/bootstrap`, Feed ingestion state, and the failing feature's diagnostic endpoint/logs.

Readiness intentionally omits raw Paper/feedback data and detailed SQL/R2 errors. Use Worker logs for server-side error detail rather than expanding the public readiness payload.

## 2. Migration failure

Collector production migrations are applied with:

```bash
npm run db:migrate:remote
```

This is `wrangler d1 migrations apply DB --remote` using the Collector-specific `paper_collector_migrations` table. Cloudflare rolls back the migration that fails while preserving previously successful migrations.

If a migration fails:

1. stop before deploying Worker code that depends on it
2. read the migration error
3. fix the migration/code on a branch
4. rerun the normal test suite locally/CI
5. apply the corrected remote migration
6. deploy only after migration success
7. confirm `/api/readiness`

Do **not** fake success by deleting/editing rows in `paper_collector_migrations`, and do not run `seed/development.sql` against production.

## 3. Worker-code rollback

If migrations are healthy but a newly deployed Worker version is bad, roll the Worker code back to a known-good deployed version.

Wrangler supports:

```bash
npx wrangler rollback
```

Without a version ID, Wrangler selects the version uploaded before the latest version interactively. A specific known-good version ID can also be supplied.

The dashboard path is:

```text
Workers & Pages -> paper-collector -> Deployments -> known-good version -> ... -> Rollback
```

A Worker rollback creates a new deployment of the selected old Worker version and makes it active across the Worker's deployed routes/domains.

### Critical storage caveat

Worker rollback does **not** roll back connected D1/R2 resources. Never assume reverting code also reverts schema or data.

Before rolling code back across a schema change, verify that the older Worker remains compatible with the already-applied Collector schema. Prefer additive/backward-compatible migrations so this remains possible. If an older version is not schema-compatible, fix forward instead of forcing an unsafe rollback.

The #83 production-readiness change itself adds no D1 migration, so rolling between its branch/main code versions does not require a schema reversal.

## 4. Shared D1 diagnosis

Paper Collector and Reader share one physical D1 but own different tables/migration histories.

If Collector readiness reports missing Collector tables or migration rows:

- inspect/apply **Collector** migrations only
- do not modify Reader's `d1_migrations`
- do not recreate the physical `book-reader` database
- do not delete Reader-owned tables to make Collector tests pass

If evidence suggests Reader-owned data itself was affected, stop Collector recovery operations and investigate the shared database as a cross-application incident rather than guessing a repair from the Collector repository.

## 5. Shared R2 diagnosis

Collector owns only:

```text
paper-collector/cold/v1/
```

within:

```text
book-reader-documents
```

If readiness cannot list the owned prefix, verify the binding/bucket configuration first. Do not probe by writing a test object to production and do not list/delete Reader document keys outside the Collector prefix.

For an interrupted feedback archive, follow [`COLD_ARCHIVE.md`](COLD_ARCHIVE.md). The archive protocol is content-addressed and verifies R2 before physically deleting represented raw feedback rows, so retry is preferred over ad-hoc cleanup.

## 6. Feature-level diagnosis after readiness succeeds

If `/api/readiness` is healthy:

1. `GET /api/bootstrap` — confirm the Worker can load Collector state.
2. Inspect the affected Feed's ingestion status/watermark if collection is failing.
3. Use `GET /api/papers/<paper-id>/evidence` only when provider-field selection is the problem.
4. Use `GET /api/storage/feedback-archive` for archive aggregate status; do not commit a new archive merely as a health probe.
5. Check Worker logs for the server-side error that the bounded public readiness response intentionally hides.

An empty Collector Inbox is not itself an outage when no Feed has successfully collected Papers yet.

## 7. Recovery completion

After any fix or rollback:

1. `GET /api/readiness` -> `200`, `ok=true`
2. `GET /api/bootstrap` -> valid payload
3. confirm the originally failing operation
4. confirm Reader behavior remains unaffected
5. record what changed if the incident affects later capacity/retention measurements

Do not enable automatic feedback retention as part of incident recovery. Issue #59 remains measurement-driven.
