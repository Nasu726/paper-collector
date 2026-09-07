import { RECOMMENDATION_MODEL_VERSION, tokenizeLexicalText } from './recommendation'

export const PAPER_GC_RETENTION_DAYS = 30
export const PAPER_GC_DEFAULT_LIMIT = 50
export const PAPER_GC_MAX_LIMIT = 200

export type PaperGcEnv = {
  DB: D1Database
}

type CandidateRow = {
  id: string
  title: string
  abstract: string
  estimated_source_bytes: number
}

type CountRow = {
  count: number
}

type StorageRow = {
  paper_rows: number
  rejected_rows: number
  feedback_rows: number
  purged_learning_rows: number
  seen_identifier_rows: number
  retention_refs: number
  estimated_paper_bytes: number
}

export type PaperStorageStats = {
  paperRows: number
  rejectedRows: number
  feedbackRows: number
  purgedLearningRows: number
  seenIdentifierRows: number
  retentionRefs: number
  estimatedPaperBytes: number
}

export type PaperGcResult = {
  retentionDays: number
  cutoff: string
  candidates: number
  purged: number
  skipped: number
  estimatedBytesFreed: number
  before: PaperStorageStats
  after: PaperStorageStats
}

function boundedTerms(text: string, uniqueLimit: number): string {
  const counts = new Map<string, number>()
  for (const token of tokenizeLexicalText(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, uniqueLimit)
    .flatMap(([token, count]) => Array.from({ length: Math.min(count, 3) }, () => token))
    .join(' ')
}

function cutoffIso(referenceTime: Date, retentionDays: number): string {
  return new Date(referenceTime.getTime() - retentionDays * 86_400_000).toISOString()
}

function eligibilitySql(alias = 'p'): string {
  return `EXISTS (
    SELECT 1
    FROM decisions d
    WHERE d.paper_id = ${alias}.id
      AND d.state = 'rejected'
      AND d.decided_at <= ?
  )
  AND NOT EXISTS (
    SELECT 1 FROM paper_retention_refs r WHERE r.paper_id = ${alias}.id
  )`
}

export async function paperStorageStats(db: D1Database): Promise<PaperStorageStats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM papers) AS paper_rows,
         (SELECT COUNT(*) FROM decisions WHERE state = 'rejected') AS rejected_rows,
         (SELECT COUNT(*) FROM feedback_events) AS feedback_rows,
         (SELECT COUNT(*) FROM purged_paper_learning) AS purged_learning_rows,
         (SELECT COUNT(*) FROM seen_paper_identifiers) AS seen_identifier_rows,
         (SELECT COUNT(*) FROM paper_retention_refs) AS retention_refs,
         COALESCE((
           SELECT SUM(
             length(CAST(title AS BLOB)) +
             length(CAST(abstract AS BLOB)) +
             length(CAST(authors_json AS BLOB)) +
             length(CAST(COALESCE(venue, '') AS BLOB)) +
             length(CAST(source_url AS BLOB)) +
             length(CAST(COALESCE(pdf_url, '') AS BLOB)) +
             length(CAST(identifiers_json AS BLOB))
           ) FROM papers
         ), 0) AS estimated_paper_bytes`,
    )
    .first<StorageRow>()

  if (!row) throw new Error('Failed to read Paper storage stats.')
  return {
    paperRows: row.paper_rows,
    rejectedRows: row.rejected_rows,
    feedbackRows: row.feedback_rows,
    purgedLearningRows: row.purged_learning_rows,
    seenIdentifierRows: row.seen_identifier_rows,
    retentionRefs: row.retention_refs,
    estimatedPaperBytes: row.estimated_paper_bytes,
  }
}

async function loadCandidates(
  db: D1Database,
  cutoff: string,
  limit: number,
): Promise<CandidateRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         p.id,
         p.title,
         p.abstract,
         (
           length(CAST(p.title AS BLOB)) +
           length(CAST(p.abstract AS BLOB)) +
           length(CAST(p.authors_json AS BLOB)) +
           length(CAST(COALESCE(p.venue, '') AS BLOB)) +
           length(CAST(p.source_url AS BLOB)) +
           length(CAST(COALESCE(p.pdf_url, '') AS BLOB)) +
           length(CAST(p.identifiers_json AS BLOB))
         ) AS estimated_source_bytes
       FROM papers p
       JOIN decisions d ON d.paper_id = p.id
       WHERE d.state = 'rejected'
         AND d.decided_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM paper_retention_refs r WHERE r.paper_id = p.id
         )
       ORDER BY d.decided_at ASC, p.id ASC
       LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<CandidateRow>()
  return rows.results
}

async function purgeCandidate(
  db: D1Database,
  candidate: CandidateRow,
  cutoff: string,
  purgedAt: string,
): Promise<boolean> {
  const titleTerms = boundedTerms(candidate.title, 24)
  const abstractTerms = boundedTerms(candidate.abstract, 64)
  const eligible = eligibilitySql('p')

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO purged_paper_learning (
           paper_id, feature_version, title_terms, abstract_terms, purged_at, estimated_source_bytes
         )
         SELECT p.id, ?, ?, ?, ?, ?
         FROM papers p
         WHERE p.id = ? AND ${eligible}
         ON CONFLICT(paper_id) DO UPDATE SET
           feature_version = excluded.feature_version,
           title_terms = excluded.title_terms,
           abstract_terms = excluded.abstract_terms,
           purged_at = excluded.purged_at,
           estimated_source_bytes = excluded.estimated_source_bytes`,
      )
      .bind(
        RECOMMENDATION_MODEL_VERSION,
        titleTerms,
        abstractTerms,
        purgedAt,
        candidate.estimated_source_bytes,
        candidate.id,
        cutoff,
      ),
    db
      .prepare(
        `INSERT INTO seen_paper_identifiers (
           kind, value, provider, first_seen_at, last_seen_at
         )
         SELECT pi.kind, pi.value, pi.provider, ?, ?
         FROM paper_identifiers pi
         JOIN papers p ON p.id = pi.paper_id
         WHERE p.id = ? AND ${eligible}
         ON CONFLICT(kind, value, provider) DO UPDATE SET
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(purgedAt, purgedAt, candidate.id, cutoff),
    db
      .prepare(
        `DELETE FROM recommendation_snapshots
         WHERE paper_id = ?
           AND EXISTS (SELECT 1 FROM papers p WHERE p.id = ? AND ${eligible})`,
      )
      .bind(candidate.id, candidate.id, cutoff),
    db
      .prepare(
        `DELETE FROM recommendation_snapshot_staging
         WHERE paper_id = ?
           AND EXISTS (SELECT 1 FROM papers p WHERE p.id = ? AND ${eligible})`,
      )
      .bind(candidate.id, candidate.id, cutoff),
    db
      .prepare(
        `DELETE FROM papers
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM decisions d
             WHERE d.paper_id = papers.id
               AND d.state = 'rejected'
               AND d.decided_at <= ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM paper_retention_refs r WHERE r.paper_id = papers.id
           )`,
      )
      .bind(candidate.id, cutoff),
  ])

  return (results[4]?.meta.changes ?? 0) > 0
}

export async function purgeDisposablePapers(
  env: PaperGcEnv,
  options: {
    limit?: number
    referenceTime?: Date
    retentionDays?: number
  } = {},
): Promise<PaperGcResult> {
  const limit = Math.max(1, Math.min(PAPER_GC_MAX_LIMIT, options.limit ?? PAPER_GC_DEFAULT_LIMIT))
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? PAPER_GC_RETENTION_DAYS))
  const referenceTime = options.referenceTime ?? new Date()
  const cutoff = cutoffIso(referenceTime, retentionDays)
  const before = await paperStorageStats(env.DB)
  const candidates = await loadCandidates(env.DB, cutoff, limit)
  const purgedAt = referenceTime.toISOString()

  let purged = 0
  let estimatedBytesFreed = 0
  for (const candidate of candidates) {
    const deleted = await purgeCandidate(env.DB, candidate, cutoff, purgedAt)
    if (!deleted) continue
    purged += 1
    estimatedBytesFreed += candidate.estimated_source_bytes
  }

  const after = await paperStorageStats(env.DB)
  return {
    retentionDays,
    cutoff,
    candidates: candidates.length,
    purged,
    skipped: candidates.length - purged,
    estimatedBytesFreed,
    before,
    after,
  }
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

export async function handlePaperStorageApi(
  request: Request,
  env: PaperGcEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/storage/stats') {
    return json(await paperStorageStats(env.DB))
  }

  if (request.method === 'POST' && url.pathname === '/api/storage/gc') {
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit === null ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > PAPER_GC_MAX_LIMIT)) {
      return json({ error: `limit must be an integer from 1 to ${PAPER_GC_MAX_LIMIT}.` }, { status: 400 })
    }
    return json(await purgeDisposablePapers(env, { limit }))
  }

  return null
}
