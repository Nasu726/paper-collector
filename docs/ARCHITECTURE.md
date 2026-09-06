# Architecture

## 1. Goals

The architecture is optimized for a personal, mobile-first Paper Inbox. The UI should remain simple while persistence, ingestion, identity resolution, provider provenance, feedback evidence, and recommendation become progressively more capable behind stable boundaries.

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
- Cloudflare Cron Trigger for scheduled ingestion/enrichment
- localStorage only as a development/offline fallback for decision state

### Scholarly metadata
- OpenAlex as the collection/discovery provider
- Crossref as DOI/publisher metadata enrichment
- arXiv remains an optional future preprint source rather than the default published-paper source

### Deployment security
- Cloudflare Access for personal authentication

## 3. Runtime topology

```text
Browser / PWA                  Cloudflare Cron Trigger
    |                                  |
    | same-origin /api/*               | scheduled()
    v                                  v
              Worker composition entry
        /          |           |          \
       /           |           |           \
 base app      Feed lifecycle  feedback   metadata/enrichment
    |              |           |              |
    v              v           v              v
 OpenAlex <-------------------- D1 -------- Crossref
```

`worker/entry.ts` composes Feed lifecycle, feedback, metadata inspection, and enrichment endpoints around the stable base handler in `worker/index.ts`.

Static SPA assets are served by the same Worker deployment.

## 4. Frontend data boundary

```text
React UI
  ↓
Application state / use-cases
  ↓
App repository
  ├─ critical state → Worker → D1
  ├─ best-effort feedback → Worker → D1
  └─ local development fallback for decisions/demo data
```

The cloud bootstrap returns visible feeds, papers, recommendation snapshots, ingestion state, and decisions together. In deployed mode D1 is the source of truth. Bundled synthetic data exists only so frontend work remains possible when the Worker API is unavailable.

Feedback has deliberately different failure semantics from decisions. Failure to record an implicit interaction does not switch otherwise healthy decision persistence to local fallback and does not block navigation.

Provider evidence, ingestion provenance, and feedback history are not part of the normal Inbox payload. They are inspectable through bounded on-demand endpoints.

## 5. Explicit Feed configuration stays separate from learned state

A Feed has two different kinds of text:

- `intent`: the user's explicit, human-facing description of what they want to follow
- `providerQuery`: the concrete search expression sent to the collection provider

They must not be conflated. The mobile Feed editor can change both explicitly, but recommendation or learned preference state must never silently rewrite either field.

Feed lifecycle has three practical states:

- Active — visible and collected
- Paused — visible but not collected
- Archived — hidden from normal Feed management/collection while historical membership and provenance remain persisted

Normal bootstrap suppresses archived Feed IDs on Papers and omits undecided Papers that only belong to archived Feeds. Saved/Rejected Papers remain available as history.

See [`FEED_MANAGEMENT.md`](FEED_MANAGEMENT.md).

## 6. Worker API and scheduled handler

Important current endpoints include:

### App state and decisions
- `GET /api/health`
- `GET /api/bootstrap`
- `PUT /api/decisions/:paperId`
- `DELETE /api/decisions/:paperId`
- `DELETE /api/decisions`

### Feed lifecycle and collection
- `POST /api/feeds`
- `PATCH /api/feeds/:feedId`
- `POST /api/feeds/:feedId/pause`
- `POST /api/feeds/:feedId/resume`
- `POST /api/feeds/:feedId/archive`
- `POST /api/feeds/:feedId/restore`
- `GET /api/feeds/archived`
- `POST /api/feeds/:feedId/refresh`

### Provider metadata/provenance
- `POST /api/enrichment/crossref?limit=N`
- `GET /api/papers/:paperId/evidence`
- `GET /api/papers/:paperId/provenance`

### Implicit feedback
- `POST /api/feedback-events`
- `GET /api/papers/:paperId/feedback?limit=N`

The same OpenAlex refresh state machine is used by manual refresh and the Worker's `scheduled()` handler. After scheduled collection, a bounded Crossref enrichment batch runs over pending DOI-bearing Papers.

## 7. D1 schema

The schema currently contains:

- `feeds`
- `papers`
- `paper_feeds`
- `paper_identifiers`
- `ingestion_provenance`
- `feed_ingestion_state`
- `paper_field_evidence`
- `paper_field_sources`
- `crossref_enrichment_state`
- `decisions`
- `recommendation_snapshots`
- `feedback_events`

`papers.identifiers_json` remains the bootstrap-friendly representation of identifiers, while `paper_identifiers` provides normalized lookup keys for identity resolution.

`ingestion_provenance` records why a provider-created Paper belongs to a Feed. `paper_field_evidence` records what each metadata provider said about canonical fields. `paper_field_sources` records which evidence source currently controls the rendered canonical value.

`feedback_events` stores append-only raw interaction evidence. Current events leave the schema's `weight` field unset; recommendation feature weighting is a later model concern.

## 8. Incremental ingestion state machine

For a newly configured Feed, the first normal refresh scans a fourteen-day inclusive publication window.

After a successful refresh, `watermark_date` advances to the completed `toDate`. Future normal refreshes begin one day before that watermark so late provider indexing can still be observed. Canonical D1 upserts make this overlap safe.

