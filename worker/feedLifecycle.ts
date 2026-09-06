import type { Feed } from '../src/domain'

export type FeedLifecycleEnv = {
  DB: D1Database
}

type FeedRow = {
  id: string
  name: string
  intent: string
  exclusions: string | null
  source_policy: Feed['sourcePolicy']
  active: number
  provider_query: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

type FeedInput = {
  name: string
  intent: string
  exclusions?: string
  sourcePolicy: Feed['sourcePolicy']
  providerQuery: string
}

type FeedPatch = Partial<FeedInput>

const sourcePolicies = new Set<Feed['sourcePolicy']>([
  'published_only',
  'accepted_when_verifiable',
  'include_preprints',
])

const createFields = new Set(['name', 'intent', 'exclusions', 'sourcePolicy', 'providerQuery'])
const patchFields = createFields

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

function cleanText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const normalized = value.replace(/\r\n/g, '\n').trim()
  if (normalized.length < min) throw new Error(`${field} must not be empty.`)
  if (normalized.length > max) throw new Error(`${field} must be at most ${max} characters.`)
  return normalized
}

function cleanOptionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  const normalized = value.replace(/\r\n/g, '\n').trim()
  if (!normalized) return undefined
  if (normalized.length > max) throw new Error(`${field} must be at most ${max} characters.`)
  return normalized
}

function cleanSourcePolicy(value: unknown): Feed['sourcePolicy'] {
  if (typeof value !== 'string' || !sourcePolicies.has(value as Feed['sourcePolicy'])) {
    throw new Error('sourcePolicy is invalid.')
  }
  return value as Feed['sourcePolicy']
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

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`Unknown Feed field(s): ${unknown.join(', ')}.`)
}

function parseCreate(value: Record<string, unknown>): FeedInput {
  rejectUnknownFields(value, createFields)
  return {
    name: cleanText(value.name, 'name', 1, 80),
    intent: cleanText(value.intent, 'intent', 1, 4000),
    exclusions: cleanOptionalText(value.exclusions, 'exclusions', 2000),
    sourcePolicy: cleanSourcePolicy(value.sourcePolicy),
    providerQuery: cleanText(value.providerQuery, 'providerQuery', 1, 1000),
  }
}

function parsePatch(value: Record<string, unknown>): FeedPatch {
  rejectUnknownFields(value, patchFields)
  if (Object.keys(value).length === 0) throw new Error('Feed patch must contain at least one field.')

  const patch: FeedPatch = {}
  if ('name' in value) patch.name = cleanText(value.name, 'name', 1, 80)
  if ('intent' in value) patch.intent = cleanText(value.intent, 'intent', 1, 4000)
  if ('exclusions' in value) patch.exclusions = cleanOptionalText(value.exclusions, 'exclusions', 2000)
  if ('sourcePolicy' in value) patch.sourcePolicy = cleanSourcePolicy(value.sourcePolicy)
  if ('providerQuery' in value) patch.providerQuery = cleanText(value.providerQuery, 'providerQuery', 1, 1000)
  return patch
}

