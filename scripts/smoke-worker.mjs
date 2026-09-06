import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5173'
const viteCommand = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite',
)

const server = spawn(viteCommand, ['--host', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
server.stdout.on('data', (chunk) => {
  output += chunk.toString()
})
server.stderr.on('data', (chunk) => {
  output += chunk.toString()
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Dev server exited early.\n${output}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // The server may not be listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for dev server.\n${output}`)
}

async function getBootstrap() {
  const response = await fetch(`${baseUrl}/api/bootstrap`, { cache: 'no-store' })
  assert(response.ok, `Bootstrap failed with ${response.status}`)
  return response.json()
}

async function createFeed(body) {
  const response = await fetch(`${baseUrl}/api/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

async function patchFeed(feedId, body) {
  const response = await fetch(`${baseUrl}/api/feeds/${encodeURIComponent(feedId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

async function transitionFeed(feedId, action) {
  const response = await fetch(`${baseUrl}/api/feeds/${encodeURIComponent(feedId)}/${action}`, {
    method: 'POST',
  })
  return { response, payload: await response.json() }
}

async function run() {
  await waitForServer()

  const initial = await getBootstrap()
  assert(Array.isArray(initial.feeds), 'Bootstrap feeds must be an array')
  assert(Array.isArray(initial.papers), 'Bootstrap papers must be an array')
  assert(initial.feeds.length === 2, `Expected 2 seeded feeds, received ${initial.feeds.length}`)
  assert(initial.papers.length === 4, `Expected 4 seeded papers, received ${initial.papers.length}`)

  const invalid = await createFeed({
    name: 'Missing Query',
    intent: 'This payload should fail validation.',
    sourcePolicy: 'published_only',
  })
  assert(invalid.response.status === 400, `Invalid Feed payload returned ${invalid.response.status}`)

  const created = await createFeed({
    name: 'Dynamic Programming',
    intent: 'Theoretical dynamic programming techniques and structural optimizations.',
    exclusions: 'Avoid application-only benchmark papers.',
    sourcePolicy: 'published_only',
    providerQuery: 'dynamic programming algorithms optimization',
  })
  assert(created.response.status === 201, `Feed create returned ${created.response.status}`)
  assert(created.payload.feed?.id?.startsWith('feed-'), 'Server-generated Feed ID is missing')
  assert(created.payload.collectionReset === true, 'New Feed should begin with a fresh collection window')
  const createdId = created.payload.feed.id

  const afterCreate = await getBootstrap()
  assert(afterCreate.feeds.some((feed) => feed.id === createdId), 'Created Feed is missing from bootstrap')
  assert(afterCreate.feeds.length === 3, 'Created Feed did not increase visible Feed count')

  const renamed = await patchFeed(createdId, { name: 'DP & Optimization' })
  assert(renamed.response.ok, `Feed rename returned ${renamed.response.status}`)
  assert(renamed.payload.collectionReset === false, 'Renaming a Feed must not reset collection state')
  assert(renamed.payload.feed.providerQuery === 'dynamic programming algorithms optimization', 'Rename mutated provider query')

  const intentEdit = await patchFeed(createdId, {
    intent: 'Algorithms using dynamic programming, state compression, and nontrivial optimization.',
  })
  assert(intentEdit.response.ok, `Feed intent edit returned ${intentEdit.response.status}`)
  assert(intentEdit.payload.collectionReset === false, 'Editing explicit intent must not reset collection state')
  assert(intentEdit.payload.feed.providerQuery === 'dynamic programming algorithms optimization', 'Intent edit mutated provider query')

  const queryEdit = await patchFeed(createdId, { providerQuery: 'state compression dynamic programming' })
  assert(queryEdit.response.ok, `Feed query edit returned ${queryEdit.response.status}`)
  assert(queryEdit.payload.collectionReset === true, 'Changing provider query must reset collection state')

  const paused = await transitionFeed(createdId, 'pause')
  assert(paused.response.ok && paused.payload.feed.active === false, 'Feed pause failed')
  const resumed = await transitionFeed(createdId, 'resume')
  assert(resumed.response.ok && resumed.payload.feed.active === true, 'Feed resume failed')

  const archived = await transitionFeed(createdId, 'archive')
  assert(archived.response.ok, 'Feed archive failed')
  assert(archived.payload.feed.active === false && archived.payload.feed.archivedAt, 'Archive state is incomplete')

  const afterArchive = await getBootstrap()
  assert(!afterArchive.feeds.some((feed) => feed.id === createdId), 'Archived Feed remained in normal bootstrap')

  const archivedListResponse = await fetch(`${baseUrl}/api/feeds/archived`)
  assert(archivedListResponse.ok, `Archived Feed list returned ${archivedListResponse.status}`)
  const archivedList = await archivedListResponse.json()
  assert(archivedList.feeds.some((feed) => feed.id === createdId), 'Archived Feed is not recoverable through archive API')

  const editArchived = await patchFeed(createdId, { name: 'Should Fail' })
  assert(editArchived.response.status === 409, 'Archived Feed should require restore before editing')

  const restored = await transitionFeed(createdId, 'restore')
  assert(restored.response.ok, 'Feed restore failed')
  assert(restored.payload.feed.active === false && !restored.payload.feed.archivedAt, 'Restored Feed should return paused')
  const afterRestore = await getBootstrap()
  assert(afterRestore.feeds.some((feed) => feed.id === createdId), 'Restored Feed did not return to bootstrap')

  const paper = initial.papers[0]
  assert(paper && typeof paper.id === 'string', 'Seeded paper is missing')

  const decision = {
    paperId: paper.id,
    state: 'saved',
    decidedAt: new Date().toISOString(),
    feedIds: paper.feedIds,
    recommendationBucket: paper.recommendation?.bucket,
    modelVersion: paper.recommendation?.modelVersion,
  }

  const putResponse = await fetch(`${baseUrl}/api/decisions/${encodeURIComponent(paper.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  })
  assert(putResponse.ok, `Decision PUT failed with ${putResponse.status}`)

  const afterSave = await getBootstrap()
  assert(afterSave.decisions?.[paper.id]?.state === 'saved', 'Saved decision did not survive a new bootstrap request')

  const deleteResponse = await fetch(`${baseUrl}/api/decisions/${encodeURIComponent(paper.id)}`, {
    method: 'DELETE',
  })
  assert(deleteResponse.status === 204, `Decision DELETE failed with ${deleteResponse.status}`)

  const afterDelete = await getBootstrap()
  assert(afterDelete.decisions?.[paper.id] === undefined, 'Deleted decision remained in a new bootstrap request')

  console.log('Worker smoke test passed: Feed lifecycle validation/archive/restore and decision round-trip OK.')
}

let exitCode = 0
try {
  await run()
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output)
} finally {
  server.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => server.once('exit', resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 1000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

process.exit(exitCode)
