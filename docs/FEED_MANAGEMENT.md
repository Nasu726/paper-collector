# Feed management and lifecycle

Research Feeds are user-owned configuration. The explicit natural-language research intent is deliberately separate from the provider query used for collection.

## Lifecycle states

A Feed has two independent lifecycle signals:

- `active=1` — scheduled/manual normal collection is allowed
- `archived_at != NULL` — the Feed is removed from normal Feed management

Normal states are:

| State | `active` | `archived_at` | Scheduled collection |
| --- | ---: | --- | --- |
| Active | 1 | NULL | yes |
| Paused | 0 | NULL | no |
| Archived | 0 | timestamp | no |

Restoring an archived Feed returns it to **Paused** state. The user must explicitly resume collection.

Archiving is a logical lifecycle transition, not deletion. Existing Papers, `paper_feeds` membership, decisions, ingestion provenance, recommendation history, and feedback data are retained.

## API

### Create

```text
POST /api/feeds
```

Required fields:

- `name`
- `intent`
- `sourcePolicy`
- `providerQuery`

Optional:

- `exclusions`

The Worker generates the Feed ID. Clients must not invent IDs.

### Edit

```text
PATCH /api/feeds/:feedId
```

Any subset of the editable fields may be supplied. Unknown fields are rejected.

The explicit `intent` and `providerQuery` are independent. Editing one never rewrites the other.

### Pause / resume

```text
POST /api/feeds/:feedId/pause
POST /api/feeds/:feedId/resume
```

Pause keeps all historical data and the successful ingestion checkpoint.

### Archive / restore

```text
POST /api/feeds/:feedId/archive
POST /api/feeds/:feedId/restore
GET  /api/feeds/archived
```

Archived Feeds are omitted from the ordinary `/api/bootstrap` Feed list. They remain recoverable from the archive endpoint.

### Inspect ingestion provenance

```text
GET /api/papers/:paperId/provenance
```

This diagnostic endpoint exposes every persisted Feed/provider origin for a canonical Paper. It is intentionally independent from the currently visible Feed list so historical provenance remains inspectable after a Feed is archived.

## Normal bootstrap visibility after archive

Persistent history and the normal Inbox payload are deliberately different views.

D1 continues to retain historical `paper_feeds` memberships and ingestion provenance after archive. Normal `/api/bootstrap`, however, only exposes non-archived Feed IDs in each Paper's `feedIds`.

For Papers:

- an **undecided** Paper with at least one non-archived Feed remains in normal bootstrap
- an **undecided** Paper whose only memberships are archived is omitted from normal bootstrap
- a **Saved or Rejected** Paper remains in normal bootstrap even if every source Feed is archived, so reading/decision history is not lost
- a Paused Feed is not archived, so its Paper memberships remain visible
- restoring a Feed reveals its persisted historical Paper memberships again without provider re-fetch

This filtering is presentation/application state only. It must never delete `paper_feeds`, provenance, or decisions from D1.

## Collection checkpoint reset policy

Changing presentation or human-owned research description must not cause collection history to restart.

These edits **preserve** `feed_ingestion_state`:

- `name`
- `intent`
- `exclusions`

These edits **delete** the previous `feed_ingestion_state` checkpoint:

- `providerQuery`
- `sourcePolicy`

The Feed configuration update and checkpoint deletion are submitted through one D1 `batch`, so a collection-semantics change cannot commit while leaving the stale checkpoint behind.

The next normal refresh after such a collection-semantics change therefore behaves like a newly configured Feed and uses the standard fourteen-day lookback. This avoids silently skipping papers that became eligible under the new query or source policy.

Explicit backfills remain diagnostic and do not advance the incremental checkpoint.

## Multi-Feed identity and history

Feed configuration is independent, but Paper identity is global.

When two Feeds discover the same normalized DOI:

- there is one canonical `papers` row
- `paper_feeds` contains one membership for each Feed
- the Inbox renders one canonical Paper rather than duplicate cards
- `ingestion_provenance` retains each Feed/provider/query origin independently
- a decision belongs to the canonical Paper and survives later Feed lifecycle changes

Archiving one Feed therefore does **not** delete that Feed ID from historical D1 membership, provenance, or saved/rejected decisions. Normal bootstrap may suppress archived Feed IDs and archived-only undecided Papers as described above.

Editing one Feed must never mutate another Feed's explicit intent, query, exclusions, policy, active state, or checkpoint.

These invariants are covered by the deterministic `api:smoke:multifeed` integration test.

## Validation bounds

Current Worker validation is intentionally bounded:

- name: 1–80 characters
- intent: 1–4000 characters
- exclusions: at most 2000 characters
- provider query: 1–1000 characters
- source policy: one of `published_only`, `accepted_when_verifiable`, `include_preprints`

Malformed JSON, arrays instead of objects, unknown fields, empty required strings, and invalid source policies produce deterministic 4xx responses.

## Product invariant

Feed lifecycle operations must never mutate learned preference state. Later recommendation models may learn from decisions associated with a Feed, but they must not silently rewrite `intent`, `providerQuery`, exclusions, or source policy.
