# Deployment

Pulseflare deploys through GitHub Actions. The normal setup does not require Wrangler on your machine.

## One-time setup

1. Create a repository from this template.
2. Create a Cloudflare API token.
3. Add the Cloudflare values to GitHub secrets.
4. Add the GitHub variable that enables deployment.
5. Push to `main`.

The workflow finds or creates the D1 database, writes a temporary Wrangler config, applies the migrations, and deploys the Worker with static assets.

## Create a Cloudflare API token

In Cloudflare, open `My profile` > `API Tokens` > `Create Token` > `Custom token`.

Choose the narrowest permissions that work for your account:

- `Account` > `Cloudflare Workers Scripts` > `Edit`
- `Account` > `D1` > `Edit`

Scope the token to the account that will own the Worker and D1 database. If Cloudflare renames these permissions, choose the equivalent permissions for editing Workers and D1 in one account.

## Find your account ID

The workflow also needs `CLOUDFLARE_ACCOUNT_ID`.

To find it:

1. Open the Cloudflare dashboard.
2. Select the account you want to deploy into.
3. Open any Workers, D1, or domain page inside that account.
4. Copy `Account ID` from the right sidebar.

If the sidebar is not visible, open the Workers overview for the account. The account ID also appears in many dashboard URLs after `/accounts/`.

## Add GitHub secrets

In GitHub, open `Settings` > `Secrets and variables` > `Actions` > `Secrets`.

Add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PULSEFLARE_BOOTSTRAP_TOKEN` if you want to run the protected bootstrap endpoint after deployment
- `PULSEFLARE_REMOTE_PROBE_TOKEN` if you use regional probes

## Enable deployment

Deployment is off by default, which prevents forks and development repositories from deploying by accident.

In GitHub, open `Settings` > `Secrets and variables` > `Actions` > `Variables`.

Add:

- `PULSEFLARE_ENABLE_DEPLOY` = `true`

Optional variables:

- `PULSEFLARE_WORKER_NAME` defaults to `pulseflare-status`
- `PULSEFLARE_D1_NAME` defaults to `pulseflare-d1`
- `PULSEFLARE_CHECK_CRON` defaults to `* * * * *`
- `PULSEFLARE_REMOTE_PROBE_URL` is optional and enables shared remote execution for checks using `probe.kind = 'region'`
- `PULSEFLARE_HEALTHCHECK_URL` is required when deployment is enabled and must be the HTTPS base URL of the public Worker

Leave `PULSEFLARE_ENABLE_DEPLOY` unset in repositories that should only test and build.

## First deploy

Push to `main` or run the `Deploy Pulseflare` workflow manually.

The first deployment will:

- install dependencies
- run tests, build, and lint
- find or create the configured D1 database
- apply migrations from `apps/worker/migrations`
- deploy the Worker from `apps/worker`
- serve the web UI from `apps/web/dist` as Worker static assets
- verify `/api/health` and `/api/public/snapshot` on the deployed Worker

If `PULSEFLARE_BOOTSTRAP_TOKEN` is set, the workflow stores it as a Worker
secret after deployment. Use a `POST` request with an authorization header to
bootstrap:

```bash
curl -X POST \
  -H "Authorization: Bearer $PULSEFLARE_BOOTSTRAP_TOKEN" \
  https://status.example.com/api/install/bootstrap
```

Webhook secrets referenced by `secretName` must also be added as Worker
secrets. Keep those values out of `pulse.config.ts` and Git history.

## Troubleshooting

If `Resolve Cloudflare resources` reports a missing token, check that both GitHub secrets exist and are available to Actions.

If deployment is skipped, check that `PULSEFLARE_ENABLE_DEPLOY` is a repository variable, not a secret, and that its value is exactly `true`.

If a D1 migration fails, check that the API token can edit D1 in the target account before rerunning the workflow.

If static assets do not update, check that the `Verify project` step built `apps/web/dist` before deployment.

If a regional probe always reports that no shared endpoint is configured, check that `PULSEFLARE_REMOTE_PROBE_URL` is set as a repository variable and points to an HTTPS probe service. Add the matching `PULSEFLARE_REMOTE_PROBE_TOKEN` secret; the workflow installs it as a Worker secret.

If the live deployment check fails, check that `PULSEFLARE_HEALTHCHECK_URL` points to the deployed public URL and that the scheduler has completed a run. The check retries while the health endpoint is still warming up.
