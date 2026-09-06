import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5176'
const envFile = '.env'
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')

const rawFixture = JSON.parse(
  await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8'),
)
const fixture = structuredClone(rawFixture)
fixture.results[0].id = 'https://openalex.org/W7000000001'
fixture.results[0].doi = 'https://doi.org/10.5555/MultiFeed.Shared.2026'
fixture.results[0].title = 'A Shared Multi-Feed Fixture Paper'
fixture.results[0].primary_location.landing_page_url = 'https://publisher.example/multifeed-shared'
fixture.results[0].best_oa_location.landing_page_url = 'https://repository.example/multifeed-shared'
fixture.results[0].best_oa_location.pdf_url = 'https://repository.example/multifeed-shared.pdf'
fixture.results[1].id = 'https://openalex.org/W7000000002'
fixture.results[1].title = 'An Exclusive Multi-Feed Preprint'
fixture.results[1].primary_location.landing_page_url = 'https://preprint.example/W7000000002'
fixture.results[1].primary_location.pdf_url = 'https://preprint.example/W7000000002.pdf'
const fixtureJson = JSON.stringify(fixture)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startMockProvider() {
  let searchRequests = 0
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/works') {
        searchRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(fixtureJson)
        return
      }
      if (url.pathname.startsWith('/works/')) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(404).end()
    })

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Mock provider did not expose a TCP address'))
        return
      }
      resolveServer({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        getSearchRequests: () => searchRequests,
      })
    })
  })
}

async function waitForApp(child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dev server exited early.\n${output.value}`)
    try {
      const response = await fetch(`${appBaseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // The app may not be listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for multi-Feed test app.\n${output.value}`)
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

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${appBaseUrl}${path}`, init)
  const text = await response.text()
  let payload
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}: ${text}`)
  }
  return payload
}

async function bootstrap() {
  return jsonRequest('/api/bootstrap', { cache: 'no-store' })
}

async function createFeed(input) {
  const payload = await jsonRequest('/api/feeds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return payload.feed
}

async function transition(feedId, action) {
  return jsonRequest(`/api/feeds/${encodeURIComponent(feedId)}/${action}`, { method: 'POST' })
}

async function refresh(feedId) {
  return jsonRequest(`/api/feeds/${encodeURIComponent(feedId)}/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromDate: '2026-09-01', toDate: '2026-09-06' }),
  })
}

async function savePaper(paper) {
  return jsonRequest(`/api/decisions/${encodeURIComponent(paper.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      paperId: paper.id,
      state: 'saved',
      decidedAt: new Date().toISOString(),
      feedIds: paper.feedIds,
    }),
  })
}

async function scheduledRefresh() {
  const scheduledTime = Date.parse('2026-09-06T18:00:00Z')
  return jsonRequest(
    `/cdn-cgi/local/scheduled?format=json&cron=17+*%2F6+*+*+*&time=${scheduledTime}`,
  )
}

let vite
let mock
let createdEnvFile = false
let exitCode = 0
const output = { value: '' }

