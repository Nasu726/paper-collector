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
- localStorage only as a development/offline fallback for decision state

### Ingestion
- provider-neutral adapter boundary
- OpenAlex as the first real provider
- Crossref planned for DOI/publisher metadata enrichment
- arXiv planned as an optional preprint source rather than the default published-paper source

### Planned platform additions
- Cron Triggers / scheduled Workers for ingestion
- Cloudflare Access for personal authentication at deployment

## 3. Runtime topology

```text
Browser / PWA
    |
    | same-origin /api/*
    v
Cloudflare Worker
    |            \
    |             \ provider adapter
    v              v
Cloudflare D1    OpenAlex / later Crossref, arXiv
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

The cloud bootstrap returns feeds, papers, recommendation snapshots, and decisions together. In deployed mode D1 is the source of truth. Bundled synthetic data exists only so frontend work remains possible when the Worker API is unavailable.

## 5. Feed intent and collection query are separate

A Feed has two different kinds of text:

- `intent`: the user's explicit, human-facing description of what they want to follow
- `providerQuery`: the concrete search expression sent to the collection provider

They must not be conflated. Provider syntax may change, and future learned preferences must not silently rewrite the user's explicit research intent.

Milestone 4 will expose editing for these fields. Milestone 3 uses deterministic development queries to prove the ingestion path.

## 6. Worker API

Current endpoints:

- `GET /api/health` — verifies Worker/D1 reachability
- `GET /api/bootstrap` — returns feeds, papers, recommendation snapshots, and decisions
- `POST /api/feeds/:feedId/refresh` — fetches a recent OpenAlex window and upserts normalized papers
- `PUT /api/decisions/:paperId` — creates or replaces one explicit decision
- `DELETE /api/decisions/:paperId` — returns a paper to Inbox
- `DELETE /api/decisions` — resets decisions for development/demo use

The refresh endpoint defaults to a fourteen-day inclusive publication window and accepts explicit ISO `fromDate` / `toDate` bounds. Persistent incremental watermarks belong to Milestone 3c (#10).

## 7. D1 schema

The schema currently contains:

- `feeds`
- `papers`
- `paper_feeds`
- `paper_identifiers`
- `ingestion_provenance`
- `decisions`
- `recommendation_snapshots`
- `feedback_events`

`papers.identifiers_json` remains the bootstrap-friendly representation of identifiers, while `paper_identifiers` provides normalized lookup keys for identity resolution.

`ingestion_provenance` records which provider record caused a paper/feed association, the provider query, provider update timestamp when available, and first/last seen timestamps.

## 8. Ingestion boundary

```text
Feed.providerQuery + source policy
             ↓
      PaperProvider interface
             ↓
          OpenAlex
             ↓
 normalization to ProviderPaper
             ↓
 canonical identity lookup
             ↓
        D1 paper upsert
             ↓
 feed membership + provenance
             ↓
       existing bootstrap
             ↓
            Inbox
```

Provider response types do not cross into React or the domain-facing persistence layer.

## 9. OpenAlex normalization

The OpenAlex adapter currently:

- searches newest-first within a publication-date window
- requests article records, optionally including preprints according to Feed policy
- reconstructs `abstract_inverted_index` into original abstract text
- normalizes DOI values to lowercase bare DOI form
- normalizes OpenAlex work IDs to `W...`
- chooses the publisher/source landing page when available
- prefers an open PDF URL when OpenAlex exposes one
- derives `published`, `accepted`, or `preprint` only from provider evidence rather than a generic `peerReviewed` boolean

Records without enough metadata for a usable title + abstract card are skipped.

## 10. Identity resolution

Identity resolution is a first-class subsystem.

Current strong keys:

1. normalized DOI
2. provider-specific OpenAlex work ID

A new paper receives a DOI-based canonical ID when possible; otherwise it receives an OpenAlex-based ID. If a later ingestion adds a DOI to an already known OpenAlex work, the existing canonical Paper row is kept and the DOI identifier is attached to it.

An identifier that already belongs to a different Paper causes an explicit conflict instead of a silent merge.

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

OpenAlex tests use a recorded JSON fixture and a mock `fetch` implementation to verify:

- query construction
- abstract reconstruction
- DOI/OpenAlex ID normalization
- PDF/source selection
- publication policy behavior

D1 migrations and Worker persistence continue to be exercised independently in the local Cloudflare runtime.

## 13. Security and privacy

The application is initially intended for one user. Deployment should prefer Cloudflare Access in front of the complete SPA + `/api/*` surface rather than building an account system prematurely.

`OPENALEX_API_KEY`, when configured, is a Worker-side secret/config value and must never be exposed to React.

No paper abstract or browsing event should be sent to an LLM unless a future AI feature explicitly requires it.
