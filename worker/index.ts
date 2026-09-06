import type {
  Decision,
  DecisionState,
  Feed,
  Paper,
  PaperIdentifier,
  PublicationStatus,
  RecommendationBucket,
} from '../src/domain'
import { persistProviderPapers } from './ingestion'
import { OpenAlexProvider } from './providers/openalex'

type Env = {
  DB: D1Database
  OPENALEX_API_KEY?: string
  OPENALEX_BASE_URL?: string
}

type DecisionRow = {
  paper_id: string
  state: DecisionState
  decided_at: string
  feed_ids_json: string
  recommendation_bucket: RecommendationBucket | null
  model_version: string | null
}

type FeedRow = {
  id: string
  name: string
  intent: string
  exclusions: string | null
  source_policy: Feed['sourcePolicy']
  active: number
  provider_query: string | null
}

type PaperRow = {
  id: string
  title: string
  abstract: string
  authors_json: string
  published_at: string | null
  venue: string | null
  publication_status: PublicationStatus
  source_url: string
  pdf_url: string | null
  identifiers_json: string
}

type PaperFeedRow = {
  paper_id: string
  feed_id: string
}

type RecommendationRow = {
  paper_id: string
  bucket: RecommendationBucket
  reasons_json: string
  model_version: string
  scored_at: string
}

type RefreshBody = {
  fromDate?: string
  toDate?: string
}

const decisionStates = new Set<DecisionState>(['saved', 'rejected'])
const recommendationBuckets = new Set<RecommendationBucket>([
  'very_high',
  'high',
  'medium',
  'low',
  'very_low',
])

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, { status })
}

function parseJsonArray<T>(raw: string): T[] {
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new Error('Expected JSON array in D1 row')
  return value as T[]
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    paperId: row.paper_id,
    state: row.state,
    decidedAt: row.decided_at,
    feedIds: parseJsonArray<string>(row.feed_ids_json),
    recommendationBucket: row.recommendation_bucket ?? undefined,
    modelVersion: row.model_version ?? undefined,
  }
}

function rowToFeed(row: FeedRow): Feed {
  return {
    id: row.id,
    name: row.name,
    intent: row.intent,
    exclusions: row.exclusions ?? undefined,
    sourcePolicy: row.source_policy,
    active: row.active === 1,
    providerQuery: row.provider_query ?? undefined,
  }
}

function parseDecision(value: unknown, paperId: string): Decision | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Record<string, unknown>
  if (candidate.paperId !== paperId) return null
  if (typeof candidate.state !== 'string' || !decisionStates.has(candidate.state as DecisionState)) return null
  if (typeof candidate.decidedAt !== 'string' || Number.isNaN(Date.parse(candidate.decidedAt))) return null
  if (!Array.isArray(candidate.feedIds) || !candidate.feedIds.every((feedId) => typeof feedId === 'string')) return null

  const recommendationBucket = candidate.recommendationBucket
  if (
    recommendationBucket !== undefined &&
    (typeof recommendationBucket !== 'string' || !recommendationBuckets.has(recommendationBucket as RecommendationBucket))
  ) {
    return null
  }

  const modelVersion = candidate.modelVersion
  if (modelVersion !== undefined && typeof modelVersion !== 'string') return null

  return {
    paperId,
    state: candidate.state as DecisionState,
    decidedAt: candidate.decidedAt,
    feedIds: candidate.feedIds as string[],
    recommendationBucket: recommendationBucket as RecommendationBucket | undefined,
    modelVersion,
  }
}

async function loadDecisions(db: D1Database): Promise<Record<string, Decision>> {
  const result = await db
    .prepare(
      `SELECT paper_id, state, decided_at, feed_ids_json, recommendation_bucket, model_version
       FROM decisions
       ORDER BY decided_at DESC`,
    )
    .all<DecisionRow>()

  const decisions: Record<string, Decision> = {}
  for (const row of result.results) {
    const decision = rowToDecision(row)
    decisions[decision.paperId] = decision
  }
  return decisions
}

async function loadFeeds(db: D1Database): Promise<Feed[]> {
  const result = await db
    .prepare(
      `SELECT id, name, intent, exclusions, source_policy, active, provider_query
       FROM feeds
       ORDER BY created_at ASC, id ASC`,
    )
    .all<FeedRow>()

  return result.results.map(rowToFeed)
}

async function loadPapers(db: D1Database): Promise<Paper[]> {
  const [paperResult, membershipResult, recommendationResult] = await Promise.all([
    db
      .prepare(
        `SELECT id, title, abstract, authors_json, published_at, venue,
                publication_status, source_url, pdf_url, identifiers_json
         FROM papers
         ORDER BY COALESCE(published_at, created_at) DESC, id ASC`,
      )
      .all<PaperRow>(),
    db.prepare('SELECT paper_id, feed_id FROM paper_feeds ORDER BY paper_id, feed_id').all<PaperFeedRow>(),
    db
      .prepare(
        `SELECT paper_id, bucket, reasons_json, model_version, scored_at
         FROM recommendation_snapshots
         WHERE feed_id IS NULL
         ORDER BY scored_at DESC, id DESC`,
      )
      .all<RecommendationRow>(),
  ])

  const feedIdsByPaper = new Map<string, string[]>()
  for (const row of membershipResult.results) {
    const feedIds = feedIdsByPaper.get(row.paper_id) ?? []
    feedIds.push(row.feed_id)
    feedIdsByPaper.set(row.paper_id, feedIds)
  }

  const recommendationByPaper = new Map<string, RecommendationRow>()
  for (const row of recommendationResult.results) {
    if (!recommendationByPaper.has(row.paper_id)) recommendationByPaper.set(row.paper_id, row)
  }

  return paperResult.results.map((row): Paper => {
    const recommendation = recommendationByPaper.get(row.id)
    return {
      id: row.id,
      title: row.title,
      abstract: row.abstract,
      authors: parseJsonArray<string>(row.authors_json),
      publishedAt: row.published_at ?? undefined,
      venue: row.venue ?? undefined,
      publicationStatus: row.publication_status,
      sourceUrl: row.source_url,
      pdfUrl: row.pdf_url ?? undefined,
      identifiers: parseJsonArray<PaperIdentifier>(row.identifiers_json),
      feedIds: feedIdsByPaper.get(row.id) ?? [],
      recommendation: recommendation
        ? {
            bucket: recommendation.bucket,
            reasons: parseJsonArray<string>(recommendation.reasons_json),
            modelVersion: recommendation.model_version,
          }
        : undefined,
    }
  })
}

