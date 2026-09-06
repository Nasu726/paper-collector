import type {
  FeedbackEvent,
  FeedbackEventType,
  FeedbackSurface,
} from '../src/domain'

export type FeedbackEventEnv = {
  DB: D1Database
}

type FeedbackEventRow = {
  id: string
  paper_id: string
  event_type: FeedbackEventType
  event_at: string
  surface: FeedbackSurface | null
  feed_ids_json: string
  schema_version: number
  received_at: string | null
}

const eventTypes = new Set<FeedbackEventType>([
  'abstract_expanded',
  'pdf_opened',
  'source_opened',
  'saved_reopened',
])
const surfaces = new Set<FeedbackSurface>(['inbox', 'saved', 'archive'])
const inputFields = new Set(['id', 'paperId', 'type', 'surface', 'occurredAt', 'feedIds', 'schemaVersion'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class FeedbackConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedbackConflictError'
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

function error(message: string, status = 400): Response {
  return json({ error: message }, { status })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseFeedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('feedIds must contain between 1 and 20 Feed IDs.')
  }
  if (!value.every((feedId) => typeof feedId === 'string' && feedId.length > 0 && feedId.length <= 128)) {
    throw new Error('feedIds contains an invalid Feed ID.')
  }
  return [...new Set(value)].sort()
}

function parseEvent(value: Record<string, unknown>): FeedbackEvent {
  const unknown = Object.keys(value).filter((key) => !inputFields.has(key))
  if (unknown.length) throw new Error(`Unknown feedback field(s): ${unknown.join(', ')}.`)

  if (typeof value.id !== 'string' || !uuidPattern.test(value.id)) {
    throw new Error('id must be a UUID.')
  }
  if (typeof value.paperId !== 'string' || !value.paperId || value.paperId.length > 256) {
    throw new Error('paperId is invalid.')
  }
  if (typeof value.type !== 'string' || !eventTypes.has(value.type as FeedbackEventType)) {
    throw new Error('type is invalid.')
  }
  if (typeof value.surface !== 'string' || !surfaces.has(value.surface as FeedbackSurface)) {
    throw new Error('surface is invalid.')
  }
  if (value.schemaVersion !== 1) throw new Error('schemaVersion must be 1.')
  if (typeof value.occurredAt !== 'string') throw new Error('occurredAt must be an ISO timestamp.')

  const timestamp = Date.parse(value.occurredAt)
  if (!Number.isFinite(timestamp)) throw new Error('occurredAt must be an ISO timestamp.')

  return {
    id: value.id.toLowerCase(),
    paperId: value.paperId,
    type: value.type as FeedbackEventType,
    surface: value.surface as FeedbackSurface,
    occurredAt: new Date(timestamp).toISOString(),
    feedIds: parseFeedIds(value.feedIds),
    schemaVersion: 1,
  }
}

function parseStoredFeedIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return []
    return [...new Set(value)].sort()
  } catch {
    return []
  }
}

function rowToEvent(row: FeedbackEventRow): FeedbackEvent {
  if (!row.surface || !surfaces.has(row.surface)) throw new Error(`Feedback event ${row.id} has invalid surface.`)
  if (row.schema_version !== 1) throw new Error(`Feedback event ${row.id} has unsupported schema version.`)
  return {
    id: row.id,
    paperId: row.paper_id,
    type: row.event_type,
    surface: row.surface,
    occurredAt: row.event_at,
    feedIds: parseStoredFeedIds(row.feed_ids_json),
    schemaVersion: 1,
  }
}

function sameEvent(left: FeedbackEvent, right: FeedbackEvent): boolean {
  return (
    left.id === right.id &&
    left.paperId === right.paperId &&
    left.type === right.type &&
    left.surface === right.surface &&
    left.occurredAt === right.occurredAt &&
    left.schemaVersion === right.schemaVersion &&
    left.feedIds.length === right.feedIds.length &&
    left.feedIds.every((feedId, index) => feedId === right.feedIds[index])
  )
}

async function loadEvent(db: D1Database, eventId: string): Promise<FeedbackEventRow | null> {
  return db
    .prepare(
      `SELECT id, paper_id, event_type, event_at, surface,
              feed_ids_json, schema_version, received_at
       FROM feedback_events WHERE id = ?`,
    )
    .bind(eventId)
    .first<FeedbackEventRow>()
}

