import type { Decision } from './domain'

const DECISIONS_KEY = 'paper-collector:decisions:v1'

export type DecisionMap = Record<string, Decision>

export function loadDecisions(): DecisionMap {
  try {
    const raw = window.localStorage.getItem(DECISIONS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as DecisionMap
  } catch {
    return {}
  }
}

export function saveDecisions(decisions: DecisionMap): void {
  window.localStorage.setItem(DECISIONS_KEY, JSON.stringify(decisions))
}

export function clearDecisions(): void {
  window.localStorage.removeItem(DECISIONS_KEY)
}
