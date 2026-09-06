# Scheduled ingestion

Paper Collector refreshes active configured feeds every six hours through a Cloudflare Cron Trigger.

## Schedule

`wrangler.jsonc` configures:

```text
17 */6 * * *
```

Cloudflare Cron Triggers run in UTC. The non-zero minute avoids concentrating requests exactly on the hour.

## Incremental window

Each Feed stores a successful `watermark_date`.

- New Feed: scan the latest 14 calendar days, inclusive.
- Existing Feed: begin one day before the previous successful watermark and scan through the current UTC date.
- The overlap is intentional. Provider indexing and metadata updates can arrive late; D1 upserts make repeated records safe.

A normal manual refresh uses the same incremental rule as the scheduler.

If an API caller explicitly supplies `fromDate` or `toDate`, that request is treated as a backfill/diagnostic range. Papers are persisted, but the incremental watermark is not advanced.

## Pagination and safety cap

OpenAlex is read with cursor pagination:

1. start with `cursor=*`
2. request up to 100 records per page
3. follow `meta.next_cursor`
4. stop when there is no next cursor

A single Feed refresh has a 500-provider-record safety cap. If another cursor remains at the cap:

- the records already received are normalized and persisted
- Feed status becomes `truncated`
- the successful watermark does not advance
- the next refresh re-scans the incomplete range

The cap therefore limits unexpected broad queries without silently turning a partial scan into a successful checkpoint.

## Failure semantics

The successful watermark advances only after all requested provider pages have been fetched and the normalized papers have been persisted successfully.

Provider, normalization, or persistence failures record `status=error` and a diagnostic message while preserving the previous successful watermark.

Scheduled collection processes every eligible Feed. If any Feed fails or truncates, the scheduled invocation fails after the other Feeds have had a chance to run. This makes the Cloudflare Cron event visible as incomplete while preserving per-Feed state.

## Manual refresh UX

The Feeds tab exposes **Refresh now** when the application is using the cloud Worker API. After a refresh, the UI reloads bootstrap data and shows:

- last status
- last attempt/success time
- successful watermark
- provider record/page counts
- any truncation or error message
