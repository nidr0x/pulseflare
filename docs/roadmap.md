# Roadmap

Pulseflare stays small: config in code, status data in D1, and deployment through GitHub Actions.

## Completed

- Use one canonical public snapshot API instead of demo UI state.
- Calculate uptime and regional latency history from daily rollups, with retention cleanup.
- Use thresholded incident transitions and retryable webhook notifications.
- Support configurable regional failure policies and incident impact labels.
- Protect bootstrap with a POST request and an Authorization header.
- Add scheduler run leases and a health endpoint.
- Add remote region and proxy probe execution.

## Near term

- Add provider integrations beyond generic webhooks.
- Improve first-deployment errors and migration diagnostics.

## Later

- Add more status-page branding options.
- Add incident RSS or Atom feeds.
- Expand external probe support beyond the current region and proxy routing.

## Non-goals for now

- A hosted SaaS control plane.
- A required admin UI.
- A required local CLI for normal installs.
- Terraform as the default path for new users.
