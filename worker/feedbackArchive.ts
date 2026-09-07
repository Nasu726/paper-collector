export const FEEDBACK_ARCHIVE_PREFIX = 'paper-collector/cold/v1/feedback'
export const FEEDBACK_ARCHIVE_SCHEMA_VERSION = '1'
export const FEEDBACK_ARCHIVE_DEFAULT_LIMIT = 50
export const FEEDBACK_ARCHIVE_MAX_LIMIT = 50

export type FeedbackArchiveEnv = {
  DB: D1Database
  COLD_ARCHIVE: R2Bucket
}

type FeedbackRow = {
  id: string
  paper_id: string
  feed_id: string | null
  event_type: string
  event_at: string
  weight: number | null
  metadata_json: string | null
}

type FeedbackGroup = {
  paperId: string
  eventType: string
  metadataJson: string
  eventCount: number
  firstEventAt: string
  lastEventAt: string
}

type ArchiveObjectPlan = {
  batchId: string
  objectKey: string
  checksumSha256: string
  byteLength: number
  recordCount: number
  firstEventAt: string
  lastEventAt: string
  payload: Uint8Array
  digest: ArrayBuffer
}

export type FeedbackArchiveStatus = {
  rawEvents: number
  compactGroups: number
  compactEvents: number
  archivedBatches: number
  archivedRecords: number
  archivedBytes: number
  oldestRawEventAt?: string
}

export type FeedbackArchiveResult = {
  dryRun: boolean
  cutoffAt: string
  limit: number
  candidates: number
  batchId?: string
  objectKey?: string
  checksumSha256?: string
  byteLength?: number
  archived: number
  compactGroups: number
  before: FeedbackArchiveStatus
  after: FeedbackArchiveStatus
}

export class FeedbackArchiveBusyError extends Error {
  constructor() {
    super('A feedback archive job is already running. Retry after its short lease expires.')
    this.name = 'FeedbackArchiveBusyError'
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

function parseCutoff(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return null
  return new Date(timestamp).toISOString()
}

function boundedLimit(value: unknown): number | null {
  if (value === undefined) return FEEDBACK_ARCHIVE_DEFAULT_LIMIT
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > FEEDBACK_ARCHIVE_MAX_LIMIT) return null
  return Number(value)
}

async function loadCandidates(db: D1Database, cutoffAt: string, limit: number): Promise<FeedbackRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, paper_id, feed_id, event_type, event_at, weight, metadata_json
       FROM feedback_events
       WHERE event_at < ?
       ORDER BY event_at ASC, rowid ASC
       LIMIT ?`,
    )
    .bind(cutoffAt, limit)
    .all<FeedbackRow>()
  return rows.results
}

function archiveRecord(row: FeedbackRow) {
  return {
    schemaVersion: 1,
    id: row.id,
    paperId: row.paper_id,
    feedId: row.feed_id,
    eventType: row.event_type,
    eventAt: row.event_at,
    weight: row.weight,
    metadataJson: row.metadata_json,
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function objectPlan(rows: FeedbackRow[]): Promise<ArchiveObjectPlan> {
  if (!rows.length) throw new Error('Cannot build an archive object without feedback rows.')
  const text = `${rows.map((row) => JSON.stringify(archiveRecord(row))).join('\n')}\n`
  const payload = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', payload)
  const checksumSha256 = hex(digest)
  const firstEventAt = rows[0].event_at
  const lastEventAt = rows[rows.length - 1].event_at
  const month = /^\d{4}-\d{2}/.exec(firstEventAt)?.[0] ?? 'unknown-month'
  return {
    batchId: checksumSha256,
    objectKey: `${FEEDBACK_ARCHIVE_PREFIX}/${month}/${checksumSha256}.jsonl`,
    checksumSha256,
    byteLength: payload.byteLength,
    recordCount: rows.length,
    firstEventAt,
    lastEventAt,
    payload,
    digest,
  }
}

function groupRows(rows: FeedbackRow[]): FeedbackGroup[] {
  const groups = new Map<string, FeedbackGroup>()
  for (const row of rows) {
    const metadataJson = row.metadata_json ?? ''
    const key = `${row.paper_id}\u0000${row.event_type}\u0000${metadataJson}`
    const existing = groups.get(key)
    if (existing) {
      existing.eventCount += 1
      if (row.event_at < existing.firstEventAt) existing.firstEventAt = row.event_at
      if (row.event_at > existing.lastEventAt) existing.lastEventAt = row.event_at
    } else {
      groups.set(key, {
        paperId: row.paper_id,
        eventType: row.event_type,
        metadataJson,
        eventCount: 1,
        firstEventAt: row.event_at,
        lastEventAt: row.event_at,
      })
    }
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.paperId.localeCompare(right.paperId) ||
      left.eventType.localeCompare(right.eventType) ||
      left.metadataJson.localeCompare(right.metadataJson),
  )
}

async function archiveStatus(db: D1Database): Promise<FeedbackArchiveStatus> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM feedback_events) AS raw_events,
         (SELECT COUNT(*) FROM feedback_compact) AS compact_groups,
         COALESCE((SELECT SUM(event_count) FROM feedback_compact), 0) AS compact_events,
         (SELECT COUNT(*) FROM cold_archive_batches WHERE archive_type = 'feedback-v1') AS archived_batches,
         COALESCE((SELECT SUM(record_count) FROM cold_archive_batches WHERE archive_type = 'feedback-v1'), 0) AS archived_records,
         COALESCE((SELECT SUM(byte_length) FROM cold_archive_batches WHERE archive_type = 'feedback-v1'), 0) AS archived_bytes,
         (SELECT MIN(event_at) FROM feedback_events) AS oldest_raw_event_at`,
    )
    .first<{
      raw_events: number
      compact_groups: number
      compact_events: number
      archived_batches: number
      archived_records: number
      archived_bytes: number
      oldest_raw_event_at: string | null
    }>()

  if (!row) throw new Error('Failed to read feedback archive status.')
  return {
    rawEvents: row.raw_events,
    compactGroups: row.compact_groups,
    compactEvents: row.compact_events,
    archivedBatches: row.archived_batches,
    archivedRecords: row.archived_records,
    archivedBytes: row.archived_bytes,
    oldestRawEventAt: row.oldest_raw_event_at ?? undefined,
  }
}

