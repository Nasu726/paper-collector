# Architecture

## 1. Goals

The architecture is optimized for a personal, mobile-first Paper Inbox. The UI should remain simple while persistence, ingestion, identity resolution, and recommendation become progressively more capable behind stable boundaries.

## 2. Current stack

### Frontend
- React
- TypeScript
- Vite
- responsive CSS with no component-library dependency

### Runtime / persistence
- Cloudflare Vite plugin
- Cloudflare Worker API
- Cloudflare D1
- Cloudflare Cron Trigger for scheduled ingestion
- localStorage only as a development/offline fallback for decision state

### Ingestion
- provider-neutral adapter boundary
- OpenAlex as the first real provider
- Crossref planned for DOI/publisher metadata enrichment
- arXiv planned as an optional preprint source rather than the default published-paper source

### Deployment security
- Cloudflare Access for personal authentication

## 3. Runtime topology

```text
Browser / PWA                  Cloudflare Cron Trigger
    |                                  |
    | same-origin /api/*               | scheduled()
    v                                  v
                 Cloudflare Worker
                    |            \
                    |             \ provider adapter
                    v              v
              Cloudflare D1      OpenAlex
```

Static SPA assets are served by the same Worker deployment.

## 4. Frontend data boundary

```text
React UI
  ↓
Application state / use-cases
  ↓
App repository
  ├─ API adapter → Worker → D1
  └─ local development fallback
```

The cloud bootstrap returns feeds, papers, recommendation snapshots, ingestion state, and decisions together. In deployed mode D1 is the source of truth. Bundled synthetic data exists only so frontend work remains possible when the Worker API is unavailable.

## 5. Feed intent and collection query are separate

A Feed has two different kinds of text:

- `intent`: the user's explicit, human-facing description of what they want to follow
- `providerQuery`: the concrete search expression sent to the collection provider

They must not be conflated. Provider syntax may change, and future learned preferences must not silently rewrite the user's explicit research intent.

Milestone 4 will expose editing for these fields. Milestone 3 uses deterministic development queries to prove the ingestion path.

## 6. Worker API and scheduled handler

Current endpoints:

- `GET /api/health` — verifies Worker/D1 reachability
- `GET /api/bootstrap` — returns feeds, papers, recommendation snapshots, ingestion state, and decisions
- `POST /api/feeds/:feedId/refresh` — runs one Feed refresh
- `PUT /api/decisions/:paperId` — creates or replaces one explicit decision
- `DELETE /api/decisions/:paperId` — returns a paper to Inbox
- `DELETE /api/decisions` — resets decisions for development/demo use

The same refresh state machine is used by the HTTP endpoint and the Worker's `scheduled()` handler.

A normal refresh is incremental. A request that explicitly supplies `fromDate` or `toDate` is treated as a backfill/diagnostic range and does not advance the incremental watermark.

## 7. D1 schema

The schema currently contains:

- `feeds`
- `papers`
- `paper_feeds`
- `paper_identifiers`
- `ingestion_provenance`
- `feed_ingestion_state`
- `decisions`
- `recommendation_snapshots`
- `feedback_events`

`papers.identifiers_json` remains the bootstrap-friendly representation of identifiers, while `paper_identifiers` provides normalized lookup keys for identity resolution.

`ingestion_provenance` records which provider record caused a paper/feed association, the provider query, provider update timestamp when available, and first/last seen timestamps.

`feed_ingestion_state` stores the last attempt, last successful refresh, successful date watermark, status, provider-page count, fetched-record count, and error/truncation diagnostic.

## 8. Incremental ingestion state machine

For a newly configured Feed, the first normal refresh scans a fourteen-day inclusive publication window.

After a successful refresh, `watermark_date` is advanced to the completed `toDate`. Future normal refreshes begin one day before that watermark so late provider indexing can still be observed. Canonical D1 upserts make this overlap safe.

The watermark advances only when the provider scan completes without truncation and persistence completes successfully.

Provider or persistence failure records `status=error` while preserving the previous watermark. Hitting the 500-record safety cap records `status=truncated`, persists the records already received, and also preserves the previous watermark.

Checkpoint updates are ordered by attempt timestamp, and the watermark itself is monotonic. An older overlapping run therefore cannot move a newer checkpoint backwards.

## 9. OpenAlex pagination and normalization

The OpenAlex adapter:

- searches newest-first within a publication-date window
- starts cursor pagination with `cursor=*`
- follows `meta.next_cursor`
- requests at most 100 provider records per page
- caps one Feed refresh at 500 provider records
- requests article records, optionally including preprints according to Feed policy
- reconstructs `abstract_inverted_index` into original abstract text
- normalizes DOI values to lowercase bare DOI form
- normalizes OpenAlex work IDs to `W...`
- chooses the publisher/source landing page when available
- prefers an open PDF URL when OpenAlex exposes one
- derives `published`, `accepted`, or `preprint` only from provider evidence rather than a generic `peerReviewed` boolean

Records without enough metadata for a usable title + abstract card are skipped.

## 10. Identity resolution and concurrency

Identity resolution is a first-class subsystem.

Current strong keys:

1. normalized DOI
2. provider-specific OpenAlex work ID

A new paper receives a DOI-based canonical ID when possible; otherwise it receives an OpenAlex-based ID. If a later ingestion adds a DOI to an already known OpenAlex work, the existing canonical Paper row is kept and the DOI identifier is attached to it.

An identifier that already belongs to a different Paper causes an explicit conflict instead of a silent merge.

Paper-to-Feed membership uses an idempotent insert so overlapping refreshes cannot fail merely because both runs discover the same membership.

Crossref enrichment and more complete multi-provider conflict policy are tracked in #9.

## 11. Publication policy

Publication status and source type remain separate. The system does not store a loose `peerReviewed` boolean.

Feed policies are:

- `published_only`
- `accepted_when_verifiable`
- `include_preprints`

The provider normalizes evidence first, then applies the Feed policy. Recommendation never changes ingestion eligibility and never hides an eligible paper.

## 12. Testing strategy

CI must not depend on live scholarly APIs.

OpenAlex tests use recorded JSON fixtures and mock `fetch` implementations to verify:

- query construction
- cursor pagination
- truncation behavior
- abstract reconstruction
- DOI/OpenAlex ID normalization
- PDF/source selection
- publication policy behavior

The Worker smoke test runs against a local mock OpenAlex endpoint and D1 to verify:

- explicit backfill does not advance the watermark
- repeated ingestion is idempotent
- local scheduled invocation advances watermarks
- a provider failure leaves the successful watermark intact

Cloudflare exposes the local scheduled handler through `/cdn-cgi/local/scheduled`, so CI exercises the same `scheduled()` entrypoint used by Cron Triggers.

## 13. Security and privacy

The application is initially intended for one user. Deployment should prefer Cloudflare Access in front of the complete SPA + `/api/*` surface rather than building an account system prematurely.

`OPENALEX_API_KEY`, when configured, is a Worker-side secret/config value and must never be exposed to React.

No paper abstract or browsing event should be sent to an LLM unless a future AI feature explicitly requires it.
