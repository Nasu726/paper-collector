import baseHandler from './index'
import {
  enrichPendingCrossrefPapers,
  type CrossrefEnrichmentEnv,
} from './crossrefEnrichment'
import {
  handleFeedbackApi,
  type FeedbackEnv,
} from './feedback'
import {
  handleFeedbackArchiveApi,
  type FeedbackArchiveEnv,
} from './feedbackArchive'
import {
  handleFeedLifecycleApi,
  visibleFeedIds,
  type FeedLifecycleEnv,
} from './feedLifecycle'
import type { RefreshEnv } from './feedRefresh'
import {
  handlePaperStorageApi,
  purgeDisposablePapers,
  type PaperGcEnv,
} from './paperGc'
import type { RecommendationEnv } from './recommendation'
import {
  handleRecommendationApiSafely,
  rebuildRecommendationSnapshotsSafely,
} from './recommendationRuntime'

type Env = RefreshEnv &
  CrossrefEnrichmentEnv &
  FeedLifecycleEnv &
  FeedbackEnv &
  FeedbackArchiveEnv &
  RecommendationEnv &
  PaperGcEnv
type BaseFetchRequest = Parameters<typeof baseHandler.fetch>[0]

type EvidenceRow = {
  field_name: string
  provider: string
  provider_record_id: string
  source_field: string
  value_json: string
  observed_at: string
  selected_provider: string | null
  selected_provider_record_id: string | null
  selected_source_field: string | null
  policy_version: string | null
  selected_at: string | null
}

type ProvenanceRow = {
  feed_id: string
  provider: string
  provider_record_id: string
  query_text: string
  provider_updated_at: string | null
  first_seen_at: string
  last_seen_at: string
}

type BootstrapPaper = {
  id?: unknown
  feedIds?: unknown
  recommendation?: unknown
  [key: string]: unknown
}

type BootstrapPayload = {
  feeds?: Array<{ id?: unknown }>
  papers?: BootstrapPaper[]
  decisions?: Record<string, unknown>
  [key: string]: unknown
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

async function requirePaper(env: Env, paperId: string): Promise<boolean> {
  const paper = await env.DB.prepare('SELECT id FROM papers WHERE id = ?').bind(paperId).first<{ id: string }>()
  return Boolean(paper)
}

async function fieldEvidence(env: Env, paperId: string): Promise<Response> {
  if (!(await requirePaper(env, paperId))) return error('Paper does not exist.', 404)

  const result = await env.DB
    .prepare(
      `SELECT e.field_name, e.provider, e.provider_record_id, e.source_field,
              e.value_json, e.observed_at,
              s.provider AS selected_provider,
              s.provider_record_id AS selected_provider_record_id,
              s.source_field AS selected_source_field,
              s.policy_version, s.selected_at
       FROM paper_field_evidence e
       LEFT JOIN paper_field_sources s
         ON s.paper_id = e.paper_id AND s.field_name = e.field_name
       WHERE e.paper_id = ?
       ORDER BY e.field_name, e.provider, e.source_field`,
    )
    .bind(paperId)
    .all<EvidenceRow>()

  return json({
    paperId,
    evidence: result.results.map((row) => ({
      fieldName: row.field_name,
      provider: row.provider,
      providerRecordId: row.provider_record_id,
      sourceField: row.source_field,
      value: JSON.parse(row.value_json) as unknown,
      observedAt: row.observed_at,
      selected:
        row.selected_provider === row.provider &&
        row.selected_provider_record_id === row.provider_record_id &&
        row.selected_source_field === row.source_field,
      selectedSource: row.selected_provider
        ? {
            provider: row.selected_provider,
            providerRecordId: row.selected_provider_record_id,
            sourceField: row.selected_source_field,
            policyVersion: row.policy_version,
            selectedAt: row.selected_at,
          }
        : undefined,
    })),
  })
}

async function ingestionProvenance(env: Env, paperId: string): Promise<Response> {
  if (!(await requirePaper(env, paperId))) return error('Paper does not exist.', 404)

  const result = await env.DB
    .prepare(
      `SELECT feed_id, provider, provider_record_id, query_text,
              provider_updated_at, first_seen_at, last_seen_at
       FROM ingestion_provenance
       WHERE paper_id = ?
       ORDER BY feed_id, provider, provider_record_id`,
    )
    .bind(paperId)
    .all<ProvenanceRow>()

  return json({
    paperId,
    provenance: result.results.map((row) => ({
      feedId: row.feed_id,
      provider: row.provider,
      providerRecordId: row.provider_record_id,
      queryText: row.query_text,
      providerUpdatedAt: row.provider_updated_at ?? undefined,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    })),
  })
}

async function handleMetadataApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/api/enrichment/crossref') {
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw === null ? undefined : Number(limitRaw)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
      return error('limit must be an integer from 1 to 20.')
    }
    return json(await enrichPendingCrossrefPapers(env, { limit }))
  }

  const evidenceMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/evidence$/)
  if (request.method === 'GET' && evidenceMatch) {
    return fieldEvidence(env, decodeURIComponent(evidenceMatch[1]))
  }

  const provenanceMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/provenance$/)
  if (request.method === 'GET' && provenanceMatch) {
    return ingestionProvenance(env, decodeURIComponent(provenanceMatch[1]))
  }

  return null
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

