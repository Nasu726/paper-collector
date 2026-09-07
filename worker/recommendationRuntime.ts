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
            return target.prepare(
              `DELETE FROM recommendation_snapshot_staging
               WHERE build_id = ${buildLiteral} AND ? IS NOT NULL`,
            )
          }

          if (normalized.startsWith('INSERT INTO recommendation_snapshots (')) {
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

          if (normalized === 'SELECT COUNT(*) AS count FROM recommendation_snapshots WHERE model_version = ?') {
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
    await db.batch([
      db.prepare('DELETE FROM recommendation_snapshot_staging WHERE build_id = ?').bind(buildId),
      db.prepare('DELETE FROM recommendation_builds WHERE build_id = ?').bind(buildId),
    ])
  } catch (cause) {
    console.warn('Failed to clean recommendation staging build', buildId, cause)
  }
}

async function reserveGeneration(db: D1Database, buildId: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO recommendation_builds (build_id, model_version)
       VALUES (?, ?)
       RETURNING generation`,
    )
    .bind(buildId, RECOMMENDATION_MODEL_VERSION)
    .first<{ generation: number }>()

  if (!row || !Number.isInteger(row.generation) || row.generation <= 0) {
    throw new Error('Failed to reserve recommendation generation.')
  }
  return row.generation
}

export async function rebuildRecommendationSnapshotsSafely(env: RecommendationEnv) {
  const buildId = `recommendation-build-${crypto.randomUUID()}`
  const generation = await reserveGeneration(env.DB, buildId)
  const stagedEnv: RecommendationEnv = {
    ...env,
    DB: stagingDatabase(env.DB, buildId),
  }

  try {
    const report = await rebuildRecommendationSnapshots(stagedEnv)

    // The generation state and snapshot swap happen in one D1 batch transaction.
    // A newer generation that has already published makes the first statement a no-op;
    // subsequent DELETE/INSERT statements are guarded by equality with this generation,
    // so a stale build can clean its staging rows but cannot overwrite the live snapshot.
    const results = await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO recommendation_model_state (model_version, live_generation, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(model_version) DO UPDATE SET
             live_generation = excluded.live_generation,
             updated_at = CURRENT_TIMESTAMP
           WHERE recommendation_model_state.live_generation < excluded.live_generation`,
        )
        .bind(RECOMMENDATION_MODEL_VERSION, generation),
      env.DB
        .prepare(
          `DELETE FROM recommendation_snapshots
           WHERE model_version = ?
             AND (SELECT live_generation FROM recommendation_model_state WHERE model_version = ?) = ?`,
        )
        .bind(RECOMMENDATION_MODEL_VERSION, RECOMMENDATION_MODEL_VERSION, generation),
      env.DB
        .prepare(
          `INSERT INTO recommendation_snapshots (
             id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
           )
           SELECT id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
           FROM recommendation_snapshot_staging
           WHERE build_id = ?
             AND (SELECT live_generation FROM recommendation_model_state WHERE model_version = ?) = ?`,
        )
        .bind(buildId, RECOMMENDATION_MODEL_VERSION, generation),
      env.DB.prepare('DELETE FROM recommendation_snapshot_staging WHERE build_id = ?').bind(buildId),
      env.DB.prepare('DELETE FROM recommendation_builds WHERE build_id = ?').bind(buildId),
    ])

    const published = (results[0]?.meta.changes ?? 0) > 0
    return { ...report, generation, published }
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
