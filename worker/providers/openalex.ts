import type { Feed, PaperIdentifier, PublicationStatus } from '../../src/domain'
import type { PaperProvider, ProviderPaper, ProviderSearchRequest } from './types'

type OpenAlexLocation = {
  landing_page_url?: string | null
  pdf_url?: string | null
  is_published?: boolean | null
  is_accepted?: boolean | null
  source?: {
    display_name?: string | null
  } | null
}

type OpenAlexWork = {
  id?: string | null
  doi?: string | null
  title?: string | null
  publication_date?: string | null
  type?: string | null
  updated_date?: string | null
  abstract_inverted_index?: Record<string, number[]> | null
  authorships?: Array<{
    author?: {
      display_name?: string | null
    } | null
  }> | null
  primary_location?: OpenAlexLocation | null
  best_oa_location?: OpenAlexLocation | null
  locations?: OpenAlexLocation[] | null
}

type OpenAlexResponse = {
  results?: OpenAlexWork[]
}

export type OpenAlexProviderOptions = {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function normalizeDate(value: string | null | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return value
}

export function normalizeDoi(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
  return normalized.startsWith('10.') && normalized.includes('/') ? normalized : undefined
}

export function normalizeOpenAlexId(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const candidate = value.trim().replace(/^https?:\/\/openalex\.org\//i, '')
  return /^W\d+$/i.test(candidate) ? candidate.toUpperCase() : undefined
}

export function reconstructOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return ''

  let maxPosition = -1
  for (const positions of Object.values(index)) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) maxPosition = Math.max(maxPosition, position)
    }
  }
  if (maxPosition < 0) return ''

  const words = new Array<string>(maxPosition + 1)
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < words.length && words[position] === undefined) {
        words[position] = word
      }
    }
  }

  return words.filter((word): word is string => typeof word === 'string').join(' ')
}

function publicationStatus(work: OpenAlexWork): PublicationStatus {
  if (work.type === 'preprint') return 'preprint'

  const locations = [work.primary_location, work.best_oa_location, ...(work.locations ?? [])].filter(
    (location): location is OpenAlexLocation => Boolean(location),
  )
  if (locations.some((location) => location.is_published === true)) return 'published'
  if (locations.some((location) => location.is_accepted === true)) return 'accepted'
  return 'unknown'
}

function allowedByPolicy(status: PublicationStatus, policy: Feed['sourcePolicy']): boolean {
  if (policy === 'published_only') return status === 'published'
  if (policy === 'accepted_when_verifiable') return status === 'published' || status === 'accepted'
  return status === 'published' || status === 'accepted' || status === 'preprint'
}

export function normalizeOpenAlexWork(work: OpenAlexWork): ProviderPaper | null {
  const openAlexId = normalizeOpenAlexId(work.id)
  const title = work.title?.trim() ?? ''
  const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index)
  if (!openAlexId || !title || !abstract) return null

  const doi = normalizeDoi(work.doi)
  const identifiers: PaperIdentifier[] = [
    { kind: 'provider', value: openAlexId, provider: 'openalex' },
  ]
  if (doi) identifiers.unshift({ kind: 'doi', value: doi })

  const primary = work.primary_location ?? undefined
  const bestOa = work.best_oa_location ?? undefined
  const sourceUrl = primary?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : `https://openalex.org/${openAlexId}`)
  const pdfUrl = bestOa?.pdf_url ?? primary?.pdf_url ?? undefined
  const venue = primary?.source?.display_name?.trim() || undefined
  const authors = (work.authorships ?? [])
    .map((authorship) => authorship.author?.display_name?.trim())
    .filter((name): name is string => Boolean(name))

  return {
    provider: 'openalex',
    providerRecordId: openAlexId,
    providerUpdatedAt: work.updated_date ?? undefined,
    title,
    abstract,
    authors,
    publishedAt: normalizeDate(work.publication_date),
    venue,
    publicationStatus: publicationStatus(work),
    sourceUrl,
    pdfUrl,
    identifiers,
  }
}

export class OpenAlexProvider implements PaperProvider {
  readonly name = 'openalex'
  private readonly apiKey?: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAlexProviderOptions = {}) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.openalex.org').replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async search(request: ProviderSearchRequest): Promise<ProviderPaper[]> {
    const url = new URL(`${this.baseUrl}/works`)
    url.searchParams.set('search', request.query)

    const workTypes = request.sourcePolicy === 'include_preprints' ? 'article|preprint' : 'article'
    url.searchParams.set(
      'filter',
      `from_publication_date:${request.fromDate},to_publication_date:${request.toDate},has_abstract:true,type:${workTypes}`,
    )
    url.searchParams.set('sort', '-publication_date')
    url.searchParams.set('per_page', String(Math.min(Math.max(request.limit ?? 50, 1), 100)))
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'paper-collector/0.3 (+https://github.com/Nasu726/paper-collector)',
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) throw new Error(`OpenAlex request failed with ${response.status}`)

    const payload = (await response.json()) as OpenAlexResponse
    const normalized = (payload.results ?? [])
      .map(normalizeOpenAlexWork)
      .filter((paper): paper is ProviderPaper => paper !== null)

    return normalized.filter((paper) => allowedByPolicy(paper.publicationStatus, request.sourcePolicy))
  }
}
