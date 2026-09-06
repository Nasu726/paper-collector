import type { DecisionState, RecommendationBucket } from '../src/domain'
import type { FeedbackEventType, FeedbackSurface } from './feedback'

export const RECOMMENDATION_MODEL_VERSION = 'lexical-v1'

export type RecommendationEnv = {
  DB: D1Database
}

export type LexicalPaper = {
  id: string
  title: string
  abstract: string
}

export type LexicalFeed = {
  id: string
  name: string
  intent: string
  exclusions?: string
}

export type ImplicitEvidence = {
  type: FeedbackEventType
  surface: FeedbackSurface
  count: number
}

export type ProfileEvidence = {
  paper: LexicalPaper
  explicitState?: DecisionState
  implicit: ImplicitEvidence[]
}

export type LexicalFeedProfile = {
  feed: LexicalFeed
  intentVector: Map<string, number>
  exclusionVector: Map<string, number>
  learnedVector: Map<string, number>
  explicitCount: number
  savedCount: number
  rejectedCount: number
  implicitMass: number
  evidenceStrength: number
}

export type FeedScore = {
  score: number
  bucket: RecommendationBucket
  reasons: string[]
}

type FeedRow = {
  id: string
  name: string
  intent: string
  exclusions: string | null
}

type PaperRow = LexicalPaper

type MembershipRow = {
  paper_id: string
  feed_id: string
}

type DecisionRow = {
  paper_id: string
  state: DecisionState
  feed_ids_json: string
}

type FeedbackRow = {
  paper_id: string
  event_type: FeedbackEventType
  metadata_json: string | null
  event_count: number
}

type FeedbackMetadata = {
  surface: FeedbackSurface
  feedIds: string[]
}

type Snapshot = {
  id: string
  paperId: string
  feedId: string | null
  bucket: RecommendationBucket
  score: number
  reasons: string[]
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'among',
  'and',
  'are',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'does',
  'each',
  'for',
  'from',
  'have',
  'into',
  'its',
  'may',
  'more',
  'most',
  'not',
  'only',
  'other',
  'our',
  'over',
  'paper',
  'such',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'using',
  'very',
  'was',
  'were',
  'when',
  'where',
  'which',
  'while',
  'with',
  'without',
  'would',
])

const feedbackTypes = new Set<FeedbackEventType>([
  'abstract_expanded',
  'pdf_opened',
  'source_opened',
])
const feedbackSurfaces = new Set<FeedbackSurface>(['inbox', 'saved', 'archive'])

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizedToken(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3)
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2)
  if (
    token.length > 4 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('is') &&
    !token.endsWith('us')
  ) {
    return token.slice(0, -1)
  }
  return token
}

export function tokenizeLexicalText(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015-]+/g, ' ')
  const matches = normalized.match(/[\p{L}\p{N}]+/gu) ?? []

  return matches
    .map(normalizedToken)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
}

function tokenVector(text: string, multiplier = 1): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokenizeLexicalText(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  const vector = new Map<string, number>()
  for (const [token, count] of counts) {
    vector.set(token, multiplier * (1 + Math.log(count)))
  }
  return vector
}

function addScaled(target: Map<string, number>, source: Map<string, number>, scale: number): void {
  for (const [token, value] of source) {
    const next = (target.get(token) ?? 0) + value * scale
    if (Math.abs(next) < 1e-12) target.delete(token)
    else target.set(token, next)
  }
}

function vectorNorm(vector: Map<string, number>): number {
  let sum = 0
  for (const value of vector.values()) sum += value * value
  return Math.sqrt(sum)
}

function normalizedVector(vector: Map<string, number>): Map<string, number> {
  const norm = vectorNorm(vector)
  if (norm === 0) return new Map()
  return new Map([...vector].map(([token, value]) => [token, value / norm]))
}

export function vectorizePaper(paper: Pick<LexicalPaper, 'title' | 'abstract'>): Map<string, number> {
  const vector = tokenVector(paper.abstract, 1)
  addScaled(vector, tokenVector(paper.title, 1), 2.2)
  return vector
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  if (!left.size || !right.size) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let dot = 0
  for (const [token, value] of small) dot += value * (large.get(token) ?? 0)
  return clamp(dot, -1, 1)
}

function queryCoverage(candidate: Map<string, number>, query: Map<string, number>): number {
  if (!query.size) return 0
  let total = 0
  let matched = 0
  for (const [token, value] of query) {
    const weight = Math.abs(value)
    total += weight
    if (candidate.has(token)) matched += weight
  }
  return total === 0 ? 0 : matched / total
}

