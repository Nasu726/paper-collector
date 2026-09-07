import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5182'
const bin = (name) => resolve('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const viteCommand = bin('vite')
const wranglerCommand = bin('wrangler')
const server = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5182', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
server.stdout.on('data', (chunk) => { output += chunk.toString() })
server.stderr.on('data', (chunk) => { output += chunk.toString() })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function d1(sql) {
  const result = spawnSync(
    wranglerCommand,
    ['d1', 'execute', 'DB', '--local', '--command', sql],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`D1 command failed (${result.status}): ${sql}\n${result.stdout}\n${result.stderr}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
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
  throw new Error(`Timed out waiting for feedback archive test app.\n${output}`)
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = text
  }
  return { response, payload }
}

async function bootstrap() {
  const { response, payload } = await jsonRequest('/api/bootstrap', { cache: 'no-store' })
  assert(response.ok, `Bootstrap failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function postFeedback(paperId, type) {
  const { response, payload } = await jsonRequest('/api/feedback-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paperId, type, surface: 'inbox' }),
  })
  assert(response.status === 201, `Feedback POST failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload.event
}

async function rebuild() {
  const { response, payload } = await jsonRequest('/api/recommendations/rebuild', { method: 'POST' })
  assert(response.ok, `Recommendation rebuild failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function status() {
  const { response, payload } = await jsonRequest('/api/storage/feedback-archive')
  assert(response.ok, `Archive status failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function archive(body) {
  return jsonRequest('/api/storage/feedback-archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function profileFor(report, feedId) {
  return report.profiles.find((profile) => profile.feedId === feedId)
}

let exitCode = 0
try {
  await waitForServer()

  const initial = await bootstrap()
  const paper = initial.papers.find(
    (candidate) =>
      Array.isArray(candidate.feedIds) &&
      candidate.feedIds.length > 0 &&
      !Object.prototype.hasOwnProperty.call(initial.decisions ?? {}, candidate.id),
  )
  assert(paper, 'Feedback archive smoke requires an undecided Paper with Feed membership')
  const feedId = paper.feedIds[0]

  const created = [
    await postFeedback(paper.id, 'pdf_opened'),
    await postFeedback(paper.id, 'pdf_opened'),
    await postFeedback(paper.id, 'source_opened'),
  ]
  assert(new Set(created.map((event) => event.id)).size === 3, 'Feedback archive fixture did not create unique events')

  const ids = created.map((event) => sqlString(event.id)).join(', ')
  d1(`UPDATE feedback_events SET event_at = '2026-08-01T00:00:00.000Z' WHERE id IN (${ids})`)

  const beforeStatus = await status()
  const beforeRecommendation = await rebuild()
  const beforeProfile = profileFor(beforeRecommendation, feedId)
  assert(beforeProfile, `Missing Feed profile for ${feedId} before archive`)

  const future = await archive({ cutoffAt: '2999-01-01T00:00:00Z', dryRun: true })
  assert(future.response.status === 400, `Future cutoff returned ${future.response.status}`)

  const cutoffAt = '2026-09-01T00:00:00.000Z'
  const dryRun = await archive({ cutoffAt, dryRun: true })
  assert(dryRun.response.ok, `Dry run failed: ${dryRun.response.status} ${JSON.stringify(dryRun.payload)}`)
  assert(dryRun.payload.dryRun === true, 'Dry run response lost dryRun=true')
  assert(dryRun.payload.candidates === 3, `Expected 3 dry-run candidates, got ${dryRun.payload.candidates}`)
  assert(dryRun.payload.archived === 0, 'Dry run unexpectedly archived rows')
  assert(dryRun.payload.objectKey?.startsWith('paper-collector/cold/v1/feedback/'), 'Archive object key escaped owned prefix')
  const afterDryRunStatus = await status()
  assert(afterDryRunStatus.rawEvents === beforeStatus.rawEvents, 'Dry run changed raw feedback rows')
  assert(afterDryRunStatus.archivedBatches === beforeStatus.archivedBatches, 'Dry run created an archive manifest')

  d1(
    `INSERT INTO cold_archive_leases (name, token, lease_until)
     VALUES ('feedback', 'smoke-lock', datetime('now', '+5 minutes'))
     ON CONFLICT(name) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until`,
  )
  const busy = await archive({ cutoffAt })
  assert(busy.response.status === 409, `Active archive lease returned ${busy.response.status}`)
  d1("DELETE FROM cold_archive_leases WHERE name = 'feedback' AND token = 'smoke-lock'")

  const archived = await archive({ cutoffAt })
  assert(archived.response.ok, `Archive failed: ${archived.response.status} ${JSON.stringify(archived.payload)}`)
  assert(archived.payload.archived === 3, `Expected 3 archived events, got ${archived.payload.archived}`)
  assert(archived.payload.candidates === 3, 'Archive candidate count changed from dry-run plan')
  assert(archived.payload.batchId === dryRun.payload.batchId, 'Actual archive batch differs from deterministic dry-run batch')
  assert(archived.payload.objectKey === dryRun.payload.objectKey, 'Actual archive object key differs from dry-run key')
  assert(archived.payload.checksumSha256 === dryRun.payload.checksumSha256, 'Archive checksum changed between dry run and commit')

  const afterStatus = await status()
  assert(afterStatus.rawEvents === beforeStatus.rawEvents - 3, 'Raw feedback rows were not physically removed after verified archive')
  assert(afterStatus.compactEvents === beforeStatus.compactEvents + 3, 'Compact feedback did not retain every archived event signal')
  assert(afterStatus.archivedBatches === beforeStatus.archivedBatches + 1, 'Archive batch manifest was not recorded')
  assert(afterStatus.archivedRecords === beforeStatus.archivedRecords + 3, 'Archive manifest record count is wrong')
  assert(afterStatus.archivedBytes > beforeStatus.archivedBytes, 'Archived byte metric did not increase')

  const afterRecommendation = await rebuild()
  const afterProfile = profileFor(afterRecommendation, feedId)
  assert(afterProfile, `Missing Feed profile for ${feedId} after archive`)
  assert(
    afterProfile.implicitMass === beforeProfile.implicitMass,
    `Recommendation implicit mass changed across compaction: ${beforeProfile.implicitMass} -> ${afterProfile.implicitMass}`,
  )
  assert(
    afterProfile.evidenceStrength === beforeProfile.evidenceStrength,
    `Recommendation evidence strength changed across compaction: ${beforeProfile.evidenceStrength} -> ${afterProfile.evidenceStrength}`,
  )

  const repeated = await archive({ cutoffAt })
  assert(repeated.response.ok, `Repeated archive failed: ${repeated.response.status}`)
  assert(repeated.payload.candidates === 0 && repeated.payload.archived === 0, 'Repeated archive was not idempotent')
  const finalStatus = await status()
  assert(finalStatus.compactEvents === afterStatus.compactEvents, 'Repeated archive double-counted compact feedback')
  assert(finalStatus.archivedBatches === afterStatus.archivedBatches, 'Repeated archive created a duplicate batch')

  console.log('Feedback cold archive smoke passed: dry-run, lease, verified R2 archive, D1 compaction, recommendation parity, and idempotent retry verified.')
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
