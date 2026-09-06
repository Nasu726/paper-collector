import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5177'
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const server = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5177', '--strictPort'], {
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
  throw new Error(`Timed out waiting for feedback test app.\n${output}`)
}

async function bootstrap() {
  const response = await fetch(`${baseUrl}/api/bootstrap`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Bootstrap failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function postFeedback(body) {
  const response = await fetch(`${baseUrl}/api/feedback-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json()
  return { response, payload }
}

async function listFeedback(paperId, limit = 50) {
  const response = await fetch(
    `${baseUrl}/api/papers/${encodeURIComponent(paperId)}/feedback?limit=${limit}`,
    { cache: 'no-store' },
  )
  const payload = await response.json()
  return { response, payload }
}

let exitCode = 0
try {
  await waitForServer()

  const initial = await bootstrap()
  const paper = initial.papers.find((candidate) => Array.isArray(candidate.feedIds) && candidate.feedIds.length > 0)
  assert(paper, 'Feedback smoke needs a seeded Paper with Feed membership')

  const injected = await postFeedback({
    paperId: paper.id,
    type: 'pdf_opened',
    surface: 'saved',
    feedIds: ['client-injected-feed'],
  })
  assert(injected.response.status === 400, `Client metadata injection returned ${injected.response.status}`)

  const invalidType = await postFeedback({
    paperId: paper.id,
    type: 'time_on_card',
    surface: 'inbox',
  })
  assert(invalidType.response.status === 400, `Invalid feedback type returned ${invalidType.response.status}`)

  const invalidSurface = await postFeedback({
    paperId: paper.id,
    type: 'source_opened',
    surface: 'settings',
  })
  assert(invalidSurface.response.status === 400, `Invalid feedback surface returned ${invalidSurface.response.status}`)

  const missingPaper = await postFeedback({
    paperId: 'paper-does-not-exist',
    type: 'pdf_opened',
    surface: 'inbox',
  })
  assert(missingPaper.response.status === 404, `Unknown Paper returned ${missingPaper.response.status}`)

  const first = await postFeedback({
    paperId: paper.id,
    type: 'abstract_expanded',
    surface: 'inbox',
  })
  assert(first.response.status === 201, `Valid feedback returned ${first.response.status}`)
  assert(first.payload.event?.id?.startsWith('feedback-'), 'Server-generated feedback ID is missing')
  assert(first.payload.event.paperId === paper.id, 'Feedback Paper ID changed')
  assert(first.payload.event.type === 'abstract_expanded', 'Feedback type changed')
  assert(first.payload.event.surface === 'inbox', 'Feedback surface changed')
  assert(!Number.isNaN(Date.parse(first.payload.event.occurredAt)), 'Server feedback timestamp is invalid')
  assert(
    JSON.stringify([...first.payload.event.feedIds].sort()) === JSON.stringify([...paper.feedIds].sort()),
    'Server Feed membership snapshot does not match persisted Paper membership',
  )
  assert(!('weight' in first.payload.event), 'Raw feedback response exposed a baked-in weight')

  const second = await postFeedback({
    paperId: paper.id,
    type: 'pdf_opened',
    surface: 'saved',
  })
  assert(second.response.status === 201, `Second feedback returned ${second.response.status}`)
  assert(second.payload.event.id !== first.payload.event.id, 'Append-only events reused an ID')

  const listed = await listFeedback(paper.id, 2)
  assert(listed.response.ok, `Feedback list returned ${listed.response.status}`)
  assert(listed.payload.paperId === paper.id, 'Feedback list Paper ID changed')
  assert(Array.isArray(listed.payload.events) && listed.payload.events.length === 2, 'Feedback list did not honor limit=2')
  assert(listed.payload.events[0].id === second.payload.event.id, 'Feedback list is not newest-first')
  assert(listed.payload.events[0].surface === 'saved', 'Saved surface context was not retained')
  assert(!('weight' in listed.payload.events[0]), 'Read API exposed ranking weight on raw evidence')

  const badLimit = await listFeedback(paper.id, 101)
  assert(badLimit.response.status === 400, `Out-of-range feedback limit returned ${badLimit.response.status}`)

  const missingList = await listFeedback('paper-does-not-exist')
  assert(missingList.response.status === 404, `Unknown Paper feedback list returned ${missingList.response.status}`)

  console.log('Feedback API smoke passed: validation, server context snapshot, append-only events, and bounded read verified.')
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
