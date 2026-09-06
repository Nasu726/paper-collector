import {
  RECOMMENDATION_MODEL_VERSION,
  rebuildRecommendationSnapshots,
  type RecommendationEnv,
} from './recommendation'

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function stagingDatabase(db: D1Database, buildId: string): D1Database {
  const buildLiteral = sqlLiteral(buildId)

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string) => {
          const normalized = query.replace(/\s+/g, ' ').trim()

          if (normalized === 'DELETE FROM recommendation_snapshots WHERE model_version = ?') {
            // The scorer's first step clears its destination. Redirect that clear to this isolated build.
            // Keep one bind placeholder so the existing call signature remains unchanged.
            return target.prepare(
              `DELETE FROM recommendation_snapshot_staging
               WHERE build_id = ${buildLiteral} AND ? IS NOT NULL`,
            )
          }

          if (normalized.startsWith('INSERT INTO recommendation_snapshots (')) {
            // Preserve the scorer's eight bind parameters; build_id is a server-generated SQL literal.
            return target.prepare(
              `INSERT INTO recommendation_snapshot_staging (
                 build_id, id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
               ) VALUES (${buildLiteral}, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(build_id, id) DO UPDATE SET
                 paper_id = excluded.paper_id,
                 feed_id = excluded.feed_id,
                 bucket = excluded.bucket,
                 reasons_json = excluded.reasons_json,
                 model_version = excluded.model_version,
                 scored_at = excluded.scored_at,
                 score = excluded.score`,
            )
          }

          if (
            normalized ===
            'SELECT COUNT(*) AS count FROM recommendation_snapshots WHERE model_version = ?'
          ) {
            return target.prepare(
              `SELECT COUNT(*) AS count
               FROM recommendation_snapshot_staging
               WHERE build_id = ${buildLiteral} AND model_version = ?`,
            )
          }

          return target.prepare(query)
        }
      }

      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as D1Database
}

async function discardBuild(db: D1Database, buildId: string): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM recommendation_snapshot_staging WHERE build_id = ?')
      .bind(buildId)
      .run()
  } catch (cause) {
    console.warn('Failed to clean recommendation staging build', buildId, cause)
  }
}

export async function rebuildRecommendationSnapshotsSafely(env: RecommendationEnv) {
  const buildId = `recommendation-build-${crypto.randomUUID()}`
  const stagedEnv: RecommendationEnv = {
    ...env,
    DB: stagingDatabase(env.DB, buildId),
  }

  try {
    const report = await rebuildRecommendationSnapshots(stagedEnv)

    // D1 batch executes transactionally. The live lexical-v1 generation is replaced only after
    // the complete next generation exists in staging. A failed scorer/batch leaves the old
    // generation intact instead of exposing a partially rebuilt Inbox.
    await env.DB.batch([
      env.DB
        .prepare('DELETE FROM recommendation_snapshots WHERE model_version = ?')
        .bind(RECOMMENDATION_MODEL_VERSION),
      env.DB
        .prepare(
          `INSERT INTO recommendation_snapshots (
             id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
           )
           SELECT id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
           FROM recommendation_snapshot_staging
           WHERE build_id = ?`,
        )
        .bind(buildId),
      env.DB
        .prepare('DELETE FROM recommendation_snapshot_staging WHERE build_id = ?')
        .bind(buildId),
    ])

    return report
  } catch (cause) {
    await discardBuild(env.DB, buildId)
    throw cause
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

export async function handleRecommendationApiSafely(
  request: Request,
  env: RecommendationEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/recommendations/rebuild') {
    return json(await rebuildRecommendationSnapshotsSafely(env))
  }
  return null
}
