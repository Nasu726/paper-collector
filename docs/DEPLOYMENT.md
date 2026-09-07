# Cloudflare deployment, shared D1/R2, and first-use runbook

Authentication remains a deployment-layer concern rather than an application account system. Scholarly provider credentials/configuration remain Worker-side and must never be exposed to React.

Paper Collector and `Nasu726/book-reader` intentionally share one production D1 database and one private R2 bucket. This document describes the Collector-owned part of that deployment.

## 1. Local development

Install dependencies, apply schema migrations, and seed deterministic development data:

```bash
npm install
npm run db:setup:local
npm run dev
```

`db:setup:local` performs two distinct operations:

1. applies versioned schema migrations from `migrations/`
2. loads synthetic development records from `seed/development.sql`

The seed is deliberately **not** a migration, so remote production databases are never polluted with demo papers by normal migration deployment.

The Cloudflare Vite plugin runs the frontend and Worker together. Requests under `/api/*` execute in the Workers runtime and use local simulated bindings. Although production shares the Reader's D1 and R2, normal local Collector development does not mutate those production resources.

Useful checks:

```bash
npm run build
npm run test:openalex
npm run test:crossref
npm run test:recommendation
npm run test:readiness
npm run db:smoke:local
npm run api:smoke:readiness
npm run api:smoke:local
npm run api:smoke:feedback
npm run api:smoke:recommendation
npm run api:smoke:ingestion
npm run api:smoke:feed-lifecycle
npm run api:smoke:multifeed
npm run api:smoke:paper-gc
npm run api:smoke:feedback-archive
```

## 2. Production D1: reuse `book-reader`

Do **not** create a second production D1 for Paper Collector.

`wrangler.jsonc` binds Collector's `DB` to the existing Reader database:

```text
database_name = book-reader
database_id   = c0ed3894-0dbf-4de3-b151-2bf35396d577
```

The database ID is configuration metadata rather than a password.

The two repositories deliberately keep independent migration histories inside the same physical D1:

```text
book-reader               -> d1_migrations
paper-collector           -> paper_collector_migrations
```

This prevents independently numbered migration files such as `0001_*.sql` from being mistaken for each other.

Collector migrations own Collector tables only. They must not delete or rewrite Reader-owned `documents`, progress, highlights, notes, conversations, vocabulary, or other Reader state. See [`SHARED_PAPER_LIBRARY.md`](SHARED_PAPER_LIBRARY.md) for ownership boundaries.

## 3. Production R2: reuse `book-reader-documents`

Do **not** create a separate production R2 bucket for Collector history.

`wrangler.jsonc` binds:

```text
COLD_ARCHIVE -> book-reader-documents
```

Collector owns only this key prefix:

```text
paper-collector/cold/v1/
```

Reader document/PDF objects outside that prefix are not Collector data and must never be listed, modified, or deleted by Collector archive code.

The current archive implementation moves selected raw implicit-feedback history to R2 while preserving compact recommendation evidence in D1. Archive execution is **manual only** until real production growth measurements justify an automatic retention age/cadence. Do not invent a default such as 30 days during deployment.

See [`COLD_ARCHIVE.md`](COLD_ARCHIVE.md) for verification-before-delete, idempotency, and recovery semantics.

## 4. Apply remote migrations before deploying code

Authenticate Wrangler if necessary:

```bash
npx wrangler login
```

Local schema:

```bash
npm run db:migrate:local
```

Remote production schema:

```bash
npm run db:migrate:remote
```

The remote command is `wrangler d1 migrations apply DB --remote`, uses the configured `DB` binding, and records Collector history in `paper_collector_migrations`. Wrangler rolls back a migration that fails, leaving the previous successful migration applied.

**Production ordering is migration first, Worker deploy second.** New Worker code may require a new Collector table/column immediately, so deploying code before its migration can create an avoidable outage.

Do **not** run `seed/development.sql` against production.

A shared D1 makes ownership especially important:

- Collector migrations may modify Collector-owned tables.
- Reader migrations remain owned by the Reader repository.
- A future cross-application schema change must be explicitly coordinated rather than added casually to either side.

## 5. OpenAlex configuration

Paper Collector can call OpenAlex without a key for casual development, but a free API key is recommended for real use.

Store it as a Worker-side secret/configuration value named:

```text
OPENALEX_API_KEY
```

For example:

```bash
npx wrangler secret put OPENALEX_API_KEY
```

The key is read only by the Worker when it constructs the OpenAlex provider. It must never be placed in Vite client environment variables or committed to the repository.

Development CI uses recorded OpenAlex fixtures and a local provider server rather than live provider calls.

## 6. Crossref configuration

Crossref enrichment uses single-DOI REST lookups and does not require a secret API token for the normal public/polite pools.

Set a contact email for Crossref identification:

```text
CROSSREF_MAILTO
```

Optional overrides:

```text
CROSSREF_BASE_URL
CROSSREF_MIN_INTERVAL_MS
```

