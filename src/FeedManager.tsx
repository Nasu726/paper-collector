import { useMemo, useState } from 'react'
import {
  appRepository,
  type AppBootstrap,
  type FeedConfigInput,
  type PersistenceMode,
} from './appRepository'
import type { Feed, FeedSourcePolicy } from './domain'

type FeedManagerProps = {
  feeds: Feed[]
  persistenceMode: PersistenceMode
  onBootstrap: (bootstrap: AppBootstrap) => void
  onResetDecisions: () => void
}

type EditorState = {
  mode: 'create' | 'edit'
  feedId?: string
  originalQuery?: string
  originalPolicy?: FeedSourcePolicy
}

const sourcePolicyOptions: Array<{ value: FeedSourcePolicy; label: string; help: string }> = [
  {
    value: 'published_only',
    label: 'Published only',
    help: 'Prefer formally published journal and proceedings records.',
  },
  {
    value: 'accepted_when_verifiable',
    label: 'Published + verifiable accepted',
    help: 'Also allow accepted records when provider metadata explicitly supports that state.',
  },
  {
    value: 'include_preprints',
    label: 'Include preprints',
    help: 'Also collect provider records identified as preprints.',
  },
]

function emptyDraft(): FeedConfigInput {
  return {
    name: '',
    intent: '',
    exclusions: '',
    sourcePolicy: 'published_only',
    providerQuery: '',
  }
}

function feedDraft(feed: Feed): FeedConfigInput {
  return {
    name: feed.name,
    intent: feed.intent,
    exclusions: feed.exclusions ?? '',
    sourcePolicy: feed.sourcePolicy,
    providerQuery: feed.providerQuery ?? '',
  }
}

function FeedIngestionStatus({ feed }: { feed: Feed }) {
  const state = feed.ingestion
  if (!state) return <p className="ingestion-status">Not refreshed yet.</p>

  return (
    <div className={`ingestion-status ingestion-${state.status}`}>
      <p>
        {state.status === 'success'
          ? 'Last refresh succeeded.'
          : state.status === 'truncated'
            ? 'Last refresh was incomplete.'
            : state.status === 'error'
              ? 'Last refresh failed.'
              : 'Not refreshed yet.'}
      </p>
      {state.lastSuccessAt ? <span>Success: {new Date(state.lastSuccessAt).toLocaleString()}</span> : null}
      {state.watermarkDate ? <span>Watermark: {state.watermarkDate}</span> : null}
      {state.lastAttemptAt ? <span>Attempt: {new Date(state.lastAttemptAt).toLocaleString()}</span> : null}
      {state.lastPages > 0 ? <span>{state.lastFetched} provider records across {state.lastPages} page(s)</span> : null}
      {state.lastError ? <strong>{state.lastError}</strong> : null}
    </div>
  )
}

function FeedEditor({
  state,
  draft,
  busy,
  onDraft,
  onSave,
  onCancel,
}: {
  state: EditorState
  draft: FeedConfigInput
  busy: boolean
  onDraft: (next: FeedConfigInput) => void
  onSave: () => void
  onCancel: () => void
}) {
  const collectionChanged =
    state.mode === 'edit' &&
    (draft.providerQuery.trim() !== (state.originalQuery ?? '').trim() ||
      draft.sourcePolicy !== state.originalPolicy)

  const selectedPolicy = sourcePolicyOptions.find((option) => option.value === draft.sourcePolicy)

  return (
    <section className="feed-editor" aria-label={state.mode === 'create' ? 'Create Feed' : 'Edit Feed'}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">{state.mode === 'create' ? 'New research Feed' : 'Edit research Feed'}</p>
          <h2>{state.mode === 'create' ? 'What should this Inbox follow?' : 'Feed settings'}</h2>
        </div>
        <button className="text-button editor-close" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      <label className="field-group">
        <span>Name</span>
        <input
          value={draft.name}
          maxLength={80}
          autoComplete="off"
          placeholder="Graph Algorithms"
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
        />
      </label>

      <label className="field-group">
        <span>Research intent</span>
        <small>Your human-owned description. Learning and provider syntax never rewrite this automatically.</small>
        <textarea
          value={draft.intent}
          maxLength={4000}
          rows={5}
          placeholder="Simple but nontrivial graph algorithms, data structures, and complexity improvements…"
          onChange={(event) => onDraft({ ...draft, intent: event.target.value })}
        />
      </label>

      <label className="field-group">
        <span>Collection query</span>
        <small>Sent to the scholarly provider. Keep this concrete; it is separate from your research intent.</small>
        <textarea
          value={draft.providerQuery}
          maxLength={1000}
          rows={3}
          placeholder="graph algorithms shortest paths data structures"
          onChange={(event) => onDraft({ ...draft, providerQuery: event.target.value })}
        />
      </label>

      <label className="field-group">
        <span>Exclude</span>
        <small>Optional human-readable exclusions used to document the Feed boundary.</small>
        <textarea
          value={draft.exclusions ?? ''}
          maxLength={2000}
          rows={3}
          placeholder="Application-only ML papers"
          onChange={(event) => onDraft({ ...draft, exclusions: event.target.value })}
        />
      </label>

      <label className="field-group">
        <span>Publication sources</span>
        <select
          value={draft.sourcePolicy}
          onChange={(event) => onDraft({ ...draft, sourcePolicy: event.target.value as FeedSourcePolicy })}
        >
          {sourcePolicyOptions.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selectedPolicy ? <small>{selectedPolicy.help}</small> : null}
      </label>

      {collectionChanged ? (
        <div className="collection-reset-note" role="status">
          Collection query or publication policy changed. After saving, the next refresh starts a fresh 14-day lookback so newly eligible papers are not skipped.
        </div>
      ) : null}

      <button
        className="editor-save-button"
        type="button"
        disabled={busy || !draft.name.trim() || !draft.intent.trim() || !draft.providerQuery.trim()}
        onClick={onSave}
      >
        {busy ? 'Saving…' : state.mode === 'create' ? 'Create Feed' : 'Save changes'}
      </button>
    </section>
  )
}

