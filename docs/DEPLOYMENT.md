# Cloudflare deployment and D1 setup

This document covers the Milestone 2 backend foundation. Authentication with Cloudflare Access is intentionally kept as a deployment-layer concern rather than an application account system.

## 1. Local development

Install dependencies and apply migrations to the local D1 database:

```bash
npm install
npm run db:migrate:local
npm run dev
```

The Cloudflare Vite plugin runs the frontend and Worker together. Requests under `/api/*` execute in the Workers runtime and have access to the local `DB` binding.

Useful health check after starting the app:

```text
GET /api/health
```

A healthy local database returns `{"ok":true}`.

## 2. Create the production D1 database

Authenticate Wrangler, then create the database once:

```bash
npx wrangler login
npx wrangler d1 create paper-collector
```

Wrangler prints a real `database_id`. Replace the all-zero placeholder in `wrangler.jsonc` with that ID before deployment.

Do not commit credentials. The D1 database ID is configuration metadata rather than a password, but environment secrets introduced later should use Wrangler/Cloudflare secret storage.

## 3. Apply migrations

Local:

```bash
npm run db:migrate:local
```

Remote production database:

```bash
npm run db:migrate:remote
```

D1 records applied migrations in its migration tracking table, so migrations should be additive and committed to `migrations/`.

## 4. Validate and deploy

```bash
npm run typecheck
npm run build
npm run deploy
```

The Cloudflare Vite plugin creates deployment output containing both the React assets and Worker configuration. `wrangler deploy` deploys that output.

## 5. Cloudflare Access (personal deployment)

Before using real personal preference data, put the deployed application behind Cloudflare Access and restrict it to the intended account/email identity.

The SPA and `/api/*` should be protected by the same Access application/policy. Do not expose the API publicly while protecting only the visible frontend.

Detailed Access policy configuration is finalized in Milestone 2b because the final hostname/domain is deployment-specific.

## 6. Transitional persistence behavior

During Milestone 2a:

- demo papers and feeds are bundled in the frontend
- explicit decisions are stored in D1 when the API is reachable
- a localStorage mirror is maintained on the current browser
- if the Worker/API is unavailable, the application switches to local fallback

Milestone 2b moves papers and feeds into D1 as well, making the Worker/D1 dataset the complete source of truth for cross-device use.

## 7. Configuration invariant

`wrangler.jsonc` deliberately contains a placeholder production D1 ID so repository builds do not depend on a specific account. Deployment is not complete until the database is created and that placeholder is replaced in the deployed configuration.
