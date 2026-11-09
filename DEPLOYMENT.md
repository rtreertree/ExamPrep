# GitHub → Cloudflare deployment

One `exam-prep` Worker serves React/Vite assets and Hono at the same origin,
`https://exam.phonet.app`. Neon remains the only durable store. The Docker/Node
entry point uses the same application and migrations.

## Initial setup

1. Source belongs in [rtreertree/ExamPrep](https://github.com/rtreertree/ExamPrep),
   default branch **main**. This folder had no Git history; the first commit preserves
   the existing application. Local secret files, dependencies and generated builds
   are ignored. Do not commit them.
2. In GitHub Settings → Environments, use **production**, restricted to the branch
   `main` (no tag rules). This restriction and the verified account variable were
   configured during setup. Add the configuration below through that environment,
   never through chat or source. No integration environment or Neon API key is needed.
3. Choose a production Neon database separate from local development/test data.
   Copy its pooled and direct URLs into the production environment. Enable TLS
   (`sslmode=require` or a stricter verification mode) on both.
4. Use the active `phonet.app` zone in the connected deployment Cloudflare account.
   The hostname was corrected to `exam.phonet.app` by the owner after account
   inspection; no DNS record was replaced.
   The `production` Wrangler environment attaches the exact requested custom domain
   and lets Cloudflare manage its DNS/certificate. Check for an existing conflicting
   record/service before the initial attachment; never overwrite another service.
5. Provision the initial Worker/domain with an authorized administrator, or give the
   initial deployment token the permissions to create the Worker. For ongoing CI,
   use a token scoped to **exam-prep** with Workers **Editor** access; changing the
   custom domain also requires zone **Workers Routes Write** on `phonet.app` only.
   Legacy API-token UI names are **Workers Scripts: Edit** and **Workers Routes:
   Edit**. Add account/zone read access only if required for Wrangler discovery.
   Do not grant unrelated KV, R2, D1, DNS-edit or all-zone permissions.
6. GitHub Actions is enabled. `main` is protected with the PR CI check
   **Typecheck, unit tests, builds and Worker package**, up-to-date branches,
   disabled force pushes/deletion, and owner review for changes. Administrator
   recovery bypass remains available. CODEOWNERS identifies the owner. Environment reviewers are optional; enabling
   them adds an approval gate to otherwise automatic releases.
7. Push/merge reviewed source to `main`, or select Actions → **Release** → Run
   workflow on **main**. No arbitrary SHA or PR-ref deployment input is accepted.

## Exact environment configuration

GitHub **production** environment:

| Kind | Name | Value/purpose |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | `90145ce51d276d276787dc0ee9561f0a` (verified, already set) |
| Secret | `CLOUDFLARE_API_TOKEN` | Scoped deployment token described above |
| Secret | `DATABASE_URL` | Production pooled Neon URL (`-pooler` hostname); runtime access |
| Secret | `DATABASE_URL_UNPOOLED` | Direct URL for the **same endpoint/database**, without `-pooler`; migration tooling only |
| Secret | `BETTER_AUTH_SECRET` | Independent cryptographically random secret, at least 32 characters |
| Secret | `PASSWORD_PEPPER` | Separate stable random secret, at least 32 characters; encrypted backup required |
| Optional secret | `RESEND_API_KEY` | Sending-only Resend key for password recovery |
| Optional variable | `RESET_EMAIL_FROM` | Email address on a verified Resend sending domain |

`BETTER_AUTH_URL=https://exam.phonet.app` is public configuration in Wrangler and
the release workflow, not another secret or a `VITE_` setting. Do not rotate an
existing pepper when connecting an existing database: preserve the pepper that
created its password hashes. Changing it makes those passwords unverifiable.

GitHub requires no Neon management API key, CI project, branch IDs or test-database
secrets. Production connection URLs are still required for persistence and migrations.

Cloudflare production bindings:

| Binding | Source |
| --- | --- |
| `ASSETS` | Wrangler-managed `dist/client` static assets |
| `BETTER_AUTH_URL` | Production `vars`, exact HTTPS origin above |
| `DATABASE_URL`, `BETTER_AUTH_SECRET`, `PASSWORD_PEPPER` | Worker secrets uploaded atomically with code from GitHub production secrets |
| `RESEND_API_KEY`, `RESET_EMAIL_FROM` | Optional Worker bindings included when both production settings are provided |

The direct migration URL and Cloudflare API token are **never Worker bindings**. Resend is used only for password recovery. `PORT` applies only to Node. Local `.env`/`.dev.vars` remain ignored and are
not uploaded. Never enable SQL parameter logging or dump runtime environments.

## Checks and release ordering

- **All PRs, including forks:** read-only GitHub token; no environments or secrets;
  `npm ci`, generated clients/assets, TypeScript, focused unit tests, production
  frontend/Node builds, default and production Wrangler dry runs, Docker image build.
  Actions are pinned to verified release commits; Node is 24.14.0 and the existing
  dependency lockfile is retained. Checkout does not persist Git credentials;
  package-manager caches are disabled between trust boundaries.
- **Production:** only after the CI checks succeed, rebuild/dry-run, validate configuration,
  apply production migrations with the direct URL, run the existing free-tier/password
  readiness guard, then deploy a matching code/secrets version. A failed readiness
  check prevents deployment, including when legacy scrypt credentials remain.
  Preserve the Node sign-in migration path documented in README; never delete or
  reset users to bypass this guard.
- Deployment concurrency serializes the entire release and never cancels an active
  migration. GitHub environment status, commit-labelled Cloudflare versions and the
  workflow summary identify the release. Post-deploy smoke retries check HTML,
  JavaScript, `/history` SPA fallback, `/api/health`, JSON API errors and unauthenticated
  private-response cache policy. Smoke creates no accounts and makes no writes.

GitHub runs simulated-data Chromium browser regressions with no production secrets.
It runs no live database acceptance tests, creates no Neon branches and schedules no branch cleanup. The optional local API/browser suites use
only an existing dedicated test database connection; no Neon API key is needed.
Those local checks do not gate deployment. Run them locally when changing auth,
ownership, persistence, grading or migrations.

Never use `pull_request_target` to execute PR code. Production credentials are
available only to the production deployment job on trusted `main`; do not weaken
its environment branch rules. Do not run a second Cloudflare Git build pipeline
that can deploy without these checks.

## Origins, routing and previews

Client routes fall back to the SPA; `/api` and `/api/*` always reach Hono. Hashed
`/assets/*` files use immutable caching. Downloaded study examples revalidate;
private APIs always use `no-store, private`. Static CSP, HSTS and other security
headers remain in `_headers`, and Hono owns API headers.

Authentication uses the exact configured origin, HTTPS `Secure`/HttpOnly session
cookies, CSRF/origin checks, account ownership and database sessions. Keep cookies
host-only; do not enable cross-subdomain sharing or wildcard trusted origins. TLS
must be valid on the production hostname. Nothing is split across CORS origins.

Public PR/branch previews are deliberately **disabled** (`preview_urls: false`;
production `workers_dev: false`). A version URL would share production resources.
To add public previews later, create a separate Worker and disposable Neon branch
per preview, generate independent auth secrets and use that preview's **exact HTTPS origin**; never reuse
production secrets or data. Add close/cancel cleanup before enabling preview URLs.

## Migrations and rollback

`npm run db:migrate` now requires a direct, TLS-protected Neon URL. Prisma 7 reads
`DATABASE_URL_UNPOOLED` through `prisma.config.ts`; it never falls back to the pooled
runtime URL. `migrate deploy` applies checked-in migrations, never `migrate dev`,
`reset`, `db push` or a production seed. Migrations do not run at request/startup.

Migrations run **before** new code, while the previous Worker still serves traffic.
Use expand → migrate/backfill → contract across separate releases: additive schema
first, code supporting both shapes next, remove old fields only after old code and
rollback needs are retired. A deploy failure can leave new schema in place; it is
not undone automatically. Review lock duration and take/verify a Neon recovery
point before risky changes. CI does not exercise migrations against a database;
validate schema upgrades and backfills locally against a dedicated test database.

For an application rollback, pause new releases, inspect the currently deployed
version and schema compatibility, then use an authorized shell:

```sh
npm ci
npm exec -- wrangler deployments list --env production
npm exec -- wrangler rollback VERSION_ID --env production
npm run smoke -- https://exam.phonet.app
```

Choose a verified compatible version; never invent a version ID. Worker rollback
does **not** reverse SQL migrations or restore database records. Keep current
password hashing callbacks and the matching pepper; old scrypt-only code cannot
read new hashes. If schema/data need repair, use a reviewed forward migration or
restore a Neon recovery point into a **separate branch**, verify it, and plan the
cutover and any lost writes. Never reset/drop production or automatically run down
migrations. Fix/revert `main` through review so the next automatic release does not
undo the rollback. First deployment has no earlier Worker version to restore.

## Diagnosing readiness failures

Migrations use the direct connection; runtime readiness uses the pooled connection.
A successful migration does not prove that the runtime role/password can connect.
Readiness failures report the failing stage and safe SQL/Prisma error category.
Check the production `DATABASE_URL` first for credential/access errors. Missing
schema/functions after a manual reset require reviewed schema repair; retaining
migration history can prevent already-applied migrations from recreating objects.
Never clear more data just to bypass a readiness error.

## Local reproduction and remaining setup

```sh
npm ci
npm run build
npm test
npm run worker:check
# Only with .env targeting a confirmed dedicated test database:
npm run db:migrate
npm exec -- playwright install chromium
TEST_DATABASE_CONFIRMED=1 npm run test:acceptance
```

Acceptance uses isolated ports 8791/8792 and temporary Worker configuration; it
does not overwrite local secret files or stop another developer server. Local
success does not verify remote Workers Free CPU accounting or production HTTPS
auth. Measure deployed authentication and maximum-size import/grading/retry CPU
before production reliance. Local Docker validation needs a running Docker engine;
GitHub CI builds the image independently.

Production uses the five secrets listed above. Supply the production database
region before choosing explicit placement. No Neon management API key is required.
An older integration environment may contain saved settings, but no workflow uses it.
The test database was not promoted to production. No production migration or public
deployment has been performed as part of local validation.

## Official references checked

- [GitHub environment protection and deployment status](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub secure PR execution](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [Cloudflare static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/)
- [Cloudflare code and secrets in one deployment](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)
- [Cloudflare deployment permissions](https://developers.cloudflare.com/workers/authorization/workers/)
- [Cloudflare rollback limitations](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
- [Prisma 7 configuration and direct migration URL](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [Better Auth Prisma compatibility](https://better-auth.com/docs/adapters/prisma) and [secure cookies](https://better-auth.com/docs/concepts/cookies)

## v1 attempt-progress maintenance migration

Apply `202611080003_attempt_progress` before starting this version. It adds nullable scoring metadata, its private validation-version marker, database protection against later metadata mutation, and an index for unfinished-attempt continuation. Existing records begin at version 0; application code validates their immutable snapshot before installing version-1 metadata. This marker is internal storage bookkeeping, not a portable-file or product version change. The additive columns permit older application code to continue reading existing records. Keep the migration when rolling application code back; do not drop columns or reset data.

Progress acknowledgements and compact submission acknowledgements omit unchanged snapshot/answer data. Full attempt GETs still return the snapshot and confirmed responses for resume. Existing v1 full-map progress clients remain accepted within the existing request cap; the current client sends one changed answer per request and drains all changes before submission or navigation. Measure complete deployed operations, including database transfer and response storage, at the supported maxima before asserting Worker CPU or memory compliance.