function topOverlapTerms(
  candidate: Map<string, number>,
  reference: Map<string, number>,
  predicate: (value: number) => boolean,
  limit = 3,
): string[] {
  return [...reference]
    .filter(([token, value]) => candidate.has(token) && predicate(value))
    .map(([token, value]) => ({
      token,
      strength: Math.abs(value) * (candidate.get(token) ?? 0),
    }))
    .sort((a, b) => b.strength - a.strength || a.token.localeCompare(b.token))
    .slice(0, limit)
    .map((entry) => entry.token)
}

export function implicitSignalWeight(
  type: FeedbackEventType,
  surface: FeedbackSurface,
  count: number,
): number {
  const base: Record<FeedbackEventType, number> = {
    abstract_expanded: 0.14,
    source_opened: 0.38,
    pdf_opened: 0.85,
  }
  const surfaceMultiplier: Record<FeedbackSurface, number> = {
    inbox: 1,
    saved: 1.2,
    archive: 0.2,
  }
  const capped = clamp(Math.floor(count), 0, 4)
  if (capped === 0) return 0
  const repetition = Math.log1p(capped) / Math.log(2)
  return base[type] * surfaceMultiplier[surface] * repetition
}

export function buildFeedProfile(feed: LexicalFeed, evidence: ProfileEvidence[]): LexicalFeedProfile {
  const intentVector = tokenVector(feed.intent)
  const exclusionVector = tokenVector(feed.exclusions ?? '')
  const learned = new Map<string, number>()

  let explicitCount = 0
  let savedCount = 0
  let rejectedCount = 0
  let implicitMass = 0

  for (const item of evidence) {
    const paperVector = normalizedVector(vectorizePaper(item.paper))
    if (!paperVector.size) continue

    if (item.explicitState) {
      explicitCount += 1
      if (item.explicitState === 'saved') {
        savedCount += 1
        addScaled(learned, paperVector, 4)
      } else {
        rejectedCount += 1
        addScaled(learned, paperVector, -5)
      }
      // Explicit judgment already captures this Paper. Do not double-count its opens.
      continue
    }

    let paperImplicitWeight = 0
    for (const event of item.implicit) {
      paperImplicitWeight += implicitSignalWeight(event.type, event.surface, event.count)
    }
    if (paperImplicitWeight > 0) {
      implicitMass += paperImplicitWeight
      addScaled(learned, paperVector, paperImplicitWeight)
    }
  }

  const evidenceStrength = clamp(explicitCount * 0.55 + Math.min(implicitMass, 4) / 8, 0, 1)

  return {
    feed,
    intentVector,
    exclusionVector,
    learnedVector: normalizedVector(learned),
    explicitCount,
    savedCount,
    rejectedCount,
    implicitMass,
    evidenceStrength,
  }
}

export function bucketForRecommendationScore(score: number): RecommendationBucket {
  if (score >= 0.62) return 'very_high'
  if (score >= 0.35) return 'high'
  if (score >= -0.05) return 'medium'
  if (score >= -0.3) return 'low'
  return 'very_low'
}

