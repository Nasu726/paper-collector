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

async function run() {
  await waitForServer()

  const initial = await getBootstrap()
  assert(Array.isArray(initial.feeds), 'Bootstrap feeds must be an array')
  assert(Array.isArray(initial.papers), 'Bootstrap papers must be an array')
  assert(initial.feeds.length === 2, `Expected 2 seeded feeds, received ${initial.feeds.length}`)
  assert(initial.papers.length === 4, `Expected 4 seeded papers, received ${initial.papers.length}`)

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

  console.log(`Worker smoke test passed: ${initial.feeds.length} feeds, ${initial.papers.length} papers, decision round-trip OK.`)
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
