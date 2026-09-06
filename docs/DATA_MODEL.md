# Data Model

This document describes the target logical model. The first UI prototype stores only a subset locally.

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

`id` is an internal canonical identifier. It must not assume that DOI is always present.

## PublicationStatus

```ts
type PublicationStatus =
  | 'published'
  | 'accepted'
  | 'preprint'
  | 'unknown'
```

`accepted` should only be used when acceptance can actually be verified from source metadata.

## PaperIdentifier

```ts
type PaperIdentifier = {
  kind: 'doi' | 'arxiv' | 'provider'
  value: string
  provider?: string
}
```

Identifiers should be normalized before uniqueness comparison.

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
}
```

The `intent` and `exclusions` fields are explicit user configuration. Learned preferences must not overwrite them.

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

A decision should be reversible. Historical decision events may be added later if we need an audit trail rather than only current state.

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

This is separate from `Feed.intent` by design.

## Target relational tables

A likely D1 schema will eventually contain:

- `papers`
- `paper_identifiers`
- `feeds`
- `paper_feed_memberships`
- `decisions`
- `feedback_events`
- `learned_feed_profiles`
- `ingestion_runs`
- `paper_sources`

The exact SQL schema should be introduced when backend persistence begins, not prematurely frozen during the UI prototype.
