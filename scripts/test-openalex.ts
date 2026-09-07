import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { planInitialCollection } from '../worker/feedRefresh'
import {
  normalizeDoi,
  normalizeOpenAlexId,
  OpenAlexProvider,
  reconstructOpenAlexAbstract,
} from '../worker/providers/openalex'

const fixtureText = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
const fixture = JSON.parse(fixtureText) as { results: unknown[] }
let lastUrl = ''

const fetchImpl: typeof fetch = async (input) => {
  lastUrl = input instanceof Request ? input.url : input.toString()
  return new Response(fixtureText, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

assert.equal(normalizeDoi('https://doi.org/10.5555/Graph.Test.2026'), '10.5555/graph.test.2026')
assert.equal(normalizeDoi('not-a-doi'), undefined)
assert.equal(normalizeOpenAlexId('https://openalex.org/W1234567890'), 'W1234567890')
assert.equal(normalizeOpenAlexId('A123'), undefined)
assert.equal(
  reconstructOpenAlexAbstract({ algorithms: [3], We: [0], graph: [2], study: [1] }),
  'We study graph algorithms',
)

assert.deepEqual(planInitialCollection('2026-09-07', 500), {
  fromDate: '2026-01-01',
  maxResults: 500,
  mode: 'current_year',
  countedMatches: 500,
})
assert.deepEqual(planInitialCollection('2026-09-07', 501), {
  fromDate: '2026-01-01',
  maxResults: 100,
  mode: 'latest_100',
  countedMatches: 501,
})
assert.deepEqual(planInitialCollection('2026-09-07'), {
  fromDate: '2026-01-01',
  maxResults: 100,
  mode: 'latest_100',
  countedMatches: undefined,
})

const provider = new OpenAlexProvider({
  baseUrl: 'https://api.openalex.test',
  fetchImpl,
  apiKey: 'fixture-key',
})

const currentYearCount = await provider.countMatches({
  query: 'graph algorithms',
  fromDate: '2026-01-01',
  toDate: '2026-09-07',
  sourcePolicy: 'include_preprints',
})
assert.equal(currentYearCount, 2)
const countUrl = new URL(lastUrl)
assert.equal(countUrl.searchParams.get('per_page'), '1')
assert.equal(countUrl.searchParams.get('cursor'), null)
assert.equal(countUrl.searchParams.get('sort'), '-publication_date')
assert.match(countUrl.searchParams.get('filter') ?? '', /from_publication_date:2026-01-01/)
assert.match(countUrl.searchParams.get('filter') ?? '', /to_publication_date:2026-09-07/)

const published = await provider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'published_only',
})

assert.equal(published.papers.length, 1)
assert.equal(published.pages, 1)
assert.equal(published.rawFetched, 2)
assert.equal(published.truncated, false)
assert.equal(published.papers[0].provider, 'openalex')
assert.equal(published.papers[0].providerRecordId, 'W1234567890')
assert.equal(published.papers[0].publicationStatus, 'published')
assert.equal(published.papers[0].abstract, 'We study graph algorithms carefully.')
assert.deepEqual(published.papers[0].authors, ['Ada Example', 'Taro Example'])
assert.equal(published.papers[0].venue, 'Journal of Fixture Research')
assert.equal(published.papers[0].pdfUrl, 'https://repository.example/graph-test.pdf')
assert.deepEqual(published.papers[0].identifiers, [
  { kind: 'doi', value: '10.5555/graph.test.2026' },
  { kind: 'provider', value: 'W1234567890', provider: 'openalex' },
])

const publishedUrl = new URL(lastUrl)
assert.equal(publishedUrl.searchParams.get('search'), 'graph algorithms')
assert.match(publishedUrl.searchParams.get('filter') ?? '', /type:article/)
assert.equal(publishedUrl.searchParams.get('sort'), '-publication_date')
assert.equal(publishedUrl.searchParams.get('api_key'), 'fixture-key')
assert.equal(publishedUrl.searchParams.get('cursor'), '*')
assert.equal(publishedUrl.searchParams.get('per_page'), '100')

const withPreprints = await provider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'include_preprints',
})

assert.equal(withPreprints.papers.length, 2)
assert.equal(withPreprints.papers[1].publicationStatus, 'preprint')
assert.match(new URL(lastUrl).searchParams.get('filter') ?? '', /type:article\|preprint/)

const cursorRequests: string[] = []
const pagedFetch: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const cursor = url.searchParams.get('cursor') ?? ''
  cursorRequests.push(cursor)

  const payload =
    cursor === '*'
      ? { meta: { next_cursor: 'cursor-2' }, results: [fixture.results[0]] }
      : { meta: { next_cursor: null }, results: [fixture.results[1]] }
  return Response.json(payload)
}

const pagedProvider = new OpenAlexProvider({
  baseUrl: 'https://api.openalex.test',
  fetchImpl: pagedFetch,
})
const paged = await pagedProvider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'include_preprints',
  maxResults: 10,
})
assert.deepEqual(cursorRequests, ['*', 'cursor-2'])
assert.equal(paged.pages, 2)
assert.equal(paged.rawFetched, 2)
assert.equal(paged.papers.length, 2)
assert.equal(paged.truncated, false)

const truncatedProvider = new OpenAlexProvider({
  baseUrl: 'https://api.openalex.test',
  fetchImpl: async () => Response.json({ meta: { next_cursor: 'more' }, results: [fixture.results[0]] }),
})
const truncated = await truncatedProvider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'include_preprints',
  maxResults: 1,
})
assert.equal(truncated.pages, 1)
assert.equal(truncated.rawFetched, 1)
assert.equal(truncated.truncated, true)

console.log('OpenAlex provider fixture test passed.')