function recommendationModelVersion(paper: BootstrapPaper): string | undefined {
  if (!paper.recommendation || typeof paper.recommendation !== 'object') return undefined
  const modelVersion = (paper.recommendation as Record<string, unknown>).modelVersion
  return typeof modelVersion === 'string' ? modelVersion : undefined
}

async function filteredBootstrap(request: BaseFetchRequest, env: Env): Promise<Response> {
  const response = await baseHandler.fetch(request, env)
  if (!response.ok) return response

  const payload = (await response.json()) as BootstrapPayload
  if (!Array.isArray(payload.feeds)) return json(payload, { status: response.status })

  const [visible, activeModel] = await Promise.all([
    visibleFeedIds(env.DB),
    activeRecommendationModel(env.DB),
  ])
  const visibleFeeds = payload.feeds.filter((feed) => typeof feed.id === 'string' && visible.has(feed.id))
  const decisions = payload.decisions ?? {}
  const papers = Array.isArray(payload.papers)
    ? payload.papers
        .map((paper) => {
          const visiblePaperFeedIds = Array.isArray(paper.feedIds)
            ? paper.feedIds.filter((feedId): feedId is string => typeof feedId === 'string' && visible.has(feedId))
            : []
          const recommendation =
            activeModel && recommendationModelVersion(paper) !== activeModel
              ? undefined
              : paper.recommendation
          return { ...paper, feedIds: visiblePaperFeedIds, recommendation }
        })
        .filter((paper) => {
          const decided = typeof paper.id === 'string' && Object.prototype.hasOwnProperty.call(decisions, paper.id)
          return paper.feedIds.length > 0 || decided
        })
    : payload.papers

  return json(
    {
      ...payload,
      feeds: visibleFeeds,
      papers,
    },
    { status: response.status },
  )
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    try {
      const lifecycleResponse = await handleFeedLifecycleApi(request, env)
      if (lifecycleResponse) return lifecycleResponse

      const feedbackResponse = await handleFeedbackApi(request, env)
      if (feedbackResponse) return feedbackResponse

      const feedbackArchiveResponse = await handleFeedbackArchiveApi(request, env)
      if (feedbackArchiveResponse) return feedbackArchiveResponse

      const recommendationResponse = await handleRecommendationApiSafely(request, env)
      if (recommendationResponse) return recommendationResponse

      const storageResponse = await handlePaperStorageApi(request, env)
      if (storageResponse) return storageResponse

      const metadataResponse = await handleMetadataApi(request, env)
      if (metadataResponse) return metadataResponse

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        return filteredBootstrap(request, env)
      }
    } catch (cause) {
      console.error('Paper Collector extension API error', cause)
      return error('Internal server error.', 500)
    }

    return baseHandler.fetch(request, env)
  },

  async scheduled(controller, env) {
    let ingestionFailure: unknown
    try {
      await baseHandler.scheduled(controller, env)
    } catch (cause) {
      ingestionFailure = cause
    }

    const enrichment = await enrichPendingCrossrefPapers(env, { limit: 8 })
    if (ingestionFailure) throw ingestionFailure
    if (enrichment.failed > 0) {
      throw new Error(`Crossref enrichment failed for ${enrichment.failed} paper(s).`)
    }

    await purgeDisposablePapers(env)
    await rebuildRecommendationSnapshotsSafely(env)
  },
} satisfies ExportedHandler<Env>
