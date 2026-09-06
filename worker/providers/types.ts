import type { Feed, PaperIdentifier, PublicationStatus } from '../../src/domain'

export type ProviderPaper = {
  provider: string
  providerRecordId: string
  providerUpdatedAt?: string
  title: string
  abstract: string
  authors: string[]
  publishedAt?: string
  venue?: string
  publicationStatus: PublicationStatus
  sourceUrl: string
  pdfUrl?: string
  identifiers: PaperIdentifier[]
}

export type ProviderSearchRequest = {
  query: string
  fromDate: string
  toDate: string
  sourcePolicy: Feed['sourcePolicy']
  limit?: number
}

export interface PaperProvider {
  readonly name: string
  search(request: ProviderSearchRequest): Promise<ProviderPaper[]>
}
