import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5176'
const envFile = '.env'
const openAlexFixture = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
const crossrefFixture = await readFile(new URL('../test/fixtures/crossref/work.json', import.meta.url), 'utf8')
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')

const graphId = 'graph-algorithms'
const compilerId = 'compilers'
const graphQuery = 'graph invariant lifecycle query'
const compilerQuery = 'compiler invariant lifecycle query'
const sharedPaperId = 'doi:10.5555/graph.test.2026'
const graphOnlyPreprintId = 'openalex:w9988776655'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startMockApis() {
  const queryCounts = new Map()
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/works') {
        const query = url.searchParams.get('search') ?? ''
        queryCounts.set(query, (queryCounts.get(query) ?? 0) + 1)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(openAlexFixture)
        return
      }
      if (url.pathname.startsWith('/works/')) {
        const requestedDoi = decodeURIComponent(url.pathname.slice('/works/'.length)).toLowerCase()
        if (requestedDoi !== '10.5555/graph.test.2026') {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(crossrefFixture)
        return
      }
      response.writeHead(404).end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Mock API has no TCP address'))
      resolveServer({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        count(query) {
          return queryCounts.get(query) ?? 0
        },
      })
    })
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function waitForApp(child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dev server exited early.\n${output.value}`)
    try {
      const response = await fetch(`${appBaseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for app.\n${output.value}`)
}

async function jsonRequest(path, init) {
  const response = await fetch(`${appBaseUrl}${path}`, init)
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

async function bootstrap() {
  return jsonRequest('/api/bootstrap')
}

async function patchFeed(feedId, body) {
  return jsonRequest(`/api/feeds/${feedId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function transition(feedId, action) {
  return jsonRequest(`/api/feeds/${feedId}/${action}`, { method: 'POST' })
}

async function scheduled(time) {
  const response = await fetch(
    `${appBaseUrl}/cdn-cgi/local/scheduled?format=json&cron=17+*%2F6+*+*+*&time=${time}`,
  )
  if (!response.ok) throw new Error(`Scheduled invocation failed: ${response.status} ${await response.text()}`)
  const payload = await response.json()
  assert(payload.outcome === 'ok', `Scheduled outcome was ${payload.outcome}`)
}

let vite
let mock
let createdEnvFile = false
let exitCode = 0
const output = { value: '' }

try {
  mock = await startMockApis()
  await writeFile(
    envFile,
    [
      `OPENALEX_BASE_URL="${mock.baseUrl}"`,
      `CROSSREF_BASE_URL="${mock.baseUrl}"`,
      'CROSSREF_MIN_INTERVAL_MS="0"',
      '',
    ].join('\n'),
    { flag: 'wx' },
  )
  createdEnvFile = true

  vite = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5176', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', (chunk) => { output.value += chunk.toString() })
  vite.stderr.on('data', (chunk) => { output.value += chunk.toString() })
  await waitForApp(vite, output)

  // Normalize state left by earlier smoke tests.
  await patchFeed(graphId, {
    name: 'Graph Algorithms',
    intent: 'Graph algorithms integration invariant.',
    providerQuery: graphQuery,
    sourcePolicy: 'include_preprints',
  })
  await patchFeed(compilerId, {
    name: 'Compilers',
    intent: 'Compiler integration invariant.',
    providerQuery: compilerQuery,
    sourcePolicy: 'published_only',
  })
  await transition(graphId, 'resume')
  await transition(compilerId, 'resume')

  await scheduled(Date.parse('2026-09-06T12:00:00Z'))
  assert(mock.count(graphQuery) === 1, 'Graph Feed was not collected exactly once')
  assert(mock.count(compilerQuery) === 1, 'Compiler Feed was not collected exactly once')

  let state = await bootstrap()
  const canonicalMatches = state.papers.filter((paper) => paper.id === sharedPaperId)
  assert(canonicalMatches.length === 1, `Expected one canonical shared DOI Paper, got ${canonicalMatches.length}`)
  const sharedPaper = canonicalMatches[0]
  assert(sharedPaper.feedIds.includes(graphId), 'Shared Paper is missing Graph membership')
  assert(sharedPaper.feedIds.includes(compilerId), 'Shared Paper is missing Compiler membership')
  const graphOnlyPreprint = state.papers.find((paper) => paper.id === graphOnlyPreprintId)
  assert(graphOnlyPreprint, 'Graph-only preprint is missing')
  assert(
    graphOnlyPreprint.feedIds.length === 1 && graphOnlyPreprint.feedIds[0] === graphId,
    'Source-policy-specific preprint membership is incorrect',
  )

  const decision = {
    paperId: sharedPaperId,
    state: 'saved',
    decidedAt: new Date().toISOString(),
    feedIds: sharedPaper.feedIds,
  }
  await jsonRequest(`/api/decisions/${encodeURIComponent(sharedPaperId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  })

  let provenance = await jsonRequest(`/api/papers/${encodeURIComponent(sharedPaperId)}/provenance`)
  assert(provenance.provenance.some((item) => item.feedId === graphId), 'Graph provenance is missing')
  assert(provenance.provenance.some((item) => item.feedId === compilerId), 'Compiler provenance is missing')

  const graphBeforeCompilerEdit = state.feeds.find((feed) => feed.id === graphId)
  await patchFeed(compilerId, { intent: 'Compiler intent changed independently.' })
  state = await bootstrap()
  const graphAfterCompilerEdit = state.feeds.find((feed) => feed.id === graphId)
  const compilerAfterEdit = state.feeds.find((feed) => feed.id === compilerId)
  assert(graphAfterCompilerEdit.intent === graphBeforeCompilerEdit.intent, 'Editing Compiler Feed mutated Graph intent')
  assert(graphAfterCompilerEdit.providerQuery === graphBeforeCompilerEdit.providerQuery, 'Editing Compiler Feed mutated Graph query')
  assert(compilerAfterEdit.intent === 'Compiler intent changed independently.', 'Compiler edit was not persisted')

  await transition(graphId, 'archive')
  state = await bootstrap()
  assert(!state.feeds.some((feed) => feed.id === graphId), 'Archived Graph Feed remains in normal bootstrap')
  const afterArchivePaper = state.papers.find((paper) => paper.id === sharedPaperId)
  assert(afterArchivePaper, 'Archiving a Feed deleted the shared Paper')
  assert(!afterArchivePaper.feedIds.includes(graphId), 'Archived Graph membership leaked into normal Paper feedIds')
  assert(afterArchivePaper.feedIds.includes(compilerId), 'Archive damaged visible Compiler membership')
  assert(
    !state.papers.some((paper) => paper.id === graphOnlyPreprintId),
    'Undecided Paper from an archived-only Feed remained in normal bootstrap',
  )
  assert(state.decisions?.[sharedPaperId]?.state === 'saved', 'Archive deleted the saved decision')

  provenance = await jsonRequest(`/api/papers/${encodeURIComponent(sharedPaperId)}/provenance`)
  assert(provenance.provenance.some((item) => item.feedId === graphId), 'Archive deleted Graph provenance')
  assert(provenance.provenance.some((item) => item.feedId === compilerId), 'Archive deleted Compiler provenance')
  const archived = await jsonRequest('/api/feeds/archived')
  assert(archived.feeds.some((feed) => feed.id === graphId), 'Archived Graph Feed is not recoverable')

  const graphCountBeforeArchivedSchedule = mock.count(graphQuery)
  const compilerCountBeforeArchivedSchedule = mock.count(compilerQuery)
  await scheduled(Date.parse('2026-09-06T18:00:00Z'))
  assert(mock.count(graphQuery) === graphCountBeforeArchivedSchedule, 'Archived Feed was still scheduled')
  assert(mock.count(compilerQuery) === compilerCountBeforeArchivedSchedule + 1, 'Active Compiler Feed was not scheduled')

  await transition(compilerId, 'archive')
  state = await bootstrap()
  const decidedArchivedOnlyPaper = state.papers.find((paper) => paper.id === sharedPaperId)
  assert(decidedArchivedOnlyPaper, 'Saved Paper disappeared when all source Feeds were archived')
  assert(decidedArchivedOnlyPaper.feedIds.length === 0, 'Archived-only Feed IDs leaked onto a decided Paper')
  assert(
    !state.papers.some((paper) => paper.id === graphOnlyPreprintId),
    'Undecided archived-only Paper reappeared after all Feeds were archived',
  )
  assert(state.decisions?.[sharedPaperId]?.state === 'saved', 'Decision was lost when all source Feeds were archived')

  provenance = await jsonRequest(`/api/papers/${encodeURIComponent(sharedPaperId)}/provenance`)
  assert(provenance.provenance.some((item) => item.feedId === graphId), 'All-archive transition deleted Graph provenance')
  assert(provenance.provenance.some((item) => item.feedId === compilerId), 'All-archive transition deleted Compiler provenance')

  const compilerRestored = await transition(compilerId, 'restore')
  assert(compilerRestored.feed.active === false && !compilerRestored.feed.archivedAt, 'Compiler restore must return paused')
  state = await bootstrap()
  const compilerOnlyShared = state.papers.find((paper) => paper.id === sharedPaperId)
  assert(
    compilerOnlyShared?.feedIds.length === 1 && compilerOnlyShared.feedIds[0] === compilerId,
    'Restoring Compiler Feed did not reveal retained historical membership',
  )
  assert(
    !state.papers.some((paper) => paper.id === graphOnlyPreprintId),
    'Graph-only preprint became visible while Graph Feed remained archived',
  )

  const graphCountBeforeRestore = mock.count(graphQuery)
  const restored = await transition(graphId, 'restore')
  assert(restored.feed.active === false && !restored.feed.archivedAt, 'Restore must return Feed in paused state')
  state = await bootstrap()
  const restoredShared = state.papers.find((paper) => paper.id === sharedPaperId)
  const restoredPreprint = state.papers.find((paper) => paper.id === graphOnlyPreprintId)
  assert(restoredShared?.feedIds.includes(graphId), 'Restoring Graph Feed did not reveal retained shared membership')
  assert(restoredShared?.feedIds.includes(compilerId), 'Restoring Graph Feed damaged Compiler membership')
  assert(
    restoredPreprint?.feedIds.length === 1 && restoredPreprint.feedIds[0] === graphId,
    'Restoring Graph Feed did not reveal retained preprint membership',
  )
  assert(mock.count(graphQuery) === graphCountBeforeRestore, 'Restore unexpectedly re-fetched provider data')

  const graphCountBeforePausedSchedule = mock.count(graphQuery)
  const compilerCountBeforePausedSchedule = mock.count(compilerQuery)
  await scheduled(Date.parse('2026-09-07T00:00:00Z'))
  assert(mock.count(graphQuery) === graphCountBeforePausedSchedule, 'Restored-paused Graph Feed was scheduled')
  assert(mock.count(compilerQuery) === compilerCountBeforePausedSchedule, 'Restored-paused Compiler Feed was scheduled')

  await transition(graphId, 'resume')
  await scheduled(Date.parse('2026-09-07T06:00:00Z'))
  assert(mock.count(graphQuery) === graphCountBeforePausedSchedule + 1, 'Resumed Graph Feed was not scheduled')
  assert(mock.count(compilerQuery) === compilerCountBeforePausedSchedule, 'Paused Compiler Feed was unexpectedly scheduled')

  state = await bootstrap()
  assert(state.papers.filter((paper) => paper.id === sharedPaperId).length === 1, 'Lifecycle transitions duplicated canonical Paper')
  assert(state.decisions?.[sharedPaperId]?.state === 'saved', 'Lifecycle transitions lost decision history')

  console.log(
    'Multi-Feed lifecycle smoke passed: canonical identity, archive-aware bootstrap visibility, retained history, independent edits, and scheduling states verified.',
  )
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output.value)
} finally {
  await stopChild(vite)
  if (mock) await new Promise((resolve) => mock.server.close(resolve))
  if (createdEnvFile) {
    try { await unlink(envFile) } catch (error) { if (error?.code !== 'ENOENT') console.error(error) }
  }
}

process.exit(exitCode)
