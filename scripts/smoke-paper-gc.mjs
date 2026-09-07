import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5184'
const envFile = '.env'
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8'))
const sourceWork = fixture.results[0]
const gcDoi = '10.5555/paper-gc.test.2026'
const gcPaperId = `doi:${gcDoi}`
const gcWork = {
  ...sourceWork,
  id: 'https://openalex.org/W9876543210',
  doi: `https://doi.org/${gcDoi}`,
  title: 'Separator Learning Signal for Paper GC Regression',
  publication_date: '2026-09-04',
}

const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const wranglerCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runSql(command) {
  return execFileSync(
    wranglerCommand,
    ['d1', 'execute', 'DB', '--local', '--command', command, '--json'],
    { encoding: 'utf8' },
  )
}

function sqlCount(command) {
  const output = runSql(command)
  const parsed = JSON.parse(output)
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  const row = first?.results?.[0]
  const value = Number(row?.count)
  if (!Number.isFinite(value)) throw new Error(`Could not parse D1 count from: ${output}`)
  return value
}

function startOpenAlexMock() {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/works') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ meta: { count: 1, next_cursor: null }, results: [gcWork] }))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Paper GC OpenAlex mock did not expose a TCP address'))
        return
      }
      resolveServer({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function stopServer(server) {
  if (!server) return
  await new Promise((resolveClose) => server.close(resolveClose))
}

async function waitForApp(vite, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error(`Dev server exited early.\n${output.value}`)
    try {
      const response = await fetch(`${appBaseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // App may still be starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for Paper GC app.\n${output.value}`)
}

async function bootstrap() {
  const response = await fetch(`${appBaseUrl}/api/bootstrap`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Bootstrap failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function clearDecisions() {
  const response = await fetch(`${appBaseUrl}/api/decisions`, { method: 'DELETE' })
  assert(response.status === 204, `Decision reset returned ${response.status}`)
}

async function refreshGraph() {
  const response = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromDate: '2026-09-01', toDate: '2026-09-06' }),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`GC fixture refresh failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function putDecision(paper, state, decidedAt) {
  const response = await fetch(`${appBaseUrl}/api/decisions/${encodeURIComponent(paper.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      paperId: paper.id,
      state,
      decidedAt,
      feedIds: paper.feedIds,
      recommendationBucket: paper.recommendation?.bucket,
      modelVersion: paper.recommendation?.modelVersion,
    }),
  })
  assert(response.ok, `Decision PUT for ${paper.id} returned ${response.status}`)
}

async function postFeedback(paperId) {
  const response = await fetch(`${appBaseUrl}/api/feedback-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paperId, type: 'pdf_opened', surface: 'inbox' }),
  })
  assert(response.status === 201, `Feedback POST returned ${response.status}: ${await response.text()}`)
}

async function rebuild() {
  const response = await fetch(`${appBaseUrl}/api/recommendations/rebuild`, { method: 'POST' })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Recommendation rebuild failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function storageStats() {
  const response = await fetch(`${appBaseUrl}/api/storage/stats`, { cache: 'no-store' })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Storage stats failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function runGc() {
  const response = await fetch(`${appBaseUrl}/api/storage/gc?limit=50`, { method: 'POST' })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Paper GC failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

let vite
let mock
let previousEnv
let hadEnv = false
let exitCode = 0
const output = { value: '' }

try {
  try {
    previousEnv = await readFile(envFile, 'utf8')
    hadEnv = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  mock = await startOpenAlexMock()
  await writeFile(envFile, `OPENALEX_BASE_URL="${mock.baseUrl}"\n`)

  vite = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5184', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', (chunk) => { output.value += chunk.toString() })
  vite.stderr.on('data', (chunk) => { output.value += chunk.toString() })

  await waitForApp(vite, output)
  await clearDecisions()

  const firstRefresh = await refreshGraph()
  assert(firstRefresh.inserted === 1, `Expected GC fixture insertion, got ${firstRefresh.inserted}`)

  const initial = await bootstrap()
  const gcPaper = initial.papers.find((paper) => paper.id === gcPaperId)
  const retainedPaper = initial.papers.find((paper) => paper.id === 'demo-graph-1')
  const savedPaper = initial.papers.find((paper) => paper.id === 'demo-compiler-1')
  const recentPaper = initial.papers.find((paper) => paper.id === 'demo-graph-2')
  assert(gcPaper && retainedPaper && savedPaper && recentPaper, 'GC smoke is missing required live Papers')

  await putDecision(gcPaper, 'rejected', '2026-07-01T00:00:00.000Z')
  await putDecision(retainedPaper, 'rejected', '2026-07-01T00:00:00.000Z')
  await putDecision(savedPaper, 'saved', '2026-07-01T00:00:00.000Z')
  await putDecision(recentPaper, 'rejected', new Date().toISOString())
  await postFeedback(gcPaper.id)

  runSql(
    `INSERT OR REPLACE INTO paper_retention_refs (paper_id, owner, reference_id) VALUES (` +
      `${sqlString(retainedPaper.id)}, 'paper-gc-smoke', 'reader-retained')`,
  )

  const beforeProfileReport = await rebuild()
  const targetFeedId = gcPaper.feedIds[0]
  const beforeProfile = beforeProfileReport.profiles.find((profile) => profile.feedId === targetFeedId)
  assert(beforeProfile, `No recommendation profile found for ${targetFeedId}`)

  const before = await storageStats()
  const gc = await runGc()
  assert(gc.retentionDays === 30, `Unexpected GC retention window ${gc.retentionDays}`)
  assert(gc.purged >= 1, `Expected at least one purged Paper, got ${gc.purged}`)
  assert(gc.estimatedBytesFreed > 0, 'GC did not report any estimated bytes freed')
  assert(gc.after.paperRows < gc.before.paperRows, 'GC did not reduce canonical Paper row count')
  assert(gc.after.estimatedPaperBytes < gc.before.estimatedPaperBytes, 'GC did not reduce estimated Paper bytes')
  assert(gc.after.purgedLearningRows > before.purgedLearningRows, 'GC did not retain compact learning evidence')
  assert(gc.after.seenIdentifierRows > before.seenIdentifierRows, 'GC did not retain minimal seen identifiers')

  const afterGc = await bootstrap()
  assert(!afterGc.papers.some((paper) => paper.id === gcPaper.id), 'Purged Paper metadata remained in bootstrap')
  assert(afterGc.decisions[gcPaper.id]?.state === 'rejected', 'Rejected decision disappeared after Paper purge')
  assert(afterGc.papers.some((paper) => paper.id === retainedPaper.id), 'Reader-retained Paper was purged')
  assert(afterGc.papers.some((paper) => paper.id === savedPaper.id), 'Saved Paper was purged')
  assert(afterGc.papers.some((paper) => paper.id === recentPaper.id), 'Recent rejected Paper was purged before retention elapsed')

  const feedbackCount = sqlCount(
    `SELECT COUNT(*) AS count FROM feedback_events WHERE paper_id = ${sqlString(gcPaper.id)}`,
  )
  assert(feedbackCount >= 1, 'Feedback event was deleted with canonical Paper metadata')

  const livePaperCount = sqlCount(
    `SELECT COUNT(*) AS count FROM papers WHERE id = ${sqlString(gcPaper.id)}`,
  )
  assert(livePaperCount === 0, 'Canonical papers row was not physically deleted')

  const afterProfileReport = await rebuild()
  const afterProfile = afterProfileReport.profiles.find((profile) => profile.feedId === targetFeedId)
  assert(afterProfile, `No post-GC recommendation profile found for ${targetFeedId}`)
  assert(
    afterProfile.explicitCount === beforeProfile.explicitCount &&
      afterProfile.rejectedCount === beforeProfile.rejectedCount,
    `Purged learning signal disappeared: before ${beforeProfile.explicitCount}/${beforeProfile.rejectedCount}, after ${afterProfile.explicitCount}/${afterProfile.rejectedCount}`,
  )

  const repeatRefresh = await refreshGraph()
  assert(repeatRefresh.inserted === 0, `Previously purged Paper was reinserted: ${repeatRefresh.inserted}`)
  const afterRepeat = await bootstrap()
  assert(!afterRepeat.papers.some((paper) => paper.id === gcPaper.id), 'Seen identifier failed to prevent Paper recreation')

  console.log('Paper GC smoke passed: hard delete, retention guards, learning preservation, feedback retention, storage reduction, and re-fetch suppression verified.')
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output.value)
} finally {
  await stopChild(vite)
  await stopServer(mock?.server)
  if (hadEnv) await writeFile(envFile, previousEnv)
  else {
    try { await unlink(envFile) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

process.exit(exitCode)
