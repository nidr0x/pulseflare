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

- Worker entry point with live `/api/public/summary`, `/api/public/services`, `/api/public/incidents`, and `/api/public/maintenance` routes
- a protected `/api/install/bootstrap` route that creates the base D1 schema and seeds services from checked-in config
- a React status site built into Worker static assets
- schema validation for the config file
- D1 migration for services, status, incidents, and latency
- shared summary logic in `@pulseflare/core`

Not wired end-to-end yet:

- notification delivery driven by stored status transitions

### `apps/worker`

Current behavior:

- serves `/api/public/summary`
- serves a protected install bootstrap route at `/api/install/bootstrap`
- reads config from the checked-in product config, with env override support if needed
- serves the built public status app through Worker static assets
- contains domain and repository modules that are not fully connected to the live request path yet

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
- API client logic that overlays public API responses onto fallback demo data

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
3. The Worker reads that config during bootstrap and uses it to seed the `services` table.
4. The frontend bundle is deployed alongside the Worker and overlays public API responses when available.

### Later

1. The Worker loads validated product config for install and runtime behavior.
2. Declared services drive scheduled checks and incident transitions.
3. D1-backed records shape public service and incident responses, while config-backed maintenance is normalized into a public response.
4. The public page renders Worker-owned status data instead of depending on bundled mock content.

## Request flow

### Public status

1. A browser requests public API routes under `/api/public/*`.
2. The Worker returns summary, service, incident, or maintenance payloads from Worker-owned public state.
3. The web client merges those payloads into the in-memory status snapshot.
4. React routes render the overview or incidents view with the latest summary state.

### First-time install bootstrap

1. An operator opens `/api/install/bootstrap?token=...`.
2. The Worker validates the bootstrap token.
3. The Worker creates the base D1 tables if they do not already exist.
4. The Worker seeds `services` from `config/pulse.config.ts` if the install is still empty.
5. The route returns a small JSON summary describing whether the install was newly created or already initialized.

### Monitoring lifecycle

This is the intended runtime path:

1. Services declare one or more checks in config.
2. Scheduled Worker runs evaluate HTTP and TCP checks and normalize results.
3. D1 stores the latest service status, open or resolved incidents, and latency points.
4. Notification logic will decide whether to emit provider calls for state changes.
5. Public APIs read from persisted state instead of exposing storage internals directly.

## Persistence model

The initial D1 schema in [`apps/worker/migrations/0001_initial.sql`](../apps/worker/migrations/0001_initial.sql) defines explicit tables for:

- `services`
- `service_status`
- `incidents`
- `latency_points`

This keeps public summaries and incident history queryable without relying on one serialized state blob.

## Project constraints

- Worker logic owns status data
- the web app stays presentation-focused
- shared packages carry contracts, not deployment logic
- config stays schema-validated
- public API shapes should stay stable while storage changes
