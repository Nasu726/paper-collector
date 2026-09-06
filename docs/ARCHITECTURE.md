# Architecture

## 1. Goals

The architecture is optimized for a personal, mobile-first web application. The UI must stay simple while persistence, ingestion, identity resolution, and recommendation become progressively more capable behind stable boundaries.

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
- localStorage as a development/offline fallback for decision state

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
    |
    v
Cloudflare D1

Static SPA assets are served by the same Worker deployment.
```

`wrangler.jsonc` routes `/api/*` to the Worker first and uses `single-page-application` fallback for the React app.

## 4. Frontend layering

```text
React UI
  ↓
Application state / use-cases
  ↓
Decision repository abstraction
  ├─ API adapter → Worker → D1
  └─ localStorage mirror/fallback
```

The UI does not call localStorage directly. The resilient decision repository first attempts the Worker API. A successful cloud bootstrap is mirrored locally. If the API is unavailable, the current-device local copy keeps triage usable.

The local copy is not the production source of truth once D1 is configured.

## 5. Worker API

Current endpoints:

- `GET /api/health` — verifies Worker/D1 reachability
- `GET /api/bootstrap` — returns persisted decision state
- `PUT /api/decisions/:paperId` — creates or replaces one explicit decision
- `DELETE /api/decisions/:paperId` — returns a paper to Inbox
- `DELETE /api/decisions` — resets decisions (development/demo operation)

The API validates decision state, feed IDs, timestamps, recommendation buckets, and model-version fields before writing to D1.

## 6. D1 schema

The first migration creates tables for:

- `feeds`
- `papers`
- `paper_feeds`
- `decisions`
- `recommendation_snapshots`
- `feedback_events`

This deliberately establishes the eventual normalized schema before real ingestion is connected.

During Milestone 2a, demo papers/feeds are still bundled in the frontend while decisions move to D1. For that transitional reason `decisions.paper_id` is not yet constrained by a foreign key to `papers`; Milestone 2b seeds papers into D1 and removes the architectural dependence on bundled demo records.

## 7. Current data flow

1. React loads bundled demo papers/feeds.
2. The decision repository requests `GET /api/bootstrap`.
3. If the API succeeds, D1 decisions are the source of truth and are mirrored locally.
4. If the API is unavailable, localStorage decisions are used.
5. Undecided papers form Inbox.
6. Save / Not interested updates UI optimistically and persists through the repository.
7. Saved and Archive derive from the same decision map.
8. Opening PDF/source does not alter the explicit decision.

## 8. Backend migration path

1. **Milestone 2a:** Worker runtime, D1 schema, decision API, repository abstraction.
2. **Milestone 2b:** seed/load feeds and papers from D1; make cloud persistence complete across devices.
3. Add ingestion provider adapters and provenance.
4. Add feedback event logging.
5. Add ranking/recommendation service.

## 9. Ingestion boundary

External paper providers sit behind adapters:

```text
Crossref / OpenAlex / arXiv / other sources
                 ↓
            Normalization
                 ↓
        Identity resolution
                 ↓
              Papers
                 ↓
          Feed membership
```

Publication status and source type remain separate. `journal article`, `conference paper`, `preprint`, and `accepted when verifiable` must not collapse into an ambiguous `peerReviewed` boolean.

Provider-specific metadata must remain auditable enough to explain how publication status was inferred.

## 10. Identity resolution

Identity resolution is a first-class subsystem. A canonical paper has zero or more identifiers. Exact DOI and arXiv matches are strong merges; title-based matching is heuristic and must retain provenance.

## 11. Recommendation invariants

- recommendation may reorder Inbox
- recommendation may add a coarse bucket and explanation
- recommendation must not remove eligible papers
- explicit feed text is immutable except by user action
- learned preferences are versioned separately
- model/version metadata is stored with decisions once ranking is introduced

## 12. Security and privacy

The application is initially intended for one user. Deployment should prefer Cloudflare Access in front of the application rather than building an account system prematurely.

The Worker API is same-origin and should sit behind the same Access policy as the SPA once deployed.

No paper abstract or browsing event should be sent to an LLM unless a future AI feature explicitly requires it.
