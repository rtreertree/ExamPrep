# GitHub → Cloudflare deployment

One `exam-prep` Worker serves React/Vite assets and Hono at the same origin,
`https://exam.phonet.app`. Neon remains the only durable store. The Docker/Node
entry point uses the same application and migrations.

## Initial setup

1. Source belongs in [rtreertree/ExamPrep](https://github.com/rtreertree/ExamPrep),
   default branch **main**. This folder had no Git history; the first commit preserves
   the existing application. Local secret files, dependencies and generated builds
   are ignored. Do not commit them.
2. In GitHub Settings → Environments, use **integration** and **production**, each
   restricted to the branch `main` (no tag rules). These restrictions and the
   verified production account variable were configured during setup. Add the
   configuration below through those environments, never through chat or source.
3. Create a **separate Neon CI project**, with a parent branch named **ci-empty**.
   Its configured database must have no application tables or users. Do not clone
   production or point CI at a production project. Give CI a project-scoped Neon
   API key able to create/read/delete branches and retrieve connection URIs there.
4. Choose a separate production Neon database. Keep production credentials out of
   the CI project. Copy its pooled and direct URLs into the production environment.
   Enable TLS (`sslmode=require` or a stricter verification mode) on both.
5. Use the active `phonet.app` zone in the connected deployment Cloudflare account.
   The hostname was corrected to `exam.phonet.app` by the owner after account
   inspection; no DNS record was replaced.
   The `production` Wrangler environment attaches the exact requested custom domain
   and lets Cloudflare manage its DNS/certificate. Check for an existing conflicting
   record/service before the initial attachment; never overwrite another service.
6. Provision the initial Worker/domain with an authorized administrator, or give the
   initial deployment token the permissions to create the Worker. For ongoing CI,
   use a token scoped to **exam-prep** with Workers **Editor** access; changing the
   custom domain also requires zone **Workers Routes Write** on `phonet.app` only.
   Legacy API-token UI names are **Workers Scripts: Edit** and **Workers Routes:
   Edit**. Add account/zone read access only if required for Wrangler discovery.
   Do not grant unrelated KV, R2, D1, DNS-edit or all-zone permissions.
7. GitHub Actions is enabled. `main` is protected with the PR CI check
   **Typecheck, unit tests, builds and Worker package**, up-to-date branches,
   disabled force pushes/deletion, and owner review for changes. Administrator
   recovery bypass remains available. CODEOWNERS identifies the owner. Environment reviewers are optional; enabling
   them adds an approval gate to otherwise automatic releases. Keep integration
   available to scheduled cleanup without a human approval gate.
8. Push/merge reviewed source to `main`, or select Actions → **Release** → Run
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

`BETTER_AUTH_URL=https://exam.phonet.app` is public configuration in Wrangler and
the release workflow, not another secret or a `VITE_` setting. Do not rotate an
existing pepper when connecting an existing database: preserve the pepper that
created its password hashes. Changing it makes those passwords unverifiable.

GitHub **integration** environment:

| Kind | Name | Value/purpose |
| --- | --- | --- |
| Secret | `NEON_API_KEY` | API key scoped to the dedicated CI project |
| Variable | `NEON_PROJECT_ID` | Dedicated CI project ID |
| Variable | `NEON_PARENT_BRANCH_ID` | ID of that project's empty `ci-empty` branch |
| Variable | `NEON_DATABASE_NAME` | Database inherited from the empty parent |
| Variable | `NEON_ROLE_NAME` | Role inherited from the empty parent; can apply migrations and install pgcrypto |

Each run retrieves **its child branch's** pooled/direct URLs and generates fresh
auth secrets. They are masked before writing the runner environment, never exposed
as job outputs, and never copied from production. GitHub supplies run/repository
IDs automatically. No Cloudflare token is needed by integration tests.

Cloudflare production bindings:

| Binding | Source |
| --- | --- |
| `ASSETS` | Wrangler-managed `dist/client` static assets |
| `BETTER_AUTH_URL` | Production `vars`, exact HTTPS origin above |
| `DATABASE_URL`, `BETTER_AUTH_SECRET`, `PASSWORD_PEPPER` | Worker secrets uploaded atomically with code from GitHub production secrets |

The direct migration URL, Neon API key and Cloudflare API token are **never Worker
bindings**. No Hyperdrive, Pages, extra database, OAuth provider or mail service is
needed. `PORT` applies only to Node. Local `.env`/`.dev.vars` remain ignored and are
not uploaded. Never enable SQL parameter logging or dump runtime environments.

## Checks and release ordering

- **All PRs, including forks:** read-only GitHub token; no environments or secrets;
  `npm ci`, generated clients/assets, TypeScript, focused unit tests, production
  frontend/Node builds, default and production Wrangler dry runs, Docker image build.
  Actions are pinned to verified release commits; Node is 24.14.0 and the existing
  dependency lockfile is retained. Checkout does not persist Git credentials;
  package-manager caches are disabled between trust boundaries.
- **Trusted `main` only:** after CI passes, create a disposable Neon branch, apply
  the complete migration chain, then run all five live API tests and all three
  Chromium workflows sequentially on packaged Node and local Workers/workerd.
  Tests cover auth/password changes, two-account isolation, strict import/export,
  persistence/resume, revision conflicts, grading/partial credit, immutable snapshots,
  source deletion, mistake retries, flashcards, draft recovery and responsive UI.
  The auth limiter stays enabled. Browser plugin was unavailable locally; the
  repository's pinned Playwright Chromium suite supplies browser acceptance.
- Cleanup runs with `always()` after failures. Test suites remove their unique
  accounts; branch deletion removes the remaining isolated database/session/rate
  limiter state. Interrupted POST responses are recovered by exact run name.
  A six-hour scheduled/manual janitor removes only this repository's CI-prefixed,
  nondefault, unprotected children of the configured parent older than two hours.
  It paginates and rechecks live metadata before deleting. If Actions is disabled
  or the API is unavailable, run cleanup manually after restoring access. Neon
  branch TTL is not assumed: the current API documents access restrictions.
- **Production:** only after both jobs succeed, rebuild/dry-run, validate configuration,
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

Never use `pull_request_target` to execute PR code. Secret-backed acceptance is
intentionally unavailable to fork and same-repository PR heads; merge only reviewed
changes to trusted `main` before running it. Do not weaken environment branch rules
to make a PR integration run possible. Do not run a second Cloudflare Git build
pipeline that can deploy without these checks.

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
This implementation uses isolated local Workers in CI instead. To add public previews
later, create a separate Worker and disposable Neon branch per preview, generate
independent auth secrets and use that preview's **exact HTTPS origin**; never reuse
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
point before risky changes. The CI empty branch proves fresh installation, not every
upgrade/backfill against existing production data.

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

Still required: integration's Neon API key/four variables, production's five secrets,
and production database region for an explicit placement decision.
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
- [Neon branch creation](https://neon.com/docs/reference/api/branches/create-project-branch), [connection URIs](https://neon.com/docs/reference/api/projects/get-connection-uri), [pagination](https://neon.com/docs/reference/api/branches/list-project-branches)
- [Better Auth Prisma compatibility](https://better-auth.com/docs/adapters/prisma) and [secure cookies](https://better-auth.com/docs/concepts/cookies)
