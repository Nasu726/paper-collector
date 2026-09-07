import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5174'
const envFile = '.env'
const openAlexFixture = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
const crossrefFixture = await readFile(new URL('../test/fixtures/crossref/work.json', import.meta.url), 'utf8')
const parsedOpenAlexFixture = JSON.parse(openAlexFixture)
const broadWorks = Array.from({ length: 100 }, (_, index) => ({
  ...parsedOpenAlexFixture.results[0],
  id: `https://openalex.org/W${7000000000 + index}`,
  doi: null,
  title: `Broad first-collection fixture ${String(index + 1).padStart(3, '0')}`,
  publication_date: '2026-09-05',
}))
const viteCommand = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startMockScholarlyApis() {
  let openAlexFailing = false
  let crossrefRequests = 0
  const openAlexRequests = []

  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/works') {
        openAlexRequests.push(url.toString())
        const query = url.searchParams.get('search') ?? ''
        const isCountProbe = url.searchParams.get('per_page') === '1' && !url.searchParams.has('cursor')

        if (openAlexFailing || (query === 'probe failure safety' && isCountProbe)) {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'fixture outage' }))
          return
        }

        if (query === 'broad initial safety') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              meta: { count: 501, next_cursor: isCountProbe ? null : 'more-broad-results' },
              results: isCountProbe ? [broadWorks[0]] : broadWorks,
            }),
          )
          return
        }

        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(openAlexFixture)
        return
      }

      if (url.pathname.startsWith('/works/')) {
        crossrefRequests += 1
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
      if (!address || typeof address === 'string') {
        reject(new Error('Mock scholarly API did not expose a TCP address'))
        return
      }
      resolveServer({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        setOpenAlexFailing(value) {
          openAlexFailing = value
        },
        getCrossrefRequests() {
          return crossrefRequests
        },
        getOpenAlexRequests() {
          return [...openAlexRequests]
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

async function patchGraph(body) {
  const response = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Feed patch failed with ${response.status}: ${await response.text()}`)
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

async function evidence(paperId) {
  const response = await fetch(`${appBaseUrl}/api/papers/${encodeURIComponent(paperId)}/evidence`)
  if (!response.ok) throw new Error(`Evidence lookup failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

async function runCrossrefAgain() {
  const response = await fetch(`${appBaseUrl}/api/enrichment/crossref?limit=8`, { method: 'POST' })
  if (!response.ok) throw new Error(`Crossref enrichment failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

function requestsForQuery(requests, query) {
  return requests.map((value) => new URL(value)).filter((url) => url.searchParams.get('search') === query)
}

let vite
let mock
let createdEnvFile = false
let exitCode = 0
const output = { value: '' }

try {
  mock = await startMockScholarlyApis()
  await writeFile(
    envFile,
    [
      `OPENALEX_BASE_URL="${mock.baseUrl}"`,
      `CROSSREF_BASE_URL="${mock.baseUrl}"`,
      'CROSSREF_MAILTO="paper@example.test"',
      'CROSSREF_MIN_INTERVAL_MS="0"',
      '',
    ].join('\n'),
    { flag: 'wx' },
  )
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
  assert(doiPaper.publishedAt === '2026-09-01', 'OpenAlex publication date was not initially canonical')

  const preprint = afterFirst.papers.find((paper) => paper.id === 'openalex:w9988776655')
  assert(preprint, 'OpenAlex-ID fixture preprint is missing from bootstrap')
  assert(preprint.publicationStatus === 'preprint', 'Preprint status was not persisted')

  const second = await backfillRefresh()
  assert(second.rawFetched === 2, `Expected second refresh to fetch 2 records, got ${second.rawFetched}`)
  assert(second.inserted === 0, `Repeated refresh inserted duplicates: ${second.inserted}`)
  assert(second.updated === 2, `Expected repeated refresh to update 2 papers, got ${second.updated}`)
  assert(second.attached === 0, `Repeated refresh duplicated Feed membership: ${second.attached}`)

  const requestsBeforeScheduled = mock.getOpenAlexRequests().length
  const scheduled = await scheduledRefresh()
  assert(scheduled.outcome === 'ok', `Scheduled handler outcome was ${scheduled.outcome}`)
  assert(mock.getCrossrefRequests() === 1, `Expected one Crossref DOI request, got ${mock.getCrossrefRequests()}`)

  const initialRequests = mock.getOpenAlexRequests().slice(requestsBeforeScheduled)
  const graphInitialRequests = requestsForQuery(initialRequests, 'graph algorithms structural graph theory complexity improvement')
  const graphCountProbe = graphInitialRequests.find((url) => url.searchParams.get('per_page') === '1' && !url.searchParams.has('cursor'))
  const graphInitialSearch = graphInitialRequests.find((url) => url.searchParams.get('cursor') === '*')
  assert(graphCountProbe, 'Initial automatic collection did not probe current-year OpenAlex count')
  assert(graphInitialSearch, 'Initial automatic collection did not execute the current-year search')
  assert(graphInitialSearch.searchParams.get('per_page') === '100', 'Narrow current-year collection should use the provider page size')
  assert(
    (graphInitialSearch.searchParams.get('filter') ?? '').includes('from_publication_date:2026-01-01'),
    'Initial narrow Feed did not backfill from the start of 2026',
  )

  const afterScheduled = await bootstrap()
  const graphFeed = afterScheduled.feeds.find((feed) => feed.id === 'graph-algorithms')
  const compilerFeed = afterScheduled.feeds.find((feed) => feed.id === 'compilers')
  assert(graphFeed?.ingestion?.status === 'success', 'Scheduled graph refresh did not succeed')
  assert(compilerFeed?.ingestion?.status === 'success', 'Scheduled compiler refresh did not succeed')
  assert(graphFeed.ingestion.watermarkDate === '2026-09-06', 'Scheduled graph watermark was not advanced')
  assert(compilerFeed.ingestion.watermarkDate === '2026-09-06', 'Scheduled compiler watermark was not advanced')

  const crossFeedDoi = afterScheduled.papers.find((paper) => paper.id === 'doi:10.5555/graph.test.2026')
  assert(crossFeedDoi.feedIds.includes('compilers'), 'Scheduled refresh did not attach shared canonical paper to second Feed')
  assert(crossFeedDoi.title === 'A Fixture Paper on Graph Algorithms', 'Crossref silently overwrote canonical title')
  assert(crossFeedDoi.venue === 'Journal of Fixture Research', 'Crossref silently overwrote canonical venue')
  assert(crossFeedDoi.publishedAt === '2026-09-02', 'Publisher publication date did not become canonical')
  assert(crossFeedDoi.publicationStatus === 'published', 'Crossref enrichment regressed publication status')

  const paperEvidence = await evidence(crossFeedDoi.id)
  const titleEvidence = paperEvidence.evidence.filter((item) => item.fieldName === 'title')
  assert(titleEvidence.some((item) => item.provider === 'openalex'), 'OpenAlex title evidence is missing')
  assert(titleEvidence.some((item) => item.provider === 'crossref'), 'Crossref title disagreement is missing')
  assert(titleEvidence.some((item) => item.provider === 'openalex' && item.selected), 'OpenAlex title should remain selected')
  assert(!titleEvidence.some((item) => item.provider === 'crossref' && item.selected), 'Crossref title should not be selected')

  const publishedEvidence = paperEvidence.evidence.filter((item) => item.fieldName === 'published_at')
  assert(publishedEvidence.some((item) => item.provider === 'openalex'), 'OpenAlex publication-date evidence is missing')
  assert(
    publishedEvidence.some((item) => item.provider === 'crossref' && item.selected && item.value === '2026-09-02'),
    'Crossref publication-date evidence was not selected',
  )
  assert(
    paperEvidence.evidence.some(
      (item) => item.fieldName === 'accepted_at' && item.provider === 'crossref' && item.selected && item.value === '2026-08-20',
    ),
    'Crossref accepted-date evidence is missing or unselected',
  )

  const crossrefRequestsBeforeCachedRun = mock.getCrossrefRequests()
  const cachedEnrichment = await runCrossrefAgain()
  assert(cachedEnrichment.considered === 0, 'Fresh Crossref enrichment should have been cached')
  assert(cachedEnrichment.skippedFresh >= 1, 'Fresh Crossref state was not reported as cached')
  assert(mock.getCrossrefRequests() === crossrefRequestsBeforeCachedRun, 'Cached enrichment still called Crossref')

  const overlapping = await Promise.all([refreshGraph(), refreshGraph()])
  assert(overlapping.every((result) => result.status === 'success'), 'Overlapping refresh did not complete successfully')
  assert(overlapping.every((result) => result.inserted === 0), 'Overlapping refresh inserted duplicate canonical papers')
  assert(overlapping.every((result) => result.attached === 0), 'Overlapping refresh inserted duplicate Feed memberships')

  const afterOverlap = await bootstrap()
  const overlapGraph = afterOverlap.feeds.find((feed) => feed.id === 'graph-algorithms')
  const overlapDoi = afterOverlap.papers.find((paper) => paper.id === 'doi:10.5555/graph.test.2026')
  assert(overlapGraph?.ingestion?.watermarkDate >= '2026-09-06', 'Overlapping refresh regressed the watermark')
  assert(afterOverlap.papers.length === beforeCount + 2, 'Overlapping refresh changed canonical paper count')
  assert(overlapDoi.publishedAt === '2026-09-02', 'OpenAlex refresh overwrote selected Crossref publication date')

  mock.setOpenAlexFailing(true)
  const failedResponse = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms/refresh`, { method: 'POST' })
  assert(failedResponse.status === 502, `Expected provider failure to return 502, got ${failedResponse.status}`)

  const afterFailure = await bootstrap()
  const failedGraph = afterFailure.feeds.find((feed) => feed.id === 'graph-algorithms')
  assert(failedGraph?.ingestion?.status === 'error', 'Provider failure was not recorded on the Feed')
  assert(failedGraph.ingestion.watermarkDate >= '2026-09-06', 'Provider failure advanced backwards or erased the watermark')
  assert(Boolean(failedGraph.ingestion.lastError), 'Provider failure did not retain an error message')
  mock.setOpenAlexFailing(false)

  // Resetting the query removes the watermark. A broad first collection with >500
  // current-year matches must intentionally stop after the newest 100 and still
  // establish the incremental watermark.
  const broadPatch = await patchGraph({ providerQuery: 'broad initial safety' })
  assert(broadPatch.collectionReset === true, 'Broad test query did not reset collection state')
  const broadRequestStart = mock.getOpenAlexRequests().length
  const broadScheduled = await scheduledRefresh()
  assert(broadScheduled.outcome === 'ok', `Broad scheduled handler outcome was ${broadScheduled.outcome}`)

  const broadState = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(broadState?.status === 'success', 'Latest-100 first collection was incorrectly marked truncated')
  assert(broadState.watermarkDate === '2026-09-06', 'Latest-100 first collection did not establish a watermark')
  assert(broadState.lastFetched === 100, `Expected broad first collection to fetch 100 rows, got ${broadState.lastFetched}`)

  const broadRequests = requestsForQuery(mock.getOpenAlexRequests().slice(broadRequestStart), 'broad initial safety')
  const broadProbe = broadRequests.find((url) => url.searchParams.get('per_page') === '1' && !url.searchParams.has('cursor'))
  const broadSearches = broadRequests.filter((url) => url.searchParams.has('cursor'))
  assert(broadProbe, 'Broad first collection did not probe the current-year count')
  assert(broadSearches.length === 1, `Broad first collection fetched ${broadSearches.length} search pages instead of one`)
  assert(broadSearches[0].searchParams.get('per_page') === '100', 'Broad first collection did not enforce latest-100')
  assert(broadSearches[0].searchParams.get('cursor') === '*', 'Broad first collection did not start at newest cursor page')
  assert(
    (broadSearches[0].searchParams.get('filter') ?? '').includes('from_publication_date:2026-01-01'),
    'Broad first collection escaped the current-year window',
  )

  // A failed count probe is not allowed to open an unbounded path. It must fall
  // back to the same latest-100 current-year search and still produce a usable Feed.
  const fallbackPatch = await patchGraph({ providerQuery: 'probe failure safety' })
  assert(fallbackPatch.collectionReset === true, 'Probe-failure test query did not reset collection state')
  const fallbackRequestStart = mock.getOpenAlexRequests().length
  const fallbackScheduled = await scheduledRefresh()
  assert(fallbackScheduled.outcome === 'ok', `Probe-failure scheduled handler outcome was ${fallbackScheduled.outcome}`)

  const fallbackState = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(fallbackState?.status === 'success', 'Count-probe failure incorrectly failed the Feed refresh')
  assert(fallbackState.watermarkDate === '2026-09-06', 'Count-probe fallback did not establish a watermark')
  const fallbackRequests = requestsForQuery(mock.getOpenAlexRequests().slice(fallbackRequestStart), 'probe failure safety')
  const fallbackProbe = fallbackRequests.find((url) => url.searchParams.get('per_page') === '1' && !url.searchParams.has('cursor'))
  const fallbackSearch = fallbackRequests.find((url) => url.searchParams.get('cursor') === '*')
  assert(fallbackProbe, 'Probe-failure path did not attempt the bounded count request')
  assert(fallbackSearch?.searchParams.get('per_page') === '100', 'Probe failure did not fall back to latest-100')
  assert(
    (fallbackSearch?.searchParams.get('filter') ?? '').includes('from_publication_date:2026-01-01'),
    'Probe-failure fallback escaped the current-year window',
  )

  console.log(
    'Ingestion smoke test passed: provider enrichment, incremental semantics, <=500 annual backfill, >500 latest-100 cap, and probe-failure fallback verified.',
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
