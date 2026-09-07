import assert from 'node:assert/strict'
import {
  emptyTriageSession,
  formatSecondsPerDecision,
  recordTriageDecision,
  startTriageSession,
  triageSessionMetrics,
} from '../src/triageSession'

let session = emptyTriageSession()
assert.deepEqual(triageSessionMetrics(session), {
  decisionCount: 0,
  elapsedMs: 0,
  secondsPerDecision: null,
})

session = startTriageSession(session, 1_000)
session = startTriageSession(session, 9_999)
assert.equal(session.startedAt, 1_000, 'Session start must be stable after initialization')

session = recordTriageDecision(session, 6_000)
let metrics = triageSessionMetrics(session)
assert.equal(metrics.decisionCount, 1)
assert.equal(metrics.elapsedMs, 5_000)
assert.equal(metrics.secondsPerDecision, 5)
assert.equal(formatSecondsPerDecision(metrics), '5.0s/decision')

session = recordTriageDecision(session, 21_000)
metrics = triageSessionMetrics(session)
assert.equal(metrics.decisionCount, 2)
assert.equal(metrics.elapsedMs, 20_000)
assert.equal(metrics.secondsPerDecision, 10)
assert.equal(formatSecondsPerDecision(metrics), '10s/decision')

const cold = recordTriageDecision(emptyTriageSession(), 30_000)
assert.equal(cold.startedAt, 30_000)
assert.equal(cold.lastDecisionAt, 30_000)
assert.equal(cold.decisionCount, 1)
assert.equal(triageSessionMetrics(cold).secondsPerDecision, 0)

const clamped = recordTriageDecision(startTriageSession(emptyTriageSession(), 50_000), 40_000)
assert.equal(clamped.lastDecisionAt, 50_000, 'Clock skew must not create negative elapsed time')
assert.equal(triageSessionMetrics(clamped).elapsedMs, 0)

console.log('Triage session tests passed: aggregate-only elapsed time and decision throughput verified.')
