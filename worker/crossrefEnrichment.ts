import type { PublicationStatus } from '../src/domain'
import {
  FIELD_POLICY_VERSION,
  recordFieldEvidence,
  selectFieldSource,
  type CanonicalFieldName,
} from './fieldEvidence'
import { CrossrefProvider, type CrossrefRecord } from './providers/crossref'

export type CrossrefEnrichmentEnv = {
  DB: D1Database
  CROSSREF_BASE_URL?: string
  CROSSREF_MAILTO?: string
  CROSSREF_MIN_INTERVAL_MS?: string
}

type CandidateRow = {
  paper_id: string
  doi: string
}

type CanonicalPaperRow = {
  id: string
  published_at: string | null
  venue: string | null
  publication_status: PublicationStatus
}

export type CrossrefEnrichmentResult = {
  considered: number
  enriched: number
  notFound: number
  failed: number
  skippedFresh: number
  failures: Array<{ paperId: string; doi: string; error: string }>
}

const statusRank: Record<PublicationStatus, number> = {
  unknown: 0,
  preprint: 1,
  accepted: 2,
  published: 3,
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message.slice(0, 1000)
  return 'Unknown Crossref enrichment failure'
}

function isoBefore(now: Date, milliseconds: number): string {
  return new Date(now.getTime() - milliseconds).toISOString()
}

function intervalFromEnv(env: CrossrefEnrichmentEnv): number {
  const raw = env.CROSSREF_MIN_INTERVAL_MS
  if (raw === undefined) return 225
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 10_000) : 225
}

