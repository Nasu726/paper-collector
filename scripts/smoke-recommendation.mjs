import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5179'
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const server = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5179', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
server.stdout.on('data', (chunk) => { output += chunk.toString() })
server.stderr.on('data', (chunk) => { output += chunk.toString() })

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
  throw new Error(`Timed out waiting for recommendation test app.\n${output}`)
}

async function bootstrap() {
  const response = await fetch(`${baseUrl}/api/bootstrap`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Bootstrap failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function rebuild() {
  const response = await fetch(`${baseUrl}/api/recommendations/rebuild`, { method: 'POST' })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Recommendation rebuild failed: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function clearDecisions() {
  const response = await fetch(`${baseUrl}/api/decisions`, { method: 'DELETE' })
  assert(response.status === 204, `Decision reset returned ${response.status}`)
}

async function putDecision(paper, state) {
  const decision = {
    paperId: paper.id,
    state,
    decidedAt: new Date().toISOString(),
    feedIds: paper.feedIds,
    recommendationBucket: paper.recommendation?.bucket,
    modelVersion: paper.recommendation?.modelVersion,
  }
  const response = await fetch(`${baseUrl}/api/decisions/${encodeURIComponent(paper.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decision),
  })
  assert(response.ok, `Decision PUT returned ${response.status}`)
}

async function deleteDecision(paperId) {
  const response = await fetch(`${baseUrl}/api/decisions/${encodeURIComponent(paperId)}`, { method: 'DELETE' })
  assert(response.status === 204, `Decision DELETE returned ${response.status}`)
}

function assertOpaqueRanks(papers) {
  const ranked = papers.filter((paper) => paper.recommendation)
  assert(ranked.every((paper) => Number.isInteger(paper.recommendation.rank)), 'Recommendation rank is missing')
  assert(ranked.every((paper) => !('score' in paper.recommendation)), 'Internal raw score leaked into bootstrap')
  const ranks = ranked.map((paper) => paper.recommendation.rank).sort((a, b) => a - b)
  assert(new Set(ranks).size === ranks.length, 'Recommendation ranks are not unique')
  assert(ranks.every((rank, index) => rank === index + 1), `Expected contiguous ranks, got ${ranks.join(',')}`)
}

let exitCode = 0
try {
  await waitForServer()
  await clearDecisions()

  const before = await bootstrap()
  assert(before.feeds.length >= 2, `Expected at least the 2 seed Feeds, got ${before.feeds.length}`)
  assert(before.papers.length === 4, `Expected 4 seed Papers, got ${before.papers.length}`)
  const eligibleBefore = before.papers.filter((paper) => Array.isArray(paper.feedIds) && paper.feedIds.length > 0)
  const expectedFeedSnapshots = eligibleBefore.reduce((sum, paper) => sum + paper.feedIds.length, 0)
  const expectedSnapshotRows = eligibleBefore.length + expectedFeedSnapshots

  const first = await rebuild()
  assert(first.modelVersion === 'lexical-v1', `Unexpected model version ${first.modelVersion}`)
  assert(Number.isInteger(first.generation) && first.generation > 0, 'Recommendation generation was not reserved')
  assert(first.published === true, `Initial generation ${first.generation} was not published`)
  assert(first.visibleFeeds === before.feeds.length, `Visible Feed profile count changed from ${before.feeds.length} to ${first.visibleFeeds}`)
  assert(first.eligiblePapers === eligibleBefore.length, `Expected ${eligibleBefore.length} eligible Papers, got ${first.eligiblePapers}`)
  assert(first.globalSnapshots === eligibleBefore.length, `Expected ${eligibleBefore.length} global snapshots, got ${first.globalSnapshots}`)
  assert(first.feedSnapshots === expectedFeedSnapshots, `Expected ${expectedFeedSnapshots} per-Feed snapshots, got ${first.feedSnapshots}`)
  assert(first.snapshotRows === expectedSnapshotRows, `Expected ${expectedSnapshotRows} lexical-v1 rows, got ${first.snapshotRows}`)
  assert(first.profiles.every((profile) => profile.explicitCount === 0), 'Fresh rebuild unexpectedly found explicit decisions')

  const afterFirst = await bootstrap()
  assert(afterFirst.papers.every((paper) => paper.recommendation?.modelVersion === 'lexical-v1'), 'Not every eligible Paper exposes lexical-v1')
  assert(afterFirst.papers.every((paper) => Array.isArray(paper.recommendation?.reasons) && paper.recommendation.reasons.length > 0), 'Recommendation reason text is missing')
  assertOpaqueRanks(afterFirst.papers)

  const [parallelA, parallelB] = await Promise.all([rebuild(), rebuild()])
  assert(parallelA.generation !== parallelB.generation, 'Parallel rebuilds unexpectedly shared a generation')
  assert(
    parallelA.published === true || parallelB.published === true,
    `Neither parallel generation published: ${parallelA.generation}/${parallelA.published}, ${parallelB.generation}/${parallelB.published}`,
  )
  const afterParallel = await bootstrap()
  assert(afterParallel.papers.length === before.papers.length, 'Parallel rebuild changed Paper eligibility')
  assertOpaqueRanks(afterParallel.papers)

  const singleFeedPaper = afterParallel.papers.find((paper) => paper.feedIds.length === 1)
  assert(singleFeedPaper, 'Recommendation smoke requires a single-Feed seed Paper')
  await putDecision(singleFeedPaper, 'saved')

  const learned = await rebuild()
  assert(
    learned.published === true,
    `Learned generation ${learned.generation} was superseded unexpectedly; parallel generations were ${parallelA.generation}/${parallelA.published}, ${parallelB.generation}/${parallelB.published}`,
  )
  const expectedAfterDecision = expectedSnapshotRows - 1 - singleFeedPaper.feedIds.length
  assert(learned.eligiblePapers === eligibleBefore.length - 1, `Decided Paper remained recommendation-eligible: ${learned.eligiblePapers}`)
  assert(learned.globalSnapshots === eligibleBefore.length - 1, 'Decided Paper retained a global recommendation snapshot')
  assert(learned.snapshotRows === expectedAfterDecision, `Expected ${expectedAfterDecision} rows after decision, got ${learned.snapshotRows}`)
  const affectedProfile = learned.profiles.find((profile) => profile.feedId === singleFeedPaper.feedIds[0])
  assert(affectedProfile?.savedCount === 1, 'Explicit Save was not incorporated into the Feed profile')

  const afterDecision = await bootstrap()
  const decidedPaper = afterDecision.papers.find((paper) => paper.id === singleFeedPaper.id)
  assert(decidedPaper, 'Decided Paper disappeared from bootstrap history')
  assert(afterDecision.decisions[singleFeedPaper.id]?.state === 'saved', 'Saved decision is missing after rebuild')
  assert(!decidedPaper.recommendation, `Decided Paper retained a live recommendation at rank ${decidedPaper.recommendation?.rank}`)
  assertOpaqueRanks(afterDecision.papers)

  await deleteDecision(singleFeedPaper.id)
  const restored = await rebuild()
  assert(restored.published === true, `Restored generation ${restored.generation} was not published`)
  assert(restored.eligiblePapers === eligibleBefore.length, 'Returning a Paper to Inbox did not restore recommendation eligibility')
  assert(restored.snapshotRows === expectedSnapshotRows, 'Returning a Paper to Inbox did not restore its snapshots')
  assertOpaqueRanks((await bootstrap()).papers)

  console.log('Recommendation API smoke passed: opaque ranks, concurrent generations, idempotence, and explicit-evidence updates verified.')
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