async function validateContext(db: D1Database, event: FeedbackEvent): Promise<void> {
  const paper = await db.prepare('SELECT id FROM papers WHERE id = ?').bind(event.paperId).first<{ id: string }>()
  if (!paper) throw new Error('Paper does not exist.')

  const memberships = await db
    .prepare('SELECT feed_id FROM paper_feeds WHERE paper_id = ?')
    .bind(event.paperId)
    .all<{ feed_id: string }>()
  const validFeedIds = new Set(memberships.results.map((row) => row.feed_id))
  const invalid = event.feedIds.filter((feedId) => !validFeedIds.has(feedId))
  if (invalid.length) throw new Error(`Feed context is invalid for Paper: ${invalid.join(', ')}.`)
}

async function persistEvent(db: D1Database, event: FeedbackEvent): Promise<{ event: FeedbackEvent; duplicate: boolean }> {
  const existing = await loadEvent(db, event.id)
  if (existing) {
    const stored = rowToEvent(existing)
    if (!sameEvent(stored, event)) throw new FeedbackConflictError('Event ID already exists with different content.')
    return { event: stored, duplicate: true }
  }

  await validateContext(db, event)

  const statements = [
    db
      .prepare(
        `INSERT INTO feedback_events (
           id, paper_id, feed_id, event_type, event_at, weight, metadata_json,
           surface, feed_ids_json, schema_version, received_at
         ) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .bind(
        event.id,
        event.paperId,
        event.type,
        event.occurredAt,
        event.surface,
        JSON.stringify(event.feedIds),
        event.schemaVersion,
      ),
    ...event.feedIds.map((feedId) =>
      db
        .prepare('INSERT INTO feedback_event_feeds (event_id, feed_id) VALUES (?, ?)')
        .bind(event.id, feedId),
    ),
  ]

  try {
    await db.batch(statements)
  } catch (cause) {
    const raced = await loadEvent(db, event.id)
    if (raced) {
      const stored = rowToEvent(raced)
      if (sameEvent(stored, event)) return { event: stored, duplicate: true }
      throw new FeedbackConflictError('Event ID already exists with different content.')
    }
    throw cause
  }

  return { event, duplicate: false }
}

async function recordEvent(request: Request, env: FeedbackEventEnv): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return error('Request body must be valid JSON.')
  }
  if (!isObject(body)) return error('Request body must be a JSON object.')

  let event: FeedbackEvent
  try {
    event = parseEvent(body)
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : 'Invalid feedback event.')
  }

  try {
    const result = await persistEvent(env.DB, event)
    return json(result, { status: result.duplicate ? 200 : 201 })
  } catch (cause) {
    if (cause instanceof FeedbackConflictError) return error(cause.message, 409)
    if (cause instanceof Error && (cause.message === 'Paper does not exist.' || cause.message.startsWith('Feed context is invalid'))) {
      return error(cause.message, 422)
    }
    throw cause
  }
}

async function listPaperEvents(env: FeedbackEventEnv, paperId: string): Promise<Response> {
  const paper = await env.DB.prepare('SELECT id FROM papers WHERE id = ?').bind(paperId).first<{ id: string }>()
  if (!paper) return error('Paper does not exist.', 404)

  const rows = await env.DB
    .prepare(
      `SELECT id, paper_id, event_type, event_at, surface,
              feed_ids_json, schema_version, received_at
       FROM feedback_events
       WHERE paper_id = ?
       ORDER BY event_at ASC, id ASC`,
    )
    .bind(paperId)
    .all<FeedbackEventRow>()

  return json({
    paperId,
    events: rows.results.map((row) => ({
      ...rowToEvent(row),
      receivedAt: row.received_at ?? undefined,
    })),
  })
}

export async function handleFeedbackEventApi(
  request: Request,
  env: FeedbackEventEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/api/feedback-events') {
    return recordEvent(request, env)
  }

  const paperMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/feedback-events$/)
  if (request.method === 'GET' && paperMatch) {
    return listPaperEvents(env, decodeURIComponent(paperMatch[1]))
  }

  return null
}
