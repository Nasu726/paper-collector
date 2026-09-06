# Architecture

## 1. Goals

The architecture is optimized for a personal, mobile-first web application that can begin as a lightweight prototype and later move to Cloudflare-hosted persistence and scheduled ingestion without rewriting the UI.

## 2. Planned stack

### Frontend
- React
- TypeScript
- Vite
- responsive CSS with no component-library dependency in the MVP

### Hosting / backend target
- Cloudflare Workers
- Cloudflare D1
- scheduled Workers / Cron Triggers for ingestion
- Cloudflare Access for personal authentication when deployed

The first UI milestone intentionally uses local persistence so interaction design can be validated before backend work.

## 3. Layering

```text
UI
  ↓
Application state / use-cases
  ↓
Repository interfaces
  ↓
LocalStorage adapter (prototype)
  ↓ later
D1/API adapter
```

External paper providers sit behind ingestion adapters:

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

Recommendation consumes normalized papers plus feedback events. It does not own the Inbox and cannot silently remove items.

## 4. Frontend boundaries

### Domain types
Pure TypeScript types describing papers, feeds, decisions and recommendation buckets.

### Persistence adapter
The UI calls a small persistence module rather than using `localStorage` directly. The implementation can later be replaced by an API client.

### Screens
- Inbox
- Saved
- Archive
- Feeds

The Inbox is the default route/state and must remain the shortest path from app open to paper triage.

## 5. Data flow for the prototype

1. Seed demo papers are loaded.
2. Existing local decisions are loaded.
3. Undecided papers form Inbox.
4. Save / Not interested writes a decision immediately.
5. Saved and Archive derive from the same decision state.
6. Opening PDF/source does not alter the explicit decision.

## 6. Backend migration path

The prototype should migrate in these steps:

1. Introduce Worker API endpoints while preserving frontend interfaces.
2. Move decisions and feeds from localStorage to D1.
3. Add normalized `papers` and `paper_identifiers` tables.
4. Add ingestion jobs and provider adapters.
5. Add feedback event logging.
6. Add ranking/recommendation service.

## 7. Ingestion constraints

The system must distinguish publication status from source type. `journal article`, `conference paper`, `preprint`, and `accepted when verifiable` should not be collapsed into one ambiguous boolean such as `peerReviewed`.

Provider-specific metadata must be preserved sufficiently to audit how a publication status was inferred.

## 8. Identity resolution

Identity resolution is a first-class subsystem, not a UI convenience. The canonical paper record should have zero or more identifiers. Exact DOI and arXiv matches are strong merges; title-based matching is heuristic and should retain provenance.

## 9. Recommendation invariants

- recommendation may reorder Inbox
- recommendation may add a coarse bucket and explanation
- recommendation must not remove eligible papers
- explicit feed text is immutable except by user action
- learned preferences are versioned separately
- model/version metadata should be stored with decisions once ranking is introduced

## 10. Security and privacy

The application is initially intended for one user. Deployment should therefore prefer access control at the edge plus a private backend surface rather than building a custom account system prematurely.

No paper abstract or browsing event should be sent to an LLM unless a future AI feature explicitly requires it.
