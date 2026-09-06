# Development Roadmap

The roadmap is ordered to validate product risk before algorithmic sophistication.

## Milestone 0 — Foundation

Goal: make the repository understandable and buildable.

- [x] product specification
- [x] architecture document
- [x] logical data model
- [x] React/TypeScript/Vite app skeleton
- [x] CI for typecheck + build
- [x] mobile-first base layout

Exit criterion: a contributor can clone the repository, run the app, and understand the product boundaries.

## Milestone 1 — Triage vertical slice

Goal: validate the core phone interaction before backend work.

- [x] demo papers
- [x] Inbox shows one decision-focused card at a time
- [x] original abstract
- [x] Open PDF / Open source
- [x] Save / Not interested
- [x] Saved view
- [x] Archive view
- [x] local persistence
- [x] decision counts / queue progress

Exit criterion: the entire triage loop works after a page reload without any backend.

## Milestone 2 — Real persistence

Goal: replace prototype persistence without changing the UX contract.

Tracked by completed parent issue #2.

### Milestone 2a — Worker/D1 foundation (#3)

- [x] Cloudflare Vite plugin integration
- [x] Cloudflare Worker API boundary
- [x] initial D1 schema/migration
- [x] decision repository abstraction
- [x] D1-backed decision bootstrap/upsert/delete/reset endpoints
- [x] localStorage mirror/fallback
- [x] deployment configuration and setup documentation
- [x] CI verified after merge candidate is opened

### Milestone 2b — Complete cloud persistence (#4)

- [x] deterministic local D1 seed for development
- [x] feeds loaded from D1
- [x] papers loaded from D1
- [x] feed membership loaded from D1
- [x] recommendation snapshots loaded from D1
- [x] deployed mode no longer depends on bundled demo data
- [x] decision writes are D1-backed for cross-device use
- [x] Cloudflare Access setup documented for the personal deployment model
- [x] CI verifies build, local D1 setup, and Worker decision round-trip

Exit criterion: decisions and the feed/paper data required by the current UI persist through the Worker/D1 path; bundled demo data is only a fallback when the API is unavailable.

## Milestone 3 — Real ingestion (#7)

Goal: turn the UI prototype into a paper collector.

### Milestone 3a — OpenAlex ingestion vertical slice (#8)

- [x] choose OpenAlex as the first provider
- [x] provider adapter interface
- [x] reconstruct and normalize OpenAlex abstracts
- [x] normalize DOI and OpenAlex identifiers
- [x] normalized paper ingestion into D1
- [x] ingestion provenance
- [x] canonical DOI/provider identity upsert
- [x] multi-feed membership without duplicate Paper rows
- [x] explicit provider query kept separate from user-facing Feed intent
- [x] manual Worker refresh endpoint
- [x] recorded provider fixture test without live network dependency
- [x] merge-candidate CI verified, including fixture-backed Worker ingestion and idempotent repeat refresh

### Milestone 3b — Identity and Crossref enrichment (#9)

- [ ] Crossref DOI enrichment adapter
- [ ] accepted/publication date evidence when publisher metadata provides it
- [ ] field provenance / source-conflict policy
- [ ] multi-provider identity regression fixtures
- [ ] stronger duplicate handling for updated/cross-listed records

### Milestone 3c — Scheduled collection and refresh UX (#10)

- [ ] per-feed successful ingestion watermark
- [ ] incremental retry-safe refresh windows
- [ ] Cloudflare scheduled Worker / Cron Trigger
- [ ] manual refresh action in the Feed UI
- [ ] last-success / last-error state
- [ ] initial lookback policy for new feeds

Exit criterion: a configured feed receives new real papers without manual database entry and continues to refresh safely over time.

## Milestone 4 — Feed management

Goal: make multiple research interests first-class.

- [ ] create/edit/archive feeds
- [ ] natural-language intent
- [ ] explicit provider query configuration
- [ ] exclusions
- [ ] publication-source policy
- [ ] multi-feed membership without duplicate Inbox papers

Exit criterion: at least two independent research feeds can coexist cleanly and their collection queries can be adjusted without mutating learned preference state.

## Milestone 5 — Feedback instrumentation

Goal: collect useful preference evidence without increasing input burden.

- [ ] feedback event schema
- [ ] PDF/source open events
- [ ] abstract expansion event
- [ ] Saved re-open event
- [ ] privacy review of event collection
- [ ] event confidence policy

Exit criterion: recommendation experiments can be evaluated from actual usage data.

## Milestone 6 — Recommendation baseline

Goal: provide useful ordering without hiding papers.

Start simple. Candidate baseline:

- text embeddings for title + abstract
- per-feed positive/negative examples
- kNN or logistic regression style scorer
- coarse recommendation bucket
- explanation derived from matched topics/examples

Requirements:

- no automatic filtering
- explicit feed intent remains independent
- model version stored with scores/decisions
- cold-start behavior documented

Exit criterion: recommendation buckets demonstrably improve ordering on held-out decisions without reducing recall by filtering.

## Milestone 7 — Product refinement

- measure seconds per paper
- tune card density
- improve one-handed interaction
- add undo where useful
- consider PWA installation
- saved-paper search if the Saved list becomes large

## Deferred intentionally

These are not MVP requirements:

- custom translation
- social/sharing features
- mandatory notes or ratings
- full-text PDF parsing
- LLM-dependent core flow
- complex dashboards
- multi-user account system
