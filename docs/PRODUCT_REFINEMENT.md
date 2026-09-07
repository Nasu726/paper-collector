# Product refinement

## Goal

Milestone 7 improves the speed and recoverability of the mobile Paper Inbox without adding dashboard-style complexity or invasive behavioral telemetry.

The primary product metric remains decision throughput: how quickly a user can inspect enough evidence and make a Save / Not interested decision.

## Immediate Undo

The first refinement is an Inbox-level Undo for accidental triage decisions.

Contract:

- only the most recent decision made in the current UI session is eligible for the compact Inbox Undo action
- the Undo target does not expire on a timer; making a newer decision replaces it
- Save and Not interested are both undoable
- Undo removes the persisted decision through the same repository path used by Return to Inbox
- if the decision has already been removed or replaced, the stale Undo action must not remove newer state
- switching tabs does not fabricate a new target; returning to Inbox may still undo the latest session decision while it remains current
- Undo does not delete or synthesize feedback events
- recommendation rebuild after Undo is best-effort and must not block the interaction

Decision mutations are serialized in the client repository. This guarantees that an immediate Undo cannot send its DELETE ahead of the in-flight PUT that created the decision.

## Throughput measurement

A later refinement may measure aggregate session throughput locally.

Allowed aggregate measurements:

- session start/end or total elapsed duration
- number of decisions in the session
- derived aggregate values such as decisions per minute or seconds per decision

Do not record or persist:

- per-Paper dwell time
- card-view timestamps or heartbeats
- scroll depth
- pointer/touch traces
- per-Paper timing derived from when a card became visible

Aggregate throughput is a UX-tuning signal only. It must not become recommendation evidence.

## Mobile constraints

The iPhone 17 logical viewport (402 x 874 pt) remains the primary mobile acceptance target.

Refinements must preserve:

- one-card-at-a-time Inbox
- fixed, immediately reachable Save / Not interested actions
- safe-area spacing around Dynamic Island, rounded corners, and Home Indicator
- direct access to the paper abstract, PDF, and source page
- no mandatory notes, ratings, or confirmation step for ordinary triage

PWA installation and Saved search remain follow-up work. They should not be pulled into the Undo implementation.
