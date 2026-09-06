import { useEffect, useMemo, useState } from 'react'
import { decisionRepository, type PersistenceMode } from './decisionRepository'
import { demoFeeds, demoPapers } from './demoData'
import type {
  Decision,
  DecisionState,
  Paper,
  PublicationStatus,
  RecommendationBucket,
} from './domain'

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

function feedNames(paper: Paper): string[] {
  return paper.feedIds
    .map((feedId) => demoFeeds.find((feed) => feed.id === feedId)?.name)
    .filter((name): name is string => Boolean(name))
}

function ExternalLinks({ paper }: { paper: Paper }) {
  return (
    <div className="external-links" aria-label="Paper links">
      {paper.pdfUrl ? (
        <a className="link-button primary-link" href={paper.pdfUrl} target="_blank" rel="noreferrer">
          Open PDF ↗
        </a>
      ) : null}
      <a className="link-button" href={paper.sourceUrl} target="_blank" rel="noreferrer">
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
  onDecision,
}: {
  paper: Paper
  onDecision: (paper: Paper, state: DecisionState) => void
}) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [paper.id])

  return (
    <article className="paper-card">
      <header>
        <div className="feed-row">
          {feedNames(paper).map((name) => (
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
          <span>Original</span>
        </div>
        <p className={expanded ? 'abstract' : 'abstract abstract-collapsed'}>{paper.abstract}</p>
        <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Read full abstract'}
        </button>
      </section>

      <ExternalLinks paper={paper} />

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
  decision,
  onReturnToInbox,
}: {
  paper: Paper
  decision: Decision
  onReturnToInbox: (paperId: string) => void
}) {
  return (
    <article className="compact-paper-card">
      <div className="feed-row">
        {feedNames(paper).map((name) => (
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
      <ExternalLinks paper={paper} />
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
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>('local')
  const [persistenceReady, setPersistenceReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    void decisionRepository.load().then(({ decisions: loadedDecisions, mode }) => {
      if (cancelled) return
      setDecisions(loadedDecisions)
      setPersistenceMode(mode)
      setPersistenceReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const inbox = useMemo(
    () => demoPapers.filter((paper) => decisions[paper.id] === undefined),
    [decisions],
  )
  const saved = useMemo(
    () => demoPapers.filter((paper) => decisions[paper.id]?.state === 'saved'),
    [decisions],
  )
  const rejected = useMemo(
    () => demoPapers.filter((paper) => decisions[paper.id]?.state === 'rejected'),
    [decisions],
  )

  function decide(paper: Paper, state: DecisionState) {
    const decision: Decision = {
      paperId: paper.id,
      state,
      decidedAt: new Date().toISOString(),
      feedIds: paper.feedIds,
      recommendationBucket: paper.recommendation?.bucket,
      modelVersion: paper.recommendation?.modelVersion,
    }

    setDecisions((previous) => ({ ...previous, [paper.id]: decision }))
    void decisionRepository.upsert(decision).then(setPersistenceMode)
  }

  function returnToInbox(paperId: string) {
    setDecisions((previous) => {
      const next = { ...previous }
      delete next[paperId]
      return next
    })
    void decisionRepository.remove(paperId).then(setPersistenceMode)
  }

  function resetDemo() {
    setDecisions({})
    setTab('inbox')
    void decisionRepository.clear().then(setPersistenceMode)
  }

  const processedCount = demoPapers.length - inbox.length

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Paper Collector</p>
          <h1>{tab === 'inbox' ? 'Inbox' : tab === 'saved' ? 'Saved' : tab === 'archive' ? 'Archive' : 'Feeds'}</h1>
          <p className={`persistence-status persistence-${persistenceMode}`}>
            {persistenceMode === 'cloud' ? 'Cloud sync' : 'Local fallback'}
          </p>
        </div>
        {tab === 'inbox' && persistenceReady ? (
          <div className="queue-count" aria-label={`${inbox.length} papers remaining`}>
            <strong>{inbox.length}</strong>
            <span>left</span>
          </div>
        ) : null}
      </header>

      <main>
        {!persistenceReady ? (
          <EmptyState title="Loading Inbox" body="Loading your paper triage state." />
        ) : null}

        {persistenceReady && tab === 'inbox' ? (
          <>
            <div className="progress-row">
              <span>{processedCount} processed</span>
              <span>{demoPapers.length} total</span>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-value"
                style={{ width: `${demoPapers.length === 0 ? 0 : (processedCount / demoPapers.length) * 100}%` }}
              />
            </div>
            {inbox[0] ? (
              <FullPaperCard paper={inbox[0]} onDecision={decide} />
            ) : (
              <EmptyState
                title="Inbox cleared"
                body="There are no undecided demo papers. New papers will appear here after ingestion is connected."
              />
            )}
          </>
        ) : null}

        {persistenceReady && tab === 'saved' ? (
          <section className="paper-list">
            {saved.length ? (
              saved.map((paper) => (
                <CompactPaperCard
                  key={paper.id}
                  paper={paper}
                  decision={decisions[paper.id]}
                  onReturnToInbox={returnToInbox}
                />
              ))
            ) : (
              <EmptyState title="Nothing saved yet" body="Papers you save from Inbox will stay here for later reading." />
            )}
          </section>
        ) : null}

        {persistenceReady && tab === 'archive' ? (
          <section className="paper-list">
            {rejected.length ? (
              rejected.map((paper) => (
                <CompactPaperCard
                  key={paper.id}
                  paper={paper}
                  decision={decisions[paper.id]}
                  onReturnToInbox={returnToInbox}
                />
              ))
            ) : (
              <EmptyState title="Archive is empty" body="Not interested papers are archived instead of being deleted." />
            )}
          </section>
        ) : null}

        {persistenceReady && tab === 'feeds' ? (
          <section className="feed-list">
            {demoFeeds.map((feed) => (
              <article className="feed-card" key={feed.id}>
                <div className="feed-card-title">
                  <h2>{feed.name}</h2>
                  <span className={feed.active ? 'status-active' : ''}>{feed.active ? 'Active' : 'Paused'}</span>
                </div>
                <p>{feed.intent}</p>
                {feed.exclusions ? (
                  <p className="feed-exclusions">
                    <strong>Exclude:</strong> {feed.exclusions}
                  </p>
                ) : null}
                <p className="source-policy">Source policy: {feed.sourcePolicy.replaceAll('_', ' ')}</p>
              </article>
            ))}
            <button className="reset-button" type="button" onClick={resetDemo}>
              Reset demo decisions
            </button>
          </section>
        ) : null}
      </main>

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
