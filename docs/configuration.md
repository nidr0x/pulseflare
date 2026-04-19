# Pulseflare Configuration

Pulseflare declares product configuration in [`config/pulse.config.ts`](../config/pulse.config.ts) using the helpers exported by `@pulseflare/schema`.

## Entry Point

Use `defineStatusConfig(...)` to author a typed config and `parseStatusConfig(...)` where you need runtime validation.

This document describes the config shape supported by the schema package today. It does not imply that every field is already consumed by the live Worker runtime.

```ts
import { defineStatusConfig } from '@pulseflare/schema'

export default defineStatusConfig({
  site: {
    name: 'Acme Status',
    description: 'System health and incident reporting',
  },
  services: [],
  notifications: { providers: [] },
  maintenances: [],
})
```

## Top-Level Sections

### `site`

Controls public product metadata:

- `name`: required display name
- `description`: optional public subtitle
- `url`: optional canonical status URL
- `brand.logo`: optional asset path for the site logo
- `brand.icon`: optional asset path for the favicon or app icon
- `navigation`: optional external links shown in the public UI

### `services`

Defines the monitored services for the product config.

Each service includes:

- `id`: required stable identifier
- `name`: required display name
- `group`: optional visual grouping label
- `checks`: one or more monitoring checks

Duplicate service ids are rejected during parsing.

### `notifications`

Configures the notification model supported by the schema.

- `gracePeriodMinutes`: optional suppression window before notifying
- `providers`: array of provider definitions

Current provider model:

- `type: 'webhook'`
- `url`
- optional `method`
- optional `headers`
- optional `bodyTemplate`

### `maintenances`

Defines scheduled work in the config model.

Each entry includes:

- `id`
- `title`
- `body`
- `start`
- optional `end`
- optional `services`

When `services` is provided, each referenced id must match a defined service.

## Check Types

### HTTP check

```ts
{
  type: 'http',
  url: 'https://api.acme.dev/health',
  method: 'GET',
  headers: {
    'x-status-probe': 'pulseflare',
  },
  timeoutMs: 5000,
  expect: {
    status: [200],
    bodyIncludes: ['ok'],
    bodyExcludes: ['degraded'],
  },
  probe: {
    kind: 'region',
    target: 'WEUR',
  },
}
```

Schema-supported HTTP fields:

- `url`
- optional `method`
- optional `headers`
- optional `body`
- optional `timeoutMs`
- optional `expect.status`
- optional `expect.bodyIncludes`
- optional `expect.bodyExcludes`
- optional `probe`

### TCP check

```ts
{
  type: 'tcp',
  target: 'redis.acme.dev:6379',
  timeoutMs: 3000,
  probe: {
    kind: 'proxy',
    target: 'ams-edge',
  },
}
```

Schema-supported TCP fields:

- `target`
- optional `timeoutMs`
- optional `probe`

## Probe Model

The schema also allows an optional probe:

- `kind: 'local'`
- `kind: 'region'`
- `kind: 'proxy'`
- optional `target` for region or proxy-specific routing

## Full Example

```ts
import { defineStatusConfig } from '@pulseflare/schema'

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
    {
      id: 'redis',
      name: 'Redis Cache',
      group: 'Core Platform',
      checks: [
        {
          type: 'tcp',
          target: 'redis.acme.dev:6379',
          timeoutMs: 3000,
        },
      ],
    },
  ],
  notifications: {
    gracePeriodMinutes: 5,
    providers: [
      {
        id: 'ops-webhook',
        type: 'webhook',
        url: 'https://hooks.acme.dev/status',
        method: 'POST',
        headers: {
          authorization: 'Bearer ${STATUS_WEBHOOK_TOKEN}',
        },
        bodyTemplate: {
          source: 'pulseflare',
        },
      },
    ],
  },
  maintenances: [
    {
      id: 'db-upgrade',
      title: 'Primary database engine upgrade',
      body: 'Brief periods of elevated latency are expected during the migration window.',
      start: '2026-05-10T22:00:00Z',
      end: '2026-05-10T23:30:00Z',
      services: ['api', 'redis'],
    },
  ],
})
```

## Validation Notes

Schema validation currently checks:

- required string fields are present and non-empty
- service ids are unique
- notification provider methods are valid
- check payloads match their declared type
- maintenance service references point at real services

If you are extending the schema, update both the parser and the schema tests in [`packages/schema/src/config.test.ts`](../packages/schema/src/config.test.ts).

## Runtime Status

Current runtime behavior:

- the Worker reads `config/pulse.config.ts` for the protected bootstrap install flow
- the bootstrap route seeds the `services` table from config on a fresh install
- the Worker exposes a live public summary route
- the web app overlays that summary onto bundled mock data

Planned runtime behavior:

- service definitions from config drive checks, incidents, and notifications
- public APIs return config-backed and persistence-backed service data
- maintenance and notification settings affect live status behavior
