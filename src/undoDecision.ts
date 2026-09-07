import type { Decision, DecisionState } from './domain'

export type UndoTarget = {
  paperId: string
  state: DecisionState
  decidedAt: string
  title: string
}

export function undoTargetForDecision(decision: Decision, title: string): UndoTarget {
  return {
    paperId: decision.paperId,
    state: decision.state,
    decidedAt: decision.decidedAt,
    title,
  }
}

export function isUndoTargetAvailable(
  target: UndoTarget | null,
  decisions: Record<string, Decision>,
): target is UndoTarget {
  if (!target) return false
  const current = decisions[target.paperId]
  return Boolean(
    current &&
      current.state === target.state &&
      current.decidedAt === target.decidedAt,
  )
}

export function clearUndoTargetForPaper(target: UndoTarget | null, paperId: string): UndoTarget | null {
  return target?.paperId === paperId ? null : target
}
