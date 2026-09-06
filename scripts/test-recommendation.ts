import assert from 'node:assert/strict'
import {
  buildFeedProfile,
  bucketForRecommendationScore,
  implicitSignalWeight,
  scorePaperForFeed,
  tokenizeLexicalText,
  vectorizePaper,
  type LexicalFeed,
  type LexicalPaper,
} from '../worker/recommendation'

const graphFeed: LexicalFeed = {
  id: 'graph',
  name: 'Graph Algorithms',
  intent: 'structural graph algorithms separator complexity improvement',
  exclusions: 'application machine learning benchmark',
}

const coldProfile = buildFeedProfile(graphFeed, [])
const coldPositive: LexicalPaper = {
  id: 'cold-positive',
  title: 'Separator Algorithms for Structural Graph Problems',
  abstract: 'A graph decomposition gives a complexity improvement for exact algorithms.',
}
const coldUnrelated: LexicalPaper = {
  id: 'cold-unrelated',
  title: 'Protein Folding Benchmarks',
  abstract: 'A biological benchmark study compares laboratory measurements.',
}

const tokens = tokenizeLexicalText('Graphs, graph algorithms, and structured GRAPH studies')
assert(tokens.includes('graph'), 'Tokenizer should normalize graph/graphs consistently')
assert(tokens.includes('algorithm'), 'Tokenizer should normalize simple plurals')
assert(!tokens.includes('and'), 'Tokenizer should remove stop words')

const titleWeighted = vectorizePaper({ title: 'separator', abstract: '' })
const abstractWeighted = vectorizePaper({ title: '', abstract: 'separator' })
assert(
  (titleWeighted.get('separator') ?? 0) > (abstractWeighted.get('separator') ?? 0),
  'Title terms must be weighted more strongly than abstract-only terms',
)

const coldPositiveScore = scorePaperForFeed(coldPositive, coldProfile)
const coldUnrelatedScore = scorePaperForFeed(coldUnrelated, coldProfile)
assert(
  coldPositiveScore.score > coldUnrelatedScore.score,
  'Cold start should rank Feed-intent lexical matches above unrelated papers',
)
assert(
  coldPositiveScore.reasons.some((reason) => reason.includes('Graph Algorithms intent')),
  'Cold-start explanation should identify Feed intent matches',
)

const cappedFour = implicitSignalWeight('pdf_opened', 'saved', 4)
const cappedHundred = implicitSignalWeight('pdf_opened', 'saved', 100)
assert.equal(cappedFour, cappedHundred, 'Repeated implicit opens must saturate at the configured cap')
assert(
  implicitSignalWeight('pdf_opened', 'archive', 4) < implicitSignalWeight('pdf_opened', 'inbox', 4),
  'Archive opens must be substantially weaker than ordinary Inbox opens',
)
assert(
  implicitSignalWeight('abstract_expanded', 'inbox', 1) < implicitSignalWeight('pdf_opened', 'inbox', 1),
  'Abstract expansion must remain weaker than an explicit PDF open',
)

const rejectedEvidence: LexicalPaper = {
  id: 'rejected-neural',
  title: 'Neural Ranking Systems',
  abstract: 'neural ranking systems deep learning recommendation',
}
const noisyImplicit: LexicalPaper = {
  id: 'implicit-neural',
  title: 'Neural Ranking Systems Revisited',
  abstract: 'neural ranking systems deep learning recommendation',
}
const explicitDominanceProfile = buildFeedProfile(
  {
    id: 'systems',
    name: 'Systems',
    intent: 'systems architecture',
  },
  [
    { paper: rejectedEvidence, explicitState: 'rejected', implicit: [] },
    {
      paper: noisyImplicit,
      implicit: [{ type: 'pdf_opened', surface: 'saved', count: 100 }],
    },
  ],
)
const rejectedTopicScore = scorePaperForFeed(
  {
    id: 'candidate-neural',
    title: 'Neural Ranking Systems',
    abstract: 'deep learning recommendation neural ranking systems',
  },
  explicitDominanceProfile,
)
assert(
  rejectedTopicScore.score < 0,
  'One explicit Reject must outweigh capped contradictory implicit positive opens on the same lexical topic',
)

const savedGraph: LexicalPaper = {
  id: 'saved-graph',
  title: 'Separator Decomposition for Graph Algorithms',
  abstract: 'structural graph algorithm complexity separator decomposition',
}
const learnedProfile = buildFeedProfile(graphFeed, [
  { paper: savedGraph, explicitState: 'saved', implicit: [] },
])
const learnedRelated = scorePaperForFeed(
  {
    id: 'related',
    title: 'Separator Decomposition in Graph Search',
    abstract: 'structural graph separator techniques for search algorithms',
  },
  learnedProfile,
)
assert(
  learnedRelated.score >= coldPositiveScore.score - 0.2,
  'A related explicit Save should not materially suppress matching candidates',
)
assert(learnedProfile.savedCount === 1 && learnedProfile.explicitCount === 1, 'Explicit profile counts are incorrect')

const excluded = scorePaperForFeed(
  {
    id: 'excluded',
    title: 'Machine Learning Benchmarks for Graph Applications',
    abstract: 'application machine learning benchmark on graph datasets',
  },
  coldProfile,
)
assert(
  excluded.score < coldPositiveScore.score,
  'Configured exclusions must reduce candidate score relative to a relevant candidate',
)

assert.equal(bucketForRecommendationScore(0.7), 'very_high')
assert.equal(bucketForRecommendationScore(0.4), 'high')
assert.equal(bucketForRecommendationScore(0), 'medium')
assert.equal(bucketForRecommendationScore(-0.2), 'low')
assert.equal(bucketForRecommendationScore(-0.5), 'very_low')

console.log('Recommendation unit tests passed: cold start, explicit dominance, bounded implicit evidence, exclusions, and buckets verified.')
