import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appBaseUrl = 'http://127.0.0.1:5175'
const envFile = '.env'
const fixture = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
const viteCommand = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startMockProvider() {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/works') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(fixture)
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
      resolveServer({ server, baseUrl: `http://127.0.0.1:${address.port}` })
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
      // App may not be listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for Feed lifecycle test app.\n${output.value}`)
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

async function bootstrap() {
  const response = await fetch(`${appBaseUrl}/api/bootstrap`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}: ${await response.text()}`)
  return response.json()
}

async function scheduledRefresh() {
  const scheduledTime = Date.parse('2026-09-06T12:00:00Z')
  const response = await fetch(
    `${appBaseUrl}/cdn-cgi/local/scheduled?format=json&cron=17+*%2F6+*+*+*&time=${scheduledTime}`,
  )
  if (!response.ok) throw new Error(`Scheduled refresh failed with ${response.status}: ${await response.text()}`)
  const body = await response.json()
  assert(body.outcome === 'ok', `Scheduled handler outcome was ${body.outcome}`)
}

async function patchFeed(body) {
  const response = await fetch(`${appBaseUrl}/api/feeds/graph-algorithms`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Feed patch failed with ${response.status}: ${await response.text()}`)
  return response.json()
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

  vite = spawn(viteCommand, ['--host', '127.0.0.1', '--port', '5175', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', (chunk) => {
    output.value += chunk.toString()
  })
  vite.stderr.on('data', (chunk) => {
    output.value += chunk.toString()
  })

  await waitForApp(vite, output)
  await scheduledRefresh()

  let state = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(state?.watermarkDate === '2026-09-06', 'Scheduled refresh did not establish the expected watermark')

  const intentPatch = await patchFeed({ intent: 'Updated human-facing graph research intent only.' })
  assert(intentPatch.collectionReset === false, 'Intent-only edit unexpectedly reset collection state')
  state = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(state?.watermarkDate === '2026-09-06', 'Intent-only edit erased the watermark')

  const queryPatch = await patchFeed({ providerQuery: 'graph algorithms separators shortest paths' })
  assert(queryPatch.collectionReset === true, 'Provider query edit did not request a collection reset')
  state = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(state === undefined, 'Provider query edit did not remove the previous ingestion checkpoint')

  await scheduledRefresh()
  state = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(state?.watermarkDate === '2026-09-06', 'Refresh after query edit did not create a fresh checkpoint')

  const policyPatch = await patchFeed({ sourcePolicy: 'published_only' })
  assert(policyPatch.collectionReset === true, 'Source policy edit did not request a collection reset')
  state = (await bootstrap()).feeds.find((feed) => feed.id === 'graph-algorithms')?.ingestion
  assert(state === undefined, 'Source policy edit did not remove the previous ingestion checkpoint')

  console.log('Feed lifecycle smoke test passed: intent preserves checkpoint; query/policy changes reset it.')
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
