import { demoFeeds, demoPapers } from './demoData'
import type {
  Decision,
  Feed,
  FeedbackEventType,
  FeedbackSurface,
  FeedSourcePolicy,
  Paper,
} from './domain'
import { clearDecisions, loadDecisions, saveDecisions, type DecisionMap } from './storage'

export type PersistenceMode = 'cloud' | 'local'

export type AppBootstrap = {
  feeds: Feed[]
  papers: Paper[]
  decisions: DecisionMap
  mode: PersistenceMode
}

export type FeedRefreshResponse = {
  feedId: string
  provider: string
  fromDate: string
  toDate: string
  status: 'success' | 'truncated'
  watermarkAdvanced: boolean
  rawFetched: number
  accepted: number
  pages: number
  inserted: number
  updated: number
  attached: number
}

export type FeedConfigInput = {
  name: string
  intent: string
  exclusions?: string
  sourcePolicy: FeedSourcePolicy
  providerQuery: string
}

export type FeedConfigPatch = Partial<FeedConfigInput>
export type FeedLifecycleAction = 'pause' | 'resume' | 'archive' | 'restore'

type BootstrapResponse = {
  feeds: Feed[]
  papers: Paper[]
  decisions: DecisionMap
}

type FeedMutationResponse = {
  feed: Feed
  collectionReset?: boolean
}

function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.feeds) &&
    Array.isArray(candidate.papers) &&
    typeof candidate.decisions === 'object' &&
    candidate.decisions !== null
  )
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error) return new Error(payload.error)
  } catch {
    // Fall back to the status-based message below.
  }
  return new Error(`${fallback} (${response.status})`)
}

