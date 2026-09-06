export type FeedbackEnv = {
  DB: D1Database
}

export type FeedbackEventType = 'abstract_expanded' | 'pdf_opened' | 'source_opened'
export type FeedbackSurface = 'inbox' | 'saved' | 'archive'

type FeedbackRow = {
  id: string
  paper_id: string
  event_type: FeedbackEventType
  event_at: string
  weight: number | null
  metadata_json: string | null
}

type FeedbackMetadata = {
  surface: FeedbackSurface
  feedIds: string[]
}

const eventTypes = new Set<FeedbackEventType>([
  'abstract_expanded',
  'pdf_opened',
  'source_opened',
])
const surfaces = new Set<FeedbackSurface>(['inbox', 'saved', 'archive'])
const createFields = new Set(['paperId', 'type', 'surface'])

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

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function parseCreate(body: Record<string, unknown>): {
  paperId: string
  type: FeedbackEventType
  surface: FeedbackSurface
} {
  const unknown = Object.keys(body).filter((key) => !createFields.has(key))
  if (unknown.length) throw new Error(`Unknown feedback field(s): ${unknown.join(', ')}.`)

  if (typeof body.paperId !== 'string' || !body.paperId.trim()) {
    throw new Error('paperId must be a non-empty string.')
  }
  if (body.paperId.length > 300) throw new Error('paperId must be at most 300 characters.')

  if (typeof body.type !== 'string' || !eventTypes.has(body.type as FeedbackEventType)) {
    throw new Error('type is invalid.')
  }
  if (typeof body.surface !== 'string' || !surfaces.has(body.surface as FeedbackSurface)) {
    throw new Error('surface is invalid.')
  }

  return {
    paperId: body.paperId,
    type: body.type as FeedbackEventType,
    surface: body.surface as FeedbackSurface,
  }
}

async function paperExists(db: D1Database, paperId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM papers WHERE id = ?').bind(paperId).first<{ id: string }>()
  return Boolean(row)
}

async function paperFeedIds(db: D1Database, paperId: string): Promise<string[]> {
  const rows = await db
    .prepare('SELECT feed_id FROM paper_feeds WHERE paper_id = ? ORDER BY feed_id ASC')
    .bind(paperId)
    .all<{ feed_id: string }>()
  return rows.results.map((row) => row.feed_id)
}

function parseStoredMetadata(raw: string | null): FeedbackMetadata {
  if (!raw) return { surface: 'inbox', feedIds: [] }
  try {
    const value = JSON.parse(raw) as unknown
    if (!isObject(value)) return { surface: 'inbox', feedIds: [] }
    const surface =
      typeof value.surface === 'string' && surfaces.has(value.surface as FeedbackSurface)
        ? (value.surface as FeedbackSurface)
        : 'inbox'
    const feedIds = Array.isArray(value.feedIds)
      ? value.feedIds.filter((feedId): feedId is string => typeof feedId === 'string')
      : []
    return { surface, feedIds }
  } catch {
    return { surface: 'inbox', feedIds: [] }
  }
}

function serializeRow(row: FeedbackRow) {
  const metadata = parseStoredMetadata(row.metadata_json)
  return {
    id: row.id,
    paperId: row.paper_id,
    type: row.event_type,
    occurredAt: row.event_at,
    surface: metadata.surface,
    feedIds: metadata.feedIds,
  }
}

async function createFeedbackEvent(request: Request, env: FeedbackEnv): Promise<Response> {
  const body = await readJsonObject(request)
  if (!body) return error('Request body must be a JSON object.')

  let input: ReturnType<typeof parseCreate>
  try {
    input = parseCreate(body)
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : 'Invalid feedback payload.')
  }

  if (!(await paperExists(env.DB, input.paperId))) return error('Paper does not exist.', 404)

  const feedIds = await paperFeedIds(env.DB, input.paperId)
  const eventId = `feedback-${crypto.randomUUID()}`
  const occurredAt = new Date().toISOString()
  const metadata: FeedbackMetadata = { surface: input.surface, feedIds }

  await env.DB
    .prepare(
      `INSERT INTO feedback_events (
         id, paper_id, feed_id, event_type, event_at, weight, metadata_json
       ) VALUES (?, ?, NULL, ?, ?, NULL, ?)`,
    )
    .bind(eventId, input.paperId, input.type, occurredAt, JSON.stringify(metadata))
    .run()

  return json(
    {
      event: {
        id: eventId,
        paperId: input.paperId,
        type: input.type,
        occurredAt,
        surface: input.surface,
        feedIds,
      },
    },
    { status: 201 },
  )
}

async function listFeedbackEvents(env: FeedbackEnv, paperId: string, url: URL): Promise<Response> {
  if (!(await paperExists(env.DB, paperId))) return error('Paper does not exist.', 404)

  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return error('limit must be an integer from 1 to 100.')
  }

  const rows = await env.DB
    .prepare(
      `SELECT id, paper_id, event_type, event_at, weight, metadata_json
       FROM feedback_events
       WHERE paper_id = ?
       ORDER BY event_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(paperId, limit)
    .all<FeedbackRow>()

  return json({ paperId, events: rows.results.map(serializeRow) })
}

export async function handleFeedbackApi(request: Request, env: FeedbackEnv): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/api/feedback-events') {
    return createFeedbackEvent(request, env)
  }

  const paperFeedbackMatch = url.pathname.match(/^\/api\/papers\/([^/]+)\/feedback$/)
  if (request.method === 'GET' && paperFeedbackMatch) {
    return listFeedbackEvents(env, decodeURIComponent(paperFeedbackMatch[1]), url)
  }

  return null
}