try {
  mock = await startMockProvider()
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
  vite.stdout.on('data', (chunk) => {
    output.value += chunk.toString()
  })
  vite.stderr.on('data', (chunk) => {
    output.value += chunk.toString()
  })

  await waitForApp(vite, output)

  const initial = await bootstrap()
  for (const feed of initial.feeds.filter((candidate) => candidate.active)) {
    await transition(feed.id, 'pause')
  }

  const publishedFeed = await createFeed({
    name: 'Multi-Feed Published',
    intent: 'Shared papers, but only formally published records.',
    exclusions: '',
    sourcePolicy: 'published_only',
    providerQuery: 'multifeed published query',
  })
  const broadFeed = await createFeed({
    name: 'Multi-Feed Broad',
    intent: 'Shared papers plus useful preprints.',
    exclusions: '',
    sourcePolicy: 'include_preprints',
    providerQuery: 'multifeed broad query',
  })

  const publishedRefresh = await refresh(publishedFeed.id)
  const broadRefresh = await refresh(broadFeed.id)
  assert(publishedRefresh.rawFetched === 2 && publishedRefresh.accepted === 1, 'Published-only policy did not exclude the preprint')
  assert(broadRefresh.rawFetched === 2 && broadRefresh.accepted === 2, 'Broad Feed did not accept both fixture records')

  let state = await bootstrap()
  const sharedId = 'doi:10.5555/multifeed.shared.2026'
  const preprintId = 'openalex:w7000000002'
  assert(state.papers.filter((paper) => paper.id === sharedId).length === 1, 'Shared DOI produced duplicate canonical Papers')
  assert(state.papers.filter((paper) => paper.id === preprintId).length === 1, 'Preprint produced duplicate canonical Papers')

  let shared = state.papers.find((paper) => paper.id === sharedId)
  let preprint = state.papers.find((paper) => paper.id === preprintId)
  assert(shared, 'Shared DOI Paper is missing')
  assert(preprint, 'Broad-feed preprint is missing')
  assert(shared.feedIds.includes(publishedFeed.id) && shared.feedIds.includes(broadFeed.id), 'Shared DOI is not attached to both Feeds')
  assert(preprint.feedIds.length === 1 && preprint.feedIds[0] === broadFeed.id, 'Preprint membership ignored source-policy independence')

  await savePaper(shared)

  await transition(broadFeed.id, 'archive')
  state = await bootstrap()
  shared = state.papers.find((paper) => paper.id === sharedId)
  preprint = state.papers.find((paper) => paper.id === preprintId)
  assert(shared, 'Shared Paper disappeared while it still belongs to a visible Feed')
  assert(shared.feedIds.length === 1 && shared.feedIds[0] === publishedFeed.id, 'Archived Feed leaked into visible Paper membership')
  assert(!preprint, 'Undecided Paper from an archived-only Feed remained in Inbox bootstrap')
  assert(state.decisions?.[sharedId]?.state === 'saved', 'Decision was lost when one Feed was archived')

  await transition(publishedFeed.id, 'archive')
  state = await bootstrap()
  shared = state.papers.find((paper) => paper.id === sharedId)
  assert(shared, 'Saved Paper disappeared after all source Feeds were archived')
  assert(shared.feedIds.length === 0, 'Archived-only memberships leaked into normal bootstrap')
  assert(!state.papers.some((paper) => paper.id === preprintId), 'Undecided archived-only Paper remained visible')
  assert(state.decisions?.[sharedId]?.state === 'saved', 'Saved decision was deleted by Feed archive')

  const archived = await jsonRequest('/api/feeds/archived')
  assert(archived.feeds.some((feed) => feed.id === publishedFeed.id), 'Published Feed is missing from archived Feed list')
  assert(archived.feeds.some((feed) => feed.id === broadFeed.id), 'Broad Feed is missing from archived Feed list')

  const searchesBeforeScheduled = mock.getSearchRequests()
  const scheduled = await scheduledRefresh()
  assert(scheduled.outcome === 'ok', `Scheduled handler outcome was ${scheduled.outcome}`)
  assert(mock.getSearchRequests() === searchesBeforeScheduled, 'Scheduled ingestion queried OpenAlex for archived/paused Feeds')

  await transition(broadFeed.id, 'restore')
  state = await bootstrap()
  shared = state.papers.find((paper) => paper.id === sharedId)
  preprint = state.papers.find((paper) => paper.id === preprintId)
  assert(shared?.feedIds.length === 1 && shared.feedIds[0] === broadFeed.id, 'Restoring broad Feed did not restore historical shared membership')
  assert(preprint?.feedIds.length === 1 && preprint.feedIds[0] === broadFeed.id, 'Restoring broad Feed did not restore preprint membership')
  assert(state.feeds.find((feed) => feed.id === broadFeed.id)?.active === false, 'Restored Feed should remain paused')

  const searchesBeforeSecondRestore = mock.getSearchRequests()
  await transition(publishedFeed.id, 'restore')
  state = await bootstrap()
  shared = state.papers.find((paper) => paper.id === sharedId)
  assert(
    shared?.feedIds.includes(publishedFeed.id) && shared.feedIds.includes(broadFeed.id),
    'Restoring both Feeds did not recover shared historical membership',
  )
  assert(mock.getSearchRequests() === searchesBeforeSecondRestore, 'Membership restoration unexpectedly re-fetched provider data')

  const publishedBeforeEdit = state.feeds.find((feed) => feed.id === publishedFeed.id)
  await jsonRequest(`/api/feeds/${encodeURIComponent(broadFeed.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'Edited broad Feed intent only.' }),
  })
  state = await bootstrap()
  const publishedAfterEdit = state.feeds.find((feed) => feed.id === publishedFeed.id)
  const broadAfterEdit = state.feeds.find((feed) => feed.id === broadFeed.id)
  assert(publishedAfterEdit?.intent === publishedBeforeEdit?.intent, 'Editing one Feed mutated another Feed')
  assert(broadAfterEdit?.intent === 'Edited broad Feed intent only.', 'Target Feed edit was not persisted')
  assert(state.decisions?.[sharedId]?.state === 'saved', 'Decision did not survive Feed restore/edit lifecycle')

  console.log(
    'Multi-Feed smoke test passed: canonical DOI sharing, policy independence, archive visibility, retained history, scheduled exclusion, restore, and decision preservation verified.',
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
