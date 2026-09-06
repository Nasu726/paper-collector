import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  normalizeDoi,
  normalizeOpenAlexId,
  OpenAlexProvider,
  reconstructOpenAlexAbstract,
} from '../worker/providers/openalex'

const fixture = await readFile(new URL('../test/fixtures/openalex/works.json', import.meta.url), 'utf8')
let lastUrl = ''

const fetchImpl: typeof fetch = async (input) => {
  lastUrl = input instanceof Request ? input.url : input.toString()
  return new Response(fixture, {
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

const provider = new OpenAlexProvider({
  baseUrl: 'https://api.openalex.test',
  fetchImpl,
  apiKey: 'fixture-key',
})

const published = await provider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'published_only',
})

assert.equal(published.length, 1)
assert.equal(published[0].provider, 'openalex')
assert.equal(published[0].providerRecordId, 'W1234567890')
assert.equal(published[0].publicationStatus, 'published')
assert.equal(published[0].abstract, 'We study graph algorithms carefully.')
assert.deepEqual(published[0].authors, ['Ada Example', 'Taro Example'])
assert.equal(published[0].venue, 'Journal of Fixture Research')
assert.equal(published[0].pdfUrl, 'https://repository.example/graph-test.pdf')
assert.deepEqual(published[0].identifiers, [
  { kind: 'doi', value: '10.5555/graph.test.2026' },
  { kind: 'provider', value: 'W1234567890', provider: 'openalex' },
])

const publishedUrl = new URL(lastUrl)
assert.equal(publishedUrl.searchParams.get('search'), 'graph algorithms')
assert.match(publishedUrl.searchParams.get('filter') ?? '', /type:article/)
assert.equal(publishedUrl.searchParams.get('sort'), '-publication_date')
assert.equal(publishedUrl.searchParams.get('api_key'), 'fixture-key')

const withPreprints = await provider.search({
  query: 'graph algorithms',
  fromDate: '2026-09-01',
  toDate: '2026-09-06',
  sourcePolicy: 'include_preprints',
})

assert.equal(withPreprints.length, 2)
assert.equal(withPreprints[1].publicationStatus, 'preprint')
assert.match(new URL(lastUrl).searchParams.get('filter') ?? '', /type:article\|preprint/)

console.log('OpenAlex provider fixture test passed.')
