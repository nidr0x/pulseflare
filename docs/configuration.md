# Configuration

Pulseflare reads config from [`config/pulse.config.ts`](../config/pulse.config.ts). The config uses helpers from `@pulseflare/schema`.

## Entry point

Use `defineStatusConfig(...)` for the checked-in config. Use `parseStatusConfig(...)` when runtime validation is needed.

This document describes the schema. Some fields are not connected to runtime behavior yet.

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

## Top-level sections

### `site`

Public site metadata:

- `name`: required display name
- `description`: optional public subtitle
- `url`: optional canonical status URL
- `brand.logo`: optional asset path for the site logo
- `brand.icon`: optional asset path for the favicon or app icon
- `navigation`: optional external links shown in the public UI

### `services`

Services to monitor.

Each service includes:

- `id`: required stable identifier
- `name`: required display name
- `group`: optional visual grouping label
- `checks`: one or more monitoring checks

Duplicate service ids are rejected during parsing.

### `notifications`

Notification settings.

- `gracePeriodMinutes`: optional suppression window before notifying
- `providers`: array of provider definitions

Supported provider shape:

- `type: 'webhook'`
- `url`
- optional `method`
- optional `headers`
- optional `bodyTemplate`

### `maintenances`

Scheduled maintenance windows.

Each entry includes:

- `id`
- `title`
- `body`
- `start`
- optional `end`
- optional `services`

If `services` is set, each id must match a configured service.

## Check types

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

HTTP fields:

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

TCP fields:

- `target`
- optional `timeoutMs`
- optional `probe`

## Probe model

Optional probe routing:

- `kind: 'local'`
- `kind: 'region'`
- `kind: 'proxy'`
- optional `target` for region or proxy-specific routing

## Full example

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

## Validation notes

Validation checks:

- required string fields are present and non-empty
- service ids are unique
- notification provider methods are valid
- check payloads match their declared type
- maintenance service references point at real services

When extending the schema, update the parser and [`packages/schema/src/config.test.ts`](../packages/schema/src/config.test.ts).

## Runtime status

Today:

- the Worker reads `config/pulse.config.ts` for the protected bootstrap install flow
- bootstrap and scheduled runs sync `services` from config into D1
- scheduled runs execute HTTP and TCP checks from config and persist status/latency results
- the Worker exposes public summary, services, incidents, and maintenance routes
- the web app overlays public API responses onto bundled fallback data

Later:

- service definitions from config drive notifications too
- maintenance and notification settings affect live status behavior
