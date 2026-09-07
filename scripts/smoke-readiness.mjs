import { spawn, spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5183'
const bin = (name) => resolve('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const viteCommand = bin('vite')
const wranglerCommand = bin('wrangler')
const server = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5183', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
server.stdout.on('data', (chunk) => { output += chunk.toString() })
server.stderr.on('data', (chunk) => { output += chunk.toString() })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function d1Row(sql) {
  const result = spawnSync(
    wranglerCommand,
    ['d1', 'execute', 'DB', '--local', '--json', '--command', sql],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`D1 command failed (${result.status}): ${sql}\n${result.stdout}\n${result.stderr}`)
  }

  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`Could not parse Wrangler D1 JSON output: ${result.stdout}`, { cause })
  }
  const batches = Array.isArray(payload) ? payload : [payload]
  const row = batches.flatMap((batch) => batch?.results ?? [])[0]
  assert(row && typeof row === 'object', `D1 query returned no row: ${result.stdout}`)
  return row
}

function fingerprint() {
  return d1Row(
    `SELECT
       (SELECT COUNT(*) FROM paper_collector_migrations) AS migrations,
       (SELECT COUNT(*) FROM feeds) AS feeds,
       (SELECT COUNT(*) FROM papers) AS papers,
       (SELECT COUNT(*) FROM paper_feeds) AS paper_feeds,
       (SELECT COUNT(*) FROM decisions) AS decisions,
       (SELECT COUNT(*) FROM recommendation_snapshots) AS recommendation_snapshots,
       (SELECT COUNT(*) FROM feedback_events) AS feedback_events,
       (SELECT COUNT(*) FROM feedback_compact) AS feedback_compact,
       (SELECT COUNT(*) FROM cold_archive_batches) AS cold_archive_batches,
       (SELECT COUNT(*) FROM cold_archive_leases) AS cold_archive_leases`,
  )
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Dev server exited early.\n${output}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for readiness smoke app.\n${output}`)
}

async function readiness() {
  const response = await fetch(`${baseUrl}/api/readiness`, { cache: 'no-store' })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch (cause) {
    throw new Error(`Readiness did not return JSON: ${response.status} ${text}`, { cause })
  }
  return { response, payload, text }
}

function assertPublicShape(payload, text) {
  const rootKeys = Object.keys(payload).sort()
  assert(isDeepStrictEqual(rootKeys, ['checkedAt', 'coldArchive', 'database', 'ok']), `Unexpected readiness root keys: ${rootKeys}`)

  const databaseKeys = Object.keys(payload.database ?? {}).sort()
  const allowedDatabaseKeys = [
    'available',
    'counts',
    'expectedMigrations',
    'migrationRows',
    'migrationTableAvailable',
    'missingTables',
    'requiredTables',
  ].sort()
  assert(isDeepStrictEqual(databaseKeys, allowedDatabaseKeys), `Unexpected readiness database keys: ${databaseKeys}`)

  const countKeys = Object.keys(payload.database?.counts ?? {}).sort()
  const allowedCountKeys = [
    'activeFeeds',
    'archiveBatches',
    'compactFeedbackEvents',
    'decisions',
    'estimatedPaperBytes',
    'feeds',
    'papers',
    'purgedLearning',
    'rawFeedback',
    'recommendationSnapshots',
    'seenIdentifiers',
  ].sort()
  assert(isDeepStrictEqual(countKeys, allowedCountKeys), `Unexpected readiness count keys: ${countKeys}`)

  const coldKeys = Object.keys(payload.coldArchive ?? {}).sort()
  assert(
    isDeepStrictEqual(coldKeys, ['available', 'hasOwnedObjects', 'ownedPrefix']),
    `Unexpected readiness cold archive keys: ${coldKeys}`,
  )

  for (const forbidden of ['"title"', '"abstract"', 'authors_json', 'metadata_json', 'objectKey', 'object_key', 'ctx.access', 'documents']) {
    assert(!text.includes(forbidden), `Readiness response exposed forbidden detail: ${forbidden}`)
  }
}

let exitCode = 0
try {
  await waitForServer()
  const before = fingerprint()

  const first = await readiness()
  assert(first.response.status === 200, `Readiness returned ${first.response.status}: ${first.text}`)
  assert(first.response.headers.get('cache-control') === 'no-store', 'Readiness response must disable caching')
  assert(first.payload.ok === true, 'Healthy local bindings were not reported ready')
  assert(first.payload.database?.available === true, 'Local D1 was not reported available')
  assert(first.payload.database?.migrationTableAvailable === true, 'Collector migration table was not detected')
  assert(first.payload.database?.migrationRows === 9, `Expected 9 local migrations, got ${first.payload.database?.migrationRows}`)
  assert(first.payload.database?.expectedMigrations === 9, 'Readiness expected-migration contract is stale')
  assert(first.payload.database?.requiredTables === 21, `Expected 21 required tables, got ${first.payload.database?.requiredTables}`)
  assert(first.payload.database?.missingTables?.length === 0, 'Healthy local D1 reported missing tables')
  assert(first.payload.database?.counts?.feeds === Number(before.feeds), 'Feed count differs from direct D1 observation')
  assert(first.payload.database?.counts?.papers === Number(before.papers), 'Paper count differs from direct D1 observation')
  assert(first.payload.database?.counts?.decisions === Number(before.decisions), 'Decision count differs from direct D1 observation')
  assert(
    first.payload.database?.counts?.recommendationSnapshots === Number(before.recommendation_snapshots),
    'Recommendation snapshot count differs from direct D1 observation',
  )
  assert(first.payload.database?.counts?.rawFeedback === Number(before.feedback_events), 'Raw feedback count differs from direct D1 observation')
  assert(first.payload.coldArchive?.available === true, 'Local R2 binding was not reported available')
  assert(first.payload.coldArchive?.ownedPrefix === 'paper-collector/cold/v1/', 'Readiness exposed the wrong R2 prefix')
  assert(typeof first.payload.coldArchive?.hasOwnedObjects === 'boolean', 'R2 owned-object signal must be boolean')
  assertPublicShape(first.payload, first.text)

  const second = await readiness()
  assert(second.response.status === 200 && second.payload.ok === true, 'Repeated readiness check failed')
  assert(
    second.payload.coldArchive?.hasOwnedObjects === first.payload.coldArchive?.hasOwnedObjects,
    'Read-only R2 visibility changed across repeated readiness checks',
  )

  const after = fingerprint()
  assert(isDeepStrictEqual(after, before), `Readiness mutated local D1 state:\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`)

  console.log('Production readiness smoke passed: D1/R2 bindings visible, response bounded, repeated checks stable, D1 unchanged.')
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output)
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveExit) => server.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)),
    ])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
}

process.exit(exitCode)