async function acquireLease(db: D1Database): Promise<string> {
  const token = crypto.randomUUID()
  const row = await db
    .prepare(
      `INSERT INTO cold_archive_leases (name, token, lease_until)
       VALUES ('feedback', ?, datetime('now', '+5 minutes'))
       ON CONFLICT(name) DO UPDATE SET
         token = excluded.token,
         lease_until = excluded.lease_until
       WHERE cold_archive_leases.lease_until <= CURRENT_TIMESTAMP
       RETURNING token`,
    )
    .bind(token)
    .first<{ token: string }>()
  if (row?.token !== token) throw new FeedbackArchiveBusyError()
  return token
}

async function releaseLease(db: D1Database, token: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM cold_archive_leases WHERE name = 'feedback' AND token = ?").bind(token).run()
  } catch (cause) {
    console.warn('Failed to release feedback archive lease', cause)
  }
}

function objectMetadata(plan: ArchiveObjectPlan): Record<string, string> {
  return {
    schemaVersion: FEEDBACK_ARCHIVE_SCHEMA_VERSION,
    archiveType: 'feedback-v1',
    checksumSha256: plan.checksumSha256,
    recordCount: String(plan.recordCount),
    byteLength: String(plan.byteLength),
    firstEventAt: plan.firstEventAt,
    lastEventAt: plan.lastEventAt,
  }
}

function verifyObject(object: R2Object | null, plan: ArchiveObjectPlan): R2Object {
  if (!object) throw new Error(`R2 verification failed: ${plan.objectKey} is missing after upload.`)
  const metadata = object.customMetadata ?? {}
  if (
    object.size !== plan.byteLength ||
    metadata.schemaVersion !== FEEDBACK_ARCHIVE_SCHEMA_VERSION ||
    metadata.archiveType !== 'feedback-v1' ||
    metadata.checksumSha256 !== plan.checksumSha256 ||
    metadata.recordCount !== String(plan.recordCount) ||
    metadata.byteLength !== String(plan.byteLength)
  ) {
    throw new Error(`R2 verification failed for ${plan.objectKey}; metadata or size does not match the planned batch.`)
  }
  return object
}

