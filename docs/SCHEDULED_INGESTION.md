# Scheduled ingestion

Paper Collector refreshes active configured feeds every six hours through a Cloudflare Cron Trigger.

## Schedule

`wrangler.jsonc` configures:

```text
17 */6 * * *
```

Cloudflare Cron Triggers run in UTC. The non-zero minute avoids concentrating requests exactly on the hour.

## Initial and incremental windows

Each Feed stores a successful `watermark_date`.

For the **first automatic collection** of a Feed, Paper Collector first asks OpenAlex for the number of matching works from January 1 of the current UTC year through the current UTC date. This count probe does not collect a second full result set.

- If the current-year match count is **500 or fewer**, collect that current-year range with a 500-record maximum.
- If the current-year match count is **more than 500**, collect only the **latest 100** matching current-year works. OpenAlex is queried in descending publication-date order.
- If the count probe itself fails, fall back to the same latest-100 policy rather than risking an unexpectedly broad first import.

The latest-100 boundary is intentional, so reaching another OpenAlex cursor after those 100 rows is considered a successful initial collection rather than a truncated incremental refresh. A successful first automatic collection advances the Feed watermark to the current date.

For an **existing Feed**, begin one day before the previous successful watermark and scan through the current UTC date, with the normal 500-record safety cap. The one-day overlap is intentional: provider indexing and metadata updates can arrive late, while D1 upserts make repeated records safe.

A normal manual refresh uses the same first/incremental rule as the scheduler.

If an API caller explicitly supplies `fromDate` or `toDate`, that request is treated as a backfill/diagnostic range. Papers are persisted, but the incremental watermark is not advanced.

## Pagination and safety cap

OpenAlex is read with cursor pagination:

1. start with `cursor=*`
2. request up to 100 records per page
3. follow `meta.next_cursor`
4. stop when there is no next cursor or the selected result boundary is reached

Normal incremental/backfill collection has a 500-provider-record safety cap. If another cursor remains at that cap:

- the records already received are normalized and persisted
- Feed status becomes `truncated`
- the successful watermark does not advance
- the next automatic refresh re-scans the incomplete range

The cap therefore limits unexpectedly broad queries without silently turning a partial incremental scan into a successful checkpoint. The intentional latest-100 first-collection policy described above is the one exception: its smaller boundary is the requested first-run scope, not an error condition.

## Failure semantics

The successful watermark advances only after all pages required by the selected collection policy have been fetched and the normalized papers have been persisted successfully.

Provider, normalization, or persistence failures record `status=error` and a diagnostic message while preserving the previous successful watermark.

Scheduled collection processes every eligible Feed. If any Feed fails or an ordinary incremental refresh truncates, the scheduled invocation fails after the other Feeds have had a chance to run. This makes the Cloudflare Cron event visible as incomplete while preserving per-Feed state.

## Manual refresh UX

The Feeds tab exposes **Refresh now** when the application is using the cloud Worker API. After a refresh, the UI reloads bootstrap data and shows:

- last status
- last attempt/success time
- successful watermark
- provider record/page counts
- any truncation or error message
