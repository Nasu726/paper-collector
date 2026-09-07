import assert from 'node:assert/strict'
import type { Decision } from '../src/domain'
import { SerialTaskQueue } from '../src/serialTaskQueue'
import {
  clearUndoTargetForPaper,
  isUndoTargetAvailable,
  undoTargetForDecision,
} from '../src/undoDecision'

function decision(paperId: string, state: 'saved' | 'rejected', decidedAt: string): Decision {
  return {
    paperId,
    state,
    decidedAt,
    feedIds: ['feed'],
  }
}

const saved = decision('paper-a', 'saved', '2026-09-07T08:00:00Z')
const savedTarget = undoTargetForDecision(saved, 'Paper A')
assert.equal(savedTarget.paperId, 'paper-a')
assert.equal(savedTarget.state, 'saved')
assert.equal(savedTarget.title, 'Paper A')
assert(isUndoTargetAvailable(savedTarget, { 'paper-a': saved }), 'Fresh Save should be undoable')
assert(
  !isUndoTargetAvailable(savedTarget, {}),
  'Undo target must become unavailable after the Paper is returned by another path',
)
assert(
  !isUndoTargetAvailable(savedTarget, {
    'paper-a': decision('paper-a', 'saved', '2026-09-07T08:01:00Z'),
  }),
  'A stale Undo target must not delete a newer decision for the same Paper',
)
assert(
  !isUndoTargetAvailable(savedTarget, {
    'paper-a': decision('paper-a', 'rejected', saved.decidedAt),
  }),
  'A stale Undo target must not delete a different decision state',
)

const rejected = decision('paper-b', 'rejected', '2026-09-07T08:02:00Z')
const rejectedTarget = undoTargetForDecision(rejected, 'Paper B')
assert(isUndoTargetAvailable(rejectedTarget, { 'paper-b': rejected }), 'Fresh rejection should be undoable')
assert.equal(clearUndoTargetForPaper(rejectedTarget, 'paper-a'), rejectedTarget)
assert.equal(clearUndoTargetForPaper(rejectedTarget, 'paper-b'), null)

let activeTarget = savedTarget
activeTarget = rejectedTarget
assert.equal(activeTarget.paperId, 'paper-b', 'A second decision must replace the previous Undo target')

const queue = new SerialTaskQueue()
const events: string[] = []
let releasePut!: () => void
const putGate = new Promise<void>((resolve) => {
  releasePut = resolve
})

const put = queue.enqueue(async () => {
  events.push('put:start')
  await putGate
  events.push('put:end')
})
const remove = queue.enqueue(async () => {
  events.push('delete:start')
  events.push('delete:end')
})

await new Promise<void>((resolve) => setTimeout(resolve, 0))
assert.deepEqual(events, ['put:start'], 'DELETE started before the in-flight PUT completed')
releasePut()
await Promise.all([put, remove])
assert.deepEqual(
  events,
  ['put:start', 'put:end', 'delete:start', 'delete:end'],
  'Decision mutation queue did not preserve PUT -> DELETE order',
)

const recoveringQueue = new SerialTaskQueue()
const recoveryEvents: string[] = []
await Promise.allSettled([
  recoveringQueue.enqueue(async () => {
    recoveryEvents.push('failure')
    throw new Error('expected test failure')
  }),
  recoveringQueue.enqueue(async () => {
    recoveryEvents.push('after-failure')
  }),
])
assert.deepEqual(recoveryEvents, ['failure', 'after-failure'], 'Queue stalled after a rejected task')

console.log('Inbox Undo tests passed: target validity and serialized PUT -> DELETE ordering verified.')
