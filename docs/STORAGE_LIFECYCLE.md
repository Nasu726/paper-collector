# Paper storage lifecycle

Paper Collector is designed to process many more Papers than it keeps as live library content. Because the shared Cloudflare D1 database has a small bounded capacity, canonical Paper metadata must not accumulate indefinitely as soft-deleted rows.

## Principle

A Paper that has become disposable is physically deleted from `papers`.

Do not add `is_deleted`, `deleted_at`, or an equivalent canonical-Paper tombstone as the primary retention mechanism. Background storage maintenance must reclaim the title, abstract, authors, URLs, publication metadata, provider evidence, and other Paper-scoped hot rows.

This is a storage lifecycle rule, not a ranking rule. Recommendation score never makes a Paper purgeable.

## Current purge eligibility

The initial GC policy is intentionally conservative.

A Paper is purgeable only when all of the following are true:

1. its latest explicit decision is `rejected`;
2. that rejection is at least 30 days old;
3. a canonical `papers` row still exists; and
4. there is no row in `paper_retention_refs` for the Paper.

Therefore the following are not purgeable:

- undecided Inbox Papers;
- Saved Papers;
- Rejected Papers still inside the 30-day Archive/recovery window;
- Papers retained by book-reader or another shared-library consumer.

The candidate query and final `DELETE` both re-check the decision state and retention reference. `paper_retention_refs.paper_id` also uses `ON DELETE RESTRICT`, providing a database-level guard against accidental deletion of shared live content.

## What physical deletion removes

Deleting the canonical `papers` row cascades through Paper-scoped data that has no independent long-term learning value, including:

- `paper_feeds`;
- `paper_identifiers`;
- `ingestion_provenance`;
- `paper_field_evidence`;
- `paper_field_sources`;
- `crossref_enrichment_state`.

Current recommendation snapshots and staging rows for the Paper are also removed explicitly.

The canonical title, abstract, authors, venue, source/PDF URLs, publication metadata, and full identifier JSON therefore leave the hot Paper store.

## What survives GC

### Explicit decision

`decisions` deliberately has no foreign key to `papers`. The rejected decision survives physical Paper deletion.

### Raw feedback

`feedback_events` also deliberately survives independently of `papers`. GC does not delete or synthesize feedback events.

### Compact lexical learning evidence

The current `lexical-v1` recommender previously needed the deleted title/abstract to learn from a Reject. Before deletion, GC creates a bounded representation in `purged_paper_learning`:

- feature/model version;
- up to 24 high-frequency normalized title terms;
- up to 64 high-frequency normalized abstract terms;
- purge timestamp;
- an estimate of the source Paper bytes reclaimed.

Terms are normalized with the same lexical tokenizer as the active recommendation model. The original title and abstract are not retained.

Safe recommendation rebuilds read live Papers together with these compact learning rows for profile construction. Purged Papers remain non-candidates because they have no live Feed membership and already have an explicit decision.

A future recommendation model must either understand the retained feature version or define a migration/compaction path. It must not silently require the deleted canonical metadata.

### Minimal duplicate-prevention identity

Before deleting `paper_identifiers`, GC copies normalized DOI, arXiv, and provider identity keys into `seen_paper_identifiers`.

This table is not a Paper tombstone. It contains only identity keys plus first/last-seen timestamps. Ingestion checks the incoming Paper's identifier tuple in one bounded lookup. If any identifier belongs to a previously purged Paper, the canonical Paper is not recreated; newly discovered aliases are added to the same minimal seen-state.

The normal Feed/provider watermark remains the primary way to avoid historical re-fetch. `seen_paper_identifiers` is a safety net for overlapping windows, explicit backfills, provider aliases, and other cases where a deleted Paper is encountered again.

## Shared Paper Library retention

`paper_retention_refs` is the cross-application protection boundary for the shared D1 database.

Conceptually:

```text
paper_id | owner       | reference_id
---------+-------------+----------------
...      | book-reader | document-123
```

A consumer should add a retention reference while it needs the canonical Paper as live content and remove that reference only when the shared Paper can become disposable again.

Paper Collector itself does not infer Reader ownership from URLs or naming conventions. Retention is explicit database state.

## Operations

### Inspect storage

`GET /api/storage/stats`

returns:

- canonical Paper row count;
- rejected decision count;
- feedback row count;
- compact purged-learning row count;
- seen-identifier row count;
- active retention-reference count;
- estimated bytes occupied by the variable-length fields in canonical `papers` rows.

The byte value is an application-level estimate, not D1's exact file allocation. It is intended to make GC impact measurable before/after a run.

### Run bounded GC

`POST /api/storage/gc?limit=N`

physically purges at most `N` eligible Papers. The default is 50 and the API maximum is 200 per invocation.

The result reports candidate/purged/skipped counts, estimated bytes reclaimed, the retention cutoff, and before/after storage statistics.

### Scheduled order

Scheduled maintenance runs:

```text
ingestion
  -> Crossref enrichment
  -> bounded Paper GC
  -> recommendation rebuild
```

Running GC before recommendation rebuild ensures compact evidence participates in the same scheduled recommendation generation that follows the deletion.

## Future pressure relief

If `feedback_events`, compact learning rows, or seen identifiers themselves become significant, reduce them without restoring full Paper tombstones. Appropriate strategies include:

- loss-aware feedback aggregation;
- bounded/versioned learned feature vectors;
- R2 cold-history exports;
- identifier compaction where provider watermarks make old seen-state redundant.

Any compaction must preserve the learning and duplicate-prevention semantics it replaces.

See also `SHARED_PAPER_LIBRARY.md` for the shared D1 ownership model and Issue #59 for cold-history/compaction work.
