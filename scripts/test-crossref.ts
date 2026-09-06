import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  CrossrefProvider,
  crossrefDate,
  crossrefDoiPath,
  normalizeCrossrefWork,
} from '../worker/providers/crossref'

const fixture = await readFile(new URL('../test/fixtures/crossref/work.json', import.meta.url), 'utf8')
let lastUrl = ''

const fetchImpl: typeof fetch = async (input) => {
  lastUrl = input instanceof Request ? input.url : input.toString()
  return new Response(fixture, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

assert.equal(crossrefDate({ 'date-parts': [[2026]] }), '2026')
assert.equal(crossrefDate({ 'date-parts': [[2026, 9]] }), '2026-09')
assert.equal(crossrefDate({ 'date-parts': [[2026, 9, 2]] }), '2026-09-02')
assert.equal(crossrefDate({ 'date-parts': [[2026, 13, 1]] }), undefined)
assert.equal(crossrefDoiPath('10.5555/path/inside:suffix'), '10.5555/path/inside%3Asuffix')

const normalized = normalizeCrossrefWork({
  DOI: 'https://doi.org/10.5555/Example.Test',
  title: ['  Example title  '],
  author: [{ given: 'Ada', family: 'Example' }],
  'container-title': ['Example Journal'],
  accepted: { 'date-parts': [[2026, 8, 20]] },
  'published-online': { 'date-parts': [[2026, 9, 2]] },
  'published-print': { 'date-parts': [[2026, 10, 1]] },
})
assert(normalized)
assert.equal(normalized.doi, '10.5555/example.test')
assert.equal(normalized.acceptedAt, '2026-08-20')
assert.equal(normalized.publishedAt, '2026-09-02')
assert.equal(normalized.publicationDateSource, 'published-online')
assert.equal(normalized.publicationStatus, 'published')
assert.deepEqual(normalized.authors, ['Ada Example'])

const acceptedOnly = normalizeCrossrefWork({
  DOI: '10.5555/accepted.only',
  accepted: { 'date-parts': [[2026, 7, 3]] },
})
assert(acceptedOnly)
assert.equal(acceptedOnly.publicationStatus, 'accepted')
assert.equal(acceptedOnly.publishedAt, undefined)

const provider = new CrossrefProvider({
  baseUrl: 'https://api.crossref.test',
  mailto: 'paper@example.test',
  fetchImpl,
})
const record = await provider.lookupDoi('10.5555/GRAPH.TEST.2026')
assert(record)
assert.equal(record.doi, '10.5555/graph.test.2026')
assert.equal(record.title, 'A Crossref Deposit for the Fixture Graph Paper')
assert.equal(record.venue, 'Journal of Publisher Deposits')
assert.equal(record.acceptedAt, '2026-08-20')
assert.equal(record.publishedAt, '2026-09-02')
assert.equal(record.publicationStatus, 'published')
assert(record.evidence.some((item) => item.fieldName === 'published_at' && item.sourceField === 'published-online'))
assert.equal(new URL(lastUrl).searchParams.get('mailto'), 'paper@example.test')
assert.equal(new URL(lastUrl).pathname, '/works/10.5555/graph.test.2026')

const notFoundProvider = new CrossrefProvider({
  baseUrl: 'https://api.crossref.test',
  fetchImpl: async () => new Response(null, { status: 404 }),
})
assert.equal(await notFoundProvider.lookupDoi('10.5555/not-found'), null)

console.log('Crossref provider fixture test passed.')
