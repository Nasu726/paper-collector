# Shared Paper Library

Paper Collector and [`Nasu726/book-reader`](https://github.com/Nasu726/book-reader) intentionally use the same physical Cloudflare D1 database.

The shared database is not one undifferentiated schema. Each application owns a bounded set of tables and an independent Wrangler migration history.

## Physical database

Production D1:

- database name: `book-reader`
- Paper Collector binding: `DB`
- Reader binding: `DB`
- Paper Collector migration table: `paper_collector_migrations`
- Reader migration table: `d1_migrations`

Separate migration tables are required because the two repositories have independently numbered migration files such as `0001_*.sql`.

Local development remains isolated. `wrangler ... --local` stores local D1 state inside each repository's Wrangler state, so Collector CI does not need the Reader schema just to run its tests.

## Schema ownership

### Shared scholarly identity — Paper Collector owned initially

`papers` is the canonical scholarly-paper record. It stores metadata and references, not PDF bytes.

Related canonical identity/evidence tables include:

- `paper_identifiers`
- `paper_field_evidence`
- `paper_field_sources`

Strong identity remains DOI first, then provider identifiers such as OpenAlex.

### Collector operational state

Paper Collector owns:

- `feeds`
- `paper_feeds`
- ingestion/provenance/checkpoint tables
- `decisions`
- `feedback_events`
- `recommendation_snapshots`
- Paper GC/compact-learning/seen-identifier state

Reader code must not depend on these tables merely to open a paper.

### Reader state

AI Reader owns `documents` plus reading-specific tables such as progress, highlights, notes, conversations, messages, and vocabulary.

A Reader document may link to a canonical scholarly paper through a nullable `paper_id`. EPUBs, books, and manually imported documents can continue to exist without a Paper record.

The relationship is intentionally asymmetric:

```text
canonical papers
      1
      |
      | optional link
      v
reader documents
      |
      +-- reading_progress
      +-- highlights
      +-- notes
      +-- conversations
```

Reader-specific edits must not silently overwrite canonical scholarly metadata. Collector provider enrichment remains responsible for canonical title/authors/publication evidence.

## Cross-application retention contract

Canonical Papers are not guaranteed to remain in D1 forever. Paper Collector physically purges old rejected Papers to keep the shared D1 useful at high triage volume.

Any application that still requires a canonical Paper as live content must register a row in `paper_retention_refs`:

```text
paper_id | owner       | reference_id
---------+-------------+----------------
...      | book-reader | document-123
```

`paper_retention_refs.paper_id` uses `ON DELETE RESTRICT`. Paper Collector's GC also excludes referenced Papers explicitly, so the table is both the logical ownership contract and a database-level deletion guard.

A consumer should remove its retention reference only when it no longer requires that canonical Paper. Paper Collector does not infer Reader ownership from a URL, title, or naming convention.

The detailed rejection window, compact-learning representation, and hard-delete behavior are documented in [`STORAGE_LIFECYCLE.md`](STORAGE_LIFECYCLE.md).

## Document bytes and URLs

Paper Collector never stores PDF bytes. A canonical Paper keeps stable references such as:

- DOI
- arXiv ID
- OpenAlex ID
- `source_url`
- `pdf_url`

For a paper discovered by Collector, Reader should normally read from the canonical remote PDF/source URL rather than duplicate the PDF into D1 or R2.

Reader's existing `DocumentStorage` remains useful for explicit local/private imports. On Cloudflare those uploaded bytes live in R2; D1 stores only an opaque storage reference. Legacy inline `data:` references are a compatibility path, not the target architecture.

## Hot versus cold data

The shared D1 is the hot relational index. It should contain data needed for ordinary interactive queries: live canonical Paper metadata, current decisions, current recommendation state, Feed membership, and Reader state.

Rejected Paper metadata is not retained indefinitely merely to remember that it existed. Once the retention policy allows GC, the canonical Paper row is physically deleted while bounded learning features and minimal seen identifiers may remain.

Append-only history can grow much faster than canonical Paper metadata. Provider history, old recommendation generations, and feedback evidence are candidates for later loss-aware compaction/export to R2 rather than indefinite raw retention in the hot D1 database. Feedback must not simply be discarded when it still carries recommendation signal.

That archival policy is intentionally a separate migration. Sharing the physical database does not by itself solve D1 capacity limits.

## Migration rules

1. Each repository may modify only the tables it owns unless a cross-repository migration is explicitly planned.
2. Paper Collector migrations must continue using `paper_collector_migrations`.
3. Reader migrations keep their existing migration history.
4. Cross-application foreign keys should be added conservatively. `paper_retention_refs` is the explicit shared deletion guard; broader cross-repository schema coupling remains avoided.
5. A consumer must establish its retention reference before relying on a Paper surviving Collector GC.

## Related work

- Paper Collector architecture issue: #58
- Paper hard-delete lifecycle: #62
- Cold-history/compaction policy: #59
- Reader integration issue: `Nasu726/book-reader#7`
