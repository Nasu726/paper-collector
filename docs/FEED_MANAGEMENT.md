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

## Collection checkpoint reset policy

Changing presentation or human-owned research description must not cause collection history to restart.

These edits **preserve** `feed_ingestion_state`:

- `name`
- `intent`
- `exclusions`

These edits **delete** the previous `feed_ingestion_state` checkpoint:

- `providerQuery`
- `sourcePolicy`

The next normal refresh after such a collection-semantics change therefore behaves like a newly configured Feed and uses the standard fourteen-day lookback. This avoids silently skipping papers that became eligible under the new query or source policy.

Explicit backfills remain diagnostic and do not advance the incremental checkpoint.

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
