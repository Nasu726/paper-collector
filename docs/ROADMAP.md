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

- [x] Crossref DOI enrichment adapter
- [x] accepted/publication date evidence when publisher metadata provides it
- [x] field provenance and explicit canonical source selection
- [x] deterministic source-conflict policy
- [x] multi-provider disagreement regression fixture
- [x] Crossref cache/retry state and conservative request pacing
- [x] later OpenAlex refreshes cannot overwrite selected Crossref publication metadata
- [x] evidence inspection API

### Milestone 3c — Scheduled collection and refresh UX (#10)

- [x] per-feed successful ingestion watermark
- [x] incremental retry-safe refresh windows with a one-day overlap
- [x] OpenAlex cursor pagination
- [x] explicit 500-record truncation cap that does not advance the watermark
- [x] monotonic checkpoint behavior for overlapping runs
- [x] Cloudflare scheduled Worker / Cron Trigger
- [x] manual refresh action in the Feed UI
- [x] last-success / last-error state
- [x] 14-day initial lookback policy for new feeds
- [x] fixture-backed CI coverage for scheduled execution and failure-preserving watermarks

Exit criterion: a configured feed receives new real papers without manual database entry, enriches DOI metadata without losing provider disagreement, and continues to refresh safely over time.

## Milestone 4 — Feed management (#14)

Goal: make multiple research interests first-class.

### Milestone 4a — Feed lifecycle API (#15)

- [x] create/edit Feed API with bounded validation
- [x] server-generated stable Feed IDs
- [x] pause/resume
- [x] archive/restore without deleting history
- [x] archived Feed recovery endpoint
- [x] intent and provider query remain independent
- [x] query/source-policy changes reset collection checkpoint
- [x] name/intent/exclusion changes preserve collection checkpoint
- [x] configuration update and checkpoint reset are atomic

### Milestone 4b — Mobile Feed editor (#16)

- [x] create Feed from the Feeds tab
- [x] edit natural-language research intent
- [x] edit explicit provider query independently
- [x] edit exclusions
- [x] edit publication-source policy
- [x] pause/resume controls
- [x] two-step archive action
- [x] archived Feed restore UI
- [x] inline API errors and fresh-lookback warning
- [x] no dashboard introduced

### Milestone 4c — Multi-Feed lifecycle invariants (#17)

- [x] same DOI may belong to multiple Feeds while remaining one canonical Paper
- [x] ingestion provenance remains inspectable per Feed
- [x] decisions survive Feed edits/archive
- [x] archived and paused Feeds are excluded from scheduled collection
- [x] restore returns paused; explicit resume re-enables collection
- [x] editing one Feed does not mutate another Feed
- [x] deterministic CI regression covers the full lifecycle
- [x] archived-only undecided Papers are hidden from normal bootstrap while decided history is retained (#26)

Exit criterion: at least two independent research feeds coexist cleanly, share canonical Papers without duplicate Inbox records, can be configured from the mobile UI, and preserve history across pause/archive/configuration transitions.

## Milestone 5 — Feedback instrumentation (#29)

Goal: collect useful preference evidence without increasing input burden.

### Milestone 5a — Append-only feedback API (#30)

- [x] validated raw feedback event API
- [x] `abstract_expanded`, `pdf_opened`, `source_opened` event taxonomy
- [x] `inbox`, `saved`, `archive` surface context
- [x] server-generated event ID and timestamp
- [x] server-owned Paper-to-Feed membership snapshot
- [x] arbitrary client metadata rejected
- [x] raw event weights remain unset; weighting belongs to ranking
- [x] bounded newest-first Paper feedback inspection API
- [x] deterministic Worker/D1 smoke coverage

### Milestone 5b — Mobile interaction instrumentation (#31)

- [x] first abstract expansion per displayed Inbox Paper instance
- [x] PDF open events
- [x] source-page open events
- [x] Saved reopen context represented by open events with `surface=saved`
- [x] Archive interaction context represented by `surface=archive`
- [x] keepalive/best-effort delivery for external-link clicks
- [x] feedback failure does not change decision persistence mode or block navigation
- [x] no time-on-card, view heartbeat, scroll-depth, or fingerprint collection

### Milestone 5c — Confidence and privacy policy (#32)

- [x] qualitative signal-strength ordering documented
- [x] raw evidence separated from model-derived/versioned weights
- [x] repetition must be regularized rather than grow unbounded
- [x] privacy-minimization rules documented
- [x] current retention assumptions documented
- [x] AI/third-party transmission is outside the current feedback contract

Exit criterion: actual usage produces structured, inspectable implicit evidence that can be consumed by recommendation experiments while the core triage flow remains unchanged and feedback failures remain non-blocking.

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
