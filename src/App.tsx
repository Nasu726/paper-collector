import { useEffect, useMemo, useRef, useState } from 'react'
import { appRepository, type AppBootstrap, type PersistenceMode } from './appRepository'
import { FeedManager } from './FeedManager'
import type {
  Decision,
  DecisionState,
  Feed,
  FeedbackSurface,
  Paper,
  PublicationStatus,
  RecommendationBucket,
} from './domain'
import { orderInboxPapers } from './inboxOrdering'
import {
  emptyTriageSession,
  formatSecondsPerDecision,
  recordTriageDecision,
  startTriageSession,
  triageSessionMetrics,
} from './triageSession'
import {
  clearUndoTargetForPaper,
  isUndoTargetAvailable,
  undoTargetForDecision,
  type UndoTarget,
} from './undoDecision'

type Tab = 'inbox' | 'saved' | 'archive' | 'feeds'

const recommendationLabels: Record<RecommendationBucket, string> = {
  very_high: 'Very high',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  very_low: 'Very low',
}

const statusLabels: Record<PublicationStatus, string> = {
  published: 'Published',
  accepted: 'Accepted',
  preprint: 'Preprint',
  unknown: 'Unknown',
}

function feedNames(paper: Paper, feeds: Feed[]): string[] {
  return paper.feedIds
    .map((feedId) => feeds.find((feed) => feed.id === feedId)?.name)
    .filter((name): name is string => Boolean(name))
}

function ExternalLinks({ paper, surface }: { paper: Paper; surface: FeedbackSurface }) {
  function record(type: 'pdf_opened' | 'source_opened') {
    void appRepository.recordFeedback(paper.id, type, surface)
  }

  return (
    <div className="external-links" aria-label="Paper links">
      {paper.pdfUrl ? (
        <a
          className="link-button primary-link"
          href={paper.pdfUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => record('pdf_opened')}
        >
          Open PDF ↗
        </a>
      ) : null}
      <a
        className="link-button"
        href={paper.sourceUrl}
        target="_blank"
        rel="noreferrer"
        onClick={() => record('source_opened')}
      >
        Source ↗
      </a>
    </div>
  )
}

function Recommendation({ paper }: { paper: Paper }) {
  if (!paper.recommendation) return null

  return (
    <section className="recommendation" aria-label="Recommendation">
      <span className={`recommendation-badge recommendation-${paper.recommendation.bucket}`}>
        {recommendationLabels[paper.recommendation.bucket]}
      </span>
      <p>{paper.recommendation.reasons.join(' · ')}</p>
    </section>
  )
}

function PaperMeta({ paper }: { paper: Paper }) {
  return (
    <div className="paper-meta">
      <span>{statusLabels[paper.publicationStatus]}</span>
      {paper.publishedAt ? <span>{paper.publishedAt}</span> : null}
      {paper.venue ? <span>{paper.venue}</span> : null}
    </div>
  )
}

