# Cloudflare Status Reboot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the project into a new Cloudflare-native uptime monitoring product with a Worker backend, a Vite + React public frontend, a new config model, and a rewritten README.

**Architecture:** Replace the current mixed Next.js + Worker layout with a monorepo-style split: `apps/worker` for checks, persistence, notifications, and public APIs; `apps/web` for the status UI; `packages/schema` for validated config and shared types; and `packages/core` for status aggregation and response shaping. Preserve broad monitoring/status-page scope while intentionally replacing structure, naming boundaries, UI patterns, and config shape.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vite, React, Vitest, workspace packages, shared schema validation.

---

### Task 1: Reframe the repository into the new product layout

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/wrangler.toml`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/schema/package.json`
- Create: `packages/schema/tsconfig.json`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`
- Test: `package.json`

- [ ] **Step 1: Write the failing workspace-shape test**

Create `package.json` scripts that expect workspace apps to exist:

```json
{
  "name": "pulseflare",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "lint": "npm run lint --workspaces"
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL because `apps/worker` and `apps/web` package manifests do not exist yet.

- [ ] **Step 3: Write the minimal workspace structure**

Create the initial manifests and configs:

```json
// apps/worker/package.json
{
  "name": "@pulseflare/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  }
}
```

```json
// apps/web/package.json
{
  "name": "@pulseflare/web",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  }
}
```

```json
// packages/core/package.json
{
  "name": "@pulseflare/core",
  "private": true,
  "type": "module",
  "main": "./src/index.ts"
}
```

```json
// packages/schema/package.json
{
  "name": "@pulseflare/schema",
  "private": true,
  "type": "module",
  "main": "./src/index.ts"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: PASS with each workspace resolving its own `build` script, even if later tasks still leave source-level build failures to address.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore apps packages
git commit -m "chore: scaffold reboot workspace layout"
```

### Task 2: Introduce the new schema-first config model

**Files:**
- Create: `packages/schema/src/index.ts`
- Create: `packages/schema/src/config.ts`
- Create: `packages/schema/src/config.test.ts`
- Create: `config/pulse.config.ts`
- Modify: `apps/worker/tsconfig.json`
- Modify: `apps/web/tsconfig.json`
- Test: `packages/schema/src/config.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Create tests for the new config contract:

```ts
import { describe, expect, it } from 'vitest'
import { defineStatusConfig, parseStatusConfig } from './config'

describe('status config', () => {
  it('accepts a service with an http check', () => {
    const config = defineStatusConfig({
      site: { name: 'Acme Status' },
      services: [
        {
          id: 'api',
          name: 'API',
          group: 'Core',
          checks: [{ type: 'http', url: 'https://api.example.com/health', method: 'GET' }],
        },
      ],
      notifications: { providers: [] },
      maintenances: [],
    })

    expect(parseStatusConfig(config).services).toHaveLength(1)
  })

  it('rejects duplicate service ids', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [
          { id: 'api', name: 'API A', checks: [{ type: 'http', url: 'https://a.dev' }] },
          { id: 'api', name: 'API B', checks: [{ type: 'http', url: 'https://b.dev' }] },
        ],
        notifications: { providers: [] },
        maintenances: [],
      })
    ).toThrow(/duplicate service id/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pulseflare/schema`
Expected: FAIL because `defineStatusConfig` and `parseStatusConfig` do not exist yet.

- [ ] **Step 3: Write the minimal config implementation**

Create a typed config module:

```ts
export type StatusConfig = {
  site: {
    name: string
    description?: string
    url?: string
    brand?: { logo?: string; icon?: string }
    navigation?: Array<{ label: string; href: string }>
  }
  services: Array<{
    id: string
    name: string
    group?: string
    checks: Array<
      | {
          type: 'http'
          url: string
          method?: string
          headers?: Record<string, string>
          body?: string
          timeoutMs?: number
          expect?: {
            status?: number[]
            bodyIncludes?: string[]
            bodyExcludes?: string[]
          }
          probe?: { kind: 'local' | 'region' | 'proxy'; target?: string }
        }
      | {
          type: 'tcp'
          target: string
          timeoutMs?: number
          probe?: { kind: 'local' | 'region' | 'proxy'; target?: string }
        }
    >
  }>
  notifications: {
    gracePeriodMinutes?: number
    providers: Array<{
      id: string
      type: 'webhook'
      url: string
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
      headers?: Record<string, string>
      bodyTemplate?: Record<string, unknown>
    }>
  }
  maintenances: Array<{
    id: string
    title: string
    body: string
    start: string
    end?: string
    services?: string[]
  }>
}

export function defineStatusConfig(config: StatusConfig): StatusConfig {
  return config
}

export function parseStatusConfig(config: StatusConfig): StatusConfig {
  const ids = new Set<string>()
  for (const service of config.services) {
    if (ids.has(service.id)) throw new Error(`Duplicate service id: ${service.id}`)
    ids.add(service.id)
  }
  return config
}
```

Add a sample product config:

```ts
import { defineStatusConfig } from '@pulseflare/schema'

export default defineStatusConfig({
  site: {
    name: 'Pulseflare',
    description: 'Cloudflare-native uptime monitoring and status pages',
  },
  services: [],
  notifications: { providers: [] },
  maintenances: [],
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace @pulseflare/schema`
Expected: PASS with duplicate-id validation and basic config parsing green.

- [ ] **Step 5: Commit**

```bash
git add packages/schema config/pulse.config.ts apps/worker/tsconfig.json apps/web/tsconfig.json
git commit -m "feat: add schema-first product config"
```

### Task 3: Build the Worker domain, storage, and public APIs

**Files:**
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/domain/check-runner.ts`
- Create: `apps/worker/src/domain/incident-engine.ts`
- Create: `apps/worker/src/domain/notification-engine.ts`
- Create: `apps/worker/src/repositories/d1.ts`
- Create: `apps/worker/src/routes/public.ts`
- Create: `apps/worker/src/routes/public.test.ts`
- Create: `apps/worker/migrations/0001_initial.sql`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/status-summary.ts`
- Create: `packages/core/src/status-summary.test.ts`
- Test: `apps/worker/src/routes/public.test.ts`
- Test: `packages/core/src/status-summary.test.ts`

- [ ] **Step 1: Write the failing domain and API tests**

Create a summary test:

```ts
import { describe, expect, it } from 'vitest'
import { buildSummary } from './status-summary'

describe('buildSummary', () => {
  it('reports degraded when any service is down', () => {
    const summary = buildSummary([
      { id: 'api', name: 'API', status: 'down' },
      { id: 'web', name: 'Web', status: 'up' },
    ])

    expect(summary.status).toBe('degraded')
    expect(summary.upCount).toBe(1)
    expect(summary.downCount).toBe(1)
  })
})
```

Create a public route test:

```ts
import { describe, expect, it } from 'vitest'
import worker from './index'

describe('/api/public/summary', () => {
  it('returns a summary payload', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {} as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pulseflare/core && npm run test --workspace @pulseflare/worker`
Expected: FAIL because the summary builder, worker entrypoint, routes, and repositories do not exist.

- [ ] **Step 3: Write the minimal domain and API implementation**

Define the first D1 schema:

```sql
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_group TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE service_status (
  service_id TEXT PRIMARY KEY,
  current_status TEXT NOT NULL,
  latest_reason TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latest_reason TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE latency_points (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  location_label TEXT NOT NULL
);
```

Define the shared summary function:

```ts
export function buildSummary(services: Array<{ id: string; name: string; status: 'up' | 'down' }>) {
  const upCount = services.filter((service) => service.status === 'up').length
  const downCount = services.length - upCount

  return {
    status: downCount === 0 ? 'operational' : 'degraded',
    upCount,
    downCount,
    totalCount: services.length,
  }
}
```

Define the first public route contract:

```ts
export async function handlePublicSummary() {
  return Response.json({
    status: 'operational',
    upCount: 0,
    downCount: 0,
    totalCount: 0,
    checkedAt: new Date().toISOString(),
  })
}
```

Mount routes in the worker:

```ts
export default {
  async fetch(request: Request) {
    const url = new URL(request.url)

    if (url.pathname === '/api/public/summary') {
      return handlePublicSummary()
    }

    return new Response('Not found', { status: 404 })
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace @pulseflare/core && npm run test --workspace @pulseflare/worker`
Expected: PASS for summary logic and public summary route.

- [ ] **Step 5: Commit**

```bash
git add apps/worker packages/core
git commit -m "feat: add worker domain and public status api"
```

### Task 4: Build the new Vite + React public status site

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/routes/HomePage.tsx`
- Create: `apps/web/src/routes/IncidentsPage.tsx`
- Create: `apps/web/src/components/HeroStatus.tsx`
- Create: `apps/web/src/components/ServiceGroupList.tsx`
- Create: `apps/web/src/components/IncidentTimeline.tsx`
- Create: `apps/web/src/components/LatencyChart.tsx`
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/app.css`
- Create: `apps/web/src/App.test.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing UI test**

Create a smoke test for the overview page:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the system status heading', () => {
    render(<App />)
    expect(screen.getByText(/system status/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace @pulseflare/web`
Expected: FAIL because the app shell and test setup do not exist yet.

- [ ] **Step 3: Write the minimal UI implementation**

Start with an intentional shell and token system:

```tsx
export default function App() {
  return (
    <div className="app-shell">
      <header className="hero">
        <p className="eyebrow">Pulseflare</p>
        <h1>System Status</h1>
        <p className="hero-copy">Cloudflare-native uptime monitoring and incident reporting.</p>
      </header>
      <main>
        <section className="status-card">
          <h2>All systems operational</h2>
          <p>Live service health, recent incidents, and scheduled maintenance.</p>
        </section>
      </main>
    </div>
  )
}
```

```css
:root {
  --bg: #f4efe6;
  --surface: rgba(255, 252, 247, 0.82);
  --ink: #1f1a17;
  --muted: #6f645c;
  --accent: #0f766e;
  --danger: #b42318;
  --line: rgba(31, 26, 23, 0.08);
  --display: "Sora", "Segoe UI", sans-serif;
  --body: "IBM Plex Sans", "Segoe UI", sans-serif;
}
```

The overview route should render:

- a hero summary
- grouped services
- recent incidents
- upcoming maintenance

The incidents route should render:

- incident history list
- service filter
- maintenance entries in the same visual system

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace @pulseflare/web`
Expected: PASS with the new app shell rendering the public status heading.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add new public status frontend"
```

### Task 5: Rewrite product documentation and remove legacy framing

**Files:**
- Modify: `README.md`
- Optionally delete or replace: `README_zh-CN.md`
- Create: `docs/architecture.md`
- Create: `docs/configuration.md`
- Test: `README.md`

- [ ] **Step 1: Write the failing documentation check**

Add a manual check list for the README:

```md
- product name is new
- architecture matches worker + vite/react split
- quickstart references the new config file
- legacy project name is absent from the main description
- screenshots section reflects the rebooted UI
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rg -n "UptimeFlare|Next.js|uptime.config.ts" README.md`
Expected: FAIL because the current README still describes the legacy project and stack.

- [ ] **Step 3: Write the minimal documentation replacement**

Rewrite `README.md` around the new product:

```md
# Pulseflare

Cloudflare-native uptime monitoring and status pages.

## Features

- HTTP and TCP monitoring
- incidents and maintenance tracking
- public status pages powered by a lightweight React frontend
- webhook notifications
- D1-backed history and summaries

## Architecture

- `apps/worker`: checks, incidents, notifications, public APIs
- `apps/web`: public status UI
- `packages/schema`: config schema
- `packages/core`: status and incident logic

## Quickstart

1. Install dependencies
2. Copy and edit `config/pulse.config.ts`
3. Apply D1 migrations
4. Run the worker and web app locally
```

Add supporting docs:

- `docs/architecture.md` for system boundaries and request flow
- `docs/configuration.md` for config sections and examples

- [ ] **Step 4: Run test to verify it passes**

Run: `rg -n "UptimeFlare|Next.js|uptime.config.ts" README.md docs/architecture.md docs/configuration.md`
Expected: PASS with no legacy framing in the new primary docs.

- [ ] **Step 5: Commit**

```bash
git add README.md README_zh-CN.md docs/architecture.md docs/configuration.md
git commit -m "docs: rewrite project documentation for reboot"
```

### Task 6: Remove the legacy app paths and verify the reboot end-to-end

**Files:**
- Delete: `pages/`
- Delete: `components/`
- Delete: `worker/`
- Delete: `styles/`
- Delete or replace: `public/`
- Modify: root lockfile(s) and any obsolete configs
- Test: whole workspace

- [ ] **Step 1: Write the failing end-to-end verification list**

Verification target:

```text
1. Worker public API returns summary and incidents data.
2. Web app renders overview and incidents routes.
3. New config file is the only documented config entrypoint.
4. Legacy Next.js pages/components paths are gone.
5. Root build, test, and lint commands pass.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rg --files pages components worker styles`
Expected: FAIL because legacy application directories still exist.

- [ ] **Step 3: Remove legacy paths and wire final scripts**

Make the repository only expose the new product shape:

```json
{
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "lint": "npm run lint --workspaces",
    "dev:web": "npm run dev --workspace @pulseflare/web",
    "dev:worker": "npm run dev --workspace @pulseflare/worker"
  }
}
```

Delete obsolete Next.js-specific files once all replacements exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npm run test && npm run lint`
Expected: PASS for the new workspace.

Run: `rg --files pages components worker styles`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: complete status product reboot"
```
