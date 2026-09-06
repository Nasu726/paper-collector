# Implicit feedback evidence and privacy

Paper Collector keeps explicit judgment deliberately simple: the user chooses **Save** or **Not interested**. Implicit feedback is supplementary evidence gathered from actions the user already performs while deciding what to read.

This document defines the raw event contract and the rules future recommendation models must follow when interpreting it.

## 1. Raw evidence is not a score

The application stores raw interaction events. It does **not** store a permanent recommendation weight on those events.

Current event types are:

| Event | Meaning | Qualitative evidence |
| --- | --- | --- |
| `abstract_expanded` | The user explicitly asked to see the complete original abstract | weak positive |
| `source_opened` | The user opened the publisher/repository/source page | medium positive |
| `pdf_opened` | The user explicitly opened the paper PDF | strong positive |

The event also stores the interaction surface:

- `inbox`
- `saved`
- `archive`

Surface is context, not a second event type. A future model may reasonably treat a repeated PDF open from Saved as stronger evidence than a first PDF open from Inbox, while an open from Archive may indicate reconsideration rather than the same kind of positive signal.

The exact mapping from raw evidence to numeric features belongs to a **versioned recommendation model**, not to the event schema. Changing recommendation weights must therefore not require rewriting historical feedback rows.

## 2. Explicit decisions remain stronger evidence

Save / Not Interested are explicit user judgments and remain in the `decisions` model rather than being duplicated as implicit feedback events.

A recommendation baseline should generally treat:

- Save as strong explicit positive evidence
- Not Interested as strong explicit negative evidence
- implicit events as supporting evidence with lower confidence

Implicit evidence must never silently reverse or overwrite an explicit decision.

## 3. Repetition is useful but must be regularized

Repeated PDF/source opens can be meaningful, especially from Saved, so Paper Collector stores each explicit open as a separate append-only event.

A future model must not let repeated clicks grow linearly without bound. Reasonable approaches include:

- a small count cap per paper/event/surface
- logarithmic count features such as `log(1 + count)`
- recency-aware diminishing returns

The exact policy belongs to the recommendation model version. Raw events remain unchanged.

## 4. Abstract expansion is de-noised at the client

For one displayed Inbox Paper instance, only the first transition from collapsed to expanded is recorded. Collapsing and expanding the same card repeatedly does not generate repeated `abstract_expanded` evidence.

This keeps a weak signal from being accidentally amplified by UI toggling.

## 5. Server-owned context snapshot

Clients submit only:

- canonical `paperId`
- event `type`
- interaction `surface`

The Worker generates:

- event ID
- occurrence timestamp
- persisted Paper-to-Feed membership snapshot

The client cannot submit arbitrary Feed IDs or arbitrary metadata. This prevents stale UI state or accidental client instrumentation changes from contaminating the historical context.

The Feed snapshot uses persisted membership, including historical membership retained through Feed archive. Later recommendation code can decide whether an archived Feed should participate in scoring without losing the historical context of the event.

## 6. Data intentionally not collected

The current product intentionally does **not** collect:

- time-on-card or dwell time
- scroll depth
- card-view heartbeats
- pointer/touch trajectories
- browser fingerprint data
- user agent as feedback metadata
- IP/location as feedback metadata
- raw title or abstract text inside feedback rows
- PDF/source URLs inside feedback rows
- arbitrary client-provided metadata objects

These are either noisy on a phone, unnecessary for the ranking problem, or disproportionate to a personal Paper Inbox.

In particular, a long dwell time is not reliable evidence: the user may simply put the phone down.

## 7. Failure behavior

Feedback collection is optional evidence, not part of the critical triage transaction.

If a feedback POST fails:

- the PDF/source link still opens
- abstract expansion still works
- Save / Not Interested still works
- the application does not downgrade otherwise healthy D1 decision persistence to local fallback merely because feedback logging failed

In local/demo fallback mode, Paper Collector does not pretend that feedback events were persisted.

## 8. Storage and inspection

Raw events are append-only in `feedback_events` and can be inspected per Paper through:

```text
GET /api/papers/:paperId/feedback?limit=N
```

The read is bounded to at most 100 newest events.

The current single-user deployment has no automatic feedback-retention window. Events remain in the private D1 database until explicitly removed at the database/administrative level. A future user-facing data-management feature may add selective or full feedback deletion, but recommendation work must not assume events are permanent.

## 9. Privacy boundary

The intended deployment protects the whole application with Cloudflare Access. Feedback is personal preference data and should be treated as private application state.

Feedback data must not be sent to an LLM or third-party analytics service merely to implement the baseline recommendation model. Local/Worker-side deterministic ranking should be preferred where sufficient.

If a future AI feature requires transmitting feedback-derived information externally, that must be introduced as a separate explicit design decision rather than silently expanding the current collection contract.

## 10. Recommendation-model contract

A future recommendation implementation should consume two distinct evidence families:

1. **explicit evidence** — Save / Not Interested decisions
2. **implicit evidence** — append-only interaction events described here

The model may derive features such as counts, recency, surface, Feed association, and similarity to previously selected papers. Derived features and weights must be versioned separately from raw events.

Recommendation remains an ordering aid. Neither explicit nor implicit evidence may be used to make eligible papers inaccessible through automatic filtering.