function FullPaperCard({
  paper,
  feeds,
  onDecision,
}: {
  paper: Paper
  feeds: Feed[]
  onDecision: (paper: Paper, state: DecisionState) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const abstractFeedbackRecorded = useRef(false)

  useEffect(() => {
    setExpanded(false)
    abstractFeedbackRecorded.current = false
  }, [paper.id])

  function toggleAbstract() {
    if (!expanded && !abstractFeedbackRecorded.current) {
      abstractFeedbackRecorded.current = true
      void appRepository.recordFeedback(paper.id, 'abstract_expanded', 'inbox')
    }
    setExpanded((value) => !value)
  }

  return (
    <article className="paper-card">
      <header>
        <div className="feed-row">
          {feedNames(paper, feeds).map((name) => (
            <span className="feed-chip" key={name}>
              {name}
            </span>
          ))}
        </div>
        <h2>{paper.title}</h2>
        <p className="authors">{paper.authors.join(', ')}</p>
        <PaperMeta paper={paper} />
      </header>

      <Recommendation paper={paper} />

      <section className="abstract-section">
        <div className="section-heading">
          <h3>Abstract</h3>
        </div>
        <p className={expanded ? 'abstract' : 'abstract abstract-collapsed'}>{paper.abstract}</p>
        <button className="text-button" type="button" onClick={toggleAbstract}>
          {expanded ? 'Show less' : 'Read full abstract'}
        </button>
      </section>

      <ExternalLinks paper={paper} surface="inbox" />

      <div className="decision-bar" aria-label="Triage actions">
        <button className="decision-button reject-button" type="button" onClick={() => onDecision(paper, 'rejected')}>
          Not interested
        </button>
        <button className="decision-button save-button" type="button" onClick={() => onDecision(paper, 'saved')}>
          Save
        </button>
      </div>
    </article>
  )
}

function CompactPaperCard({
  paper,
  feeds,
  decision,
  onReturnToInbox,
}: {
  paper: Paper
  feeds: Feed[]
  decision: Decision
  onReturnToInbox: (paperId: string) => void
}) {
  const surface: FeedbackSurface = decision.state === 'saved' ? 'saved' : 'archive'

  return (
    <article className="compact-paper-card">
      <div className="feed-row">
        {feedNames(paper, feeds).map((name) => (
          <span className="feed-chip" key={name}>
            {name}
          </span>
        ))}
      </div>
      <h3>{paper.title}</h3>
      <p className="authors">{paper.authors.join(', ')}</p>
      <p className="decision-time">
        {decision.state === 'saved' ? 'Saved' : 'Rejected'} {new Date(decision.decidedAt).toLocaleString()}
      </p>
      <ExternalLinks paper={paper} surface={surface} />
      <button className="text-button" type="button" onClick={() => onReturnToInbox(paper.id)}>
        Return to Inbox
      </button>
    </article>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="empty-state">
      <div className="empty-icon">✓</div>
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('inbox')
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [papers, setPapers] = useState<Paper[]>([])
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>('local')
  const [dataReady, setDataReady] = useState(false)
  const [undoTarget, setUndoTarget] = useState<UndoTarget | null>(null)
  const [triageSession, setTriageSession] = useState(emptyTriageSession)

  function applyBootstrap(bootstrap: AppBootstrap) {
    setFeeds(bootstrap.feeds)
    setPapers(bootstrap.papers)
    setDecisions(bootstrap.decisions)
    setPersistenceMode(bootstrap.mode)
  }

  function refreshRecommendationOrdering() {
    void appRepository.refreshRecommendations().then((refreshedPapers) => {
      if (refreshedPapers) setPapers(refreshedPapers)
    })
  }

  useEffect(() => {
    let cancelled = false

    void appRepository.load().then((bootstrap) => {
      if (cancelled) return
      applyBootstrap(bootstrap)
      setDataReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const inbox = useMemo(
    () => orderInboxPapers(papers, decisions),
    [decisions, papers],
  )
  const saved = useMemo(
    () => papers.filter((paper) => decisions[paper.id]?.state === 'saved'),
    [decisions, papers],
  )
  const rejected = useMemo(
    () => papers.filter((paper) => decisions[paper.id]?.state === 'rejected'),
    [decisions, papers],
  )
  const undoAvailable = isUndoTargetAvailable(undoTarget, decisions)
  const sessionMetrics = triageSessionMetrics(triageSession)
  const sessionPace = formatSecondsPerDecision(sessionMetrics)

  useEffect(() => {
    if (!dataReady || inbox.length === 0) return
    setTriageSession((current) => startTriageSession(current, Date.now()))
  }, [dataReady, inbox.length])

  function decide(paper: Paper, state: DecisionState) {
    const now = Date.now()
    const decision: Decision = {
      paperId: paper.id,
      state,
      decidedAt: new Date(now).toISOString(),
      feedIds: paper.feedIds,
      recommendationBucket: paper.recommendation?.bucket,
      modelVersion: paper.recommendation?.modelVersion,
    }

    setDecisions((previous) => ({ ...previous, [paper.id]: decision }))
    setUndoTarget(undoTargetForDecision(decision, paper.title))
    setTriageSession((current) => recordTriageDecision(current, now))
    void appRepository.upsertDecision(decision).then((mode) => {
      setPersistenceMode(mode)
      if (mode === 'cloud') refreshRecommendationOrdering()
    })
  }

  function removeDecisionFromInbox(paperId: string) {
    setDecisions((previous) => {
      const next = { ...previous }
      delete next[paperId]
      return next
    })
    void appRepository.removeDecision(paperId).then((mode) => {
      setPersistenceMode(mode)
      if (mode === 'cloud') refreshRecommendationOrdering()
    })
  }

  function returnToInbox(paperId: string) {
    setUndoTarget((current) => clearUndoTargetForPaper(current, paperId))
    removeDecisionFromInbox(paperId)
  }

  function undoLastDecision() {
    if (!isUndoTargetAvailable(undoTarget, decisions)) {
      setUndoTarget(null)
      return
    }

    const paperId = undoTarget.paperId
    setUndoTarget(null)
    removeDecisionFromInbox(paperId)
  }

  function resetDecisions() {
    setDecisions({})
    setUndoTarget(null)
    setTab('inbox')
    void appRepository.clearDecisions().then((mode) => {
      setPersistenceMode(mode)
      if (mode === 'cloud') refreshRecommendationOrdering()
    })
  }

  const processedCount = papers.length - inbox.length
  const inboxHasPaper = tab === 'inbox' && Boolean(inbox[0])
  const progressDetail =
    sessionMetrics.decisionCount > 0 && sessionPace
      ? `${sessionMetrics.decisionCount} session · ${sessionPace}`
      : `${papers.length} total`

  return (
    <div className={`app-shell${inboxHasPaper ? ' inbox-mode' : ''}${tab === 'inbox' && undoAvailable ? ' undo-visible' : ''}`}>
      <header className={`app-header${tab === 'inbox' ? ' app-header-inbox' : ''}`}>
        <div>
          <p className="eyebrow">Paper Collector</p>
          {tab !== 'inbox' ? (
            <h1>{tab === 'saved' ? 'Saved' : tab === 'archive' ? 'Archive' : 'Feeds'}</h1>
          ) : null}
          <p className={`persistence-status persistence-${persistenceMode}`}>
            {persistenceMode === 'cloud' ? 'Cloud sync' : 'Local fallback'}
          </p>
        </div>
        {tab === 'inbox' && dataReady ? (
          <div className="queue-count" aria-label={`${inbox.length} papers remaining`}>
            <strong>{inbox.length}</strong>
            <span>left</span>
          </div>
        ) : null}
      </header>

      <main>
        {!dataReady ? <EmptyState title="Loading Inbox" body="Loading papers and triage state." /> : null}

        {dataReady && tab === 'inbox' ? (
          <>
            <div className="progress-row">
              <span>{processedCount} processed</span>
              <span>{progressDetail}</span>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-value"
                style={{ width: `${papers.length === 0 ? 0 : (processedCount / papers.length) * 100}%` }}
              />
            </div>
            {inbox[0] ? (
              <FullPaperCard paper={inbox[0]} feeds={feeds} onDecision={decide} />
            ) : (
              <EmptyState
                title="Inbox cleared"
                body="There are no undecided papers. New papers will appear here when ingestion adds them."
              />
            )}
          </>
        ) : null}

        {dataReady && tab === 'saved' ? (
          <section className="paper-list">
            {saved.length ? (
              saved.map((paper) => (
                <CompactPaperCard
                  key={paper.id}
                  paper={paper}
                  feeds={feeds}
                  decision={decisions[paper.id]}
                  onReturnToInbox={returnToInbox}
                />
              ))
            ) : (
              <EmptyState title="Nothing saved yet" body="Papers you save from Inbox will stay here for later reading." />
            )}
          </section>
        ) : null}

        {dataReady && tab === 'archive' ? (
          <section className="paper-list">
            {rejected.length ? (
              rejected.map((paper) => (
                <CompactPaperCard
                  key={paper.id}
                  paper={paper}
                  feeds={feeds}
                  decision={decisions[paper.id]}
                  onReturnToInbox={returnToInbox}
                />
              ))
            ) : (
              <EmptyState title="Archive is empty" body="Not interested papers are archived instead of being deleted." />
            )}
          </section>
        ) : null}

        {dataReady && tab === 'feeds' ? (
          <FeedManager
            feeds={feeds}
            persistenceMode={persistenceMode}
            onBootstrap={applyBootstrap}
            onResetDecisions={resetDecisions}
          />
        ) : null}
      </main>

      {tab === 'inbox' && undoAvailable && undoTarget ? (
        <aside className="undo-bar" aria-live="polite" aria-label="Last triage action">
          <span className="undo-message">
            <strong>{undoTarget.state === 'saved' ? 'Saved' : 'Archived'}</strong>
            <span>{undoTarget.title}</span>
          </span>
          <button className="undo-button" type="button" onClick={undoLastDecision}>
            Undo
          </button>
        </aside>
      ) : null}

      <nav className="bottom-nav" aria-label="Primary navigation">
        <button className={tab === 'inbox' ? 'active' : ''} type="button" onClick={() => setTab('inbox')}>
          <span>▣</span>
          Inbox
        </button>
        <button className={tab === 'saved' ? 'active' : ''} type="button" onClick={() => setTab('saved')}>
          <span>☆</span>
          Saved
        </button>
        <button className={tab === 'archive' ? 'active' : ''} type="button" onClick={() => setTab('archive')}>
          <span>□</span>
          Archive
        </button>
        <button className={tab === 'feeds' ? 'active' : ''} type="button" onClick={() => setTab('feeds')}>
          <span>≡</span>
          Feeds
        </button>
      </nav>
    </div>
  )
}
