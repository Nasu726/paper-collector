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

let exitCode = 0
try {
  await waitForServer()
  await clearDecisions()

  const before = await bootstrap()
  assert(before.feeds.length === 2, `Expected 2 visible seed Feeds, got ${before.feeds.length}`)
  assert(before.papers.length === 4, `Expected 4 seed Papers, got ${before.papers.length}`)

  const first = await rebuild()
  assert(first.modelVersion === 'lexical-v1', `Unexpected model version ${first.modelVersion}`)
  assert(first.visibleFeeds === 2, `Expected 2 visible Feed profiles, got ${first.visibleFeeds}`)
  assert(first.eligiblePapers === 4, `Expected 4 eligible Papers, got ${first.eligiblePapers}`)
  assert(first.globalSnapshots === 4, `Expected 4 global snapshots, got ${first.globalSnapshots}`)
  assert(first.feedSnapshots === 5, `Expected 5 per-Feed snapshots, got ${first.feedSnapshots}`)
  assert(first.snapshotRows === 9, `Expected 9 lexical-v1 rows, got ${first.snapshotRows}`)
  assert(first.profiles.every((profile) => profile.explicitCount === 0), 'Fresh rebuild unexpectedly found explicit decisions')

  const afterFirst = await bootstrap()
  assert(
    afterFirst.papers.every((paper) => paper.recommendation?.modelVersion === 'lexical-v1'),
    'Not every eligible Paper exposes the lexical-v1 global recommendation after rebuild',
  )
  assert(
    afterFirst.papers.every((paper) => Array.isArray(paper.recommendation?.reasons) && paper.recommendation.reasons.length > 0),
    'Recommendation reason text is missing',
  )
  assert(
    afterFirst.papers.every((paper) => !('score' in paper.recommendation)),
    'Internal raw score leaked into the user-facing recommendation payload',
  )

  const second = await rebuild()
  assert(second.snapshotRows === 9, `Idempotent rebuild changed lexical-v1 row count to ${second.snapshotRows}`)
  assert(second.eligiblePapers === first.eligiblePapers, 'Idempotent rebuild changed eligibility')

  const singleFeedPaper = afterFirst.papers.find((paper) => paper.feedIds.length === 1)
  assert(singleFeedPaper, 'Recommendation smoke requires a single-Feed seed Paper')
  await putDecision(singleFeedPaper, 'saved')

  const learned = await rebuild()
  assert(learned.eligiblePapers === 3, `Decided Paper remained recommendation-eligible: ${learned.eligiblePapers}`)
  assert(learned.globalSnapshots === 3, 'Decided Paper retained a global recommendation snapshot')
  assert(learned.snapshotRows === 7, `Expected 7 lexical-v1 rows after one single-Feed decision, got ${learned.snapshotRows}`)
  const affectedProfile = learned.profiles.find((profile) => profile.feedId === singleFeedPaper.feedIds[0])
  assert(affectedProfile?.savedCount === 1, 'Explicit Save was not incorporated into the Feed profile')
  assert(affectedProfile?.explicitCount === 1, 'Explicit evidence count did not change after Save')

  const afterDecision = await bootstrap()
  const decidedPaper = afterDecision.papers.find((paper) => paper.id === singleFeedPaper.id)
  assert(decidedPaper, 'Decided Paper disappeared from bootstrap history')
  assert(afterDecision.decisions[singleFeedPaper.id]?.state === 'saved', 'Saved decision is missing after recommendation rebuild')

  await deleteDecision(singleFeedPaper.id)
  const restored = await rebuild()
  assert(restored.eligiblePapers === 4, 'Returning a Paper to Inbox did not restore recommendation eligibility')
  assert(restored.snapshotRows === 9, 'Returning a Paper to Inbox did not restore its snapshots')

  console.log('Recommendation API smoke passed: lexical-v1 rebuild, user-facing snapshots, idempotence, and explicit-evidence profile updates verified.')
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