async function loadBootstrap(db: D1Database) {
  const [feeds, papers, decisions] = await Promise.all([
    loadFeeds(db),
    loadPapers(db),
    loadDecisions(db),
  ])

  return { feeds, papers, decisions }
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function daysBefore(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) - days * 86_400_000
  return new Date(timestamp).toISOString().slice(0, 10)
}

async function parseRefreshBody(request: Request): Promise<RefreshBody | null> {
  if (!request.headers.get('content-type')?.includes('application/json')) return {}
  try {
    const value = (await request.json()) as unknown
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    if (candidate.fromDate !== undefined && !validDate(candidate.fromDate)) return null
    if (candidate.toDate !== undefined && !validDate(candidate.toDate)) return null
    return {
      fromDate: candidate.fromDate as string | undefined,
      toDate: candidate.toDate as string | undefined,
    }
  } catch {
    return null
  }
}

async function refreshFeed(request: Request, env: Env, feedId: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, name, intent, exclusions, source_policy, active, provider_query
       FROM feeds WHERE id = ?`,
    )
    .bind(feedId)
    .first<FeedRow>()
  if (!row) return error('Feed does not exist.', 404)

  const feed = rowToFeed(row)
  if (!feed.active) return error('Feed is paused.', 409)
  const query = feed.providerQuery?.trim()
  if (!query) return error('Feed has no provider query configured.', 409)

  const body = await parseRefreshBody(request)
  if (!body) return error('Refresh body must contain ISO fromDate/toDate values.')

  const toDate = body.toDate ?? new Date().toISOString().slice(0, 10)
  const fromDate = body.fromDate ?? daysBefore(toDate, 13)
  if (fromDate > toDate) return error('fromDate must not be after toDate.')

  const provider = new OpenAlexProvider({
    apiKey: env.OPENALEX_API_KEY,
    baseUrl: env.OPENALEX_BASE_URL,
  })
  const papers = await provider.search({
    query,
    fromDate,
    toDate,
    sourcePolicy: feed.sourcePolicy,
  })
  const result = await persistProviderPapers(env.DB, feed, papers, query)

  return json({
    feedId,
    provider: provider.name,
    fromDate,
    toDate,
    ...result,
  })
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/api/health') {
    await env.DB.prepare('SELECT 1').first()
    return json({ ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return json(await loadBootstrap(env.DB))
  }

  const refreshMatch = url.pathname.match(/^\/api\/feeds\/([^/]+)\/refresh$/)
  if (request.method === 'POST' && refreshMatch) {
    return refreshFeed(request, env, decodeURIComponent(refreshMatch[1]))
  }

  if (request.method === 'DELETE' && url.pathname === '/api/decisions') {
    await env.DB.prepare('DELETE FROM decisions').run()
    return new Response(null, { status: 204 })
  }

  const match = url.pathname.match(/^\/api\/decisions\/([^/]+)$/)
  if (match) {
    const paperId = decodeURIComponent(match[1])

    if (request.method === 'PUT') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return error('Request body must be valid JSON.')
      }

      const decision = parseDecision(body, paperId)
      if (!decision) return error('Invalid decision payload.')

      const paper = await env.DB.prepare('SELECT id FROM papers WHERE id = ?').bind(paperId).first<{ id: string }>()
      if (!paper) return error('Paper does not exist.', 404)

      await env.DB
        .prepare(
          `INSERT INTO decisions (
             paper_id, state, decided_at, feed_ids_json,
             recommendation_bucket, model_version, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(paper_id) DO UPDATE SET
             state = excluded.state,
             decided_at = excluded.decided_at,
             feed_ids_json = excluded.feed_ids_json,
             recommendation_bucket = excluded.recommendation_bucket,
             model_version = excluded.model_version,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          decision.paperId,
          decision.state,
          decision.decidedAt,
          JSON.stringify(decision.feedIds),
          decision.recommendationBucket ?? null,
          decision.modelVersion ?? null,
        )
        .run()

      return json({ decision })
    }

    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM decisions WHERE paper_id = ?').bind(paperId).run()
      return new Response(null, { status: 204 })
    }
  }

  return error('Not found.', 404)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return new Response(null, { status: 404 })

    try {
      return await handleApi(request, env)
    } catch (cause) {
      console.error('Paper Collector API error', cause)
      return error('Internal server error.', 500)
    }
  },
} satisfies ExportedHandler<Env>
