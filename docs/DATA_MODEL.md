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
  ingestion?: FeedIngestionState
}
```

`intent` is explicit human-facing research intent. `providerQuery` is the concrete query sent to the scholarly collection provider. They are deliberately separate so provider syntax, ranking models, and learned preference state cannot silently rewrite the user's intent.

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

A decision is reversible. The current table stores the latest explicit state; later feedback instrumentation may add historical decision events.

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

```ts
type FeedbackEvent = {
  id: string
  paperId: string
  type:
    | 'card_viewed'
    | 'abstract_expanded'
    | 'pdf_opened'
    | 'source_opened'
    | 'saved_reopened'
    | 'saved_removed'
  occurredAt: string
  context?: Record<string, string | number | boolean>
}
```

Implicit feedback is evidence, not ground truth. Event weights belong to the ranking layer rather than the event schema.

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
Human intent, exclusions, source policy, active state, and provider query.

### `papers`
Canonical Paper record rendered by the UI, plus accepted-date metadata used by enrichment/provenance.

### `paper_feeds`
Many-to-many Feed membership. One Paper can belong to several Feeds without duplicate Inbox records. Membership insertion is idempotent so overlapping refreshes can safely rediscover the same pair.

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
Reserved for later implicit feedback instrumentation.

## Planned additions

Likely later tables include learned feed profiles for Milestone 6. Feed CRUD in Milestone 4 is expected to extend existing Feed records rather than introduce recommendation state into the explicit Feed definition.

See [`CROSSREF_ENRICHMENT.md`](CROSSREF_ENRICHMENT.md) for the current canonical-source policy.
