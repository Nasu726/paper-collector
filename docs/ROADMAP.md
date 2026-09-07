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
- [x] bounded initial collection: current-year backfill when <=500 matches, otherwise newest 100 (#63)
- [x] count-probe failure safely falls back to newest 100 rather than unbounded history
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

## Milestone 6 — Recommendation baseline (#53)

Goal: provide useful ordering without hiding papers.

The first baseline is deliberately deterministic and lexical rather than embedding-dependent.

### Milestone 6a — Versioned lexical scorer/profile engine (#54)

- [x] normalized title + abstract lexical representation
- [x] title weighting and stop-word/basic morphology handling
- [x] explicit Save/Reject evidence dominates implicit evidence
- [x] repeated implicit interactions have capped/logarithmic influence
- [x] Feed intent and exclusions remain explicit and independent from learned state
- [x] coarse recommendation buckets and human-readable reasons
- [x] versioned recommendation snapshots in D1

### Milestone 6b — Inbox ordering and safe rebuilds (#55)

- [x] recommendation changes ordering only; it never changes eligibility
- [x] opaque rank sent to the browser instead of raw score/percentage
- [x] decision changes trigger best-effort recommendation rebuild
- [x] concurrent rebuilds use monotonic generations so stale work cannot replace newer ranking
- [x] deterministic fallback ordering and stable ties
- [x] Saved/Archive ordering remains unchanged

### Milestone 6c — Deterministic offline evaluation (#56)

- [x] network-free chronological regression fixture
- [x] intent-only baseline compared against learned `lexical-v1`
- [x] pairwise accuracy, first-positive MRR, positive/negative score gap, and eligibility recall
- [x] evaluation fails if an eligible held-out Paper is filtered
- [x] output includes model version and evidence counts
- [x] cold-start evidence-strength contract documented
- [x] lexical limitations and embedding-escalation criteria documented
- [x] current synthetic fixture improves pairwise accuracy from 0.25 to 1.00 and MRR from 0.333333 to 1.00 while recall remains 1.00

Exit criterion: recommendation buckets demonstrably improve ordering on a deterministic held-out regression fixture without reducing recall by filtering. Real-user quality remains unclaimed until enough chronological decisions exist for evaluation.

## Milestone 7 — Mobile triage refinement (#66)

Goal: improve real phone triage speed and recovery without adding invasive telemetry or dashboard complexity.

### Milestone 7a — Immediate Undo (#67, #68, #69, #70)

- [x] latest Save / Not interested action can be undone directly from Inbox
- [x] Undo target is the latest session decision and does not expire on a timer
- [x] stale Undo targets cannot delete a newer decision
- [x] decision mutations are serialized so immediate PUT -> DELETE ordering is preserved
- [x] recommendation refresh after Undo remains best-effort
- [x] deterministic Undo state/mutation-order regression test
- [x] privacy and interaction constraints documented

### Milestone 7b — Aggregate session throughput (#71)

- [ ] measure aggregate session elapsed time and decision count locally
- [ ] expose a small aggregate throughput result useful for UX tuning
- [ ] do not collect per-Paper dwell time, card-view heartbeats, scroll depth, or per-Paper timing
- [ ] do not feed throughput measurements into recommendation

### Milestone 7c — One-handed density tuning (#73)

- [ ] use measured session throughput to identify remaining card-density/reachability friction
- [ ] preserve fixed Save / Not interested controls and direct abstract/PDF access
- [ ] keep iPhone 17 (402 x 874 pt) as the primary mobile acceptance target

### Milestone 7d — PWA installability (#72)

- [ ] add web app manifest / standalone installability after the triage interaction loop stabilizes
- [ ] do not misrepresent cloud-backed state as safely offline when the Worker API is unavailable

### Deferred refinement — Saved search (#74)

Implement only when the Saved collection becomes large enough that scrolling is materially inefficient.

Exit criterion: a phone user can triage quickly, immediately recover an accidental decision, and optionally inspect aggregate session throughput without adding invasive behavioral telemetry.

## Deferred intentionally

These are not MVP requirements:

- custom translation
- social/sharing features
- mandatory notes or ratings
- full-text PDF parsing
- LLM-dependent core flow
- complex dashboards
- multi-user account system