export function FeedManager({ feeds, persistenceMode, onBootstrap, onResetDecisions }: FeedManagerProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [draft, setDraft] = useState<FeedConfigInput>(emptyDraft)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)
  const [archivedFeeds, setArchivedFeeds] = useState<Feed[]>([])
  const [archivedLoaded, setArchivedLoaded] = useState(false)

  const cloudEnabled = persistenceMode === 'cloud'
  const activeCount = useMemo(() => feeds.filter((feed) => feed.active).length, [feeds])

  function applyBootstrap(bootstrap: AppBootstrap) {
    onBootstrap(bootstrap)
  }

  function openCreate() {
    setGlobalError(null)
    setEditor({ mode: 'create' })
    setDraft(emptyDraft())
  }

  function openEdit(feed: Feed) {
    setGlobalError(null)
    setConfirmArchiveId(null)
    setEditor({
      mode: 'edit',
      feedId: feed.id,
      originalQuery: feed.providerQuery ?? '',
      originalPolicy: feed.sourcePolicy,
    })
    setDraft(feedDraft(feed))
  }

  async function saveEditor() {
    if (!editor || !cloudEnabled) return
    setBusyKey('editor')
    setGlobalError(null)
    try {
      if (editor.mode === 'create') {
        const { bootstrap } = await appRepository.createFeed(draft)
        applyBootstrap(bootstrap)
      } else if (editor.feedId) {
        const { mutation, bootstrap } = await appRepository.updateFeed(editor.feedId, draft)
        applyBootstrap(bootstrap)
        setMessages((previous) => ({
          ...previous,
          [editor.feedId as string]: mutation.collectionReset
            ? 'Saved. Collection checkpoint reset; next refresh uses a fresh 14-day lookback.'
            : 'Feed settings saved.',
        }))
      }
      setEditor(null)
      setDraft(emptyDraft())
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : 'Feed save failed.')
    } finally {
      setBusyKey(null)
    }
  }

  async function refresh(feed: Feed) {
    setBusyKey(`refresh:${feed.id}`)
    setMessages((previous) => ({ ...previous, [feed.id]: 'Refreshing…' }))
    try {
      const { refresh: result, bootstrap } = await appRepository.refreshFeed(feed.id)
      applyBootstrap(bootstrap)
      setMessages((previous) => ({
        ...previous,
        [feed.id]:
          result.status === 'truncated'
            ? `Partial refresh: safety cap reached after ${result.rawFetched} provider records.`
            : `Refresh complete: ${result.inserted} new, ${result.updated} updated.`,
      }))
    } catch (cause) {
      setMessages((previous) => ({
        ...previous,
        [feed.id]: cause instanceof Error ? cause.message : 'Feed refresh failed.',
      }))
    } finally {
      setBusyKey(null)
    }
  }

  async function transition(feed: Feed, action: 'pause' | 'resume' | 'archive') {
    setBusyKey(`${action}:${feed.id}`)
    setGlobalError(null)
    try {
      const { bootstrap } = await appRepository.transitionFeed(feed.id, action)
      applyBootstrap(bootstrap)
      setConfirmArchiveId(null)
      if (action === 'archive' && archivedLoaded) {
        setArchivedFeeds(await appRepository.loadArchivedFeeds())
      }
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : `Feed ${action} failed.`)
    } finally {
      setBusyKey(null)
    }
  }

  async function loadArchived() {
    if (!cloudEnabled) return
    setBusyKey('archived')
    setGlobalError(null)
    try {
      setArchivedFeeds(await appRepository.loadArchivedFeeds())
      setArchivedLoaded(true)
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : 'Archived Feed load failed.')
    } finally {
      setBusyKey(null)
    }
  }

  async function restore(feed: Feed) {
    setBusyKey(`restore:${feed.id}`)
    setGlobalError(null)
    try {
      const { bootstrap } = await appRepository.transitionFeed(feed.id, 'restore')
      applyBootstrap(bootstrap)
      setArchivedFeeds(await appRepository.loadArchivedFeeds())
    } catch (cause) {
      setGlobalError(cause instanceof Error ? cause.message : 'Feed restore failed.')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <section className="feed-manager">
      <div className="feed-manager-summary">
        <div>
          <strong>{feeds.length}</strong>
          <span>Feeds</span>
        </div>
        <div>
          <strong>{activeCount}</strong>
          <span>collecting</span>
        </div>
        <button className="new-feed-button" type="button" disabled={!cloudEnabled || busyKey !== null} onClick={openCreate}>
          + New Feed
        </button>
      </div>

      {!cloudEnabled ? (
        <div className="feed-management-warning">
          Feed editing is unavailable while the app is using its local fallback. Restore the Worker connection to manage collection settings.
        </div>
      ) : null}

      {globalError ? <div className="form-error" role="alert">{globalError}</div> : null}

      {editor ? (
        <FeedEditor
          state={editor}
          draft={draft}
          busy={busyKey === 'editor'}
          onDraft={setDraft}
          onSave={() => void saveEditor()}
          onCancel={() => setEditor(null)}
        />
      ) : null}

      <div className="feed-list">
        {feeds.map((feed) => {
          const archiveConfirming = confirmArchiveId === feed.id
          const feedBusy = busyKey?.endsWith(`:${feed.id}`) ?? false
          return (
            <article className="feed-card" key={feed.id}>
              <div className="feed-card-title">
                <h2>{feed.name}</h2>
                <span className={feed.active ? 'status-active' : ''}>{feed.active ? 'Active' : 'Paused'}</span>
              </div>

              <div className="feed-definition">
                <span>Research intent</span>
                <p>{feed.intent}</p>
              </div>
              <div className="feed-definition collection-query">
                <span>Collection query</span>
                <p>{feed.providerQuery || 'Not configured'}</p>
              </div>
              {feed.exclusions ? (
                <p className="feed-exclusions">
                  <strong>Exclude:</strong> {feed.exclusions}
                </p>
              ) : null}
              <p className="source-policy">Source policy: {feed.sourcePolicy.replaceAll('_', ' ')}</p>
              <FeedIngestionStatus feed={feed} />

              <div className="feed-action-grid">
                <button
                  className="refresh-button"
                  type="button"
                  disabled={!cloudEnabled || !feed.active || !feed.providerQuery || busyKey !== null}
                  onClick={() => void refresh(feed)}
                >
                  {busyKey === `refresh:${feed.id}` ? 'Refreshing…' : 'Refresh now'}
                </button>
                <button className="secondary-action" type="button" disabled={!cloudEnabled || busyKey !== null} onClick={() => openEdit(feed)}>
                  Edit
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!cloudEnabled || busyKey !== null}
                  onClick={() => void transition(feed, feed.active ? 'pause' : 'resume')}
                >
                  {busyKey === `${feed.active ? 'pause' : 'resume'}:${feed.id}`
                    ? 'Working…'
                    : feed.active
                      ? 'Pause'
                      : 'Resume'}
                </button>
                {!archiveConfirming ? (
                  <button
                    className="danger-text-action"
                    type="button"
                    disabled={!cloudEnabled || busyKey !== null}
                    onClick={() => setConfirmArchiveId(feed.id)}
                  >
                    Archive
                  </button>
                ) : (
                  <div className="archive-confirm">
                    <span>Keep all history, but remove this Feed from normal collection?</span>
                    <div>
                      <button type="button" disabled={feedBusy} onClick={() => setConfirmArchiveId(null)}>Cancel</button>
                      <button className="confirm-danger" type="button" disabled={feedBusy} onClick={() => void transition(feed, 'archive')}>
                        {busyKey === `archive:${feed.id}` ? 'Archiving…' : 'Confirm archive'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {messages[feed.id] ? <span className="refresh-message">{messages[feed.id]}</span> : null}
            </article>
          )
        })}
      </div>

      <section className="archived-feeds">
        <div className="archived-heading">
          <div>
            <h2>Archived Feeds</h2>
            <p>Archived Feeds keep their Paper membership and history but do not collect new papers.</p>
          </div>
          <button className="text-button" type="button" disabled={!cloudEnabled || busyKey !== null} onClick={() => void loadArchived()}>
            {busyKey === 'archived' ? 'Loading…' : archivedLoaded ? 'Reload' : 'Show'}
          </button>
        </div>
        {archivedLoaded ? (
          archivedFeeds.length ? (
            <div className="archived-feed-list">
              {archivedFeeds.map((feed) => (
                <article className="archived-feed-card" key={feed.id}>
                  <div>
                    <strong>{feed.name}</strong>
                    <span>{feed.archivedAt ? `Archived ${new Date(feed.archivedAt).toLocaleString()}` : 'Archived'}</span>
                  </div>
                  <button className="secondary-action" type="button" disabled={busyKey !== null} onClick={() => void restore(feed)}>
                    {busyKey === `restore:${feed.id}` ? 'Restoring…' : 'Restore paused'}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="archived-empty">No archived Feeds.</p>
          )
        ) : null}
      </section>

      <button className="reset-button" type="button" onClick={onResetDecisions}>
        Reset triage decisions
      </button>
    </section>
  )
}
