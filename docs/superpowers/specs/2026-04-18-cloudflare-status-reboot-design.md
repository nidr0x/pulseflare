# Cloudflare Status Reboot Design

## Goal

Rebuild this project as a new open-source product with the same core goal: Cloudflare-native uptime monitoring plus a public status page. The reboot must not preserve the current project's structure, naming, or UI patterns. It should keep the broad feature scope while introducing a new architecture, a new config model, a lighter frontend stack, and a cleaner developer experience.

## Product Direction

The reboot is a general-purpose OSS product, not a personal deployment template. It should be designed for reuse by teams that want:

- scheduled uptime checks on Cloudflare
- a polished public status page
- incidents and maintenance visibility
- notifications and extensibility
- infrastructure-as-code style management

Version 1 remains code-configured. There is no browser admin UI in scope for the initial reboot. The architecture should leave room for a future admin experience, but the first release should optimize for clarity, portability, and low operational complexity.

## Principles

- Clean break from the deprecated project
- Preserve the overall feature scope, not the implementation shape
- Keep Cloudflare Workers as the backend runtime
- Use a lighter frontend than the current Next.js setup
- Prefer explicit, typed, validated configuration over loosely coupled TS objects
- Separate storage shape from public API shape
- Keep the public experience fast, modern, and mobile-first

## Recommended Architecture

The product will be split into two deployable apps plus shared packages:

- `apps/worker`: Cloudflare Worker responsible for scheduled checks, persistence, incidents, notifications, maintenance evaluation, and public read APIs
- `apps/web`: `Vite + React` public status site consuming the worker's read APIs
- `packages/schema`: shared config schema, parsing, validation, and exported types
- `packages/core`: shared domain logic for uptime summaries, incident shaping, status aggregation, and chart data preparation

This split creates a strong architectural break from the old project. The backend owns monitoring and domain behavior; the frontend becomes a focused presentation layer.

## Repository Shape

The repository should be reorganized into a monorepo-style layout:

```text
apps/
  worker/
  web/
packages/
  core/
  schema/
docs/
  superpowers/
    specs/
    plans/
```

Legacy top-level `pages`, `components`, `worker`, and root config files should be retired as part of the implementation. The new codebase should read as a different product with different boundaries.

## Backend Design

### Responsibilities

The worker app owns:

- executing scheduled checks
- evaluating status transitions
- writing uptime history and incidents to D1
- applying notification rules
- exposing public read endpoints for the web app
- exposing a small internal config-debug surface if needed for validation

### Check Engine

Version 1 should preserve support for:

- HTTP and HTTPS checks
- TCP connectivity checks
- expected status-code assertions
- required response keyword checks
- forbidden response keyword checks
- request method, headers, and body support where applicable
- timeout control
- geo/proxy-based checks
- callback hooks and outgoing webhooks

The check engine should be refactored into smaller units:

- protocol runners
- result normalization
- incident transition logic
- notification dispatch
- persistence

This is intentionally different from the current worker file, which mixes orchestration, transition logic, retention, and notifications in one flow.

### Persistence

D1 remains the primary datastore. The storage model should no longer optimize around one large serialized state blob. Instead, data should be stored in domain tables with explicit records.

Target storage areas:

- service definitions snapshot or resolved config metadata
- latest service status
- check results or time-bucketed latency points
- incidents
- maintenance windows
- notification delivery logs or minimal audit records

Retention rules should be configurable but ship with sensible defaults. Public APIs should read from queryable records instead of compacted custom serialization.

### Incident Model

An incident should be a first-class entity with:

- service id
- opened at
- resolved at
- current state
- latest reason
- optional reason change history

This keeps the public timeline and notifications simpler to reason about than the current dummy-incident pattern.

## Configuration Design

The new product must not reuse `uptime.config.ts`. A new config surface should be introduced with a new name and a clearer structure.

Recommended config shape:

