export type PublicationStatus = 'published' | 'accepted' | 'preprint' | 'unknown'

export type RecommendationBucket =
  | 'very_high'
  | 'high'
  | 'medium'
  | 'low'
  | 'very_low'

export type Recommendation = {
  bucket: RecommendationBucket
  reasons: string[]
  modelVersion: string
}

export type PaperIdentifier = {
  kind: 'doi' | 'arxiv' | 'provider'
  value: string
  provider?: string
}

export type Paper = {
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

export type FeedIngestionStatus = 'never' | 'success' | 'error' | 'truncated'

export type FeedIngestionState = {
  status: FeedIngestionStatus
  watermarkDate?: string
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastFetched: number
  lastPages: number
}

export type FeedSourcePolicy =
  | 'published_only'
  | 'accepted_when_verifiable'
  | 'include_preprints'

export type Feed = {
  id: string
  name: string
  intent: string
  exclusions?: string
  sourcePolicy: FeedSourcePolicy
  active: boolean
  providerQuery?: string
  archivedAt?: string
  ingestion?: FeedIngestionState
}

export type DecisionState = 'saved' | 'rejected'

export type Decision = {
  paperId: string
  state: DecisionState
  decidedAt: string
  feedIds: string[]
  recommendationBucket?: RecommendationBucket
  modelVersion?: string
}

export type FeedbackEventType =
  | 'abstract_expanded'
  | 'pdf_opened'
  | 'source_opened'
  | 'saved_reopened'

export type FeedbackSurface = 'inbox' | 'saved' | 'archive'

export type FeedbackEvent = {
  id: string
  paperId: string
  type: FeedbackEventType
  surface: FeedbackSurface
  occurredAt: string
  feedIds: string[]
  schemaVersion: 1
}
