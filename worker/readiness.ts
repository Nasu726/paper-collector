export type ReadinessEnv = {
  DB: D1Database
  COLD_ARCHIVE: R2Bucket
}

const COLD_ARCHIVE_PREFIX = 'paper-collector/cold/v1/'
const MIGRATION_TABLE = 'paper_collector_migrations'
const EXPECTED_MIGRATIONS = 9

const REQUIRED_TABLES = [
  'feeds',
  'papers',
  'paper_feeds',
  'paper_identifiers',
  'ingestion_provenance',
  'feed_ingestion_state',
  'paper_field_evidence',
  'paper_field_sources',
  'crossref_enrichment_state',
  'decisions',
  'recommendation_snapshots',
  'recommendation_snapshot_staging',
  'recommendation_builds',
  'recommendation_model_state',
  'feedback_events',
  'purged_paper_learning',
  'seen_paper_identifiers',
  'paper_retention_refs',
  'feedback_compact',
  'cold_archive_batches',
  'cold_archive_leases',
] as const

type CountRow = {
  feeds: number
  active_feeds: number
  papers: number
  decisions: number
  recommendation_snapshots: number
  raw_feedback: number
  compact_feedback_events: number
  purged_learning: number
  seen_identifiers: number
  archive_batches: number
  estimated_paper_bytes: number
}

export type ProductionReadinessReport = {
  ok: boolean
  checkedAt: string
  database: {
    available: boolean
    migrationTableAvailable: boolean
    migrationRows?: number
    expectedMigrations: number
    requiredTables: number
    missingTables: string[]
    counts?: {
      feeds: number
      activeFeeds: number
      papers: number
      decisions: number
      recommendationSnapshots: number
      rawFeedback: number
      compactFeedbackEvents: number
      purgedLearning: number
      seenIdentifiers: number
      archiveBatches: number
      estimatedPaperBytes: number
    }
    error?: string
  }
  coldArchive: {
    available: boolean
    ownedPrefix: string
    hasOwnedObjects?: boolean
    error?: string
  }
}

function databaseFailure(cause: unknown): ProductionReadinessReport['database'] {
  console.error('Production readiness D1 check failed', cause)
  return {
    available: false,
    migrationTableAvailable: false,
    expectedMigrations: EXPECTED_MIGRATIONS,
    requiredTables: REQUIRED_TABLES.length,
    missingTables: [],
    error: 'Database readiness query failed.',
  }
}

async function databaseReadiness(env: ReadinessEnv): Promise<ProductionReadinessReport['database']> {
  try {
    const tableRows = await env.DB
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all<{ name: string }>()
    const present = new Set(tableRows.results.map((row) => row.name))
    const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table))
    const migrationTableAvailable = present.has(MIGRATION_TABLE)

    if (!migrationTableAvailable || missingTables.length > 0) {
      let migrationRows: number | undefined
      if (migrationTableAvailable) {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`)
          .first<{ count: number }>()
        migrationRows = row?.count
      }
      return {
        available: false,
        migrationTableAvailable,
        migrationRows,
        expectedMigrations: EXPECTED_MIGRATIONS,
        requiredTables: REQUIRED_TABLES.length,
        missingTables: [...missingTables],
      }
    }

    const migrationRow = await env.DB
      .prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`)
      .first<{ count: number }>()
    if (!migrationRow) throw new Error('Collector migration counter is unavailable.')
    if (migrationRow.count < EXPECTED_MIGRATIONS) {
      return {
        available: false,
        migrationTableAvailable: true,
        migrationRows: migrationRow.count,
        expectedMigrations: EXPECTED_MIGRATIONS,
        requiredTables: REQUIRED_TABLES.length,
        missingTables: [],
      }
    }

    const counts = await env.DB
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM feeds) AS feeds,
           (SELECT COUNT(*) FROM feeds WHERE active = 1 AND archived_at IS NULL) AS active_feeds,
           (SELECT COUNT(*) FROM papers) AS papers,
           (SELECT COUNT(*) FROM decisions) AS decisions,
           (SELECT COUNT(*) FROM recommendation_snapshots) AS recommendation_snapshots,
           (SELECT COUNT(*) FROM feedback_events) AS raw_feedback,
           COALESCE((SELECT SUM(event_count) FROM feedback_compact), 0) AS compact_feedback_events,
           (SELECT COUNT(*) FROM purged_paper_learning) AS purged_learning,
           (SELECT COUNT(*) FROM seen_paper_identifiers) AS seen_identifiers,
           (SELECT COUNT(*) FROM cold_archive_batches) AS archive_batches,
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
      .first<CountRow>()
    if (!counts) throw new Error('Collector schema counters are unavailable.')

    return {
      available: true,
      migrationTableAvailable: true,
      migrationRows: migrationRow.count,
      expectedMigrations: EXPECTED_MIGRATIONS,
      requiredTables: REQUIRED_TABLES.length,
      missingTables: [],
      counts: {
        feeds: counts.feeds,
        activeFeeds: counts.active_feeds,
        papers: counts.papers,
        decisions: counts.decisions,
        recommendationSnapshots: counts.recommendation_snapshots,
        rawFeedback: counts.raw_feedback,
        compactFeedbackEvents: counts.compact_feedback_events,
        purgedLearning: counts.purged_learning,
        seenIdentifiers: counts.seen_identifiers,
        archiveBatches: counts.archive_batches,
        estimatedPaperBytes: counts.estimated_paper_bytes,
      },
    }
  } catch (cause) {
    return databaseFailure(cause)
  }
}

async function coldArchiveReadiness(env: ReadinessEnv): Promise<ProductionReadinessReport['coldArchive']> {
  try {
    const listed = await env.COLD_ARCHIVE.list({ prefix: COLD_ARCHIVE_PREFIX, limit: 1 })
    return {
      available: true,
      ownedPrefix: COLD_ARCHIVE_PREFIX,
      hasOwnedObjects: listed.objects.length > 0,
    }
  } catch (cause) {
    console.error('Production readiness R2 check failed', cause)
    return {
      available: false,
      ownedPrefix: COLD_ARCHIVE_PREFIX,
      error: 'Cold archive readiness query failed.',
    }
  }
}

export async function productionReadiness(env: ReadinessEnv): Promise<ProductionReadinessReport> {
  const [database, coldArchive] = await Promise.all([
    databaseReadiness(env),
    coldArchiveReadiness(env),
  ])
  return {
    ok: database.available && coldArchive.available,
    checkedAt: new Date().toISOString(),
    database,
    coldArchive,
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

export async function handleReadinessApi(
  request: Request,
  env: ReadinessEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.pathname !== '/api/readiness') return null
  const report = await productionReadiness(env)
  return json(report, { status: report.ok ? 200 : 503 })
}
