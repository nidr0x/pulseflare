# Pulseflare Architecture

Pulseflare now defaults to a single Cloudflare Worker deployment. That Worker serves both the public status page assets and the `/api/*` monitoring/status routes.

## Repository Layout

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

## Current Implemented Behavior

The following pieces are implemented in the repo today:

- a Worker entry point with a live `/api/public/summary` route
- a protected `/api/install/bootstrap` route that creates the base D1 schema and seeds services from checked-in config
- a React status site built into Worker static assets
- a schema package that validates the Pulseflare config shape
- a D1 migration that defines service, status, incident, and latency tables
- shared summary logic in `@pulseflare/core`

What is not wired end-to-end yet:

- scheduled check execution from declared services
- persistence-backed public service, incident, and maintenance APIs
- notification delivery driven by stored status transitions

### `apps/worker`

Current behavior:

- serves `/api/public/summary`
- serves a protected install bootstrap route at `/api/install/bootstrap`
- reads config from the checked-in product config, with env override support if needed
- serves the built public status app through Worker static assets
- contains domain and repository modules that are not fully connected to the live request path yet

Target responsibility:

- public status APIs
- config ingestion
- check orchestration entry points
- incident and notification domain logic
- D1 persistence

Current public traffic enters the Worker through [`apps/worker/src/index.ts`](../apps/worker/src/index.ts), which routes `/api/public/summary` to [`apps/worker/src/routes/public.ts`](../apps/worker/src/routes/public.ts) and `/api/install/bootstrap` to [`apps/worker/src/routes/bootstrap.ts`](../apps/worker/src/routes/bootstrap.ts).

### `apps/web`

Current behavior:

- overview and incidents routes
- simplified uptime-style status UI
- API client logic that merges the live summary response into a mock snapshot

Target responsibility:

- produce the static frontend bundle that is served by the Worker without requiring a separate Pages project

The app shell starts in [`apps/web/src/App.tsx`](../apps/web/src/App.tsx), while data-fetching helpers live in [`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts).

### `packages/schema`

`@pulseflare/schema` defines the configuration contract. It exports the product types plus `defineStatusConfig` and `parseStatusConfig`, which validate site metadata, services, checks, notification providers, and maintenance windows. That schema surface exists today even though the Worker does not yet consume the checked config end-to-end.

### `packages/core`

`@pulseflare/core` holds reusable domain helpers that should stay independent of Cloudflare runtime details. The current example is summary aggregation in [`packages/core/src/status-summary.ts`](../packages/core/src/status-summary.ts).

## Configuration Flow

### Current

1. Product/site metadata and services are declared in [`config/pulse.config.ts`](../config/pulse.config.ts).
2. `@pulseflare/schema` can validate that shape and guard against invalid service definitions.
3. The Worker reads that config during bootstrap and uses it to seed the `services` table.
4. The frontend bundle is deployed alongside the Worker and overlays the live summary response when available.

### Target

1. The Worker loads validated product config for install and runtime behavior.
2. Declared services drive scheduled checks and incident transitions.
3. D1-backed records shape the public service, incident, and maintenance responses.
4. The public page renders Worker-owned status data instead of depending on bundled mock content.

## Request Flow

### Public status summary

1. A browser requests `/api/public/summary`.
2. The Worker route returns a summary payload with aggregate status counts and `checkedAt`.
3. The web client fetches that payload and merges it into the in-memory status snapshot.
4. React routes render the overview or incidents view with the latest summary state.

### First-time install bootstrap

1. An operator opens `/api/install/bootstrap?token=...`.
2. The Worker validates the bootstrap token.
3. The Worker creates the base D1 tables if they do not already exist.
4. The Worker seeds `services` from `config/pulse.config.ts` if the install is still empty.
5. The route returns a small JSON summary describing whether the install was newly created or already initialized.

### Monitoring lifecycle

This is the target runtime path, not the current live wiring:

1. Services declare one or more checks in config.
2. Worker domain modules evaluate checks and normalize results.
3. D1 stores the latest service status, open or resolved incidents, and latency points.
4. Notification logic decides whether to emit provider calls for state changes.
5. Public APIs read from persisted state instead of exposing storage internals directly.

## Persistence Model

The initial D1 schema in [`apps/worker/migrations/0001_initial.sql`](../apps/worker/migrations/0001_initial.sql) defines explicit tables for:

- `services`
- `service_status`
- `incidents`
- `latency_points`

This keeps public summaries and incident history queryable without relying on one serialized state blob. The schema is present now; full read and write paths against those tables are still being connected.

## Design Intent

The reboot favors a few constraints:

- Worker logic owns status truth
- the web app stays presentation-focused
- shared packages carry contracts, not deployment logic
- config is product-oriented and schema-validated
- the public API shape should remain stable even as persistence evolves
