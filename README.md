# paper-collector

A **mobile-first personal Paper Inbox** for discovering and triaging research papers.

The core idea is intentionally simple: collect papers into an Inbox, inspect the original abstract (or jump straight to the PDF), then choose **Save** or **Not interested**. Recommendation is treated as decision support, never as an automatic filter.

## Status

Early development. The mobile triage flow and Cloudflare Worker + D1 persistence are complete. Milestone 3 is now connecting real scholarly ingestion, starting with OpenAlex.

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
- OpenAlex for initial real-paper ingestion
- Cloudflare Access for personal deployment

## Development

Install dependencies and initialize the local D1 database with deterministic synthetic data:

```bash
npm install
npm run db:setup:local
npm run dev
```

The frontend loads feeds, papers, recommendation snapshots, and decisions from the same-origin Worker API. If the API is unavailable at bootstrap, development falls back to bundled synthetic papers plus localStorage decisions.

Useful validation:

```bash
npm run build
npm run test:openalex
npm run db:smoke:local
npm run api:smoke:local
```

## Real ingestion

A Feed may have a `providerQuery` in addition to its human-facing `intent`.

The Worker endpoint:

```text
POST /api/feeds/:feedId/refresh
```

queries OpenAlex for recent works, normalizes metadata, resolves strong DOI/OpenAlex identities, upserts canonical papers into D1, and attaches them to the Feed. The default window is the latest fourteen days; an explicit JSON body may provide `fromDate` and `toDate` as `YYYY-MM-DD`.

An OpenAlex API key is optional for casual development use. For real deployment, configure the free key as Worker-side configuration/secret rather than exposing it to the frontend.

The initial provider tests use recorded fixtures and never require live OpenAlex network access in CI.

## Deployment

Production deployment requires creating a real D1 database and replacing the placeholder `database_id` in `wrangler.jsonc`. Development seed data is intentionally separate from migrations and should not be loaded into production. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior and invariants
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture and ingestion boundaries
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — logical domain model
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare/D1 setup and deployment
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — development rules
