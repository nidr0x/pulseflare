# Architecture

Pulseflare deploys as one Cloudflare Worker by default. The Worker serves the public status page assets and the `/api/*` routes.

## Repository layout

```text
apps/
  worker/
  web/
config/
  pulse.config.ts
packages/
  core/
  schema/
```

## What works today

- Worker entry point with live `/api/public/snapshot`, `/api/public/summary`, `/api/public/services`, `/api/public/incidents`, and `/api/public/maintenance` routes
- a protected `/api/install/bootstrap` route that creates the base D1 schema and seeds services from checked-in config
- a React status site built into Worker static assets
- schema validation for the config file
- D1 migrations for services, current status, check results, incidents, latency, and notification outbox records
- bounded scheduled check concurrency, stale-state detection, incident thresholds, and retention cleanup
- shared summary logic in `@pulseflare/core`

Notification delivery is driven by stored status transitions and retried from the D1 outbox.

### `apps/worker`

Current behavior:

- serves `/api/public/summary`
- serves a protected install bootstrap route at `/api/install/bootstrap`
- reads config from the checked-in product config, with env override support if needed
- serves the built public status app through Worker static assets
- contains the check, incident, notification, persistence, and public API paths

This app should own:

- public status APIs
- config ingestion
- check orchestration entry points
- incident and notification domain logic
- D1 persistence

Public traffic enters through [`apps/worker/src/index.ts`](../apps/worker/src/index.ts). Public status routes live in [`apps/worker/src/routes/public.ts`](../apps/worker/src/routes/public.ts); install bootstrap lives in [`apps/worker/src/routes/bootstrap.ts`](../apps/worker/src/routes/bootstrap.ts).

### `apps/web`

Current behavior:

- overview and incidents routes
- status page UI
- API client logic that reads the canonical public snapshot and renders an explicit unknown state when live data is unavailable

This app should:

- produce the static frontend bundle that is served by the Worker without requiring a separate Pages project

The app shell starts in [`apps/web/src/App.tsx`](../apps/web/src/App.tsx), while data-fetching helpers live in [`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts).

### `packages/schema`

`@pulseflare/schema` defines config types and validation. It exports `defineStatusConfig` and `parseStatusConfig` for site metadata, services, checks, notification providers, and maintenance windows.

### `packages/core`

`@pulseflare/core` holds domain helpers that should not depend on Cloudflare runtime APIs. The current example is summary aggregation in [`packages/core/src/status-summary.ts`](../packages/core/src/status-summary.ts).

## Config flow

### Today

1. Product/site metadata and services are declared in [`config/pulse.config.ts`](../config/pulse.config.ts).
2. `@pulseflare/schema` can validate that shape and guard against invalid service definitions.
3. The Worker reads that config during bootstrap and scheduled runs and synchronizes active services into D1.
4. The frontend bundle is deployed alongside the Worker and reads the canonical public snapshot.

## Request flow

### Public status

1. A browser requests `/api/public/snapshot`.
2. The Worker reads current status, persisted check history, incidents, and config-backed maintenance.
3. The Worker returns one canonical public snapshot with short-lived cache headers.
4. React routes render the overview or incidents view with that snapshot.

### First-time install bootstrap

1. An operator sends `POST /api/install/bootstrap` with an `Authorization: Bearer <token>` header.
2. The Worker validates the bootstrap token.
3. The Worker creates the base D1 tables if they do not already exist.
4. The Worker synchronizes active services from `config/pulse.config.ts` and archives removed services.
5. The route returns a small JSON summary describing the synchronization result.

### Monitoring lifecycle

This is the intended runtime path:

1. Services declare one or more checks in config.
2. Scheduled Worker runs evaluate HTTP and TCP checks and normalize results.
3. D1 stores the latest service status, every check result, open or resolved incidents, latency points, and notification jobs.
4. Consecutive failure and recovery thresholds determine incident transitions.
5. Webhook jobs respect the notification grace period and retry with backoff.
6. Public APIs read from persisted state instead of exposing storage internals directly.

## Persistence model

The initial D1 schema in [`apps/worker/migrations/0001_initial.sql`](../apps/worker/migrations/0001_initial.sql) defines explicit tables for:

- `services`
- `service_status`
- `incidents`
- `latency_points`
- `check_results`
- `notification_outbox`
- `scheduler_runs`
- `scheduler_lease`

This keeps public summaries and incident history queryable without relying on one serialized state blob.

## Project constraints

- Worker logic owns status data
- the web app stays presentation-focused
- shared packages carry contracts, not deployment logic
- config stays schema-validated
- public API shapes should stay stable while storage changes
