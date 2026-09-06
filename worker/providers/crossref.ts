import type { PublicationStatus } from '../../src/domain'
import type { CanonicalFieldName } from '../fieldEvidence'
import { normalizeDoi } from './identifiers'

type CrossrefDateParts = {
  'date-parts'?: Array<Array<number | null>> | null
}

type CrossrefAuthor = {
  given?: string | null
  family?: string | null
  name?: string | null
}

type CrossrefWork = {
  DOI?: string | null
  title?: string[] | null
  author?: CrossrefAuthor[] | null
  'container-title'?: string[] | null
  URL?: string | null
  type?: string | null
  accepted?: CrossrefDateParts | null
  published?: CrossrefDateParts | null
  'published-online'?: CrossrefDateParts | null
  'published-print'?: CrossrefDateParts | null
  issued?: CrossrefDateParts | null
}

type CrossrefResponse = {
  status?: string
  message?: CrossrefWork
}

export type CrossrefFieldEvidence = {
  fieldName: CanonicalFieldName
  sourceField: string
  value: unknown
}

export type CrossrefRecord = {
  doi: string
  title?: string
  authors?: string[]
  venue?: string
  sourceUrl: string
  acceptedAt?: string
  publishedAt?: string
  publicationStatus: PublicationStatus
  publicationDateSource?: string
  evidence: CrossrefFieldEvidence[]
}

export type CrossrefProviderOptions = {
  baseUrl?: string
  mailto?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class CrossrefRequestError extends Error {
  readonly status: number
  readonly retryAfter?: string

  constructor(message: string, status: number, retryAfter?: string) {
    super(message)
    this.name = 'CrossrefRequestError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

function text(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

export function crossrefDate(value: CrossrefDateParts | null | undefined): string | undefined {
  const parts = value?.['date-parts']?.[0]
  if (!parts || typeof parts[0] !== 'number' || !Number.isInteger(parts[0])) return undefined

  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  if (month === null || month === undefined) return String(year).padStart(4, '0')
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined
  const yearMonth = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
  if (day === null || day === undefined) return yearMonth
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined
  return `${yearMonth}-${String(day).padStart(2, '0')}`
}

function authors(work: CrossrefWork): string[] | undefined {
  const names = (work.author ?? [])
    .map((author) => {
      const literal = text(author.name)
      if (literal) return literal
      return text([author.given, author.family].filter(Boolean).join(' '))
    })
    .filter((name): name is string => Boolean(name))
  return names.length ? names : undefined
}

function publicationDate(work: CrossrefWork): { value?: string; sourceField?: string } {
  const candidates: Array<[string, CrossrefDateParts | null | undefined]> = [
    ['published-online', work['published-online']],
    ['published-print', work['published-print']],
    ['published', work.published],
    ['issued', work.issued],
  ]
  for (const [sourceField, value] of candidates) {
    const normalized = crossrefDate(value)
    if (normalized) return { value: normalized, sourceField }
  }
  return {}
}

export function normalizeCrossrefWork(work: CrossrefWork, requestedDoi?: string): CrossrefRecord | null {
  const doi = normalizeDoi(work.DOI ?? requestedDoi)
  if (!doi) return null

  const title = text(work.title?.[0])
  const normalizedAuthors = authors(work)
  const venue = text(work['container-title']?.[0])
  const acceptedAt = crossrefDate(work.accepted)
  const publication = publicationDate(work)
  const publicationStatus: PublicationStatus = publication.value
    ? 'published'
    : acceptedAt
      ? 'accepted'
      : 'unknown'
  const sourceUrl = text(work.URL) ?? `https://doi.org/${doi}`

  const evidence: CrossrefFieldEvidence[] = []
  if (title) evidence.push({ fieldName: 'title', sourceField: 'title', value: title })
  if (normalizedAuthors) evidence.push({ fieldName: 'authors', sourceField: 'author', value: normalizedAuthors })
  if (venue) evidence.push({ fieldName: 'venue', sourceField: 'container-title', value: venue })
  if (acceptedAt) evidence.push({ fieldName: 'accepted_at', sourceField: 'accepted', value: acceptedAt })
  if (publication.value && publication.sourceField) {
    evidence.push({ fieldName: 'published_at', sourceField: publication.sourceField, value: publication.value })
  }
  evidence.push({
    fieldName: 'publication_status',
    sourceField: publication.value ? publication.sourceField ?? 'published' : acceptedAt ? 'accepted' : 'type',
    value: publicationStatus,
  })
  evidence.push({ fieldName: 'source_url', sourceField: 'URL', value: sourceUrl })

  return {
    doi,
    title,
    authors: normalizedAuthors,
    venue,
    sourceUrl,
    acceptedAt,
    publishedAt: publication.value,
    publicationStatus,
    publicationDateSource: publication.sourceField,
    evidence,
  }
}

export class CrossrefProvider {
  readonly name = 'crossref'
  private readonly baseUrl: string
  private readonly mailto?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: CrossrefProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.crossref.org').replace(/\/$/, '')
    this.mailto = text(options.mailto)
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async lookupDoi(doiValue: string): Promise<CrossrefRecord | null> {
    const doi = normalizeDoi(doiValue)
    if (!doi) throw new Error(`Invalid DOI: ${doiValue}`)

    const url = new URL(`${this.baseUrl}/works/${encodeURIComponent(doi)}`)
    if (this.mailto) url.searchParams.set('mailto', this.mailto)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'paper-collector/0.5 (+https://github.com/Nasu726/paper-collector)',
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 404) return null
    if (!response.ok) {
      throw new CrossrefRequestError(
        `Crossref request failed with ${response.status}`,
        response.status,
        response.headers.get('retry-after') ?? undefined,
      )
    }

    const payload = (await response.json()) as CrossrefResponse
    const record = payload.message ? normalizeCrossrefWork(payload.message, doi) : null
    if (!record) throw new Error(`Crossref returned an invalid work record for ${doi}`)
    if (record.doi !== doi) throw new Error(`Crossref DOI mismatch: requested ${doi}, received ${record.doi}`)
    return record
  }
}
