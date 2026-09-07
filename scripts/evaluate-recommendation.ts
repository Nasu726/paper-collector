import assert from 'node:assert/strict'
import { recommendationEvaluationFixture } from '../test/fixtures/recommendation/evaluation'
import {
  buildFeedProfile,
  RECOMMENDATION_MODEL_VERSION,
  scorePaperForFeed,
  type LexicalFeedProfile,
  type ProfileEvidence,
} from '../worker/recommendation'

type RankedHoldout = {
  paperId: string
  state: 'saved' | 'rejected'
  judgedAt: string
  score: number
}

type RankingMetrics = {
  pairwiseAccuracy: number
  firstPositiveMrr: number
  positiveNegativeGap: number
  eligibilityRecall: number
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function rank(profile: LexicalFeedProfile): RankedHoldout[] {
  return recommendationEvaluationFixture.holdout
    .map((item): RankedHoldout => ({
      paperId: item.paper.id,
      state: item.state,
      judgedAt: item.judgedAt,
      score: scorePaperForFeed(item.paper, profile).score,
    }))
    .sort((a, b) => b.score - a.score || a.paperId.localeCompare(b.paperId))
}

function evaluate(ranking: RankedHoldout[]): RankingMetrics {
  const positives = ranking.filter((item) => item.state === 'saved')
  const negatives = ranking.filter((item) => item.state === 'rejected')
  assert(positives.length > 0, 'Evaluation fixture requires at least one held-out Save.')
  assert(negatives.length > 0, 'Evaluation fixture requires at least one held-out rejection.')

  let pairwiseCredit = 0
  let pairs = 0
  for (const positive of positives) {
    for (const negative of negatives) {
      pairs += 1
      if (positive.score > negative.score) pairwiseCredit += 1
      else if (positive.score === negative.score) pairwiseCredit += 0.5
    }
  }

  const firstPositiveIndex = ranking.findIndex((item) => item.state === 'saved')
  assert(firstPositiveIndex >= 0, 'Held-out ranking has no positive judgment.')

  const expectedIds = new Set(recommendationEvaluationFixture.holdout.map((item) => item.paper.id))
  const rankedIds = new Set(ranking.map((item) => item.paperId))
  const retained = [...expectedIds].filter((paperId) => rankedIds.has(paperId)).length

  return {
    pairwiseAccuracy: round(pairwiseCredit / pairs),
    firstPositiveMrr: round(1 / (firstPositiveIndex + 1)),
    positiveNegativeGap: round(average(positives.map((item) => item.score)) - average(negatives.map((item) => item.score))),
    eligibilityRecall: round(retained / expectedIds.size),
  }
}

const fixture = recommendationEvaluationFixture
const cutoff = Date.parse(fixture.cutoff)
assert(Number.isFinite(cutoff), 'Fixture cutoff must be a valid timestamp.')

for (const item of fixture.training) {
  if (item.explicitState) {
    assert(item.judgedAt, `Explicit training judgment ${item.paper.id} is missing judgedAt.`)
  }
  if (item.judgedAt) {
    assert(Date.parse(item.judgedAt) < cutoff, `Training judgment ${item.paper.id} is not before the holdout cutoff.`)
  }
  for (const event of item.implicit) {
    assert(
      Date.parse(event.observedAt) < cutoff,
      `Implicit training event for ${item.paper.id} is not before the holdout cutoff.`,
    )
  }
}
for (const item of fixture.holdout) {
  assert(Date.parse(item.judgedAt) >= cutoff, `Holdout judgment ${item.paper.id} is before the cutoff.`)
}

const trainingEvidence: ProfileEvidence[] = fixture.training.map((item) => ({
  paper: item.paper,
  explicitState: item.explicitState,
  implicit: item.implicit.map(({ type, surface, count }) => ({ type, surface, count })),
}))

const baselineProfile = buildFeedProfile(fixture.feed, [])
const learnedProfile = buildFeedProfile(fixture.feed, trainingEvidence)
const baselineRanking = rank(baselineProfile)
const learnedRanking = rank(learnedProfile)
const baseline = evaluate(baselineRanking)
const learned = evaluate(learnedRanking)

assert.equal(baseline.eligibilityRecall, 1, 'Intent-only baseline filtered an eligible held-out Paper.')
assert.equal(learned.eligibilityRecall, 1, 'lexical-v1 filtered an eligible held-out Paper.')
assert.equal(learnedRanking.length, fixture.holdout.length, 'lexical-v1 changed held-out eligibility.')
assert(
  learned.pairwiseAccuracy > baseline.pairwiseAccuracy,
  `Expected learned pairwise accuracy to improve (${baseline.pairwiseAccuracy} -> ${learned.pairwiseAccuracy}).`,
)
assert(
  learned.firstPositiveMrr > baseline.firstPositiveMrr,
  `Expected learned MRR to improve (${baseline.firstPositiveMrr} -> ${learned.firstPositiveMrr}).`,
)
assert(
  learned.positiveNegativeGap > baseline.positiveNegativeGap,
  `Expected learned score gap to improve (${baseline.positiveNegativeGap} -> ${learned.positiveNegativeGap}).`,
)

const report = {
  modelVersion: RECOMMENDATION_MODEL_VERSION,
  fixture: fixture.name,
  cutoff: fixture.cutoff,
  evidence: {
    trainingItems: fixture.training.length,
    explicitCount: learnedProfile.explicitCount,
    savedCount: learnedProfile.savedCount,
    rejectedCount: learnedProfile.rejectedCount,
    implicitMass: round(learnedProfile.implicitMass),
    evidenceStrength: round(learnedProfile.evidenceStrength),
    holdoutJudgments: fixture.holdout.length,
    holdoutSaved: fixture.holdout.filter((item) => item.state === 'saved').length,
    holdoutRejected: fixture.holdout.filter((item) => item.state === 'rejected').length,
  },
  intentOnly: baseline,
  lexicalV1: learned,
  improvement: {
    pairwiseAccuracy: round(learned.pairwiseAccuracy - baseline.pairwiseAccuracy),
    firstPositiveMrr: round(learned.firstPositiveMrr - baseline.firstPositiveMrr),
    positiveNegativeGap: round(learned.positiveNegativeGap - baseline.positiveNegativeGap),
  },
  rankings: {
    intentOnly: baselineRanking,
    lexicalV1: learnedRanking,
  },
}

console.log(JSON.stringify(report, null, 2))
