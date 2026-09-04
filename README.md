# Pulseflare

Cloudflare-based uptime monitoring with a public status page.

The basic setup is:

1. Create a repository from this template.
2. Add Cloudflare credentials to GitHub.
3. Edit `config/pulse.config.ts`.
4. Push to `main`.

GitHub Actions handles the Cloudflare deployment. The basic setup does not require Wrangler, Terraform, or manual SQL.

## Public page

The public page includes:

- current overall status
- service rows with status and response time
- 90-day uptime bars
- recent incidents and maintenance windows

The UI lives in `apps/web` and is deployed as static assets on the Worker that serves `/api/*`. A separate Cloudflare Pages deployment is possible, but the default setup does not need one.

![Pulseflare public status page](docs/screenshots/public-status-page.png)

![Pulseflare public status page on mobile](docs/screenshots/public-status-page-mobile.png)

## Quickstart

### 1. Create a repository

Create a new repository from this template.

### 2. Create a Cloudflare API token

Create a Cloudflare API token with permission to deploy Workers and manage D1.

Use:

- `Cloudflare Workers:Edit`
- `D1:Edit`

You also need the Cloudflare account ID.

1. Open the dashboard for your account
2. Select any domain or Workers project
3. In the right sidebar, look for `Account ID`
4. Copy that value

Cloudflare also includes the account ID in many URLs after `/accounts/`. The sidebar is usually easier to use.

### 3. Add GitHub secrets

In your GitHub repo, add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PULSEFLARE_BOOTSTRAP_TOKEN` if you want to use the protected bootstrap endpoint
- `PULSEFLARE_REMOTE_PROBE_TOKEN` if you use regional probes

Optional GitHub repository variables are:

- `PULSEFLARE_ENABLE_DEPLOY`
- `PULSEFLARE_WORKER_NAME`
- `PULSEFLARE_D1_NAME`
- `PULSEFLARE_CHECK_CRON`
- `PULSEFLARE_REMOTE_PROBE_URL`
- `PULSEFLARE_HEALTHCHECK_URL`

The defaults are:

- Deploy disabled
- Worker name: `pulseflare-status`
- D1 name: `pulseflare-d1`
- Check schedule: `* * * * *`
- Shared remote probe endpoint: unset
- Deployment health-check URL: required when deployment is enabled

Deployment stays disabled unless `PULSEFLARE_ENABLE_DEPLOY=true`. Leave the variable unset in repositories that should only run tests and builds.

### 4. Configure the monitor

Edit [`config/pulse.config.ts`](config/pulse.config.ts) to set the site name, services, maintenance windows, and notification settings.

You can start from [`config/pulse.example.ts`](config/pulse.example.ts).

### 5. Push to `main`

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

- installs dependencies
- runs tests, build, and lint
- always runs the `verify` job
- only runs the `deploy` job when `PULSEFLARE_ENABLE_DEPLOY=true`
- finds or creates the D1 database
- applies D1 migrations
- deploys one Worker that serves both:
  - the public status site
  - the `/api/*` routes
- verifies the live `/api/health` and `/api/public/snapshot` endpoints

The default setup uses one Worker with static assets, API routes, and a D1 binding.

Keep deployment enabled only in the repository that owns the real Worker and D1 database:

- leave `PULSEFLARE_ENABLE_DEPLOY` unset in development or upstream repos
- set `PULSEFLARE_ENABLE_DEPLOY=true` only in the real deployment repo

More detail: [docs/deployment.md](docs/deployment.md).

## Cost

Cloudflare pricing relevant to this project, checked April 23, 2026:

- Workers Free: `100,000` requests per day, with `10 ms` CPU time per invocation included. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Workers Static Assets: static asset requests are `free and unlimited`. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Static assets best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- D1 Free: `5 million` rows read per day, `100,000` rows written per day, and `5 GB` total storage. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Workers Paid: minimum `$5/month`, with `10 million` included requests per month, then `$0.30` per additional million requests. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

For small installs:

- Most hobby and small-team installs should fit in the free tier.
- Costs depend on monitor count, check frequency, public traffic, and D1 usage.

The public page uses Worker static assets. The Worker handles `/api/*` before static asset handling, but it does not run first for every static page request.

## Current scope

The repository contains:

- checked-in config schema in [`config/pulse.config.ts`](config/pulse.config.ts)
- Worker routes
- D1 migrations
- canonical `/api/public/snapshot` API backed by live Worker state
- public summary API
- public services API backed by config and D1 state
- public incidents API backed by D1 state
- public maintenance API backed by config
- scheduled HTTP and TCP checks from config
- remote `region` and `proxy` probe execution
- D1-backed service status and incident transitions
- webhook notifications with grace-period handling
- persisted check history, uptime calculations, stale-state detection, and retention cleanup
- thresholded incident transitions with retryable webhook delivery
- public status UI bundled into the Worker deployment
- GitHub Actions deployment flow

The bootstrap endpoint accepts `POST /api/install/bootstrap` with an
`Authorization: Bearer <token>` header. Do not put the token in a URL query
parameter.
## Config example

```ts
import { defineStatusConfig } from '@pulseflare/schema'

export default defineStatusConfig({
  site: {
    name: 'Acme Status',
    description: 'System health and incident reporting',
    url: 'https://status.acme.dev',
    brand: {
      logo: '/brand/logo.svg',
      icon: '/brand/icon.svg',
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
      failureThreshold: 2,
      recoveryThreshold: 2,
      checks: [
        {
          type: 'http',
          url: 'https://api.acme.dev/health',
          method: 'GET',
          expect: {
            status: [200],
            bodyIncludes: ['ok'],
          },
          probe: {
            kind: 'region',
            target: 'iad',
          },
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
        url: 'https://hooks.acme.dev/pulseflare',
        method: 'POST',
        bodyTemplate: {
          source: 'pulseflare',
          event: '$EVENT',
          service: '$SERVICE_NAME',
          status: '$STATUS',
          reason: '$REASON',
        },
      },
    ],
  },
  staleAfterMinutes: 5,
  retentionDays: 90,
  maintenances: [],
})
```

More detail:

- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/roadmap.md](docs/roadmap.md)

## Local development

Use the local tooling when contributing:

```bash
npm install
npm run test
npm run build
npm run lint
```

To work on the Worker locally:

```bash
npm run dev:worker
```

To work on the UI locally:

```bash
npm run dev:web
```

## Contributing

Contributions are welcome in areas such as:

- check execution
- incident persistence
- notification providers
- config ergonomics
- status-page polish
