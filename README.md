# paper-collector

A **mobile-first personal Paper Inbox** for discovering and triaging research papers.

The core idea is intentionally simple: collect papers into an Inbox, inspect the original abstract (or jump straight to the PDF), then choose **Save** or **Not interested**. Recommendation is treated as decision support, never as an automatic filter.

## Status

Early development. Milestone 1 (the triage UI vertical slice) is complete. Milestone 2 now has a Cloudflare Worker + D1 path for feeds, papers, recommendations, and decisions; the next major milestone is real paper ingestion.

## Product principles

- mobile-first
- Inbox-first
- original title/abstract by default
- PDF/source link available before deciding
- explicit feedback stays lightweight
- implicit feedback can enrich learning later
- recommendation ranks but does not hide papers
- explicit feed intent is separate from learned preference
- AI is optional, not a core dependency

## Stack

- React 19
- TypeScript
- Vite
- Cloudflare Vite plugin
- Cloudflare Workers
- Cloudflare D1
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
npm run typecheck
npm run build
npm run db:smoke:local
```

Production deployment requires creating a real D1 database and replacing the placeholder `database_id` in `wrangler.jsonc`. Development seed data is intentionally separate from migrations and should not be loaded into production. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior and invariants
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture and migration path
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — logical domain model
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare/D1 setup and deployment
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — development rules
