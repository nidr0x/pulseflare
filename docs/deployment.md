# Deployment

Pulseflare deploys from GitHub Actions. The normal setup does not require Wrangler on your machine.

## One-time setup

1. Create a repository from this template.
2. Create a Cloudflare API token.
3. Add the Cloudflare values to GitHub secrets.
4. Set one GitHub variable to allow deployment.
5. Push to `main`.

The workflow finds or creates the D1 database, writes a temporary Wrangler config, applies migrations, and deploys the Worker with static assets.

## Create a Cloudflare API token

In Cloudflare, open `My profile` > `API Tokens` > `Create Token` > `Custom token`.

Use the narrowest permissions that work for your account:

- `Account` > `Cloudflare Workers Scripts` > `Edit`
- `Account` > `D1` > `Edit`

Scope the token to the account that will own the Worker and D1 database. If Cloudflare renames these permissions later, the intent is the same: edit Workers and D1 for one account.

## Find your account ID

The workflow also needs `CLOUDFLARE_ACCOUNT_ID`.

Usually:

1. Open the Cloudflare dashboard.
2. Select the account you want to deploy into.
3. Open any Workers, D1, or domain page inside that account.
4. Copy `Account ID` from the right sidebar.

If the sidebar is not visible, open the Workers overview for the account. The account ID is also present in many dashboard URLs after `/accounts/`.

## Add GitHub secrets

In GitHub, open `Settings` > `Secrets and variables` > `Actions` > `Secrets`.

Add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PULSEFLARE_BOOTSTRAP_TOKEN` if you want to run the protected bootstrap endpoint after deployment

## Enable deployment

Deployment is off by default so forks and development repos do not deploy by accident.

In GitHub, open `Settings` > `Secrets and variables` > `Actions` > `Variables`.

Add:

- `PULSEFLARE_ENABLE_DEPLOY` = `true`

Optional variables:

- `PULSEFLARE_WORKER_NAME` defaults to `pulseflare-status`
- `PULSEFLARE_D1_NAME` defaults to `pulseflare-d1`
- `PULSEFLARE_CHECK_CRON` defaults to `* * * * *`
- `PULSEFLARE_REMOTE_PROBE_URL` is optional and enables shared remote execution for checks using `probe.kind = 'region'`

Leave `PULSEFLARE_ENABLE_DEPLOY` unset anywhere that should only test and build.

## First deploy

Push to `main` or run the `Deploy Pulseflare` workflow manually.

The first deploy:

- install dependencies
- run tests, build, and lint
- find or create the configured D1 database
- apply migrations from `apps/worker/migrations`
- deploy the Worker from `apps/worker`
- serve the web UI from `apps/web/dist` as Worker static assets

If `PULSEFLARE_BOOTSTRAP_TOKEN` is set, the workflow stores it as a Worker
secret after deployment. Bootstrap with a `POST` request and an authorization
header:

```bash
curl -X POST \
  -H "Authorization: Bearer $PULSEFLARE_BOOTSTRAP_TOKEN" \
  https://status.example.com/api/install/bootstrap
```

Webhook secrets referenced by `secretName` must also be added as Worker
secrets. Keep those values out of `pulse.config.ts` and Git history.

## Troubleshooting

If `Resolve Cloudflare resources` fails with a missing token message, check that both GitHub secrets exist and are available to Actions.

If deployment is skipped, check that `PULSEFLARE_ENABLE_DEPLOY` is a repository variable, not a secret, and that its value is exactly `true`.

If D1 migration fails, rerun the workflow after checking that the API token has D1 edit access for the target account.

If static assets do not update, check that the `Verify project` step built `apps/web/dist` before deploy.

If a regional probe always reports that no shared endpoint is configured, check that `PULSEFLARE_REMOTE_PROBE_URL` is set as a repository variable and points to a probe service that accepts Pulseflare's JSON probe contract.
