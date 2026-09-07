import { productionReadiness, type ReadinessEnv } from '../worker/readiness'

const requiredTables = [
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
]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const preparedSql: string[] = []
const fakeDb = {
  prepare(sql: string) {
    preparedSql.push(sql)
    assert(/^SELECT\b/i.test(sql.trim()), `Readiness attempted a non-SELECT D1 statement: ${sql}`)
    return {
      async all() {
        assert(sql.includes('sqlite_schema'), `Unexpected readiness all() query: ${sql}`)
        return {
          results: [
            ...requiredTables.map((name) => ({ name })),
            { name: 'paper_collector_migrations' },
          ],
          success: true,
          meta: {},
        }
      },
      async first() {
        if (sql.includes('paper_collector_migrations')) return { count: 9 }
        return {
          feeds: 2,
          active_feeds: 2,
          papers: 4,
          decisions: 0,
          recommendation_snapshots: 4,
          raw_feedback: 0,
          compact_feedback_events: 0,
          purged_learning: 0,
          seen_identifiers: 0,
          archive_batches: 0,
          estimated_paper_bytes: 1234,
        }
      },
    }
  },
}

const r2Calls: Array<{ prefix?: string; limit?: number }> = []
const fakeR2 = new Proxy(
  {
    async list(options: { prefix?: string; limit?: number }) {
      r2Calls.push(options)
      return {
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      }
    },
  },
  {
    get(target, property, receiver) {
      if (property !== 'list' && typeof property === 'string') {
        throw new Error(`Readiness attempted forbidden R2 operation: ${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
  },
)

const report = await productionReadiness({
  DB: fakeDb,
  COLD_ARCHIVE: fakeR2,
} as unknown as ReadinessEnv)

assert(report.ok, `Read-only readiness fixture unexpectedly failed: ${JSON.stringify(report)}`)
assert(report.database.available, 'D1 fixture was not reported available')
assert(report.database.migrationTableAvailable, 'Migration table was not reported available')
assert(report.database.migrationRows === 9, `Expected 9 applied migrations, got ${report.database.migrationRows}`)
assert(report.database.expectedMigrations === 9, 'Expected migration count contract changed unexpectedly')
assert(report.database.requiredTables === requiredTables.length, 'Required table count does not match the fixture')
assert(report.database.missingTables.length === 0, 'Healthy fixture reported missing tables')
assert(report.coldArchive.available, 'R2 fixture was not reported available')
assert(report.coldArchive.ownedPrefix === 'paper-collector/cold/v1/', 'Readiness queried the wrong R2 ownership prefix')
assert(r2Calls.length === 1, `Expected exactly one R2 list call, got ${r2Calls.length}`)
assert(r2Calls[0]?.prefix === 'paper-collector/cold/v1/', 'R2 list escaped the Collector-owned prefix')
assert(r2Calls[0]?.limit === 1, 'R2 readiness should inspect at most one owned object')
assert(preparedSql.length === 3, `Expected exactly three read-only D1 statements, got ${preparedSql.length}`)

console.log('Readiness read-only contract passed: D1 used SELECT only and R2 used one bounded owned-prefix list().')
