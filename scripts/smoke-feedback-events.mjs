import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const baseUrl = 'http://127.0.0.1:5177'
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
const validEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  paperId: 'demo-cross-1',
  type: 'pdf_opened',
  surface: 'inbox',
  occurredAt: '2026-09-07T01:00:00+09:00',
  feedIds: ['compilers', 'graph-algorithms'],
  schemaVersion: 1,
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForServer(server, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Dev server exited early.\n${output.value}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for feedback test Worker.\n${output.value}`)
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

async function postEvent(event) {
  const response = await fetch(`${baseUrl}/api/feedback-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  let payload
  try { payload = await response.json() } catch { payload = null }
  return { response, payload }
}

const output = { value: '' }
const server = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5177', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => { output.value += chunk.toString() })
server.stderr.on('data', (chunk) => { output.value += chunk.toString() })

let exitCode = 0
try {
  await waitForServer(server, output)

  const first = await postEvent(validEvent)
  assert(first.response.status === 201, `Expected new event 201, got ${first.response.status}`)
  assert(first.payload?.duplicate === false, 'First event was incorrectly marked duplicate')
  assert(first.payload?.event?.occurredAt === '2026-09-06T16:00:00.000Z', 'Event timestamp was not normalized')
  assert(first.payload?.event?.feedIds?.join(',') === 'compilers,graph-algorithms', 'Feed snapshot was not normalized')

  const duplicate = await postEvent(validEvent)
  assert(duplicate.response.status === 200, `Expected duplicate retry 200, got ${duplicate.response.status}`)
  assert(duplicate.payload?.duplicate === true, 'Identical retry was not reported as duplicate')

  const conflict = await postEvent({ ...validEvent, type: 'source_opened' })
  assert(conflict.response.status === 409, `Expected conflicting event ID 409, got ${conflict.response.status}`)

  const missingPaper = await postEvent({
    ...validEvent,
    id: '22222222-2222-4222-8222-222222222222',
    paperId: 'paper-does-not-exist',
  })
  assert(missingPaper.response.status === 422, `Expected missing Paper 422, got ${missingPaper.response.status}`)

  const invalidContext = await postEvent({
    ...validEvent,
    id: '33333333-3333-4333-8333-333333333333',
    paperId: 'demo-compiler-1',
    feedIds: ['graph-algorithms'],
  })
  assert(invalidContext.response.status === 422, `Expected invalid Feed context 422, got ${invalidContext.response.status}`)

  const invalidType = await postEvent({
    ...validEvent,
    id: '44444444-4444-4444-8444-444444444444',
    type: 'dwell_time',
  })
  assert(invalidType.response.status === 400, `Expected invalid type 400, got ${invalidType.response.status}`)

  const invalidSurface = await postEvent({
    ...validEvent,
    id: '55555555-5555-4555-8555-555555555555',
    surface: 'dashboard',
  })
  assert(invalidSurface.response.status === 400, `Expected invalid surface 400, got ${invalidSurface.response.status}`)

  const inspection = await fetch(`${baseUrl}/api/papers/demo-cross-1/feedback-events`)
  assert(inspection.ok, `Feedback inspection failed with ${inspection.status}`)
  const inspectionPayload = await inspection.json()
  const matching = inspectionPayload.events.filter((event) => event.id === validEvent.id)
  assert(matching.length === 1, `Idempotent retry created ${matching.length} rows`)
  assert(matching[0].type === 'pdf_opened', 'Stored event type changed after conflicting retry')
  assert(matching[0].surface === 'inbox', 'Stored surface is incorrect')
  assert(matching[0].schemaVersion === 1, 'Stored schema version is incorrect')
  assert(typeof matching[0].receivedAt === 'string', 'Server receipt timestamp is missing')
  assert(!('weight' in matching[0]), 'Raw feedback API exposed a recommendation weight')

  console.log('Feedback event smoke passed: validation, idempotency, conflict handling, context, and inspection verified.')
} catch (error) {
  exitCode = 1
  console.error(error)
  console.error(output.value)
} finally {
  await stopChild(server)
}

process.exit(exitCode)
