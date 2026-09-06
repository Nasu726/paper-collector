# paper-collector

A **mobile-first personal Paper Inbox** for discovering and triaging research papers.

The core idea is intentionally simple: collect papers into an Inbox, inspect the abstract (or jump straight to the PDF), then choose **Save** or **Not interested**. Recommendation is treated as decision support, never as an automatic filter.

## Status

Active development. The mobile triage flow, Cloudflare persistence, scheduled OpenAlex ingestion, DOI-based Crossref enrichment, provider field provenance, Feed management, privacy-minimized implicit feedback, and the deterministic `lexical-v1` recommendation baseline are implemented.

Paper Collector and [`Nasu726/book-reader`](https://github.com/Nasu726/book-reader) now intentionally target one shared physical D1 as a **Paper Library**. Collector owns canonical scholarly-paper metadata and its operational tables; Reader keeps reading-specific state and can link a Reader document to a canonical Paper without duplicating scholarly metadata.

## Product principles

- mobile-first
- Inbox-first
- title/abstract in their source language by default
- PDF/source link available before deciding
- explicit feedback stays lightweight
- implicit feedback is supporting evidence, not ground truth
- recommendation ranks but does not hide papers
- explicit Feed intent is separate from learned preference
- provider collection queries are separate from human-facing Feed intent
- provider disagreements are retained rather than silently discarded
- PDF bytes are not stored by Paper Collector
- AI is optional, not a core dependency

## Stack

- React 19
- TypeScript
- Vite
- Cloudflare Vite plugin
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Cron Triggers
- OpenAlex for paper discovery and collection
- Crossref for DOI/publisher metadata enrichment
- Cloudflare Access for personal deployment

## Development

Install dependencies and initialize the local D1 database with deterministic synthetic data:

```bash
npm install
npm run db:setup:local
npm run dev
```

The frontend loads feeds, papers, recommendation snapshots, ingestion state, and decisions from the same-origin Worker API. If the API is unavailable at bootstrap, development falls back to bundled synthetic papers plus localStorage decisions.

`--local` D1 state is repository-local. Development and CI therefore remain isolated even though production shares the Reader's physical D1 database.

Useful validation:

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

## Real ingestion

A Feed has a human-facing `intent` and a separate `providerQuery` used for scholarly search. The mobile Feeds screen can create, edit, pause, resume, archive, restore, and manually refresh these configurations without touching D1 directly.

The Worker endpoint:

```text
POST /api/feeds/:feedId/refresh
```

queries OpenAlex, follows cursor pagination, normalizes metadata, resolves strong DOI/OpenAlex identities, upserts canonical papers into D1, and attaches them to the Feed.

Normal manual refreshes and the scheduled Worker share the same incremental watermark logic. New Feeds start with a fourteen-day lookback; successful later runs overlap one day before the previous watermark. A provider failure or a 500-record truncation never advances the successful watermark.

Supplying explicit JSON `fromDate` and/or `toDate` values (`YYYY-MM-DD`) makes the request a backfill/diagnostic range. Papers are persisted, but the incremental watermark is not advanced.

Changing only a Feed's human-facing name, intent, or exclusions preserves the ingestion checkpoint. Changing the collection query or source policy atomically updates configuration and resets the checkpoint so the next normal refresh starts a fresh fourteen-day lookback.

`wrangler.jsonc` schedules active Feeds every six hours. Archived and paused Feeds are not scheduled. After OpenAlex ingestion, the scheduled Worker runs a bounded Crossref enrichment batch for DOI-bearing papers. Crossref evidence is stored separately from the canonical field-selection decision so disagreements remain inspectable.

See [`docs/SCHEDULED_INGESTION.md`](docs/SCHEDULED_INGESTION.md), [`docs/CROSSREF_ENRICHMENT.md`](docs/CROSSREF_ENRICHMENT.md), and [`docs/FEED_MANAGEMENT.md`](docs/FEED_MANAGEMENT.md).

CI uses recorded fixtures and local mock scholarly APIs; tests do not require live OpenAlex or Crossref availability.

## Implicit feedback

The core explicit judgment remains Save / Not Interested. The app additionally records a small set of actions the user already performs:

- expanding the complete abstract
- opening the PDF
- opening the source page

Each event records whether it happened from Inbox, Saved, or Archive. Raw events do not contain a permanent recommendation weight; versioned recommendation logic decides how to interpret them.

Feedback collection is best-effort. A logging failure never blocks PDF/source navigation or downgrades otherwise healthy decision persistence.

The feedback API rejects arbitrary client metadata, raw paper text/URLs, and client-supplied Feed IDs. No dwell-time, scrolling, view heartbeat, or browser fingerprint is collected.

See [`docs/FEEDBACK.md`](docs/FEEDBACK.md).

## Shared Paper Library

Production Paper Collector binds to the existing `book-reader` D1 database. Collector migrations use the independent `paper_collector_migrations` tracking table, so Reader and Collector can keep separate migration files safely.

Paper Collector stores canonical paper metadata, identifiers, URLs, preference state, ingestion state, and current recommendation state. It does **not** copy PDF bytes. Reader may keep explicit uploaded/private document bytes in its existing R2 storage and can later link Reader documents to canonical `papers.id`.

See [`docs/SHARED_PAPER_LIBRARY.md`](docs/SHARED_PAPER_LIBRARY.md).

## Deployment

The production D1 binding in `wrangler.jsonc` points to the existing `book-reader` database. Do not create a second Paper Collector production D1. Apply Collector migrations through its own migration tracking table, and never load development seed data into production.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior and invariants
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current runtime/data boundaries
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — logical domain model
- [`docs/SHARED_PAPER_LIBRARY.md`](docs/SHARED_PAPER_LIBRARY.md) — shared D1 ownership and Reader integration boundary
- [`docs/SCHEDULED_INGESTION.md`](docs/SCHEDULED_INGESTION.md) — incremental refresh and Cron semantics
- [`docs/CROSSREF_ENRICHMENT.md`](docs/CROSSREF_ENRICHMENT.md) — field evidence and Crossref conflict policy
- [`docs/FEED_MANAGEMENT.md`](docs/FEED_MANAGEMENT.md) — Feed lifecycle and checkpoint semantics
- [`docs/FEEDBACK.md`](docs/FEEDBACK.md) — implicit evidence confidence and privacy policy
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare/D1 setup and deployment
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — development rules
