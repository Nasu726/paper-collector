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

- [ ] Cloudflare Worker API
- [ ] D1 schema and migrations
- [ ] decision repository implementation
- [ ] feed repository implementation
- [ ] deployment configuration
- [ ] Cloudflare Access deployment notes

Exit criterion: decisions and feeds persist across devices.

## Milestone 3 — Real ingestion

Goal: turn the UI prototype into a paper collector.

- [ ] choose first provider(s) based on metadata quality and coverage
- [ ] provider adapter interface
- [ ] normalized paper ingestion
- [ ] ingestion provenance
- [ ] scheduled collection
- [ ] manual refresh
- [ ] canonical identifier normalization
- [ ] initial DOI/arXiv deduplication

Exit criterion: a configured feed receives new real papers without manual data entry.

## Milestone 4 — Feed management

Goal: make multiple research interests first-class.

- [ ] create/edit/archive feeds
- [ ] natural-language intent
- [ ] exclusions
- [ ] publication-source policy
- [ ] multi-feed membership without duplicate Inbox papers

Exit criterion: at least two independent research feeds can coexist cleanly.

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
