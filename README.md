# paper-collector

A **mobile-first personal Paper Inbox** for discovering and triaging research papers.

The core idea is intentionally simple: collect papers into an Inbox, inspect the original abstract (or jump straight to the PDF), then choose **Save** or **Not interested**. Recommendation is treated as decision support, never as an automatic filter.

## Status

Early development. The mobile triage flow, Cloudflare Worker + D1 persistence, OpenAlex ingestion, and scheduled incremental refresh path are implemented. Crossref enrichment and Feed editing remain upcoming work.

## Product principles

- mobile-first
- Inbox-first
- original title/abstract by default
- PDF/source link available before deciding
- explicit feedback stays lightweight
- implicit feedback can enrich learning later
- recommendation ranks but does not hide papers
- explicit feed intent is separate from learned preference
- provider collection queries are separate from human-facing Feed intent
- AI is optional, not a core dependency

## Stack

- React 19
- TypeScript
- Vite
- Cloudflare Vite plugin
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Cron Triggers
- OpenAlex for initial real-paper ingestion
- Cloudflare Access for personal deployment

## Development

Install dependencies and initialize the local D1 database with deterministic synthetic data:

```bash
npm install
npm run db:setup:local
npm run dev
```

The frontend loads feeds, papers, recommendation snapshots, ingestion state, and decisions from the same-origin Worker API. If the API is unavailable at bootstrap, development falls back to bundled synthetic papers plus localStorage decisions.

Useful validation:

```bash
npm run build
npm run test:openalex
npm run db:smoke:local
npm run api:smoke:local
npm run api:smoke:ingestion
```

## Real ingestion

A Feed may have a `providerQuery` in addition to its human-facing `intent`.

The Worker endpoint:

```text
POST /api/feeds/:feedId/refresh
```

queries OpenAlex, follows cursor pagination, normalizes metadata, resolves strong DOI/OpenAlex identities, upserts canonical papers into D1, and attaches them to the Feed.

Normal manual refreshes and the scheduled Worker share the same incremental watermark logic. New Feeds start with a fourteen-day lookback; successful later runs overlap one day before the previous watermark. A provider failure or a 500-record truncation never advances the successful watermark.

Supplying explicit JSON `fromDate` and/or `toDate` values (`YYYY-MM-DD`) makes the request a backfill/diagnostic range. Papers are persisted, but the incremental watermark is not advanced.

`wrangler.jsonc` schedules active Feeds every six hours. See [`docs/SCHEDULED_INGESTION.md`](docs/SCHEDULED_INGESTION.md) for the state-machine and failure semantics.

An OpenAlex API key is optional for casual development use. For real deployment, configure the free key as Worker-side configuration/secret rather than exposing it to the frontend.

CI uses recorded fixtures and a local mock OpenAlex server; tests do not require live OpenAlex availability.

## Deployment

Production deployment requires creating a real D1 database and replacing the placeholder `database_id` in `wrangler.jsonc`. Development seed data is intentionally separate from migrations and should not be loaded into production. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior and invariants
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture and ingestion boundaries
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — logical domain model
- [`docs/SCHEDULED_INGESTION.md`](docs/SCHEDULED_INGESTION.md) — incremental refresh and Cron semantics
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare/D1 setup and deployment
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — development rules
