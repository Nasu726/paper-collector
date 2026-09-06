# Cloudflare deployment, shared D1, and provider setup

Authentication remains a deployment-layer concern rather than an application account system. Scholarly provider credentials/configuration remain Worker-side and must never be exposed to React.

Paper Collector and `Nasu726/book-reader` intentionally share one production D1 database. This document describes the Collector side of that arrangement.

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

The Cloudflare Vite plugin runs the frontend and Worker together. Requests under `/api/*` execute in the Workers runtime and have access to the local `DB` binding.

Although production shares the Reader's D1, Wrangler local development remains repository-local. Collector CI therefore does not require or mutate the Reader's local schema.

Useful checks:

```bash
npm run build
npm run test:openalex
npm run test:crossref
npm run test:recommendation
npm run db:smoke:local
npm run api:smoke:local
npm run api:smoke:feedback
npm run api:smoke:recommendation
npm run api:smoke:ingestion
npm run api:smoke:feed-lifecycle
npm run api:smoke:multifeed
```

## 2. Production D1: reuse book-reader

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

Collector migrations currently create Collector-owned tables only; they do not delete or rewrite Reader-owned `documents`, progress, highlights, notes, conversations, or vocabulary.

See [`SHARED_PAPER_LIBRARY.md`](SHARED_PAPER_LIBRARY.md) for schema ownership.

## 3. Apply migrations

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

The remote command uses the configured `DB` binding and writes migration history to `paper_collector_migrations`.

Do **not** run the development seed against production.

A shared D1 makes migration ownership more important than before:

- Collector migrations may modify Collector-owned tables.
- Reader migrations remain owned by the Reader repository.
- A future cross-application schema change must be explicitly coordinated rather than added casually to either side.

## 4. OpenAlex configuration

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

Development CI deliberately uses recorded OpenAlex fixtures and a local provider server instead of a live key or live provider call.

## 5. Crossref configuration

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

The limit must be between 1 and 20.

See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md) for conflict/source-selection semantics.

## 6. Scheduled ingestion and enrichment

`wrangler.jsonc` configures this Cron Trigger:

```text
17 */6 * * *
```

Cloudflare evaluates Cron schedules in UTC, so the Worker runs every six hours at minute 17.

The scheduled handler first refreshes every active Feed with a non-empty `provider_query` through OpenAlex. A newly configured Feed scans an inclusive fourteen-day window. Later successful runs overlap one day before the previous successful watermark so late provider indexing can be observed safely.

A watermark advances only after the complete provider window is fetched and persisted. Provider failures and the 500-record safety cap preserve the previous watermark.

After collection, the Worker runs a bounded Crossref enrichment batch over pending DOI-bearing Papers and rebuilds the current recommendation generation.

For local testing, Cloudflare exposes the Worker's scheduled handler through `/cdn-cgi/local/scheduled`; the ingestion smoke test uses fixture providers rather than live scholarly APIs.

See [`SCHEDULED_INGESTION.md`](SCHEDULED_INGESTION.md) for the refresh state-machine semantics.

## 7. Validate and deploy

Before deploying:

```bash
npm run build
npm run test:openalex
npm run test:crossref
npm run test:recommendation
npm run api:smoke:ingestion
```

Then apply pending Collector migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

A newly migrated shared database can legitimately have an empty Collector Inbox until at least one Feed exists and ingestion has run. Existing Reader rows remain independent.

## 8. Paper/document storage invariant

Paper Collector stores metadata and references only. In particular, canonical Paper rows may contain:

- DOI/arXiv/OpenAlex identifiers
- title/authors/abstract/publication metadata
- `source_url`
- `pdf_url`

Paper Collector does **not** store PDF bytes in D1.

The Reader already has a `DocumentStorage` boundary. Explicit uploaded/private documents can remain in Reader R2 while D1 keeps only an opaque storage reference. For Collector-discovered papers, Reader integration should normally use the canonical remote PDF/source URL instead of duplicating bytes.

## 9. Manual ingestion check

After a Feed with `provider_query` exists, the Worker can run its normal incremental refresh through:

```text
POST /api/feeds/<feed-id>/refresh
```

No request body is required. This uses the same successful-watermark logic as scheduled ingestion.

An explicit backfill window can instead be supplied:

```json
{
  "fromDate": "2026-08-24",
  "toDate": "2026-09-06"
}
```

Explicit date bounds are diagnostic/backfill input: matching papers are persisted, but the incremental successful watermark is not advanced.

## 10. Evidence inspection

For an existing Paper, inspect normalized provider evidence and the currently selected source for each field through:

```text
GET /api/papers/<paper-id>/evidence
```

This is primarily a diagnostic/research endpoint. It makes provider disagreement visible without bloating the normal Inbox bootstrap payload.

## 11. Cloudflare Access for personal deployment

Protect the complete Paper Collector hostname with one Cloudflare Access self-hosted application.

Recommended personal setup:

1. In Cloudflare Zero Trust, go to **Access controls → Applications**.
2. Create a **Self-hosted and private** application for the Paper Collector hostname.
3. Configure the application at the hostname/root path so the SPA and `/api/*` are covered by the same policy.
4. Enable **One-time PIN** if no external identity provider is desired.
5. Add an **Allow** policy for the exact personal email address.
6. Avoid broad rules such as `Everyone`.
7. Choose a practical session duration for phone use.

The SPA and same-origin API must be protected together. Cron invocations execute inside the Worker runtime and do not depend on a browser Access session.

## 12. Persistence behavior

When `/api/bootstrap` is reachable:

- feeds come from shared D1
- papers come from shared D1
- Feed membership comes from shared D1
- ingestion state/watermarks come from shared D1
- recommendation snapshots come from shared D1
- decisions come from shared D1 and are updated through the Worker API
- a localStorage decision mirror is kept only as a resilience aid

Reader-owned tables can coexist in the same physical database without becoming part of the Collector bootstrap.

If the Worker/API cannot be reached at bootstrap, the development/demo fallback uses bundled synthetic papers plus localStorage decisions. This fallback is not the production source of truth and cannot perform Feed refresh/enrichment.

## 13. Capacity policy

Sharing the database does not remove D1's per-database capacity constraint. Keep the hot relational state compact.

Canonical metadata and current state belong in D1. Append-only historical feedback, recommendation generations, and old provenance are candidates for later compaction/export to R2 under issue #59.

No production data deletion is part of the initial shared-D1 migration.