```ts
export default defineStatusConfig({
  site: {
    name: 'Acme Status',
    description: 'System health and incident reporting',
    url: 'https://status.acme.dev',
    brand: {
      logo: '/brand/logo.svg',
      icon: '/brand/icon.png',
    },
    navigation: [
      { label: 'Docs', href: 'https://acme.dev/docs' },
      { label: 'Support', href: 'https://acme.dev/support' },
    ],
  },
  services: [
    {
      id: 'api',
      name: 'Public API',
      group: 'Core Platform',
      checks: [
        {
          type: 'http',
          url: 'https://api.acme.dev/health',
          method: 'GET',
          expect: {
            status: [200],
            bodyIncludes: ['ok'],
          },
        },
      ],
    },
  ],
  notifications: {
    providers: [],
    gracePeriodMinutes: 5,
  },
  maintenances: [],
})
```

Key differences from the old config:

- config is organized around product concepts, not page-vs-worker split
- checks belong to services
- validation is schema-driven
- public branding and monitoring rules live in separate sections
- naming is new and product-oriented

The parser should validate eagerly and produce actionable errors during local development and deployment.

## Public API Design

The worker should expose stable read endpoints designed for the frontend, for example:

- `GET /api/public/summary`
- `GET /api/public/services`
- `GET /api/public/services/:id`
- `GET /api/public/incidents`
- `GET /api/public/maintenances`

API responses should be frontend-friendly and avoid leaking storage internals. The web app should not need to reconstruct incidents or aggregate raw latency arrays itself.

## Frontend Design

### Stack

The public status site should be rebuilt with `Vite + React`. This gives a lighter frontend, faster local iteration, and a cleaner separation from the backend than the current Next.js-based setup.

### UX Direction

The new UI should feel like a modern product status site rather than a utilitarian dashboard clone.

It should emphasize:

- stronger typography
- deliberate spacing and visual hierarchy
- clearer service grouping
- a more readable incident timeline
- better empty/loading states
- excellent mobile layout

The visual language should avoid resembling the current Mantine-based interface. The design system should use a new token set for color, type, spacing, surfaces, and chart styling.

### Pages

Version 1 should include:

- overview page
- service detail or expanded service section
- incidents history page
- maintenance visibility on overview and history surfaces

The overview page should prioritize:

- overall system state
- grouped services
- current incidents and upcoming maintenance
- recent performance context

## Authentication and Access

There is no admin UI in v1. Optional access protection for the public site or API may be preserved if it can be implemented simply, but it should not distort the product architecture. If included, it should be a narrow feature such as basic shared-secret protection for the public site.

## Documentation Design

The README must be rewritten as a fresh GitHub landing page for the new product. It should not mention the deprecated upstream project or read like an upgrade guide from that lineage.

The new README should include:

- product positioning
- feature overview
- architecture at a glance
- quickstart
- config example
- deployment steps
- screenshots or mockups after UI work lands
- roadmap and contribution notes

Tone should be concise, product-oriented, and explicitly Cloudflare-native.

## Migration Position

This reboot is a clean break. There is no requirement to maintain compatibility with the current config format or internal data representation. Existing users can manually migrate later, but compatibility is not a design constraint for v1.

## Testing Strategy

The new system should be implemented with testable boundaries:

- schema validation tests
- domain logic tests for aggregation and incident transitions
- worker API tests
- protocol runner tests
- frontend component and route tests for major states

The architecture should make it possible to test core behavior without deploying to Cloudflare for every iteration.

## Risks

- Preserving broad feature scope while doing a full reboot can sprawl without strict boundaries
- Replacing blob storage with queryable records requires careful retention and performance decisions
- A strong UI refresh can drift into over-design if not anchored to status-page usability
- Future admin UI ambitions must not leak into v1 structure

## Non-Goals

- browser-based admin panel in v1
- compatibility with current `uptime.config.ts`
- preserving the current file layout
- preserving the current visual identity
- implementing every possible migration aid before the reboot ships

## Success Criteria

The reboot is successful if:

- the codebase reads as a new product, not a fork-shaped rearrangement
- the feature scope remains broadly intact for monitoring, incidents, maintenance, and notifications
- the UI is materially more modern and distinct
- the config model is cleaner and easier to understand
- the README presents the project as a standalone OSS product ready for GitHub