async function ensureObject(bucket: R2Bucket, plan: ArchiveObjectPlan): Promise<R2Object> {
  const existing = await bucket.head(plan.objectKey)
  if (existing) return verifyObject(existing, plan)

  await bucket.put(plan.objectKey, plan.payload, {
    httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' },
    customMetadata: objectMetadata(plan),
    sha256: plan.digest,
  })
  return verifyObject(await bucket.head(plan.objectKey), plan)
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

async function commitArchive(
  db: D1Database,
  rows: FeedbackRow[],
  groups: FeedbackGroup[],
  plan: ArchiveObjectPlan,
  cutoffAt: string,
  etag: string,
): Promise<number> {
  const statements: D1PreparedStatement[] = groups.map((group) =>
    db
      .prepare(
        `INSERT INTO feedback_compact (
           paper_id, event_type, metadata_json, event_count,
           first_event_at, last_event_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(paper_id, event_type, metadata_json) DO UPDATE SET
           event_count = feedback_compact.event_count + excluded.event_count,
           first_event_at = MIN(feedback_compact.first_event_at, excluded.first_event_at),
           last_event_at = MAX(feedback_compact.last_event_at, excluded.last_event_at),
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        group.paperId,
        group.eventType,
        group.metadataJson,
        group.eventCount,
        group.firstEventAt,
        group.lastEventAt,
      ),
  )

  statements.push(
    db
      .prepare(`DELETE FROM feedback_events WHERE id IN (${placeholders(rows.length)})`)
      .bind(...rows.map((row) => row.id)),
  )
  statements.push(
    db
      .prepare(
        `INSERT INTO cold_archive_batches (
           batch_id, archive_type, object_key, checksum_sha256,
           record_count, byte_length, cutoff_at, first_event_at,
           last_event_at, object_etag, completed_at
         ) VALUES (?, 'feedback-v1', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .bind(
        plan.batchId,
        plan.objectKey,
        plan.checksumSha256,
        plan.recordCount,
        plan.byteLength,
        cutoffAt,
        plan.firstEventAt,
        plan.lastEventAt,
        etag,
      ),
  )

  const results = await db.batch(statements)
  const deleteResult = results[groups.length]
  return deleteResult?.meta.changes ?? 0
}

export async function archiveFeedbackBefore(
  env: FeedbackArchiveEnv,
  options: { cutoffAt: string; limit?: number; dryRun?: boolean },
): Promise<FeedbackArchiveResult> {
  const cutoffAt = parseCutoff(options.cutoffAt)
  if (!cutoffAt) throw new Error('cutoffAt must be a valid non-future ISO timestamp.')
  const limit = boundedLimit(options.limit)
  if (!limit) throw new Error(`limit must be an integer from 1 to ${FEEDBACK_ARCHIVE_MAX_LIMIT}.`)
  const dryRun = options.dryRun === true
  const before = await archiveStatus(env.DB)

  let leaseToken: string | undefined
  try {
    if (!dryRun) leaseToken = await acquireLease(env.DB)
    const rows = await loadCandidates(env.DB, cutoffAt, limit)
    if (!rows.length) {
      return {
        dryRun,
        cutoffAt,
        limit,
        candidates: 0,
        archived: 0,
        compactGroups: 0,
        before,
        after: before,
      }
    }

    const plan = await objectPlan(rows)
    const groups = groupRows(rows)
    if (dryRun) {
      return {
        dryRun: true,
        cutoffAt,
        limit,
        candidates: rows.length,
        batchId: plan.batchId,
        objectKey: plan.objectKey,
        checksumSha256: plan.checksumSha256,
        byteLength: plan.byteLength,
        archived: 0,
        compactGroups: groups.length,
        before,
        after: before,
      }
    }

    const object = await ensureObject(env.COLD_ARCHIVE, plan)
    const archived = await commitArchive(env.DB, rows, groups, plan, cutoffAt, object.etag)
    if (archived !== rows.length) {
      throw new Error(`D1 archive transaction deleted ${archived} raw rows, expected ${rows.length}.`)
    }
    const after = await archiveStatus(env.DB)
    return {
      dryRun: false,
      cutoffAt,
      limit,
      candidates: rows.length,
      batchId: plan.batchId,
      objectKey: plan.objectKey,
      checksumSha256: plan.checksumSha256,
      byteLength: plan.byteLength,
      archived,
      compactGroups: groups.length,
      before,
      after,
    }
  } finally {
    if (leaseToken) await releaseLease(env.DB, leaseToken)
  }
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function handleFeedbackArchiveApi(
  request: Request,
  env: FeedbackArchiveEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/storage/feedback-archive') {
    return json(await archiveStatus(env.DB))
  }

  if (request.method === 'POST' && url.pathname === '/api/storage/feedback-archive') {
    const body = await requestBody(request)
    const cutoffAt = parseCutoff(body.cutoffAt)
    const limit = boundedLimit(body.limit)
    if (!cutoffAt) return json({ error: 'cutoffAt must be a valid non-future ISO timestamp.' }, { status: 400 })
    if (!limit) {
      return json({ error: `limit must be an integer from 1 to ${FEEDBACK_ARCHIVE_MAX_LIMIT}.` }, { status: 400 })
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return json({ error: 'dryRun must be boolean when provided.' }, { status: 400 })
    }

    try {
      return json(await archiveFeedbackBefore(env, { cutoffAt, limit, dryRun: body.dryRun === true }))
    } catch (cause) {
      if (cause instanceof FeedbackArchiveBusyError) return json({ error: cause.message }, { status: 409 })
      throw cause
    }
  }

  return null
}
