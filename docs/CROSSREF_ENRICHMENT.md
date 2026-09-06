# Crossref enrichment and field provenance

OpenAlex is the collection provider. Crossref is an enrichment provider for Papers that already have a normalized DOI.

Crossref never creates a new Paper row. This avoids introducing a second paper-creation path for DOI-identical works.

## Why keep evidence separately?

Different scholarly providers can disagree about title spelling, venue names, publication dates, and publication state. Paper Collector therefore separates:

1. **field evidence** — every normalized value observed from a provider
2. **canonical field source** — the evidence currently selected by deterministic policy
3. **canonical Paper value** — the value rendered by the application

Provider disagreement is preserved rather than discarded.

The API:

```text
GET /api/papers/:paperId/evidence
```

returns the normalized evidence and identifies the currently selected source for each field.

## Current policy (`field-policy-v1`)

### Identity

- normalized DOI is a strong identity key
- Crossref enrichment is only attempted for an existing Paper with a DOI identifier
- Crossref does not create or merge Paper rows

### Title and authors

Crossref values are stored as evidence but do not automatically replace the OpenAlex canonical title or author list.

### Venue

Crossref `container-title` is stored as evidence. It only fills the canonical venue when that field is empty.

### Publication date

Crossref publisher-deposited publication dates can replace the current canonical publication date because they are direct publisher metadata.

However, Paper Collector does not reduce date precision. A Crossref year-only value cannot replace an existing full `YYYY-MM-DD` OpenAlex date. Equal or higher date precision is required.

Crossref publication-date source preference is:

1. `published-online`
2. `published-print`
3. `published`
4. `issued`

Date precision is preserved. Missing month/day components are not invented.

### Accepted date

When Crossref exposes an `accepted` date, it is stored in `papers.accepted_at`, preserved as evidence, and selected as the canonical accepted-date source.

### Publication status

Publication state is monotonic by confidence/order:

```text
unknown < preprint < accepted < published
```

Crossref may upgrade status but cannot downgrade a Paper from `published` to `accepted`, for example.

### Source URL and PDF

Crossref URLs are stored as evidence but do not replace OpenAlex source/PDF choices. In particular, an OpenAlex open-access PDF should not be lost merely because Crossref also provides a DOI landing page.

## Refresh protection

Once Crossref is selected as the canonical source for publication date, venue, or publication status, later OpenAlex refreshes do not overwrite that selected value. OpenAlex evidence is still updated, so disagreement remains inspectable.

## Caching and API etiquette

Successful and not-found Crossref lookups are cached for 30 days. Errors become retryable after six hours.

Requests are sequential and conservatively spaced by default. `CROSSREF_MAILTO` can be configured so calls use Crossref's polite pool. The interval can be overridden for tests with `CROSSREF_MIN_INTERVAL_MS`; production should normally keep the default.

Configuration:

```text
CROSSREF_MAILTO
CROSSREF_BASE_URL          # test/development override
CROSSREF_MIN_INTERVAL_MS   # primarily for deterministic tests
```

A bounded enrichment batch runs after scheduled OpenAlex ingestion. It can also be invoked manually:

```text
POST /api/enrichment/crossref?limit=8
```

The endpoint accepts a limit from 1 to 20.

## Tables

### `paper_field_evidence`

All normalized provider evidence by Paper, field, provider record, and provider source field.

### `paper_field_sources`

One selected source per canonical field, including the policy version that selected it.

### `crossref_enrichment_state`

Crossref cache/retry state per Paper/DOI.

This split is intentional: provenance should remain inspectable even if canonical selection policy changes later.