The watermark advances only when the provider scan completes without truncation and persistence completes successfully.

Provider/persistence failure records `status=error` while preserving the previous watermark. Hitting the 500-record safety cap records `status=truncated`, persists records already received, and preserves the previous watermark.

Checkpoint updates are ordered by attempt timestamp and the watermark is monotonic, so an older overlapping run cannot move a newer checkpoint backwards.

Changing a Feed's `providerQuery` or source policy atomically clears its previous checkpoint so the next normal run receives the standard fresh lookback. Name/intent/exclusion edits preserve the checkpoint.

## 9. OpenAlex collection and normalization

The OpenAlex adapter:

- searches newest-first within a publication-date window
- uses cursor pagination
- requests at most 100 provider records per page
- caps one Feed refresh at 500 provider records
- optionally includes preprints according to Feed policy
- reconstructs `abstract_inverted_index`
- normalizes DOI and OpenAlex work identifiers
- prefers an open PDF when exposed
- derives publication state from provider evidence rather than a generic `peerReviewed` boolean

Records without enough metadata for a usable title + abstract card are skipped.

During persistence, normalized OpenAlex values are also written to `paper_field_evidence`.

## 10. Identity resolution

Current strong identity keys are:

1. normalized DOI
2. provider-specific OpenAlex work ID

A new Paper receives a DOI-based canonical ID when possible; otherwise it receives an OpenAlex-based ID. If later ingestion adds a DOI to an already known OpenAlex work, the existing canonical Paper row is retained and the DOI identifier is attached.

An identifier that already belongs to another Paper causes an explicit conflict rather than a silent merge.

Paper-to-Feed membership insertion is idempotent. Multiple Feeds can therefore discover the same DOI while the Inbox still contains one canonical Paper.

Crossref never creates Paper rows; it only enriches existing DOI-bearing Papers.

## 11. Field evidence and conflict resolution

Canonical metadata and provider evidence are deliberately separate:

```text
provider response
      ↓
normalized field evidence
      ↓
field selection policy
      ↓
canonical Paper value
```

Provider disagreement remains stored even when one value is selected.

Current `field-policy-v1` includes:

- OpenAlex remains canonical for title/authors by default.
- Crossref venue only fills an empty venue.
- publisher-deposited Crossref publication dates may become canonical when precision is not reduced.
- accepted-date publisher evidence is retained.
- publication status is monotonic: `unknown < preprint < accepted < published`.
- Crossref DOI landing URLs do not replace a better OpenAlex PDF/source choice merely because they exist.
- selected Crossref publication metadata is not silently rolled back by later OpenAlex refreshes.

See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md).

## 12. Implicit feedback boundary

Current raw event types are:

- `abstract_expanded`
- `pdf_opened`
- `source_opened`

Context surface is one of `inbox`, `saved`, or `archive`.

The client submits only Paper ID, event type, and surface. The Worker generates event ID/time and snapshots persisted Feed membership. Arbitrary client metadata is rejected.

The frontend records abstract expansion only once per displayed Inbox Paper instance. PDF/source clicks are recorded on every explicit open. Requests are best-effort and use keepalive; failure never blocks link navigation or triage.

No dwell time, scroll depth, view heartbeat, raw paper text/URLs, or browser fingerprint is collected.

See [`FEEDBACK.md`](FEEDBACK.md).

## 13. Crossref enrichment

Crossref is queried by DOI using single-work lookup. Successful/not-found lookups are cached for 30 days; failures are retryable after six hours.

Scheduled enrichment uses a small bounded batch. Requests are sequential and conservatively spaced. `CROSSREF_MAILTO` can be configured for polite-pool identification.

The adapter preserves partial date precision instead of fabricating missing month/day components.

## 14. Publication policy

Publication status and source type remain separate. The system does not store a loose `peerReviewed` boolean.

Feed policies are:

- `published_only`
- `accepted_when_verifiable`
- `include_preprints`

The collection provider normalizes evidence first, then applies Feed policy. Recommendation never changes ingestion eligibility and never hides an eligible Paper.

## 15. Testing strategy

CI does not depend on live scholarly APIs.

Recorded OpenAlex/Crossref fixtures and local mock endpoints cover provider behavior. Worker/D1 smoke tests cover:

- decision persistence
- feedback validation/context snapshots/bounded reads
- explicit-backfill and scheduled ingestion semantics
- ingestion idempotency and concurrent refresh safety
- provider evidence/conflict behavior
- Feed lifecycle/checkpoint resets
- multi-Feed canonical identity
- archive-aware bootstrap visibility and retained history

Cloudflare's local scheduled-handler route is used so CI exercises the same `scheduled()` entrypoint used by Cron Triggers.

## 16. Security and privacy

The application is initially intended for one user. Deployment should protect the complete SPA + `/api/*` surface with Cloudflare Access rather than building a multi-user account system prematurely.

Provider credentials/configuration such as `OPENALEX_API_KEY` and `CROSSREF_MAILTO` remain Worker-side and must never be exposed to React.

Feedback is private preference data. It is kept in the application's D1 database and is not sent to an LLM or third-party analytics service under the current architecture.

No paper abstract, browsing event, or feedback-derived preference data should be transmitted to an external AI service unless a future feature explicitly introduces that boundary.
