import assert from 'node:assert/strict'
import type { Decision, Paper, RecommendationBucket } from '../src/domain'
import { orderInboxPapers } from '../src/inboxOrdering'

function paper(
  id: string,
  bucket?: RecommendationBucket,
  rank?: number,
  publishedAt = '2026-09-01',
): Paper {
  return {
    id,
    title: id,
    abstract: `${id} abstract`,
    authors: ['Example'],
    publishedAt,
    publicationStatus: 'published',
    sourceUrl: `https://example.com/${id}`,
    identifiers: [{ kind: 'provider', value: id, provider: 'test' }],
    feedIds: ['feed'],
    recommendation: bucket
      ? {
          bucket,
          reasons: [`reason for ${id}`],
          modelVersion: 'lexical-v1',
          rank,
        }
      : undefined,
  }
}

const ranked = [
  paper('third', 'medium', 3),
  paper('first', 'very_high', 1),
  paper('fourth', 'low', 4),
  paper('second', 'high', 2),
]
const rankedOrder = orderInboxPapers(ranked, {})
assert.deepEqual(
  rankedOrder.map((candidate) => candidate.id),
  ['first', 'second', 'third', 'fourth'],
  'Opaque Worker rank should define Inbox order',
)
assert.equal(rankedOrder.length, ranked.length, 'Recommendation ordering must not filter low-ranked Papers')
assert.deepEqual(
  new Set(rankedOrder.map((candidate) => candidate.id)),
  new Set(ranked.map((candidate) => candidate.id)),
  'Every eligible Paper must remain reachable after sorting',
)

const fallback = [
  paper('low', 'low', undefined, '2026-09-04'),
  paper('high-old', 'high', undefined, '2026-09-01'),
  paper('high-new', 'high', undefined, '2026-09-03'),
  paper('unranked', undefined, undefined, '2026-09-05'),
]
assert.deepEqual(
  orderInboxPapers(fallback, {}).map((candidate) => candidate.id),
  ['high-new', 'high-old', 'low', 'unranked'],
  'Fallback ordering should use coarse bucket, then publication date, then ID',
)

const tie = [
  paper('paper-b', 'medium', undefined, '2026-09-01'),
  paper('paper-a', 'medium', undefined, '2026-09-01'),
]
const firstTieOrder = orderInboxPapers(tie, {}).map((candidate) => candidate.id)
const secondTieOrder = orderInboxPapers([...tie].reverse(), {}).map((candidate) => candidate.id)
assert.deepEqual(firstTieOrder, ['paper-a', 'paper-b'], 'Equal recommendations should use stable Paper-ID tie-break')
assert.deepEqual(secondTieOrder, firstTieOrder, 'Tie order must not depend on incoming array order')

const savedDecision: Decision = {
  paperId: 'first',
  state: 'saved',
  decidedAt: '2026-09-07T00:00:00Z',
  feedIds: ['feed'],
  recommendationBucket: 'very_high',
  modelVersion: 'lexical-v1',
}
const afterDecision = orderInboxPapers(ranked, { first: savedDecision })
assert.deepEqual(
  afterDecision.map((candidate) => candidate.id),
  ['second', 'third', 'fourth'],
  'Only explicit decision state should remove a Paper from Inbox eligibility',
)

console.log('Inbox ordering tests passed: rank, fallback buckets, stable ties, and no-filter eligibility verified.')