`CROSSREF_BASE_URL` is primarily for tests/private proxies. `CROSSREF_MIN_INTERVAL_MS` exists mainly for deterministic tests; production should normally retain the conservative built-in sequential pacing.

Successful and not-found DOI enrichment is cached for 30 days. Failed lookups become retryable after six hours.

Manual enrichment can be triggered through:

```text
POST /api/enrichment/crossref?limit=8
```

The limit must be between 1 and 20. See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md) for conflict/source-selection semantics.

## 7. Scheduled production order

`wrangler.jsonc` configures:

```text
17 */6 * * *
```

Cloudflare evaluates Cron schedules in UTC, so the Worker runs every six hours at minute 17.

Each scheduled invocation performs these stages in order:

1. **OpenAlex ingestion** for active configured Feeds
2. **Crossref enrichment** for a bounded pending DOI batch
3. **Paper GC** for disposable Papers, preserving bounded learning state where required
4. **recommendation rebuild** for the current generation

A first automatic Feed refresh no longer uses a fixed 14-day window. It probes the current UTC year's match count:

- `<= 500` current-year matches: collect from January 1 through today, up to 500
- `> 500` matches: collect the latest 100 current-year matches
- count-probe failure: fail safe to the latest-100 policy

Later successful refreshes overlap one day before the previous watermark. Ordinary incremental collection has a 500-record safety cap; an incomplete capped refresh does not advance the watermark.

For local testing, Cloudflare exposes the scheduled handler through `/cdn-cgi/local/scheduled`; the ingestion smoke uses fixture providers rather than live scholarly APIs. See [`SCHEDULED_INGESTION.md`](SCHEDULED_INGESTION.md) for the full state machine.

## 8. Deploy

Before production deployment, run at least the build plus the local readiness and ingestion/storage coverage:

```bash
npm run build
npm run test:readiness
npm run api:smoke:readiness
npm run api:smoke:ingestion
npm run api:smoke:paper-gc
npm run api:smoke:feedback-archive
```

Then apply pending Collector migrations **before** the Worker deployment:

```bash
npm run db:migrate:remote
npm run deploy
```

CI intentionally does not deploy production automatically.

## 9. Protect the complete Worker with Cloudflare Access

For a personal deployment, prefer the current Worker-level Access control rather than maintaining a hostname-only application by hand.

In the Cloudflare dashboard:

1. Go to **Workers & Pages**.
2. Select the `paper-collector` Worker.
3. Open **Access**.
4. Select **Protect this Worker behind Access**.
5. Choose **All traffic**, not previews-only.
6. Choose or create an authentication policy that allows only the intended personal identity (for example, the exact email address).
7. Review session duration and apply the policy.

Worker-level protection covers the selected Worker's production and preview deployments, including associated routes, Custom Domains, and `workers.dev` URLs. This keeps the SPA and same-origin `/api/*` behind the same gate even if a domain is added later.

Avoid broad policies such as `Everyone`. Paper Collector does not add a second application-authentication layer and does not need to expose Access identity data through its API for normal personal use.

Cron invocations execute as Worker scheduled events and do not depend on a browser Access session.

## 10. Non-destructive readiness check

After migration and deployment, access this endpoint through an authenticated Access session:

```text
GET /api/readiness
```

A healthy response returns HTTP `200` and `ok: true`. A D1 schema/binding or R2 binding problem returns HTTP `503`.

The endpoint is deliberately read-only. It reports only bounded operational information:

- whether the Collector migration table is visible and how many migration rows exist
- whether every required Collector table exists
- Feed/Paper/decision/recommendation/feedback/compaction/archive counts
- an approximate byte total for selected Paper metadata fields
- whether `COLD_ARCHIVE` can list at most one object under `paper-collector/cold/v1/`

It does **not** return Paper titles/abstracts/authors, raw feedback records, R2 object keys, Access assertions, secrets, or Reader-owned table data. Responses use `cache-control: no-store`.

The current code expects all migrations through `0009_feedback_cold_archive.sql`. If the Worker is deployed before a required migration, readiness remains unavailable rather than pretending the partial schema is healthy.

## 11. Expected state on a new Collector deployment

A migrated shared D1 can legitimately contain Reader data while Collector itself has zero Feeds and zero Papers. In that state `/api/readiness` should still return `200`: an empty Collector dataset is not a binding/schema failure.

Before first use, confirm:

1. `/api/readiness` is `200` and reports no missing Collector tables.
2. `/api/bootstrap` succeeds. An empty Inbox is expected before the first Feed collects anything.
3. Reader functionality/data remains unaffected because Collector endpoints query Collector-owned tables only.

## 12. Create and refresh the first real Feed

Prefer the **Feeds** tab in the UI for normal first use. Configure a focused name, intent, source policy, and provider query. The provider query controls collection; the user-written intent remains separate recommendation context.

To exercise the same flow through the API, create a Feed with `POST /api/feeds`, then use the server-generated Feed ID returned by that request.

Trigger its normal first collection with:

