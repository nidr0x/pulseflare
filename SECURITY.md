# Security policy

## Supported versions

Pulseflare is pre-1.0. Security fixes target the current `main` branch until versioned releases begin.

## Reporting a vulnerability

Please do not open public issues for suspected vulnerabilities.

For now, report privately through GitHub private vulnerability reporting when it is enabled for the repository. If that is not available, contact the maintainer directly through the GitHub profile associated with the repository.

Useful reports include:

- affected version or commit
- deployment surface involved, such as Worker, D1, GitHub Actions, or public UI
- reproduction steps
- expected impact
- any logs or proof of concept that can be shared safely

## Token handling

Pulseflare should never require committing Cloudflare credentials. Store Cloudflare credentials only as GitHub Actions secrets or local development environment variables.
