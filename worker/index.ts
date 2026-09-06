import type { Decision, DecisionState, RecommendationBucket } from '../src/domain'

type Env = {
  DB: D1Database
}

type DecisionRow = {
  paper_id: string
  state: DecisionState
  decided_at: string
  feed_ids_json: string
  recommendation_bucket: RecommendationBucket | null
  model_version: string | null
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

function rowToDecision(row: DecisionRow): Decision {
  return {
    paperId: row.paper_id,
    state: row.state,
    decidedAt: row.decided_at,
    feedIds: JSON.parse(row.feed_ids_json) as string[],
    recommendationBucket: row.recommendation_bucket ?? undefined,
    modelVersion: row.model_version ?? undefined,
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

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/api/health') {
    await env.DB.prepare('SELECT 1').first()
    return json({ ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const decisions = await loadDecisions(env.DB)
    return json({ decisions })
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