function serializeFeed(row: FeedRow) {
  return {
    id: row.id,
    name: row.name,
    intent: row.intent,
    exclusions: row.exclusions ?? undefined,
    sourcePolicy: row.source_policy,
    active: row.active === 1,
    providerQuery: row.provider_query ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function loadFeed(db: D1Database, feedId: string): Promise<FeedRow | null> {
  return db
    .prepare(
      `SELECT id, name, intent, exclusions, source_policy, active,
              provider_query, archived_at, created_at, updated_at
       FROM feeds WHERE id = ?`,
    )
    .bind(feedId)
    .first<FeedRow>()
}

async function listArchivedFeeds(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT id, name, intent, exclusions, source_policy, active,
              provider_query, archived_at, created_at, updated_at
       FROM feeds
       WHERE archived_at IS NOT NULL
       ORDER BY archived_at DESC, created_at ASC`,
    )
    .all<FeedRow>()
  return json({ feeds: rows.results.map(serializeFeed) })
}

async function createFeed(request: Request, env: FeedLifecycleEnv): Promise<Response> {
  const body = await readJsonObject(request)
  if (!body) return error('Request body must be a JSON object.')

  let input: FeedInput
  try {
    input = parseCreate(body)
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : 'Invalid Feed payload.')
  }

  const feedId = `feed-${crypto.randomUUID()}`
  await env.DB
    .prepare(
      `INSERT INTO feeds (
         id, name, intent, exclusions, source_policy, active,
         provider_query, archived_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .bind(
      feedId,
      input.name,
      input.intent,
      input.exclusions ?? null,
      input.sourcePolicy,
      input.providerQuery,
    )
    .run()

  const row = await loadFeed(env.DB, feedId)
  if (!row) return error('Feed was created but could not be loaded.', 500)
  return json({ feed: serializeFeed(row), collectionReset: true }, { status: 201 })
}

async function patchFeed(request: Request, env: FeedLifecycleEnv, feedId: string): Promise<Response> {
  const current = await loadFeed(env.DB, feedId)
  if (!current) return error('Feed does not exist.', 404)
  if (current.archived_at) return error('Restore the Feed before editing it.', 409)

  const body = await readJsonObject(request)
  if (!body) return error('Request body must be a JSON object.')

  let patch: FeedPatch
  try {
    patch = parsePatch(body)
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : 'Invalid Feed payload.')
  }

  const next = {
    name: patch.name ?? current.name,
    intent: patch.intent ?? current.intent,
    exclusions: 'exclusions' in patch ? patch.exclusions ?? null : current.exclusions,
    sourcePolicy: patch.sourcePolicy ?? current.source_policy,
    providerQuery: patch.providerQuery ?? current.provider_query ?? '',
  }
  const collectionReset =
    next.providerQuery !== (current.provider_query ?? '') || next.sourcePolicy !== current.source_policy

  await env.DB
    .prepare(
      `UPDATE feeds SET
         name = ?, intent = ?, exclusions = ?, source_policy = ?, provider_query = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(
      next.name,
      next.intent,
      next.exclusions,
      next.sourcePolicy,
      next.providerQuery,
      feedId,
    )
    .run()

  if (collectionReset) {
    await env.DB.prepare('DELETE FROM feed_ingestion_state WHERE feed_id = ?').bind(feedId).run()
  }

  const row = await loadFeed(env.DB, feedId)
  if (!row) return error('Feed disappeared after update.', 500)
  return json({ feed: serializeFeed(row), collectionReset })
}

async function transitionFeed(
  env: FeedLifecycleEnv,
  feedId: string,
  action: 'pause' | 'resume' | 'archive' | 'restore',
): Promise<Response> {
  const current = await loadFeed(env.DB, feedId)
  if (!current) return error('Feed does not exist.', 404)

  if (action === 'pause') {
    if (current.archived_at) return error('Archived Feed cannot be paused.', 409)
    await env.DB
      .prepare('UPDATE feeds SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(feedId)
      .run()
  } else if (action === 'resume') {
    if (current.archived_at) return error('Restore the Feed before resuming it.', 409)
    await env.DB
      .prepare('UPDATE feeds SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(feedId)
      .run()
  } else if (action === 'archive') {
    if (!current.archived_at) {
      await env.DB
        .prepare(
          `UPDATE feeds SET active = 0, archived_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(feedId)
        .run()
    }
  } else {
    if (current.archived_at) {
      await env.DB
        .prepare(
          `UPDATE feeds SET active = 0, archived_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(feedId)
        .run()
    }
  }

  const row = await loadFeed(env.DB, feedId)
  if (!row) return error('Feed disappeared after lifecycle transition.', 500)
  return json({ feed: serializeFeed(row) })
}

export async function handleFeedLifecycleApi(
  request: Request,
  env: FeedLifecycleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/api/feeds') {
    return createFeed(request, env)
  }

  if (request.method === 'GET' && url.pathname === '/api/feeds/archived') {
    return listArchivedFeeds(env.DB)
  }

  const feedMatch = url.pathname.match(/^\/api\/feeds\/([^/]+)$/)
  if (request.method === 'PATCH' && feedMatch) {
    return patchFeed(request, env, decodeURIComponent(feedMatch[1]))
  }

  const transitionMatch = url.pathname.match(/^\/api\/feeds\/([^/]+)\/(pause|resume|archive|restore)$/)
  if (request.method === 'POST' && transitionMatch) {
    return transitionFeed(
      env,
      decodeURIComponent(transitionMatch[1]),
      transitionMatch[2] as 'pause' | 'resume' | 'archive' | 'restore',
    )
  }

  return null
}

export async function visibleFeedIds(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare('SELECT id FROM feeds WHERE archived_at IS NULL').all<{ id: string }>()
  return new Set(rows.results.map((row) => row.id))
}
