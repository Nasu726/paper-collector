# Architecture

## 1. Goals

The architecture is optimized for a personal, mobile-first Paper Inbox. The UI should remain simple while persistence, ingestion, identity resolution, provider provenance, and recommendation become progressively more capable behind stable boundaries.

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
                 /                 \
                /                   \
      base app/ingestion        enrichment API
             |                       |
             v                       v
      OpenAlex + D1            Crossref + D1
```

`worker/entry.ts` composes enrichment-specific endpoints and scheduled post-processing around the stable base handler in `worker/index.ts`.

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

Provider evidence is not part of the normal Inbox payload. It is inspectable on demand through a dedicated evidence endpoint.

## 5. Feed intent and collection query are separate

A Feed has two different kinds of text:

- `intent`: the user's explicit, human-facing description of what they want to follow
- `providerQuery`: the concrete search expression sent to the collection provider

They must not be conflated. Provider syntax may change, and future learned preferences must not silently rewrite the user's explicit research intent.

Milestone 4 will expose editing for these fields.

## 6. Worker API and scheduled handler

Current endpoints:

- `GET /api/health` — verifies Worker/D1 reachability
- `GET /api/bootstrap` — returns feeds, papers, recommendation snapshots, ingestion state, and decisions
- `POST /api/feeds/:feedId/refresh` — runs one OpenAlex Feed refresh
- `POST /api/enrichment/crossref?limit=N` — enriches a bounded batch of DOI-bearing Papers
- `GET /api/papers/:paperId/evidence` — returns normalized provider evidence and selected canonical sources
- `PUT /api/decisions/:paperId` — creates or replaces one explicit decision
- `DELETE /api/decisions/:paperId` — returns a paper to Inbox
- `DELETE /api/decisions` — resets decisions for development/demo use

The same OpenAlex refresh state machine is used by the HTTP endpoint and scheduled handler. After scheduled collection, a bounded Crossref enrichment batch runs over pending DOI-bearing Papers.

A normal Feed refresh is incremental. A request that explicitly supplies `fromDate` or `toDate` is treated as a backfill/diagnostic range and does not advance the incremental watermark.

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

`ingestion_provenance` records why a provider-created paper belongs to a Feed. `paper_field_evidence` serves a different purpose: it records what each metadata provider said about a canonical field. `paper_field_sources` records which evidence source currently controls the rendered canonical value.

`feed_ingestion_state` stores the last attempt, last successful refresh, successful date watermark, status, provider-page count, fetched-record count, and error/truncation diagnostic.

`crossref_enrichment_state` stores cache/retry state for DOI enrichment.

## 8. Incremental ingestion state machine

For a newly configured Feed, the first normal refresh scans a fourteen-day inclusive publication window.

After a successful refresh, `watermark_date` is advanced to the completed `toDate`. Future normal refreshes begin one day before that watermark so late provider indexing can still be observed. Canonical D1 upserts make this overlap safe.

The watermark advances only when the provider scan completes without truncation and persistence completes successfully.

Provider or persistence failure records `status=error` while preserving the previous watermark. Hitting the 500-record safety cap records `status=truncated`, persists the records already received, and also preserves the previous watermark.

Checkpoint updates are ordered by attempt timestamp, and the watermark itself is monotonic. An older overlapping run therefore cannot move a newer checkpoint backwards.

## 9. OpenAlex collection and normalization

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

During persistence, normalized OpenAlex values are also written to `paper_field_evidence`.

## 10. Identity resolution

Identity resolution is a first-class subsystem.

Current strong keys:

1. normalized DOI
2. provider-specific OpenAlex work ID

A new Paper receives a DOI-based canonical ID when possible; otherwise it receives an OpenAlex-based ID. If later ingestion adds a DOI to an already known OpenAlex work, the existing canonical Paper row is retained and the DOI identifier is attached to it.

An identifier that already belongs to a different Paper causes an explicit conflict instead of a silent merge.

Paper-to-Feed membership uses an idempotent insert so overlapping refreshes cannot fail merely because both runs discover the same membership.

Crossref does not create Paper rows. It only enriches Papers that already have a normalized DOI, so it cannot create a second DOI-identical canonical Paper through an independent ingestion path.

## 11. Field evidence and conflict resolution

Canonical metadata and provider evidence are deliberately separate.

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

Current `field-policy-v1` rules include:

- OpenAlex remains canonical for title/authors by default.
- Crossref `container-title` only fills an empty venue.
- publisher-deposited Crossref publication dates may become canonical when they do not reduce date precision.
- Crossref accepted dates are stored as accepted-date evidence/canonical database metadata.
- publication status is monotonic: `unknown < preprint < accepted < published`.
- Crossref source URLs do not replace an OpenAlex open-PDF/source choice merely because a DOI landing page exists.
- once Crossref is selected for publication date, venue, or publication status, a later OpenAlex refresh does not silently overwrite that selected value.

See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md).

## 12. Crossref enrichment

Crossref is queried by DOI using single-work lookup. Successful and not-found lookups are cached for 30 days; failed lookups are retryable after six hours.

Scheduled enrichment uses a small bounded batch. Requests are sequential and conservatively spaced. `CROSSREF_MAILTO` can be configured for polite-pool identification.

The Crossref adapter preserves partial date precision instead of fabricating month/day components. Publication date preference is:

1. `published-online`
2. `published-print`
3. `published`
4. `issued`

Every normalized value is recorded as evidence before canonical selection is considered.

## 13. Publication policy

Publication status and source type remain separate. The system does not store a loose `peerReviewed` boolean.

Feed policies are:

- `published_only`
- `accepted_when_verifiable`
- `include_preprints`

The collection provider normalizes evidence first, then applies the Feed policy. Crossref enrichment can strengthen publication metadata after collection but recommendation never changes ingestion eligibility and never hides an eligible paper.

## 14. Testing strategy

CI must not depend on live scholarly APIs.

OpenAlex and Crossref tests use recorded JSON fixtures and mock `fetch` implementations.

The Worker E2E uses local mock scholarly endpoints plus D1 to verify:

- explicit backfill does not advance the watermark
- repeated ingestion is idempotent
- local scheduled invocation advances watermarks
- OpenAlex/Crossref disagreements remain inspectable
- selected Crossref publication metadata survives later OpenAlex refreshes
- Crossref cache state prevents repeated immediate DOI calls
- overlapping refreshes do not duplicate canonical Papers or Feed memberships
- provider failure leaves the successful watermark intact

Cloudflare exposes the local scheduled handler through `/cdn-cgi/local/scheduled`, so CI exercises the same `scheduled()` entrypoint used by Cron Triggers.

## 15. Security and privacy

The application is initially intended for one user. Deployment should prefer Cloudflare Access in front of the complete SPA + `/api/*` surface rather than building an account system prematurely.

Provider credentials/configuration such as `OPENALEX_API_KEY` and `CROSSREF_MAILTO` remain Worker-side and must never be exposed to React.

No paper abstract or browsing event should be sent to an LLM unless a future AI feature explicitly requires it.
