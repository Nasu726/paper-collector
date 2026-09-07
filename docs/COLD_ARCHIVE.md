# Cold history archive

Paper Collector keeps interactive state in the shared D1 database and moves selected append-only history to the existing private `book-reader-documents` R2 bucket.

The first implemented archive format covers raw implicit feedback only. Automatic retention is intentionally **not** enabled yet; real row-growth data should determine that policy.

## Ownership

Paper Collector's R2 binding is:

```text
COLD_ARCHIVE -> book-reader-documents
```

Paper Collector owns only keys below:

```text
paper-collector/cold/v1/
```

Reader PDF/document objects are outside this prefix and must not be listed, modified, or deleted by Collector archival code.

Wrangler local development simulates the R2 binding locally, so CI does not write to the production Reader bucket.

## Feedback archive v1

### Hot D1 before compaction

`feedback_events` contains one row per raw implicit interaction.

### Hot D1 after compaction

`feedback_compact` keeps only the recommendation semantics required by `lexical-v1`:

```text
paper_id
+ event_type
+ metadata_json     # server-owned surface + Feed snapshot context
-> event_count
   first_event_at
   last_event_at
```

Recommendation rebuilds sum raw and compact counts before applying model-versioned weights. Therefore moving a raw event to compact storage must not change `implicitMass` or `evidenceStrength`.

### R2 object

Each batch is newline-delimited JSON (`application/x-ndjson`). A line preserves the raw database contract:

```json
{"schemaVersion":1,"id":"feedback-...","paperId":"...","feedId":null,"eventType":"pdf_opened","eventAt":"2026-08-01T00:00:00.000Z","weight":null,"metadataJson":"{...}"}
```

The object key is deterministic from the SHA-256 digest of the exact JSONL bytes:

```text
paper-collector/cold/v1/feedback/YYYY-MM/<sha256>.jsonl
```

R2 custom metadata stores:

- `schemaVersion`
- `archiveType=feedback-v1`
- `checksumSha256`
- `recordCount`
- `byteLength`
- first and last event timestamps

The same checksum is also the D1 `cold_archive_batches.batch_id`.

## Verify before delete

A non-dry-run archive follows this order:

1. acquire the short D1 `feedback` archive lease
2. select at most 50 raw events older than the explicit cutoff
3. deterministically serialize JSONL and calculate SHA-256
4. reuse an already matching R2 object or upload it
5. call R2 `head()` and verify object size + schema/checksum/count metadata
6. in one D1 `batch()` transaction:
   - add the event counts to `feedback_compact`
   - physically delete the represented `feedback_events` rows
   - insert the verified `cold_archive_batches` manifest row
7. release the lease

If upload or verification fails, step 6 never runs and raw D1 events remain intact.

If the Worker fails after R2 upload but before D1 commit, a retry computes the same object bytes and safely reuses/verifies the existing object.

## API

Inspect hot/cold counts without scanning R2:

```text
GET /api/storage/feedback-archive
```

Preview one bounded batch:

```json
POST /api/storage/feedback-archive
{
  "cutoffAt": "2026-09-01T00:00:00Z",
  "dryRun": true
}
```

Commit it:

```json
POST /api/storage/feedback-archive
{
  "cutoffAt": "2026-09-01T00:00:00Z"
}
```

`limit` may be supplied from 1 through 50. No default retention age or scheduled compaction exists yet.

## Recovery / import

R2 is the loss-aware raw archive; `feedback_compact` is the normal hot representation used by recommendation.

For disaster recovery of missing compact state, read the JSONL object identified by `cold_archive_batches.object_key`, group records by `(paperId, eventType, metadataJson)`, and recreate the corresponding `feedback_compact` counts.

If raw events need to be restored for event-level inspection, do **not** simply insert the JSONL rows while leaving the compact counts unchanged. That would double-count recommendation evidence. Restore must atomically:

1. reinsert the raw rows by original event ID
2. subtract the same grouped counts from `feedback_compact`
3. delete compact groups whose count reaches zero

The R2 object itself may remain immutable after restoration; the D1 batch manifest is the audit record of the original archive operation.

Before building an automated restore command, add an E2E that proves recommendation scores/profile strength are unchanged across archive -> restore.

## Retention policy remains open

Issue #59 intentionally remains open after this foundation. We still need real production measurements for:

- raw feedback rows/day
- bytes/event and bytes/compact group
- compact-group growth rate
- R2 archive bytes/month
- D1 read/write cost of compaction

Only then should a default age and automatic cadence be selected.
