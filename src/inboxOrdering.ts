import type { Decision, Paper, RecommendationBucket } from './domain'

const bucketOrder: Record<RecommendationBucket, number> = {
  very_high: 0,
  high: 1,
  medium: 2,
  low: 3,
  very_low: 4,
}

function publicationTime(paper: Paper): number {
  if (!paper.publishedAt) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(paper.publishedAt)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

function compareRecommendation(a: Paper, b: Paper): number {
  const rankA = a.recommendation?.rank
  const rankB = b.recommendation?.rank
  const hasRankA = Number.isInteger(rankA) && (rankA ?? 0) > 0
  const hasRankB = Number.isInteger(rankB) && (rankB ?? 0) > 0

  if (hasRankA && hasRankB && rankA !== rankB) return (rankA ?? 0) - (rankB ?? 0)
  if (hasRankA !== hasRankB) return hasRankA ? -1 : 1

  const bucketA = a.recommendation ? bucketOrder[a.recommendation.bucket] : Number.MAX_SAFE_INTEGER
  const bucketB = b.recommendation ? bucketOrder[b.recommendation.bucket] : Number.MAX_SAFE_INTEGER
  if (bucketA !== bucketB) return bucketA - bucketB

  const publicationDifference = publicationTime(b) - publicationTime(a)
  if (publicationDifference !== 0) return publicationDifference

  return a.id.localeCompare(b.id)
}

/**
 * Returns every undecided Paper exactly once, ordered for Inbox triage.
 * Recommendation affects order only; it never affects eligibility.
 */
export function orderInboxPapers(
  papers: Paper[],
  decisions: Record<string, Decision>,
): Paper[] {
  return papers
    .filter((paper) => decisions[paper.id] === undefined)
    .sort(compareRecommendation)
}
