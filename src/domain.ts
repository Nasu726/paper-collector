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

export type Feed = {
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

export type DecisionState = 'saved' | 'rejected'

export type Decision = {
  paperId: string
  state: DecisionState
  decidedAt: string
  feedIds: string[]
  recommendationBucket?: RecommendationBucket
  modelVersion?: string
}
