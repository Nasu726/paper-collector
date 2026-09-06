# Data Model

This document describes the current logical model and the D1 structures that back it.

## Paper

```ts
type Paper = {
  id: string
  title: string
  abstract: string
  authors: string[]
  publishedAt?: string
  venue?: string
  publicationStatus: PublicationStatus
  sourceUrl: string
  pdfUrl?: string
  identifiers: PaperIdentifier[]
  feedIds: string[]
  recommendation?: Recommendation
}
```

`id` is an internal canonical identifier. A newly ingested Paper prefers a normalized DOI-based ID when a DOI exists; otherwise the first provider identity is used. The canonical ID remains stable when later enrichment adds metadata.

The D1 `papers` row also has `accepted_at`. It is currently provenance/canonical database metadata rather than part of the normal Inbox payload; accepted-date evidence is inspectable through the evidence API.

Normal bootstrap exposes only non-archived Feed IDs in `Paper.feedIds`. Historical membership remains persisted in `paper_feeds`; restoring a Feed can therefore reveal existing memberships again without provider re-fetch.

## PublicationStatus

```ts
type PublicationStatus =
  | 'published'
  | 'accepted'
  | 'preprint'
  | 'unknown'
```

`accepted` and `published` are evidence-bearing states, not synonyms for `peer reviewed`. A provider adapter must only emit them when its metadata supports the distinction.

Canonical status selection is monotonic under the current field policy:

```text
unknown < preprint < accepted < published
```

## PaperIdentifier

```ts
type PaperIdentifier = {
  kind: 'doi' | 'arxiv' | 'provider'
  value: string
  provider?: string
}
```

Normalization rules currently include:

- DOI: lowercase bare DOI without `https://doi.org/` or `doi:` prefix
- OpenAlex work: uppercase `W...` value stored as `kind: 'provider', provider: 'openalex'`

The domain copy of identifiers is stored in `papers.identifiers_json` for bootstrap simplicity. The `paper_identifiers` table stores the same strong identities in normalized relational form for lookup and uniqueness checks.

Crossref enrichment only targets an already existing DOI identifier; it does not create another Paper row.

## Feed

```ts
type Feed = {
  id: string
  name: string
  intent: string
  exclusions?: string
  sourcePolicy:
    | 'published_only'
    | 'accepted_when_verifiable'
    | 'include_preprints'
  active: boolean
  providerQuery?: string
  archivedAt?: string
  ingestion?: FeedIngestionState
}
```

`intent` is explicit human-facing research intent. `providerQuery` is the concrete query sent to the scholarly collection provider. They are deliberately separate so provider syntax, ranking models, and learned preference state cannot silently rewrite the user's intent.

`active=false` means collection is paused. `archivedAt` additionally removes the Feed from normal Feed management/bootstrap without deleting historical Paper membership, provenance, or decisions.

## FeedIngestionState

```ts
type FeedIngestionState = {
  status: 'never' | 'success' | 'error' | 'truncated'
  watermarkDate?: string
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastFetched: number
  lastPages: number
}
```

`watermarkDate` is the most recent fully completed incremental publication-date checkpoint. It is monotonic and is not advanced by explicit backfills, failed provider requests, persistence failures, or truncated provider scans.

The stored `lastAttemptAt` also orders overlapping refresh results: an older run may finish after a newer run, but must not overwrite the newer run's visible state.

## Field evidence

Provider evidence and canonical selection are distinct records.

A normalized evidence item conceptually contains:

```ts
type FieldEvidence = {
  paperId: string
  fieldName: CanonicalFieldName
  provider: string
  providerRecordId: string
  sourceField: string
  value: unknown
}
```

Current canonical field names include:

- `title`
- `abstract`
- `authors`
- `published_at`
- `accepted_at`
- `venue`
- `publication_status`
- `source_url`
- `pdf_url`

`paper_field_evidence` can contain multiple competing values for one field. `paper_field_sources` selects at most one current source for a canonical field and records the policy version that made the selection.

This distinction allows a later policy revision to re-evaluate evidence without losing the original provider statements.

## Decision

