# Roadmap

Pulseflare should stay small: config in code, status data in D1, and deployment through GitHub Actions.

## Completed

- Replace demo UI state with one canonical public snapshot API.
- Add real uptime history and latency retention from persisted check results.
- Add thresholded incident transitions and retryable webhook notifications.
- Harden bootstrap with a POST and Authorization header.

## Near term

- Add scheduler run leases and a small internal health or heartbeat signal.
- Add explicit provider integrations beyond generic webhooks.
- Improve first-run deploy errors and migration diagnostics.

## Later

- More status-page branding options.
- Incident RSS or Atom feeds.
- Optional external probes for multi-region checks.

## Non-goals for now

- A hosted SaaS control plane.
- A required admin UI.
- A required local CLI for normal installs.
- Terraform as the default path for new users.