class ApiAppRepository {
  async load(): Promise<BootstrapResponse> {
    const response = await fetch('/api/bootstrap', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`)

    const payload = (await response.json()) as unknown
    if (!isBootstrapResponse(payload)) throw new Error('Bootstrap response is invalid')
    return payload
  }

  async rebuildRecommendations(): Promise<void> {
    const response = await fetch('/api/recommendations/rebuild', {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw await responseError(response, 'Recommendation rebuild failed')
  }

  async refreshFeed(feedId: string): Promise<FeedRefreshResponse> {
    const response = await fetch(`/api/feeds/${encodeURIComponent(feedId)}/refresh`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw await responseError(response, 'Feed refresh failed')
    return (await response.json()) as FeedRefreshResponse
  }

  async createFeed(input: FeedConfigInput): Promise<FeedMutationResponse> {
    const response = await fetch('/api/feeds', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await responseError(response, 'Feed creation failed')
    return (await response.json()) as FeedMutationResponse
  }

  async updateFeed(feedId: string, patch: FeedConfigPatch): Promise<FeedMutationResponse> {
    const response = await fetch(`/api/feeds/${encodeURIComponent(feedId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!response.ok) throw await responseError(response, 'Feed update failed')
    return (await response.json()) as FeedMutationResponse
  }

  async transitionFeed(feedId: string, action: FeedLifecycleAction): Promise<FeedMutationResponse> {
    const response = await fetch(`/api/feeds/${encodeURIComponent(feedId)}/${action}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw await responseError(response, `Feed ${action} failed`)
    return (await response.json()) as FeedMutationResponse
  }

  async loadArchivedFeeds(): Promise<Feed[]> {
    const response = await fetch('/api/feeds/archived', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw await responseError(response, 'Archived Feed load failed')
    const payload = (await response.json()) as { feeds?: unknown }
    if (!Array.isArray(payload.feeds)) throw new Error('Archived Feed response is invalid')
    return payload.feeds as Feed[]
  }

  async recordFeedback(
    paperId: string,
    type: FeedbackEventType,
    surface: FeedbackSurface,
  ): Promise<void> {
    const response = await fetch('/api/feedback-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ paperId, type, surface }),
      keepalive: true,
    })
    if (!response.ok) throw new Error(`Feedback event failed with ${response.status}`)
  }

  async upsertDecision(decision: Decision): Promise<void> {
    const response = await fetch(`/api/decisions/${encodeURIComponent(decision.paperId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision),
    })
    if (!response.ok) throw new Error(`Decision upsert failed with ${response.status}`)
  }

  async removeDecision(paperId: string): Promise<void> {
    const response = await fetch(`/api/decisions/${encodeURIComponent(paperId)}`, {
      method: 'DELETE',
    })
    if (!response.ok) throw new Error(`Decision delete failed with ${response.status}`)
  }

  async clearDecisions(): Promise<void> {
    const response = await fetch('/api/decisions', { method: 'DELETE' })
    if (!response.ok) throw new Error(`Decision reset failed with ${response.status}`)
  }
}

class LocalAppRepository {
  load(): BootstrapResponse {
    return {
      feeds: demoFeeds,
      papers: demoPapers,
      decisions: loadDecisions(),
    }
  }

  upsertDecision(decision: Decision): void {
    saveDecisions({ ...loadDecisions(), [decision.paperId]: decision })
  }

  removeDecision(paperId: string): void {
    const next = { ...loadDecisions() }
    delete next[paperId]
    saveDecisions(next)
  }

  clearDecisions(): void {
    clearDecisions()
  }
}

class ResilientAppRepository {
  private readonly api = new ApiAppRepository()
  private readonly local = new LocalAppRepository()
  private mode: PersistenceMode = 'cloud'
  private recommendationRefreshQueue: Promise<Paper[] | null> = Promise.resolve(null)

  private async loadCloud(): Promise<AppBootstrap> {
    const bootstrap = await this.api.load()
    saveDecisions(bootstrap.decisions)
    this.mode = 'cloud'
    return { ...bootstrap, mode: 'cloud' }
  }

  private requireCloud(): void {
    if (this.mode !== 'cloud') throw new Error('Feed management requires the cloud Worker API.')
  }

  async load(): Promise<AppBootstrap> {
    try {
      return await this.loadCloud()
    } catch {
      this.mode = 'local'
      return { ...this.local.load(), mode: this.mode }
    }
  }

  refreshRecommendations(): Promise<Paper[] | null> {
    if (this.mode !== 'cloud') return Promise.resolve(null)

    const next = this.recommendationRefreshQueue.then(async () => {
      if (this.mode !== 'cloud') return null
      try {
        await this.api.rebuildRecommendations()
        const bootstrap = await this.api.load()
        return bootstrap.papers
      } catch {
        // Ranking refresh is best-effort. Decision persistence has already completed.
        return null
      }
    })

    this.recommendationRefreshQueue = next.catch(() => null)
    return next
  }

  async refreshFeed(feedId: string): Promise<{ refresh: FeedRefreshResponse; bootstrap: AppBootstrap }> {
    this.requireCloud()
    const refresh = await this.api.refreshFeed(feedId)
    const bootstrap = await this.loadCloud()
    return { refresh, bootstrap }
  }

  async createFeed(input: FeedConfigInput): Promise<{ mutation: FeedMutationResponse; bootstrap: AppBootstrap }> {
    this.requireCloud()
    const mutation = await this.api.createFeed(input)
    return { mutation, bootstrap: await this.loadCloud() }
  }

  async updateFeed(
    feedId: string,
    patch: FeedConfigPatch,
  ): Promise<{ mutation: FeedMutationResponse; bootstrap: AppBootstrap }> {
    this.requireCloud()
    const mutation = await this.api.updateFeed(feedId, patch)
    return { mutation, bootstrap: await this.loadCloud() }
  }

  async transitionFeed(
    feedId: string,
    action: FeedLifecycleAction,
  ): Promise<{ mutation: FeedMutationResponse; bootstrap: AppBootstrap }> {
    this.requireCloud()
    const mutation = await this.api.transitionFeed(feedId, action)
    return { mutation, bootstrap: await this.loadCloud() }
  }

  async loadArchivedFeeds(): Promise<Feed[]> {
    this.requireCloud()
    return this.api.loadArchivedFeeds()
  }

  async recordFeedback(
    paperId: string,
    type: FeedbackEventType,
    surface: FeedbackSurface,
  ): Promise<boolean> {
    if (this.mode !== 'cloud') return false
    try {
      await this.api.recordFeedback(paperId, type, surface)
      return true
    } catch {
      return false
    }
  }

  async upsertDecision(decision: Decision): Promise<PersistenceMode> {
    this.local.upsertDecision(decision)
    if (this.mode === 'cloud') {
      try {
        await this.api.upsertDecision(decision)
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }

  async removeDecision(paperId: string): Promise<PersistenceMode> {
    this.local.removeDecision(paperId)
    if (this.mode === 'cloud') {
      try {
        await this.api.removeDecision(paperId)
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }

  async clearDecisions(): Promise<PersistenceMode> {
    this.local.clearDecisions()
    if (this.mode === 'cloud') {
      try {
        await this.api.clearDecisions()
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }
}

export const appRepository = new ResilientAppRepository()
