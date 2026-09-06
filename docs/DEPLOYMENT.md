# Cloudflare deployment, D1, and provider setup

Authentication remains a deployment-layer concern rather than an application account system. Scholarly provider credentials also remain Worker-side and must never be exposed to React.

## 1. Local development

Install dependencies, apply schema migrations, and seed deterministic development data:

```bash
npm install
npm run db:setup:local
npm run dev
```

`db:setup:local` performs two distinct operations:

1. applies versioned schema migrations from `migrations/`
2. loads synthetic development records from `seed/development.sql`

The seed is deliberately **not** a migration, so remote production databases are never polluted with demo papers by normal migration deployment.

The Cloudflare Vite plugin runs the frontend and Worker together. Requests under `/api/*` execute in the Workers runtime and have access to the local `DB` binding.

Useful checks:

```bash
npm run build
npm run test:openalex
npm run db:smoke:local
npm run api:smoke:local
npm run api:smoke:ingestion
```

A healthy local bootstrap returns feeds, papers, ingestion state, and decisions from D1.

## 2. Create the production D1 database

Authenticate Wrangler, then create the database once:

```bash
npx wrangler login
npx wrangler d1 create paper-collector
```

Wrangler prints a real `database_id`. Replace the all-zero placeholder in `wrangler.jsonc` with that ID before deployment.

The D1 database ID is configuration metadata rather than a password. Secrets introduced for provider access belong in Wrangler/Cloudflare secret storage.

## 3. Apply migrations

Local schema:

```bash
npm run db:migrate:local
```

Remote production schema:

```bash
npm run db:migrate:remote
```

D1 records applied migrations in its migration tracking table, so migrations should be additive and committed to `migrations/`.

Migration `0003_scheduled_ingestion.sql` creates the per-Feed successful watermark and refresh-status state used by both manual and scheduled ingestion.

Do **not** run the development seed against production.

## 4. OpenAlex configuration

Paper Collector can call OpenAlex without a key for casual development, but a free API key is recommended for real use.

Store it as a Worker-side secret/configuration value named:

```text
OPENALEX_API_KEY
```

For example, using Wrangler secret storage:

```bash
npx wrangler secret put OPENALEX_API_KEY
```

The key is read only by the Worker when it constructs the OpenAlex provider. It must never be placed in Vite client environment variables or committed to the repository.

Development CI deliberately uses recorded OpenAlex fixtures and a local provider server instead of a live key or live provider call.

## 5. Scheduled ingestion

`wrangler.jsonc` configures this Cron Trigger:

```text
17 */6 * * *
```

Cloudflare evaluates Cron schedules in UTC, so the Worker runs every six hours at minute 17.

The scheduled handler refreshes every active Feed with a non-empty `provider_query`. A newly configured Feed scans an inclusive fourteen-day window. Later successful runs overlap one day before the previous successful watermark so late provider indexing can be observed safely.

A watermark is advanced only after the complete provider window is fetched and persisted. Provider failures and the 500-record safety cap preserve the previous watermark.

Cron Trigger changes are deployed from `wrangler.jsonc` together with the Worker. After deployment, verify the trigger in the Cloudflare dashboard under the Worker's Triggers/Cron configuration.

For local testing, Cloudflare exposes the Worker's scheduled handler through `/cdn-cgi/local/scheduled`; `npm run api:smoke:ingestion` exercises that path with a fixture provider.

See [`SCHEDULED_INGESTION.md`](SCHEDULED_INGESTION.md) for the complete state-machine semantics.

## 6. Validate and deploy

```bash
npm run build
npm run test:openalex
npm run api:smoke:ingestion
npm run deploy
```

The Cloudflare Vite plugin creates deployment output containing both React assets and Worker configuration. `wrangler deploy` deploys that output, including the configured Cron Trigger.

A newly deployed production database can legitimately have an empty Inbox until at least one Feed exists and ingestion has run.

## 7. Manual ingestion check

After a Feed with `provider_query` exists, the Worker can run its normal incremental refresh through:

```text
POST /api/feeds/<feed-id>/refresh
```

No request body is required. This uses the same successful-watermark logic as scheduled ingestion.

An explicit backfill window can instead be supplied:

```text
POST /api/feeds/<feed-id>/refresh
Content-Type: application/json
```

```json
{
  "fromDate": "2026-08-24",
  "toDate": "2026-09-06"
}
```

Explicit date bounds are diagnostic/backfill input: matching papers are persisted, but the incremental successful watermark is not advanced.

The response reports provider records, accepted papers, provider pages, inserted/updated papers, new Feed memberships, status, and whether the watermark advanced. Newly ingested papers are immediately visible in `/api/bootstrap`.

The Feeds UI exposes the same normal refresh operation through **Refresh now** and shows the last successful watermark or failure/truncation state.

## 8. Cloudflare Access for personal deployment

Before using personal preference data, protect the entire application hostname with one Cloudflare Access self-hosted application.

Recommended personal setup:

1. In Cloudflare Zero Trust, go to **Access controls → Applications**.
2. Create a **Self-hosted and private** application for the Paper Collector hostname.
3. Configure the application at the hostname/root path so the SPA and `/api/*` are covered by the same policy.
4. Enable **One-time PIN** as an authentication method if no external identity provider is desired.
5. Add an **Allow** policy whose Include selector is the exact personal email address that should have access.
6. Do not use broad rules such as `Everyone` or unrestricted `Login Methods: One-time PIN`.
7. Choose a practical session duration so normal phone use does not require frequent re-authentication.

The key invariant is that the visible SPA and same-origin API are protected together. Cron invocations execute inside the Worker runtime and do not depend on a browser Access session.

## 9. Persistence behavior

When `/api/bootstrap` is reachable:

- feeds come from D1
- papers come from D1
- feed membership comes from D1
- ingestion status/watermarks come from D1
- recommendation snapshots come from D1
- decisions come from D1 and are updated through the Worker API
- a localStorage decision mirror is kept only as a resilience aid

If the Worker/API cannot be reached at bootstrap, the development/demo fallback uses bundled synthetic papers plus localStorage decisions. This fallback is not the production source of truth and cannot perform Feed refresh.

## 10. Configuration invariant

`wrangler.jsonc` deliberately contains a placeholder production D1 ID so repository builds do not depend on a specific account. Deployment is not complete until the database is created and that placeholder is replaced in the deployed configuration.
