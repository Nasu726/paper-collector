import type {
  Decision,
  DecisionState,
  Feed,
  FeedIngestionStatus,
  Paper,
  PaperIdentifier,
  PublicationStatus,
  RecommendationBucket,
} from '../src/domain'
import {
  FeedRefreshError,
  refreshAllActiveFeeds,
  refreshFeedById,
  validIsoDate,
  type RefreshEnv,
} from './feedRefresh'

type Env = RefreshEnv

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
  ingestion_status: FeedIngestionStatus | null
  watermark_date: string | null
  last_attempt_at: string | null
  last_success_at: string | null
  last_error: string | null
  last_fetched: number | null
  last_pages: number | null
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
  score: number
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
const recommendationBucketOrder: Record<RecommendationBucket, number> = {
  very_high: 0,
  high: 1,
  medium: 2,
  low: 3,
  very_low: 4,
}

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
    ingestion: row.ingestion_status
      ? {
          status: row.ingestion_status,
          watermarkDate: row.watermark_date ?? undefined,
          lastAttemptAt: row.last_attempt_at ?? undefined,
          lastSuccessAt: row.last_success_at ?? undefined,
          lastError: row.last_error ?? undefined,
          lastFetched: row.last_fetched ?? 0,
          lastPages: row.last_pages ?? 0,
        }
      : undefined,
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
      `SELECT f.id, f.name, f.intent, f.exclusions, f.source_policy, f.active, f.provider_query,
              s.status AS ingestion_status, s.watermark_date, s.last_attempt_at,
              s.last_success_at, s.last_error, s.last_fetched, s.last_pages
       FROM feeds f
       LEFT JOIN feed_ingestion_state s ON s.feed_id = f.id
       ORDER BY f.created_at ASC, f.id ASC`,
    )
    .all<FeedRow>()

  return result.results.map(rowToFeed)
}

async function activeRecommendationModel(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT model_version
       FROM recommendation_model_state
       WHERE live_generation > 0
       ORDER BY live_generation DESC
       LIMIT 1`,
    )
    .first<{ model_version: string }>()
  return row?.model_version ?? null
}

async function loadPapers(db: D1Database): Promise<Paper[]> {
  const activeModel = await activeRecommendationModel(db)
  const recommendationStatement = activeModel
    ? db
        .prepare(
          `SELECT paper_id, bucket, reasons_json, model_version, scored_at, score
           FROM recommendation_snapshots
           WHERE feed_id IS NULL AND model_version = ?
           ORDER BY scored_at DESC, id DESC`,
        )
        .bind(activeModel)
    : db.prepare(
        `SELECT paper_id, bucket, reasons_json, model_version, scored_at, score
         FROM recommendation_snapshots
         WHERE feed_id IS NULL
         ORDER BY scored_at DESC, id DESC`,
      )

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
    recommendationStatement.all<RecommendationRow>(),
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

  // Raw scores remain Worker-only. Browser clients receive only an ordinal rank.
  const sourceOrderByPaper = new Map(paperResult.results.map((row, index) => [row.id, index]))
  const recommendationRankByPaper = new Map<string, number>()
  ;[...recommendationByPaper.entries()]
    .sort(([paperIdA, a], [paperIdB, b]) => {
      const bucketDifference = recommendationBucketOrder[a.bucket] - recommendationBucketOrder[b.bucket]
      if (bucketDifference !== 0) return bucketDifference
      if (a.score !== b.score) return b.score - a.score
      const sourceDifference =
        (sourceOrderByPaper.get(paperIdA) ?? Number.MAX_SAFE_INTEGER) -
        (sourceOrderByPaper.get(paperIdB) ?? Number.MAX_SAFE_INTEGER)
      if (sourceDifference !== 0) return sourceDifference
      return paperIdA.localeCompare(paperIdB)
    })
    .forEach(([paperId], index) => recommendationRankByPaper.set(paperId, index + 1))

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
            rank: recommendationRankByPaper.get(row.id),
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

async function parseRefreshBody(request: Request): Promise<RefreshBody | null> {
  if (!request.headers.get('content-type')?.includes('application/json')) return {}
  try {
    const value = (await request.json()) as unknown
    if (!value || typeof value !== 'object') return null
    const candidate = value as Record<string, unknown>
    if (candidate.fromDate !== undefined && !validIsoDate(candidate.fromDate)) return null
    if (candidate.toDate !== undefined && !validIsoDate(candidate.toDate)) return null
    return {
      fromDate: candidate.fromDate as string | undefined,
      toDate: candidate.toDate as string | undefined,
    }
  } catch {
    return null
  }
}

async function refreshFeedEndpoint(request: Request, env: Env, feedId: string): Promise<Response> {
  const body = await parseRefreshBody(request)
  if (!body) return error('Refresh body must contain ISO YYYY-MM-DD fromDate/toDate values.')

  try {
    return json(await refreshFeedById(env, feedId, body))
  } catch (cause) {
    if (cause instanceof FeedRefreshError) return error(cause.message, cause.httpStatus)
    throw cause
  }
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
    return refreshFeedEndpoint(request, env, decodeURIComponent(refreshMatch[1]))
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

  async scheduled(controller, env) {
    await refreshAllActiveFeeds(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