```ts
type Decision = {
  paperId: string
  state: 'saved' | 'rejected'
  decidedAt: string
  feedIds: string[]
  recommendationBucket?: RecommendationBucket
  modelVersion?: string
}
```

A decision is reversible. The current table stores the latest explicit state. Save / Not Interested remain explicit evidence and are not duplicated as implicit feedback events.

## Ingestion provenance

Every collection-provider-created paper/feed association records:

- canonical `paper_id`
- `feed_id`
- provider name
- provider record ID
- concrete query text
- provider update timestamp when supplied
- first-seen timestamp
- last-seen timestamp

This answers “why is this Paper in this Feed?” and is separate from field provenance, which answers “which provider said this metadata value?”

## FeedbackEvent

Current raw implicit evidence is deliberately small:

```ts
type FeedbackEventType =
  | 'abstract_expanded'
  | 'pdf_opened'
  | 'source_opened'

type FeedbackSurface =
  | 'inbox'
  | 'saved'
  | 'archive'

type FeedbackEvent = {
  id: string
  paperId: string
  type: FeedbackEventType
  occurredAt: string
  surface: FeedbackSurface
  feedIds: string[]
}
```

The client submits only `paperId`, `type`, and `surface`. The Worker generates `id` and `occurredAt`, verifies the Paper, and snapshots persisted Feed membership into `feedIds`.

Raw feedback carries no permanent recommendation weight. The existing D1 `weight` column remains NULL for current events; feature weights belong to a later versioned recommendation model.

The server does not accept arbitrary event metadata, raw titles/abstracts, URLs, or client-supplied Feed IDs.

See [`FEEDBACK.md`](FEEDBACK.md) for confidence and privacy policy.

## Recommendation

```ts
type RecommendationBucket =
  | 'very_high'
  | 'high'
  | 'medium'
  | 'low'
  | 'very_low'

type Recommendation = {
  bucket: RecommendationBucket
  reasons: string[]
  modelVersion: string
}
```

The bucket is deliberately coarse and must not be interpreted as a calibrated probability.

## LearnedFeedProfile

```ts
type LearnedFeedProfile = {
  feedId: string
  modelVersion: string
  updatedAt: string
  representation: unknown
  humanReadableSummary?: string[]
}
```

This remains separate from both `Feed.intent` and `Feed.providerQuery`.

## Current relational tables

### `feeds`
Human intent, exclusions, source policy, active/archive state, and provider query.

### `papers`
Canonical Paper record rendered by the UI, plus accepted-date metadata used by enrichment/provenance.

### `paper_feeds`
Many-to-many historical Feed membership. One Paper can belong to several Feeds without duplicate Inbox records. Membership insertion is idempotent so overlapping refreshes can safely rediscover the same pair. Archive does not delete these rows.

### `paper_identifiers`
Normalized strong identity lookup. Its `(kind, value, provider)` key may point to only one canonical Paper.

### `ingestion_provenance`
Collection-provider/feed origin and first/last-seen evidence.

### `feed_ingestion_state`
Per-Feed provider status, successful watermark, latest attempt/success timestamps, diagnostics, and provider page/record counts.

### `paper_field_evidence`
All normalized metadata evidence by Paper, field, provider record, and provider source field.

### `paper_field_sources`
Current selected canonical source per Paper/field, including `policy_version`.

### `crossref_enrichment_state`
Per-Paper DOI lookup cache/retry state (`success`, `not_found`, or `error`).

### `decisions`
Latest Save / Not Interested state.

### `recommendation_snapshots`
Versioned coarse recommendation output.

### `feedback_events`
Append-only implicit interaction evidence. Current events use `event_type`, `event_at`, and a server-generated JSON context containing `surface` and Feed membership snapshot. Legacy/general-purpose `feed_id` and `weight` columns are not used for the current event contract.

## Planned additions

Likely later tables include learned feed profiles for Milestone 6. Recommendation state must remain separate from explicit Feed configuration.

See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md) for the current canonical-source policy and [`FEEDBACK.md`](FEEDBACK.md) for implicit-evidence policy.
