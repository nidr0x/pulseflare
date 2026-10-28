# Architecture

By default, one Cloudflare Worker serves Pulseflare's public status page assets and `/api/*` routes.

## Repository layout

```text
apps/
  worker/
  web/
config/
  pulse.config.ts
packages/
  schema/
```

## Current pieces

- a Worker entry point with live `/api/public/snapshot`, `/api/public/summary`, `/api/public/services`, `/api/public/incidents`, `/api/public/maintenance`, and `/api/health` routes
- a protected `/api/install/bootstrap` route that creates the base D1 schema and seeds services from checked-in config
- a React status site built into Worker static assets
- config validation through `@pulseflare/schema`
- D1 migrations for services, current status, failed check details, daily regional rollups, incidents, notification outbox records, scheduler runs, and materialized snapshot state
- bounded scheduled check concurrency, stale-state detection, incident thresholds, and retention cleanup
- public summary and payload construction in `apps/worker/src/routes/public.ts`

Status transitions queue notification jobs for the Worker to retry from the D1 outbox.

### `apps/worker`

The Worker:

- serves `/api/public/summary`
- serves a protected install bootstrap route at `/api/install/bootstrap`
- reads config from the checked-in product config, with env override support if needed
- serves the built public status app through Worker static assets
- contains the check, incident, notification, persistence, and public API paths
- builds public summary, services, incidents, and maintenance payloads in [`apps/worker/src/routes/public.ts`](../apps/worker/src/routes/public.ts)

It owns:

- public status APIs
- config ingestion
- check orchestration entry points
- incident and notification domain logic
- D1 persistence

Public traffic enters through [`apps/worker/src/index.ts`](../apps/worker/src/index.ts). Public status routes live in [`apps/worker/src/routes/public.ts`](../apps/worker/src/routes/public.ts); install bootstrap lives in [`apps/worker/src/routes/bootstrap.ts`](../apps/worker/src/routes/bootstrap.ts).

### `apps/web`

The web app:

- overview and incidents routes
- status page UI
- API client logic that reads the canonical public snapshot and renders an explicit unknown state when live data is unavailable

It:

- produces the static frontend bundle that is served by the Worker without requiring a separate Pages project

The app shell starts in [`apps/web/src/App.tsx`](../apps/web/src/App.tsx), while data-fetching helpers live in [`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts).

### `packages/schema`

`@pulseflare/schema` defines config types and validates site metadata, services, checks, notification providers, and maintenance windows. It exports `defineStatusConfig` and `parseStatusConfig`; the Worker owns runtime summary and public payload construction.

## Config flow

1. Product metadata and services are declared in [`config/pulse.config.ts`](../config/pulse.config.ts).
2. `@pulseflare/schema` validates the shape and rejects invalid service definitions.
3. The Worker reads the config during bootstrap and scheduled runs, then synchronizes active services into D1.
4. The frontend bundle is deployed alongside the Worker and reads the canonical public snapshot.

## Request flow

### Public status

1. A browser requests `/api/public/snapshot` or `/api/public/services`.
2. On an edge-cache miss, both routes use the same materialized-services resolver. It reads the singleton `snapshot_state` row and uses it only while `updated_at` is no more than ten minutes old and the payload covers every service in the current config.
3. The resolver filters and orders services from the current config, overlays current names and groups, and rechecks status freshness against `staleAfterMinutes`. Removed services disappear immediately; a new service or an unusable, stale, or incomplete row triggers live computation from current status and daily rollups.
4. `/api/public/snapshot` adds the current summary, incidents, and config-backed maintenance to the services payload; `/api/public/services` returns the services slice. The Worker uses short-lived cache headers and the edge cache for both routes.
5. React routes render the overview or incidents view with the snapshot and refresh at most every five minutes, or immediately when the tab becomes visible.

`snapshot_state` stores the services payload and its materialization time as a single row. Near the end of each scheduled run, the scheduler builds it with the same Worker payload function; materialization errors are logged and do not fail the run. A missing or stale row leaves the public routes on their live-computation path.

`/api/health` reports the latest completed scheduler run, selected from succeeded or failed runs and excluding any still-running run. It returns healthy only for a recent successful run within `staleAfterMinutes`; otherwise it returns degraded (503), with `no-store` caching.

### First-time install bootstrap

1. An operator sends `POST /api/install/bootstrap` with an `Authorization: Bearer <token>` header.
2. The Worker validates the bootstrap token.
3. The Worker creates the base D1 tables if they do not already exist.
4. The Worker synchronizes active services from `config/pulse.config.ts` and archives removed services.
5. The route returns a small JSON summary describing the synchronization result.

### Monitoring lifecycle

The runtime path is:

1. Services declare one or more checks in config.
2. Scheduled Worker runs evaluate HTTP and TCP checks and normalize results.
3. D1 stores the latest service status, failed check details, daily per-location counts and latency, open or resolved incidents, notification jobs, scheduler runs, and the materialized services payload.
4. The configured regional failure policy and consecutive failure/recovery thresholds determine incident transitions.
5. When an incident opens after its threshold and grace period, the incident and its configured notification outbox jobs are written in one D1 batch, so they commit or roll back together. Webhook jobs retry with backoff.
6. Public APIs read from persisted state instead of exposing storage internals directly.
7. After pruning, each run stores the services payload used by the public routes in the single-row `snapshot_state` table. Both snapshot and services requests share its freshness and current-config resolution; materialization failures are logged and do not fail the run. Schedules that run less often than every ten minutes gain nothing from the row because it expires between runs.

## Persistence model

The D1 schema starts with [`apps/worker/migrations/0001_initial.sql`](../apps/worker/migrations/0001_initial.sql), which defines:

- `services`
- `service_status`
- `incidents`
- `latency_points`

Later migrations add:

- `check_results`
- `daily_check_rollups`
- `notification_outbox`
- `scheduler_runs`
- `scheduler_lease`
- `snapshot_state`

Public summaries and incident history remain queryable without a single serialized state blob. Daily rollups power aggregate history; the aggregate service history ships the full retention window, while per-location records ship only their latest bucket because the UI renders one state per location. Raw failure details and completed notification jobs are pruned according to configured retention, with cleanup scheduled at most once per day. Public latency is the median across reporting probe locations.

Daily regional rollups use UTC calendar dates: the scheduler stores the date prefix of its ISO check timestamp, and public history windows are also generated with UTC date boundaries.

## Project constraints

- Worker logic owns status data.
- The web app stays presentation-focused.
- Shared packages carry contracts, not deployment logic.
- Config stays schema-validated.
- Public API shapes should stay stable while storage changes.
