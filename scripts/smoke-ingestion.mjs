import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5174'
const envFile = '.env'
const fixture = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
const viteCommand = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startMockOpenAlex() {
  let failing = false
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/works') {
        response.writeHead(404).end()
        return
      }
      if (failing) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'fixture outage' }))
        return
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(fixture)
    })

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Mock OpenAlex did not expose a TCP address'))
        return
      }
      resolveServer({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        setFailing(value) {
          failing = value
        },
      })
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

async function waitForApp(server, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Dev server exited early.\n${output.value}`)
    try {
      const response = await fetch(`${appBaseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // The app may not be listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for ingestion test app.\n${output.value}`)
}

async function bootstrap() {
  const response = await fetch(`${appBaseUrl}/api/bootstrap`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

async function refreshGraph(body) {
  const options = { method: 'POST', headers: {} }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms/refresh`, options)
  if (!response.ok) throw new Error(`Feed refresh failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

async function backfillRefresh() {
  return refreshGraph({ fromDate: '2026-09-01', toDate: '2026-09-06' })
}

async function scheduledRefresh() {
  const scheduledTime = Date.parse('2026-09-06T12:00:00Z')
  const response = await fetch(
    `${appBaseUrl}/cdn-cgi/local/scheduled?format=json&cron=17+*%2F6+*+*+*&time=${scheduledTime}`,
  )
  if (!response.ok) throw new Error(`Scheduled refresh failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

let vite
let mock
let createdEnvFile = false
let exitCode = 0
const output = { value: '' }

try {
  mock = await startMockOpenAlex()
  await writeFile(envFile, `OPENALEX_BASE_URL="${mock.baseUrl}"\n`, { flag: 'wx' })
  createdEnvFile = true

  vite = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', (chunk) => {
    output.value += chunk.toString()
  })
  vite.stderr.on('data', (chunk) => {
    output.value += chunk.toString()
  })

  await waitForApp(vite, output)

  const before = await bootstrap()
  assert(Array.isArray(before.papers), 'Bootstrap papers must be an array')
  const beforeCount = before.papers.length

  const first = await backfillRefresh()
  assert(first.rawFetched === 2, `Expected first refresh to fetch 2 provider records, got ${first.rawFetched}`)
  assert(first.accepted === 2, `Expected first refresh to accept 2 papers, got ${first.accepted}`)
  assert(first.inserted === 2, `Expected first refresh to insert 2 papers, got ${first.inserted}`)
  assert(first.attached === 2, `Expected first refresh to attach 2 papers, got ${first.attached}`)
  assert(first.watermarkAdvanced === false, 'Explicit backfill must not advance the incremental watermark')

  const afterFirst = await bootstrap()
  assert(afterFirst.papers.length === beforeCount + 2, 'First refresh did not add exactly two canonical papers')
  const graphAfterBackfill = afterFirst.feeds.find((feed) => feed.id === 'graph-algorithms')
  assert(graphAfterBackfill?.ingestion?.status === 'success', 'Backfill success state was not exposed')
  assert(graphAfterBackfill.ingestion.watermarkDate === undefined, 'Backfill unexpectedly created a watermark')

  const doiPaper = afterFirst.papers.find((paper) => paper.id === 'doi:10.5555/graph.test.2026')
  assert(doiPaper, 'DOI-backed fixture paper is missing from bootstrap')
  assert(doiPaper.feedIds.includes('graph-algorithms'), 'DOI paper is not attached to the target Feed')
  assert(doiPaper.pdfUrl === 'https://repository.example/graph-test.pdf', 'Open PDF URL was not persisted')

  const preprint = afterFirst.papers.find((paper) => paper.id === 'openalex:w9988776655')
  assert(preprint, 'OpenAlex-ID fixture preprint is missing from bootstrap')
  assert(preprint.publicationStatus === 'preprint', 'Preprint status was not persisted')

  const second = await backfillRefresh()
  assert(second.rawFetched === 2, `Expected second refresh to fetch 2 records, got ${second.rawFetched}`)
  assert(second.inserted === 0, `Repeated refresh inserted duplicates: ${second.inserted}`)
  assert(second.updated === 2, `Expected repeated refresh to update 2 papers, got ${second.updated}`)
  assert(second.attached === 0, `Repeated refresh duplicated Feed membership: ${second.attached}`)

  const scheduled = await scheduledRefresh()
  assert(scheduled.outcome === 'ok', `Scheduled handler outcome was ${scheduled.outcome}`)

  const afterScheduled = await bootstrap()
  const graphFeed = afterScheduled.feeds.find((feed) => feed.id === 'graph-algorithms')
  const compilerFeed = afterScheduled.feeds.find((feed) => feed.id === 'compilers')
  assert(graphFeed?.ingestion?.status === 'success', 'Scheduled graph refresh did not succeed')
  assert(compilerFeed?.ingestion?.status === 'success', 'Scheduled compiler refresh did not succeed')
  assert(graphFeed.ingestion.watermarkDate === '2026-09-06', 'Scheduled graph watermark was not advanced')
  assert(compilerFeed.ingestion.watermarkDate === '2026-09-06', 'Scheduled compiler watermark was not advanced')

  const crossFeedDoi = afterScheduled.papers.find((paper) => paper.id === 'doi:10.5555/graph.test.2026')
  assert(crossFeedDoi.feedIds.includes('compilers'), 'Scheduled refresh did not attach shared canonical paper to second Feed')

  const overlapping = await Promise.all([refreshGraph(), refreshGraph()])
  assert(overlapping.every((result) => result.status === 'success'), 'Overlapping refresh did not complete successfully')
  assert(overlapping.every((result) => result.inserted === 0), 'Overlapping refresh inserted duplicate canonical papers')
  assert(overlapping.every((result) => result.attached === 0), 'Overlapping refresh inserted duplicate Feed memberships')

  const afterOverlap = await bootstrap()
  const overlapGraph = afterOverlap.feeds.find((feed) => feed.id === 'graph-algorithms')
  assert(overlapGraph?.ingestion?.watermarkDate >= '2026-09-06', 'Overlapping refresh regressed the watermark')
  assert(afterOverlap.papers.length === beforeCount + 2, 'Overlapping refresh changed canonical paper count')

  mock.setFailing(true)
  const failedResponse = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms/refresh`, { method: 'POST' })
  assert(failedResponse.status === 502, `Expected provider failure to return 502, got ${failedResponse.status}`)

  const afterFailure = await bootstrap()
  const failedGraph = afterFailure.feeds.find((feed) => feed.id === 'graph-algorithms')
  assert(failedGraph?.ingestion?.status === 'error', 'Provider failure was not recorded on the Feed')
  assert(failedGraph.ingestion.watermarkDate >= '2026-09-06', 'Provider failure advanced backwards or erased the watermark')
  assert(Boolean(failedGraph.ingestion.lastError), 'Provider failure did not retain an error message')

  console.log(
    'Ingestion smoke test passed: idempotent backfill, scheduled watermark, overlapping refresh, and failure-preserving watermark verified.',
  )
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output.value)
} finally {
  await stopChild(vite)
  if (mock) await new Promise((resolveClose) => mock.server.close(resolveClose))
  if (createdEnvFile) {
    try {
      await unlink(envFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error(`Could not remove ${envFile}:`, error)
    }
  }
}

process.exit(exitCode)
