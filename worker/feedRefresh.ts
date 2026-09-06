import type { Feed } from '../src/domain'
import { persistProviderPapers } from './ingestion'
import { OpenAlexProvider } from './providers/openalex'

export type RefreshEnv = {
  DB: D1Database
  OPENALEX_API_KEY?: string
  OPENALEX_BASE_URL?: string
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

type WatermarkRow = {
  watermark_date: string | null
}

export type FeedRefreshInput = {
  fromDate?: string
  toDate?: string
  now?: Date
}

export type FeedRefreshResult = {
  feedId: string
  provider: string
  fromDate: string
  toDate: string
  status: 'success' | 'truncated'
  watermarkAdvanced: boolean
  rawFetched: number
  accepted: number
  pages: number
  inserted: number
  updated: number
  attached: number
}

export class FeedRefreshError extends Error {
  readonly httpStatus: number

  constructor(message: string, httpStatus = 500) {
    super(message)
    this.name = 'FeedRefreshError'
    this.httpStatus = httpStatus
  }
}

export function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

export function daysBefore(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) - days * 86_400_000
  return new Date(timestamp).toISOString().slice(0, 10)
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

async function loadFeed(db: D1Database, feedId: string): Promise<Feed | null> {
  const row = await db
    .prepare(
      `SELECT id, name, intent, exclusions, source_policy, active, provider_query
       FROM feeds WHERE id = ?`,
    )
    .bind(feedId)
    .first<FeedRow>()
  return row ? rowToFeed(row) : null
}

async function loadWatermark(db: D1Database, feedId: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT watermark_date FROM feed_ingestion_state WHERE feed_id = ?')
    .bind(feedId)
    .first<WatermarkRow>()
  return row?.watermark_date ?? undefined
}

async function recordAttempt(db: D1Database, feedId: string, attemptedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feed_ingestion_state (
         feed_id, provider, status, last_attempt_at, updated_at
       ) VALUES (?, 'openalex', 'never', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(feed_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(feedId, attemptedAt)
    .run()
}

async function recordSuccess(
  db: D1Database,
  feedId: string,
  completedAt: string,
  toDate: string,
  advanceWatermark: boolean,
  rawFetched: number,
  pages: number,
): Promise<void> {
  const watermark = advanceWatermark ? toDate : null
  await db
    .prepare(
      `INSERT INTO feed_ingestion_state (
         feed_id, provider, status, watermark_date,
         last_attempt_at, last_success_at, last_error,
         last_fetched, last_pages, updated_at
       ) VALUES (?, 'openalex', 'success', ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(feed_id) DO UPDATE SET
         status = 'success',
         watermark_date = COALESCE(excluded.watermark_date, feed_ingestion_state.watermark_date),
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         last_error = NULL,
         last_fetched = excluded.last_fetched,
         last_pages = excluded.last_pages,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(feedId, watermark, completedAt, completedAt, rawFetched, pages)
    .run()
}

async function recordIncomplete(
  db: D1Database,
  feedId: string,
  attemptedAt: string,
  status: 'error' | 'truncated',
  message: string,
  rawFetched: number,
  pages: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feed_ingestion_state (
         feed_id, provider, status, last_attempt_at, last_error,
         last_fetched, last_pages, updated_at
       ) VALUES (?, 'openalex', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(feed_id) DO UPDATE SET
         status = excluded.status,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error,
         last_fetched = excluded.last_fetched,
         last_pages = excluded.last_pages,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(feedId, status, attemptedAt, message, rawFetched, pages)
    .run()
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message.slice(0, 1000)
  return 'Unknown ingestion failure'
}

export async function refreshFeedById(
  env: RefreshEnv,
  feedId: string,
  input: FeedRefreshInput = {},
): Promise<FeedRefreshResult> {
  const feed = await loadFeed(env.DB, feedId)
  if (!feed) throw new FeedRefreshError('Feed does not exist.', 404)
  if (!feed.active) throw new FeedRefreshError('Feed is paused.', 409)

  const query = feed.providerQuery?.trim()
  if (!query) throw new FeedRefreshError('Feed has no provider query configured.', 409)
  if (input.fromDate !== undefined && !validIsoDate(input.fromDate)) {
    throw new FeedRefreshError('fromDate must be an ISO YYYY-MM-DD date.', 400)
  }
  if (input.toDate !== undefined && !validIsoDate(input.toDate)) {
    throw new FeedRefreshError('toDate must be an ISO YYYY-MM-DD date.', 400)
  }

  const explicitRange = input.fromDate !== undefined || input.toDate !== undefined
  const now = input.now ?? new Date()
  const toDate = input.toDate ?? now.toISOString().slice(0, 10)
  const previousWatermark = await loadWatermark(env.DB, feedId)
  const fromDate = input.fromDate ?? (previousWatermark ? daysBefore(previousWatermark, 1) : daysBefore(toDate, 13))
  if (fromDate > toDate) throw new FeedRefreshError('fromDate must not be after toDate.', 400)

  const attemptedAt = now.toISOString()
  await recordAttempt(env.DB, feedId, attemptedAt)

  const provider = new OpenAlexProvider({
    apiKey: env.OPENALEX_API_KEY,
    baseUrl: env.OPENALEX_BASE_URL,
  })

  try {
    const search = await provider.search({
      query,
      fromDate,
      toDate,
      sourcePolicy: feed.sourcePolicy,
      maxResults: 500,
    })
    const persisted = await persistProviderPapers(env.DB, feed, search.papers, query)

    if (search.truncated) {
      const message = 'OpenAlex refresh hit the 500-result safety cap; watermark was not advanced.'
      await recordIncomplete(env.DB, feedId, attemptedAt, 'truncated', message, search.rawFetched, search.pages)
      return {
        feedId,
        provider: provider.name,
        fromDate,
        toDate,
        status: 'truncated',
        watermarkAdvanced: false,
        rawFetched: search.rawFetched,
        accepted: search.papers.length,
        pages: search.pages,
        inserted: persisted.inserted,
        updated: persisted.updated,
        attached: persisted.attached,
      }
    }

    const completedAt = new Date().toISOString()
    const advanceWatermark = !explicitRange
    await recordSuccess(
      env.DB,
      feedId,
      completedAt,
      toDate,
      advanceWatermark,
      search.rawFetched,
      search.pages,
    )

    return {
      feedId,
      provider: provider.name,
      fromDate,
      toDate,
      status: 'success',
      watermarkAdvanced: advanceWatermark,
      rawFetched: search.rawFetched,
      accepted: search.papers.length,
      pages: search.pages,
      inserted: persisted.inserted,
      updated: persisted.updated,
      attached: persisted.attached,
    }
  } catch (cause) {
    const message = errorMessage(cause)
    await recordIncomplete(env.DB, feedId, attemptedAt, 'error', message, 0, 0)
    throw new FeedRefreshError(message, 502)
  }
}

export async function refreshAllActiveFeeds(
  env: RefreshEnv,
  scheduledTime: number,
): Promise<FeedRefreshResult[]> {
  const feedRows = await env.DB
    .prepare(
      `SELECT id FROM feeds
       WHERE active = 1 AND provider_query IS NOT NULL AND TRIM(provider_query) <> ''
       ORDER BY created_at ASC, id ASC`,
    )
    .all<{ id: string }>()

  const results: FeedRefreshResult[] = []
  const failures: string[] = []
  const now = new Date(scheduledTime)

  for (const row of feedRows.results) {
    try {
      const result = await refreshFeedById(env, row.id, { now })
      results.push(result)
      if (result.status === 'truncated') failures.push(`${row.id}: truncated`)
    } catch (cause) {
      failures.push(`${row.id}: ${errorMessage(cause)}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Scheduled ingestion incomplete: ${failures.join('; ')}`)
  }
  return results
}
