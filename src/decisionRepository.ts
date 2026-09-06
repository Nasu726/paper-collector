import type { Decision } from './domain'
import { clearDecisions, loadDecisions, saveDecisions, type DecisionMap } from './storage'

export type PersistenceMode = 'cloud' | 'local'

export type LoadedDecisions = {
  decisions: DecisionMap
  mode: PersistenceMode
}

type BootstrapResponse = {
  decisions: DecisionMap
}

class ApiDecisionRepository {
  async load(): Promise<DecisionMap> {
    const response = await fetch('/api/bootstrap', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`)

    const payload = (await response.json()) as BootstrapResponse
    if (!payload || typeof payload.decisions !== 'object' || payload.decisions === null) {
      throw new Error('Bootstrap response is invalid')
    }
    return payload.decisions
  }

  async upsert(decision: Decision): Promise<void> {
    const response = await fetch(`/api/decisions/${encodeURIComponent(decision.paperId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision),
    })
    if (!response.ok) throw new Error(`Decision upsert failed with ${response.status}`)
  }

  async remove(paperId: string): Promise<void> {
    const response = await fetch(`/api/decisions/${encodeURIComponent(paperId)}`, {
      method: 'DELETE',
    })
    if (!response.ok) throw new Error(`Decision delete failed with ${response.status}`)
  }

  async clear(): Promise<void> {
    const response = await fetch('/api/decisions', { method: 'DELETE' })
    if (!response.ok) throw new Error(`Decision reset failed with ${response.status}`)
  }
}

class LocalDecisionRepository {
  load(): DecisionMap {
    return loadDecisions()
  }

  upsert(decision: Decision): void {
    saveDecisions({ ...loadDecisions(), [decision.paperId]: decision })
  }

  remove(paperId: string): void {
    const next = { ...loadDecisions() }
    delete next[paperId]
    saveDecisions(next)
  }

  clear(): void {
    clearDecisions()
  }
}

class ResilientDecisionRepository {
  private readonly api = new ApiDecisionRepository()
  private readonly local = new LocalDecisionRepository()
  private mode: PersistenceMode = 'cloud'

  async load(): Promise<LoadedDecisions> {
    try {
      const decisions = await this.api.load()
      saveDecisions(decisions)
      this.mode = 'cloud'
      return { decisions, mode: this.mode }
    } catch {
      this.mode = 'local'
      return { decisions: this.local.load(), mode: this.mode }
    }
  }

  async upsert(decision: Decision): Promise<PersistenceMode> {
    this.local.upsert(decision)
    if (this.mode === 'cloud') {
      try {
        await this.api.upsert(decision)
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }

  async remove(paperId: string): Promise<PersistenceMode> {
    this.local.remove(paperId)
    if (this.mode === 'cloud') {
      try {
        await this.api.remove(paperId)
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }

  async clear(): Promise<PersistenceMode> {
    this.local.clear()
    if (this.mode === 'cloud') {
      try {
        await this.api.clear()
      } catch {
        this.mode = 'local'
      }
    }
    return this.mode
  }
}

export const decisionRepository = new ResilientDecisionRepository()