function datePrecision(value: string | null | undefined): number {
  if (!value) return 0
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 3
  if (/^\d{4}-\d{2}$/.test(value)) return 2
  if (/^\d{4}$/.test(value)) return 1
  return 0
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function candidatePapers(
  db: D1Database,
  now: Date,
  limit: number,
): Promise<{ rows: CandidateRow[]; skippedFresh: number }> {
  const successCutoff = isoBefore(now, 30 * 24 * 60 * 60 * 1000)
  const errorCutoff = isoBefore(now, 6 * 60 * 60 * 1000)

  const result = await db
    .prepare(
      `SELECT pi.paper_id, pi.value AS doi
       FROM paper_identifiers pi
       LEFT JOIN crossref_enrichment_state s ON s.paper_id = pi.paper_id
       LEFT JOIN papers p ON p.id = pi.paper_id
       WHERE pi.kind = 'doi' AND pi.provider = ''
         AND (
           s.paper_id IS NULL
           OR (s.status IN ('success', 'not_found') AND s.last_attempt_at < ?)
           OR (s.status = 'error' AND s.last_attempt_at < ?)
         )
       ORDER BY COALESCE(p.published_at, p.created_at) DESC, pi.paper_id ASC
       LIMIT ?`,
    )
    .bind(successCutoff, errorCutoff, limit)
    .all<CandidateRow>()

  const fresh = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM paper_identifiers pi
       JOIN crossref_enrichment_state s ON s.paper_id = pi.paper_id
       WHERE pi.kind = 'doi' AND pi.provider = ''
         AND (
           (s.status IN ('success', 'not_found') AND s.last_attempt_at >= ?)
           OR (s.status = 'error' AND s.last_attempt_at >= ?)
         )`,
    )
    .bind(successCutoff, errorCutoff)
    .first<{ count: number }>()

  return { rows: result.results, skippedFresh: fresh?.count ?? 0 }
}

async function recordState(
  db: D1Database,
  paperId: string,
  doi: string,
  status: 'success' | 'not_found' | 'error',
  attemptedAt: string,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO crossref_enrichment_state (
         paper_id, doi, status, last_attempt_at, last_success_at, last_error, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(paper_id) DO UPDATE SET
         doi = excluded.doi,
         status = excluded.status,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = CASE
           WHEN excluded.status = 'success' THEN excluded.last_success_at
           ELSE crossref_enrichment_state.last_success_at
         END,
         last_error = excluded.last_error,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(paperId, doi, status, attemptedAt, status === 'success' ? attemptedAt : null, error)
    .run()
}

async function chooseCrossrefSource(
  db: D1Database,
  paperId: string,
  doi: string,
  fieldName: CanonicalFieldName,
  sourceField: string,
): Promise<void> {
  await selectFieldSource(db, {
    paperId,
    fieldName,
    provider: 'crossref',
    providerRecordId: doi,
    sourceField,
    policyVersion: FIELD_POLICY_VERSION,
  })
}

async function applyCanonicalPolicy(
  db: D1Database,
  paperId: string,
  record: CrossrefRecord,
): Promise<void> {
  const paper = await db
    .prepare('SELECT id, published_at, venue, publication_status FROM papers WHERE id = ?')
    .bind(paperId)
    .first<CanonicalPaperRow>()
  if (!paper) throw new Error(`Paper disappeared during Crossref enrichment: ${paperId}`)

  for (const evidence of record.evidence) {
    await recordFieldEvidence(db, {
      paperId,
      fieldName: evidence.fieldName,
      provider: 'crossref',
      providerRecordId: record.doi,
      sourceField: evidence.sourceField,
      value: evidence.value,
    })
  }

  if (record.acceptedAt) {
    await db
      .prepare('UPDATE papers SET accepted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(record.acceptedAt, paperId)
      .run()
    await chooseCrossrefSource(db, paperId, record.doi, 'accepted_at', 'accepted')
  }

  if (
    record.publishedAt &&
    record.publicationDateSource &&
    datePrecision(record.publishedAt) >= datePrecision(paper.published_at)
  ) {
    await db
      .prepare('UPDATE papers SET published_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(record.publishedAt, paperId)
      .run()
    await chooseCrossrefSource(db, paperId, record.doi, 'published_at', record.publicationDateSource)
  }

  if (record.venue && !paper.venue?.trim()) {
    await db
      .prepare('UPDATE papers SET venue = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(record.venue, paperId)
      .run()
    await chooseCrossrefSource(db, paperId, record.doi, 'venue', 'container-title')
  }

  if (
    record.publicationStatus !== 'unknown' &&
    statusRank[record.publicationStatus] >= statusRank[paper.publication_status]
  ) {
    await db
      .prepare('UPDATE papers SET publication_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(record.publicationStatus, paperId)
      .run()
    await chooseCrossrefSource(
      db,
      paperId,
      record.doi,
      'publication_status',
      record.publishedAt ? record.publicationDateSource ?? 'published' : 'accepted',
    )
  }
}

export async function enrichPendingCrossrefPapers(
  env: CrossrefEnrichmentEnv,
  options: { limit?: number; now?: Date } = {},
): Promise<CrossrefEnrichmentResult> {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20)
  const now = options.now ?? new Date()
  const attemptedAt = now.toISOString()
  const candidates = await candidatePapers(env.DB, now, limit)
  const provider = new CrossrefProvider({
    baseUrl: env.CROSSREF_BASE_URL,
    mailto: env.CROSSREF_MAILTO,
  })
  const minIntervalMs = intervalFromEnv(env)

  let enriched = 0
  let notFound = 0
  let failed = 0
  const failures: Array<{ paperId: string; doi: string; error: string }> = []

  for (let index = 0; index < candidates.rows.length; index += 1) {
    const candidate = candidates.rows[index]
    try {
      const record = await provider.lookupDoi(candidate.doi)
      if (!record) {
        notFound += 1
        await recordState(env.DB, candidate.paper_id, candidate.doi, 'not_found', attemptedAt, null)
      } else {
        await applyCanonicalPolicy(env.DB, candidate.paper_id, record)
        enriched += 1
        await recordState(env.DB, candidate.paper_id, candidate.doi, 'success', attemptedAt, null)
      }
    } catch (cause) {
      failed += 1
      const message = errorMessage(cause)
      failures.push({ paperId: candidate.paper_id, doi: candidate.doi, error: message })
      await recordState(env.DB, candidate.paper_id, candidate.doi, 'error', attemptedAt, message)
    }

    if (index + 1 < candidates.rows.length) await sleep(minIntervalMs)
  }

  return {
    considered: candidates.rows.length,
    enriched,
    notFound,
    failed,
    skippedFresh: candidates.skippedFresh,
    failures,
  }
}
