# Configuration

Pulseflare reads config from [`config/pulse.config.ts`](../config/pulse.config.ts). The config uses helpers from `@pulseflare/schema`.

## Entry point

Use `defineStatusConfig(...)` in the checked-in config. Use `parseStatusConfig(...)` when validating config at runtime.

This document covers the current schema and runtime behavior.

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

Public site metadata includes:

- `name`: required display name
- `description`: optional public subtitle
- `url`: optional canonical status URL
- `brand.logo`: optional asset path for the site logo
- `brand.icon`: optional asset path for the favicon or app icon
- `navigation`: optional external links shown in the public UI

### `services`

Services to monitor. Each service includes:

- `id`: required stable identifier
- `name`: required display name
- `group`: optional visual grouping label
- `failureThreshold`: optional consecutive failures required to open an incident; defaults to `2`
- `recoveryThreshold`: optional consecutive successes required to resolve an incident; defaults to `2`
- `checks`: one or more monitoring checks

Duplicate service ids are rejected during parsing.

### `notifications`

Notification settings include:

- `gracePeriodMinutes`: optional suppression window before notifying
- `providers`: array of provider definitions

The supported provider shape is:

- `type: 'webhook'`
- `url`
- optional `method`
- optional `headers`
- optional `secretName`, `secretHeader`, and `secretPrefix` for a Worker secret binding
- optional `bodyTemplate`

At the top level, `staleAfterMinutes` sets how long the public page treats the
latest check as current. `retentionDays` sets how long historical D1 data stays.

### `maintenances`

Scheduled maintenance windows use entries with:

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

Probes can route checks through:

- `kind: 'local'`
- `kind: 'region'`
- `kind: 'proxy'`
- optional `target` for region or proxy-specific routing

At runtime:

- `local` runs inside the Worker directly
- `region` sends the check to the shared remote probe endpoint configured with `PULSEFLARE_REMOTE_PROBE_URL`
- `proxy` sends the check to the full HTTP(S) URL stored in `probe.target`

Remote probe requests use JSON `POST` calls with the original `check` and `probe` values. Regional requests use a `Bearer` token from the `PULSEFLARE_REMOTE_PROBE_TOKEN` Worker secret and require an HTTPS endpoint. The response must be JSON with:

- `status`: `up` or `down`
- `reason`: string
- optional `latencyMs`: non-negative integer no greater than 10 minutes

Check history records the probe location. Regional labels are shown in the public snapshot as safe location summaries; proxy URLs are never returned to the public API.

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
        secretName: 'STATUS_WEBHOOK_TOKEN',
        secretHeader: 'authorization',
        secretPrefix: 'Bearer ',
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

## Validation

The parser checks that:

- required string fields are present and non-empty
- service ids are unique
- notification provider methods are valid
- check payloads match their declared type
- maintenance service references point at real services

When extending the schema, update the parser and [`packages/schema/src/config.test.ts`](../packages/schema/src/config.test.ts).

## Runtime behavior

The Worker currently:

- reads `config/pulse.config.ts` for the protected bootstrap install flow
- bootstrap and scheduled runs sync `services` from config into D1
- scheduled runs execute HTTP and TCP checks from config and persist status/latency results
- scheduled runs dispatch webhook notifications on incident open and resolve transitions
- notification grace periods delay incident opening and webhook delivery until sustained failure is confirmed
- active maintenance windows suppress incident-open notifications for affected services
- the Worker exposes public summary, services, incidents, and maintenance routes
- the web app reads one canonical `/api/public/snapshot` response and uses an empty unknown state when it is unavailable
- scheduled checks persist every result and calculate real 90-day history from D1
- incidents require configurable consecutive failures and recoveries
- webhook notifications are queued in D1 and retried asynchronously

Planned extensions:

- notification delivery providers can be expanded beyond generic webhooks
- additional probe regions and routing options can add more multi-region evidence
