export type TriageSession = {
  startedAt: number | null
  lastDecisionAt: number | null
  decisionCount: number
}

export type TriageSessionMetrics = {
  decisionCount: number
  elapsedMs: number
  secondsPerDecision: number | null
}

export function emptyTriageSession(): TriageSession {
  return {
    startedAt: null,
    lastDecisionAt: null,
    decisionCount: 0,
  }
}

export function startTriageSession(session: TriageSession, now: number): TriageSession {
  if (session.startedAt !== null) return session
  return {
    ...session,
    startedAt: now,
  }
}

export function recordTriageDecision(session: TriageSession, now: number): TriageSession {
  const startedAt = session.startedAt ?? now
  return {
    startedAt,
    lastDecisionAt: Math.max(now, startedAt),
    decisionCount: session.decisionCount + 1,
  }
}

export function triageSessionMetrics(session: TriageSession): TriageSessionMetrics {
  if (session.startedAt === null || session.lastDecisionAt === null || session.decisionCount === 0) {
    return {
      decisionCount: session.decisionCount,
      elapsedMs: 0,
      secondsPerDecision: null,
    }
  }

  const elapsedMs = Math.max(0, session.lastDecisionAt - session.startedAt)
  return {
    decisionCount: session.decisionCount,
    elapsedMs,
    secondsPerDecision: elapsedMs / 1000 / session.decisionCount,
  }
}

export function formatSecondsPerDecision(metrics: TriageSessionMetrics): string | null {
  if (metrics.secondsPerDecision === null) return null
  if (metrics.secondsPerDecision < 10) return `${metrics.secondsPerDecision.toFixed(1)}s/decision`
  return `${Math.round(metrics.secondsPerDecision)}s/decision`
}