export function scorePaperForFeed(paper: LexicalPaper, profile: LexicalFeedProfile): FeedScore {
  const rawCandidate = vectorizePaper(paper)
  const candidate = normalizedVector(rawCandidate)
  const intentCoverage = queryCoverage(rawCandidate, profile.intentVector)
  const exclusionCoverage = queryCoverage(rawCandidate, profile.exclusionVector)
  const learnedSimilarity = cosineSimilarity(candidate, profile.learnedVector)

  const score = clamp(
    0.72 * intentCoverage -
      0.78 * exclusionCoverage +
      0.66 * profile.evidenceStrength * learnedSimilarity,
    -1,
    1,
  )

  const reasons: string[] = []
  const intentTerms = topOverlapTerms(rawCandidate, profile.intentVector, (value) => value > 0)
  const positiveTerms = topOverlapTerms(rawCandidate, profile.learnedVector, (value) => value > 0.03)
  const negativeTerms = topOverlapTerms(rawCandidate, profile.learnedVector, (value) => value < -0.03)
  const exclusionTerms = topOverlapTerms(rawCandidate, profile.exclusionVector, (value) => value > 0)

  if (intentTerms.length) reasons.push(`Matches ${profile.feed.name} intent: ${intentTerms.join(', ')}`)
  if (positiveTerms.length && profile.evidenceStrength > 0) {
    reasons.push(`Learned positive terms: ${positiveTerms.join(', ')}`)
  }
  if (exclusionTerms.length) reasons.push(`Matches exclusions: ${exclusionTerms.join(', ')}`)
  else if (negativeTerms.length && score < 0.35) reasons.push(`Negative evidence terms: ${negativeTerms.join(', ')}`)
  if (!reasons.length) reasons.push('Limited lexical evidence; kept visible for exploration')

  return {
    score: Number(score.toFixed(6)),
    bucket: bucketForRecommendationScore(score),
    reasons: reasons.slice(0, 3),
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseFeedbackMetadata(raw: string | null): FeedbackMetadata {
  if (!raw) return { surface: 'inbox', feedIds: [] }
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { surface: 'inbox', feedIds: [] }
    const record = value as Record<string, unknown>
    const surface =
      typeof record.surface === 'string' && feedbackSurfaces.has(record.surface as FeedbackSurface)
        ? (record.surface as FeedbackSurface)
        : 'inbox'
    const feedIds = Array.isArray(record.feedIds)
      ? record.feedIds.filter((item): item is string => typeof item === 'string')
      : []
    return { surface, feedIds }
  } catch {
    return { surface: 'inbox', feedIds: [] }
  }
}

function evidenceSlot(
  map: Map<string, Map<string, ProfileEvidence>>,
  feedId: string,
  paper: LexicalPaper,
): ProfileEvidence {
  let feedEvidence = map.get(feedId)
  if (!feedEvidence) {
    feedEvidence = new Map()
    map.set(feedId, feedEvidence)
  }
  let slot = feedEvidence.get(paper.id)
  if (!slot) {
    slot = { paper, implicit: [] }
    feedEvidence.set(paper.id, slot)
  }
  return slot
}

function snapshotId(paperId: string, feedId: string | null): string {
  return `recommendation:${RECOMMENDATION_MODEL_VERSION}:${feedId ?? 'global'}:${paperId}`
}

async function persistSnapshots(db: D1Database, snapshots: Snapshot[], scoredAt: string): Promise<number> {
  await db
    .prepare('DELETE FROM recommendation_snapshots WHERE model_version = ?')
    .bind(RECOMMENDATION_MODEL_VERSION)
    .run()

  const chunkSize = 40
  for (let offset = 0; offset < snapshots.length; offset += chunkSize) {
    const chunk = snapshots.slice(offset, offset + chunkSize)
    const statements = chunk.map((snapshot) =>
      db
        .prepare(
          `INSERT INTO recommendation_snapshots (
             id, paper_id, feed_id, bucket, reasons_json, model_version, scored_at, score
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             paper_id = excluded.paper_id,
             feed_id = excluded.feed_id,
             bucket = excluded.bucket,
             reasons_json = excluded.reasons_json,
             model_version = excluded.model_version,
             scored_at = excluded.scored_at,
             score = excluded.score`,
        )
        .bind(
          snapshot.id,
          snapshot.paperId,
          snapshot.feedId,
          snapshot.bucket,
          JSON.stringify(snapshot.reasons),
          RECOMMENDATION_MODEL_VERSION,
          scoredAt,
          snapshot.score,
        ),
    )
    if (statements.length) await db.batch(statements)
  }

  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM recommendation_snapshots WHERE model_version = ?')
    .bind(RECOMMENDATION_MODEL_VERSION)
    .first<{ count: number }>()
  return count?.count ?? 0
}

export async function rebuildRecommendationSnapshots(env: RecommendationEnv) {
  const [feedRows, paperRows, membershipRows, decisionRows, feedbackRows] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, name, intent, exclusions
         FROM feeds
         WHERE archived_at IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all<FeedRow>(),
    env.DB.prepare('SELECT id, title, abstract FROM papers ORDER BY id ASC').all<PaperRow>(),
    env.DB.prepare('SELECT paper_id, feed_id FROM paper_feeds ORDER BY paper_id, feed_id').all<MembershipRow>(),
    env.DB.prepare('SELECT paper_id, state, feed_ids_json FROM decisions ORDER BY paper_id').all<DecisionRow>(),
    env.DB
      .prepare(
        `SELECT paper_id, event_type, metadata_json, COUNT(*) AS event_count
         FROM feedback_events
         GROUP BY paper_id, event_type, metadata_json
         ORDER BY paper_id, event_type`,
      )
      .all<FeedbackRow>(),
  ])

  const feeds = feedRows.results.map(
    (row): LexicalFeed => ({
      id: row.id,
      name: row.name,
      intent: row.intent,
      exclusions: row.exclusions ?? undefined,
    }),
  )
  const visibleFeedIds = new Set(feeds.map((feed) => feed.id))
  const papers = new Map(paperRows.results.map((paper) => [paper.id, paper]))
  const decidedPaperIds = new Set(decisionRows.results.map((row) => row.paper_id))

  const feedIdsByPaper = new Map<string, string[]>()
  for (const row of membershipRows.results) {
    if (!visibleFeedIds.has(row.feed_id)) continue
    const current = feedIdsByPaper.get(row.paper_id) ?? []
    current.push(row.feed_id)
    feedIdsByPaper.set(row.paper_id, current)
  }

  const evidenceByFeed = new Map<string, Map<string, ProfileEvidence>>()
  for (const row of decisionRows.results) {
    const paper = papers.get(row.paper_id)
    if (!paper) continue
    for (const feedId of parseStringArray(row.feed_ids_json)) {
      if (!visibleFeedIds.has(feedId)) continue
      evidenceSlot(evidenceByFeed, feedId, paper).explicitState = row.state
    }
  }

  for (const row of feedbackRows.results) {
    if (decidedPaperIds.has(row.paper_id)) continue
    if (!feedbackTypes.has(row.event_type)) continue
    const paper = papers.get(row.paper_id)
    if (!paper) continue
    const metadata = parseFeedbackMetadata(row.metadata_json)
    for (const feedId of metadata.feedIds) {
      if (!visibleFeedIds.has(feedId)) continue
      evidenceSlot(evidenceByFeed, feedId, paper).implicit.push({
        type: row.event_type,
        surface: metadata.surface,
        count: row.event_count,
      })
    }
  }

  const profileByFeed = new Map<string, LexicalFeedProfile>()
  for (const feed of feeds) {
    profileByFeed.set(feed.id, buildFeedProfile(feed, [...(evidenceByFeed.get(feed.id)?.values() ?? [])]))
  }

  const snapshots: Snapshot[] = []
  let eligiblePapers = 0
  let feedSnapshots = 0

  for (const paper of paperRows.results) {
    if (decidedPaperIds.has(paper.id)) continue
    const feedIds = feedIdsByPaper.get(paper.id) ?? []
    if (!feedIds.length) continue

    const scoredFeeds = feedIds
      .map((feedId) => {
        const profile = profileByFeed.get(feedId)
        return profile ? { feedId, profile, result: scorePaperForFeed(paper, profile) } : null
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => b.result.score - a.result.score || a.feedId.localeCompare(b.feedId))

    if (!scoredFeeds.length) continue
    eligiblePapers += 1

    for (const entry of scoredFeeds) {
      snapshots.push({
        id: snapshotId(paper.id, entry.feedId),
        paperId: paper.id,
        feedId: entry.feedId,
        bucket: entry.result.bucket,
        score: entry.result.score,
        reasons: entry.result.reasons,
      })
      feedSnapshots += 1
    }

    const winner = scoredFeeds[0]
    const globalReasons = [...winner.result.reasons]
    if (scoredFeeds.length > 1 && scoredFeeds[1].result.score >= winner.result.score - 0.08) {
      const secondName = scoredFeeds[1].profile.feed.name
      if (!globalReasons.some((reason) => reason.includes(secondName))) {
        globalReasons.push(`Also relevant to ${secondName}`)
      }
    }

    snapshots.push({
      id: snapshotId(paper.id, null),
      paperId: paper.id,
      feedId: null,
      bucket: winner.result.bucket,
      score: winner.result.score,
      reasons: globalReasons.slice(0, 3),
    })
  }

  const scoredAt = new Date().toISOString()
  const snapshotRows = await persistSnapshots(env.DB, snapshots, scoredAt)

  return {
    modelVersion: RECOMMENDATION_MODEL_VERSION,
    scoredAt,
    visibleFeeds: feeds.length,
    eligiblePapers,
    globalSnapshots: eligiblePapers,
    feedSnapshots,
    snapshotRows,
    profiles: feeds.map((feed) => {
      const profile = profileByFeed.get(feed.id)!
      return {
        feedId: feed.id,
        explicitCount: profile.explicitCount,
        savedCount: profile.savedCount,
        rejectedCount: profile.rejectedCount,
        implicitMass: Number(profile.implicitMass.toFixed(4)),
        evidenceStrength: Number(profile.evidenceStrength.toFixed(4)),
      }
    }),
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...(init?.headers ?? {}),
    },
  })
}

export async function handleRecommendationApi(
  request: Request,
  env: RecommendationEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/recommendations/rebuild') {
    return json(await rebuildRecommendationSnapshots(env))
  }
  return null
}
