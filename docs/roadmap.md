# Roadmap

Pulseflare should stay small: config in code, status data in D1, and deployment through GitHub Actions.

## Near term

- Replace the remaining demo UI data with API data.
- Add richer uptime history from persisted status data.
- Send webhook notifications when state changes.
- Add a public maintenance API.
- Improve first-run deploy errors.

## Later

- More status-page branding options.
- Incident RSS or Atom feeds.
- Retention settings for latency and history data.
- Optional external probes for multi-region checks.

## Non-goals for now

- A hosted SaaS control plane.
- A required admin UI.
- A required local CLI for normal installs.
- Terraform as the default path for new users.
