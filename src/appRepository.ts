import { demoFeeds, demoPapers } from './demoData'
import type { Decision, Feed, Paper } from './domain'
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

type BootstrapResponse = {
  feeds: Feed[]
  papers: Paper[]
  decisions: DecisionMap
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

  async refreshFeed(feedId: string): Promise<FeedRefreshResponse> {
    const response = await fetch(`/api/feeds/${encodeURIComponent(feedId)}/refresh`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw await responseError(response, 'Feed refresh failed')
    return (await response.json()) as FeedRefreshResponse
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

  async load(): Promise<AppBootstrap> {
    try {
      const bootstrap = await this.api.load()
      saveDecisions(bootstrap.decisions)
      this.mode = 'cloud'
      return { ...bootstrap, mode: this.mode }
    } catch {
      this.mode = 'local'
      return { ...this.local.load(), mode: this.mode }
    }
  }

  async refreshFeed(feedId: string): Promise<{ refresh: FeedRefreshResponse; bootstrap: AppBootstrap }> {
    if (this.mode !== 'cloud') throw new Error('Feed refresh requires the cloud Worker API.')

    const refresh = await this.api.refreshFeed(feedId)
    const bootstrap = await this.api.load()
    saveDecisions(bootstrap.decisions)
    return {
      refresh,
      bootstrap: { ...bootstrap, mode: 'cloud' },
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
