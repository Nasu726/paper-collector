# paper-collector

A **mobile-first personal Paper Inbox** for discovering and triaging research papers.

The core idea is intentionally simple: collect papers into an Inbox, inspect the original abstract (or jump straight to the PDF), then choose **Save** or **Not interested**. Recommendation is treated as decision support, never as an automatic filter.

## Status

Early development. The current branch focuses on the first interactive MVP vertical slice.

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

## Planned stack

- React
- TypeScript
- Vite
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Access for personal deployment

The first prototype uses local persistence so the triage UX can be validated before backend work.

## Development

```bash
npm install
npm run dev
```

Validation:

```bash
npm run typecheck
npm run build
```

## Documentation

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product behavior and invariants
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — target architecture and migration path
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — logical domain model
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone plan
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — development rules