```text
POST /api/feeds/<feed-id>/refresh
```

No request body is required. The first collection follows the current-year `<=500` / latest-100 policy described above.

After refresh:

1. confirm the Feed ingestion state reports success (or diagnose a visible error/truncation)
2. reload `/api/bootstrap` and verify Papers can appear in the Inbox
3. re-run `/api/readiness` and confirm counts remain internally plausible

An explicit diagnostic/backfill range can instead be supplied:

```json
{
  "fromDate": "2026-08-24",
  "toDate": "2026-09-06"
}
```

Explicit date bounds persist matching Papers but do not advance the normal incremental watermark.

## 13. Post-deploy smoke sequence

For the first production deployment, perform this sequence while authenticated through Access:

1. `GET /api/readiness` -> `200`, `ok=true`, no missing tables
2. `GET /api/bootstrap` -> valid payload; zero Collector rows are acceptable before Feed creation
3. create the first real Feed
4. `POST /api/feeds/<feed-id>/refresh`
5. `GET /api/bootstrap` -> Feed visible and any collected Papers visible
6. make one ordinary Inbox decision, then reload to verify persistence
7. `GET /api/readiness` again -> binding/schema status remains healthy

If readiness returns `503`, diagnose migrations/bindings before doing destructive recovery. Do not load the development seed or recreate the shared production database as a shortcut.

## 14. Collect real capacity measurements without telemetry

Issues such as #59 need observed production growth, not a guessed retention period. `/api/readiness` provides enough aggregate data to begin measuring manually without adding per-user telemetry.

At a known start time, save these readiness fields in a private note:

```text
checkedAt
papers
rawFeedback
compactFeedbackEvents
archiveBatches
estimatedPaperBytes
```

Repeat after several days of ordinary use. From the two snapshots calculate:

```text
Paper rows/day            = delta(papers) / elapsed days
Paper metadata bytes/day  = delta(estimatedPaperBytes) / elapsed days
raw feedback rows/day     = delta(rawFeedback) / elapsed days
compact events/day        = delta(compactFeedbackEvents) / elapsed days
```

If a manual feedback archive is deliberately run during the observation window, record its cutoff and the before/after archive status separately; otherwise raw-row growth and compact growth cannot be interpreted as one uninterrupted hot-storage series.

For triage throughput (#73), use the existing aggregate session display (`decisionCount` and seconds/decision) during deliberate Inbox sessions and copy the aggregate result manually. Do not add per-Paper timing events merely to collect this first evidence.

Once enough real samples exist, #59 can use them to choose whether automatic archival is needed and, if so, an evidence-based age/cadence.

## 15. Manual feedback archive remains opt-in

Inspect hot/cold aggregate status through:

```text
GET /api/storage/feedback-archive
```

Before any real archive, preview an explicit cutoff:

```text
POST /api/storage/feedback-archive
{
  "cutoffAt": "<explicit ISO timestamp>",
  "dryRun": true
}
```

Only commit after reviewing that bounded plan. There is intentionally no scheduled/default retention age yet. See [`COLD_ARCHIVE.md`](COLD_ARCHIVE.md) for the full procedure.

## 16. Paper/document storage invariant

Paper Collector stores metadata and references only. Canonical Paper rows may contain:

- DOI/arXiv/OpenAlex identifiers
- title/authors/abstract/publication metadata
- `source_url`
- `pdf_url`

Paper Collector does **not** store PDF bytes in D1.

The Reader already has a `DocumentStorage` boundary. Explicit uploaded/private documents can remain in Reader R2 while D1 keeps only an opaque storage reference. For Collector-discovered papers, Reader integration should normally use the canonical remote PDF/source URL instead of duplicating bytes.

## 17. Diagnostic evidence inspection

For an existing Paper, inspect normalized provider evidence and the currently selected source for each field through:

```text
GET /api/papers/<paper-id>/evidence
```

This endpoint is diagnostic/research tooling. It makes provider disagreement visible without bloating the normal Inbox bootstrap payload.

## 18. Persistence behavior

When `/api/bootstrap` is reachable:

- feeds come from shared D1
- papers come from shared D1
- Feed membership comes from shared D1
- ingestion state/watermarks come from shared D1
- recommendation snapshots come from shared D1
- decisions come from shared D1 and are updated through the Worker API
- a localStorage decision mirror is kept only as a resilience aid

Reader-owned tables coexist in the same physical database without becoming part of the Collector bootstrap.

If the Worker/API cannot be reached at bootstrap, the development/demo fallback uses bundled synthetic papers plus localStorage decisions. This fallback is not the production source of truth and cannot perform Feed refresh/enrichment.

## 19. Capacity policy

Sharing the database does not remove D1's per-database capacity constraint. Keep hot relational state compact.

Paper hard deletion and feedback cold archival now provide the mechanisms needed to keep bounded/append-only data under control. The remaining policy question is empirical: measure actual production growth first, then decide when/if automated feedback archival should run.

No guessed automatic retention age is part of initial production deployment.
