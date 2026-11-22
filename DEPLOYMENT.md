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
   never through chat or source. Configure the separate
   [database-acceptance environment](#database-acceptance-in-github) and verify
   a manual acceptance run before enabling the first automatic release with this flow.
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
| Secret | `DATABASE_URL` | Production pooled Neon URL (`-pooler` hostname) for the application |
| Secret | `DATABASE_URL_UNPOOLED` | Direct owner URL for the **same endpoint/database**, without `-pooler` |
| Secret | `BETTER_AUTH_SECRET` | Independent cryptographically random secret, at least 32 characters |
| Secret | `PASSWORD_PEPPER` | Separate stable random secret, at least 32 characters; encrypted backup required |
| Optional secret | `RESEND_API_KEY` | Sending-only Resend key for password recovery |
| Optional variable | `RESET_EMAIL_FROM` | Email address on a verified Resend sending domain |

`BETTER_AUTH_URL=https://exam.phonet.app` is public configuration in Wrangler and
the release workflow, not another secret or a `VITE_` setting. Do not rotate an
existing pepper when connecting an existing database: preserve the pepper that
created its password hashes. Changing it makes those passwords unverifiable.

The production URLs can use the same Neon login. They must use TLS and point to
the same endpoint and database. The Neon management key belongs in the separate
acceptance environment below.

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

- **All PRs, including forks.** The package job typechecks, runs database-free unit
  tests, builds the frontend and Node app, and checks both Worker configurations
  and the production package budget. Mocked Chromium and Docker build jobs run in
  parallel. The required **Typecheck, unit tests, builds and Worker package** check
  aggregates all three results. New commits cancel superseded runs on the same PR.
  Jobs use a read-only token and run without secrets or deployment environments.
- **Every release.** CI builds and publishes an immutable artifact containing the
  frontend, Node build, generated Node Prisma client, and production Worker bundle
  with its WebAssembly module and source map. **Database acceptance** verifies those
  builds on Node and Workerd against a dedicated database in the isolated Neon project.
  GitHub serializes runs that share the database. The job verifies both connections,
  applies pending migrations, and checks that the suites clean up their test accounts
  before production can run.
  The manual **Database acceptance** action on `main` builds and tests the same package.
- **Production.** The deployment job downloads the accepted artifact by ID from the
  same run. It validates configuration and the package, checks review schedules,
  applies migrations with the direct URL, and runs the free-tier and password
  readiness checks. Wrangler deploys the prebuilt Worker, assets, and matching
  secrets together. A readiness failure blocks deployment, including when legacy
  scrypt credentials remain. Use the Node sign-in migration path documented in README
  to upgrade those credentials.
- **Queue and smoke.** Release runs are serialized. GitHub checks the current `main`
  SHA when a queued run starts, after acceptance, and immediately before production
  preflight. A superseded run exits before production changes. Once preflight starts,
  the release runs through completion. Smoke checks HTML, JavaScript, `/history` SPA
  fallback, JSON API errors, private-response cache policy, and the exact Cloudflare
  release tag on `/api/health`. Historical clone conversion starts only after smoke
  succeeds. The Actions summary records the commit, attempt tag, and failed phase.

Retry a failed current release through **Release** on `main`. Rerunning failed jobs
can use an artifact from an earlier attempt of the same run. Start a fresh run if
the artifact expired. After a newer commit reaches `main`, use that commit for the
next release. Use the explicit rollback procedure below for recovery to an older version.

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
point before risky changes. Database acceptance applies pending migrations to the
dedicated test database. Rehearse upgrades and backfills against the
preceding schema in a dedicated test database before release.

After the live-set cutover, the minimum compatible code revision is `7e0fcae`.
Earlier builds hide live viewer memberships and lack the retired-ID route.
Use the deployed version's commit label to verify the viewer and alias paths.
Record its actual Cloudflare version ID and verify that its database binding
will work after credential rotation. If no deployed version qualifies, ship a
forward fix or deploy a compatible build with current secrets.

For an application rollback, pause new releases, inspect the currently deployed
version and schema compatibility, then use an authorized shell:

```sh
npm ci
npm exec -- wrangler deployments list --env production
npm exec -- wrangler rollback VERSION_ID --env production
npm run smoke -- https://exam.phonet.app
```

Worker rollback changes the deployed Worker version. SQL migrations and live data
persist. Keep the current password hashing callbacks and pepper. For schema or
data repair, use a reviewed forward migration or restore a Neon recovery point
into a **separate branch**, verify viewer access and converted IDs, and reconcile
writes made after the recovery point before switching traffic. Fix or revert
`main` through review to keep the next release aligned with the rollback.
[Cloudflare rollback behavior](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Diagnosing readiness failures

Migrations use the direct connection; runtime readiness uses the pooled connection.
A successful migration does not prove that the runtime role/password can connect.
Readiness failures report the failing stage and safe SQL/Prisma error category.
Check the production `DATABASE_URL` first for credential/access errors. Missing
schema/functions after a manual reset require reviewed schema repair; retaining
migration history can prevent already-applied migrations from recreating objects.
Never clear more data just to bypass a readiness error.

## Restricted runtime credential rollout

Production can adopt a restricted runtime login as a separate rollout. Live database acceptance requires one.

1. Rehearse the new role through Node and Worker in the isolated test project. Record results for sign-up, sign-in, backup and restore, scheduling, viewer access and converted IDs. Verify the pooled role cannot modify schema, truncate tables, change triggers, access migration history, or read recovery payloads.
2. In the separately authorized rollout, verify the active production Worker’s bindings, its deploy commit and the rollback candidate’s version ID. Secure a Neon recovery point. Set `DATABASE_URL_UNPOOLED` explicitly to the verified direct migration owner and supply a random 64-digit hex `RUNTIME_DATABASE_PASSWORD` through the shell environment. Run `node --import tsx scripts/provision-runtime-role.ts`. Rerunning the script reapplies grants and leaves an existing role’s password in place.
3. Build the pooled URL with the new role and password. Verify the connection and password hashing with `npm run cloudflare:check` after building both packages. Stage the GitHub production `DATABASE_URL` secret, then run Release. Verify the serving version and viewer access before rotating any credential still used by the active or rollback version. Keep the pepper stable.
4. Give routine auditors a separate SQL-created read-only role with schema usage and explicit `SELECT` on approved tables or views. Keep `recovery` and credential secrets limited to authorized maintenance access.

## Database acceptance in GitHub

Create a protected `database-acceptance` environment restricted to `main`.
For automatic releases, use the branch restriction without a required reviewer.

1. Pick a dedicated branch in a Neon test project independent of production.
   Apply the initial schema, create the restricted runtime role, and install
   the test marker using [Test database setup](#test-database-setup).
2. Add these **environment secrets** to `database-acceptance`.

   | Secret | Value |
   | --- | --- |
   | `TEST_DATABASE_URL` | Pooled TLS URL for `examprep_runtime` on the test branch |
   | `TEST_DATABASE_URL_UNPOOLED` | Direct TLS URL for the owner of the same test database |

   Paste the raw `postgresql://...` URLs. The runtime host has `-pooler` and
   uses the password set for `examprep_runtime`. The direct host has the same
   endpoint without `-pooler` and uses the owner's credentials, typically
   `neondb_owner`. Both URLs use the same database name and include
   `sslmode=require` or a stricter TLS mode.

3. Use Actions → **Database acceptance** → Run workflow on `main` to verify
   the environment. The workflow generates fresh auth secrets, verifies both
   database connections, applies pending migrations, and runs the Node and Worker
   suites. Each suite cleans up its own test accounts. The job checks for
   leftover accounts before migration and after each runtime.

If a canceled or failed run leaves accounts behind, inspect the dedicated branch
and remove only confirmed test accounts or prepare a new dedicated branch.
If a schema change requires new runtime grants, apply the migration and rerun
`scripts/provision-runtime-role.ts` against the verified test branch before
retrying. Keep the pooled and direct secrets pointed at the same branch.

## Test database setup

Use an empty Neon branch in the isolated test project. Verify its
endpoint in Neon and set `DATABASE_URL_UNPOOLED` to that branch's direct owner
connection. Set `RUNTIME_DATABASE_PASSWORD` to a random 64-digit hex value and
keep it for the pooled connection. Apply migrations and provision the pooled role.

```sh
npm ci
npm run build
npm run db:migrate
node --import tsx scripts/provision-runtime-role.ts
```

In the verified test database, run this SQL as its owner to mark it for acceptance.
If you already installed the old marker and its table contains a row, reuse it.

```sql
CREATE SCHEMA examprep_test;
CREATE TABLE examprep_test.target (enabled boolean PRIMARY KEY CHECK (enabled));
GRANT USAGE ON SCHEMA examprep_test TO examprep_runtime;
GRANT SELECT ON examprep_test.target TO examprep_runtime;
INSERT INTO examprep_test.target (enabled) VALUES (true);
```

## Local database acceptance

Use a separate branch if CI may be running against its configured database.
Prepare it as described in [Test database setup](#test-database-setup), then run
`npm exec -- playwright install chromium`.

Put the pooled runtime URL in `TEST_DATABASE_URL` and the direct owner URL in
`TEST_DATABASE_URL_UNPOOLED`.
Add dedicated `BETTER_AUTH_SECRET` and `PASSWORD_PEPPER` values to an ignored
`.env.test` and run `node --env-file=.env.test --import tsx scripts/acceptance.ts`.
For a standalone Node test server, also set its runtime `DATABASE_URL` to the
same pooled URL, its `BETTER_AUTH_URL` to its loopback origin, and
`TEST_DATABASE_MODE=1`. For a standalone Worker, set the same values in the
test-only `.dev.vars`. The wrapper configures both automatically and starts
Node and Worker on ports 8791 and 8792.

## Review schedule preflight

Run `node --import tsx scripts/check-review-schedules.ts` with the verified
direct URL before applying the recovery migration to an existing database. The
read-only check reports aggregate counts of invalid and future-dated rows. If
it reports a problem, export the affected rows under maintenance access and
review them against legitimate completed attempts before applying a repair.
Backup replay skips schedules for edited or removed cards. Practice on the
current card establishes its new schedule.

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

## First administrator

Apply the `202611200001_admin_discover` migration before releasing the updated Node server or Worker. The migration uses PostgreSQL’s `pg_trgm` extension for indexed directory search. All existing sets start unpublished.

After the intended administrator registers, verify their exact account ID in the target database. Run the following command from a checkout with generated Prisma clients and the target `DATABASE_URL`.

```sh
node --import tsx scripts/promote-admin.ts '<exact-user-id>'
```

Reload the app to see Admin. Further promotions, suspensions, and role changes can be made in the Admin tab.

### Convert historical library clones

Apply `202611210001_live_sets` through the Release workflow. It inventories the existing set IDs and tracks old copy receipts during rollout. The new app records intentional editable copies separately. The production release audits, converts verified eligible copies, and reconciles counts after the updated Worker passes smoke checks. A database completion marker makes this a one-time operation. A failed run resumes on the next successful release. The commands below also support rehearsals and reviewed follow-up cases.

1. Rehearse on a disposable production branch and verify a recovery point. Use its direct Neon connection in `DATABASE_URL_UNPOOLED`. Run `npm run db:convert-clones -- --details` for a read-only inventory. The report contains set IDs, revisions, candidate IDs and eligibility reasons. Keep detailed reports private.
2. Verify the provenance of untracked copies using source and content history. Supply a local JSON array of objects with `copyId`, `sourceId`, the audited `revision`, and an `evidence` string describing what verifies provenance, using `--matches path/to/matches.json`. Conversion also requires exact content equality and current access. A recorded origin that is missing or conflicts with the mapping stays under review.
3. With the production direct connection, audit again. Run `npm run db:convert-clones -- --apply` to convert all verified eligible entries, or add `--copy ID` for one. The script commits each conversion atomically. Interrupted runs are safe to repeat. Existing placements take precedence. For multiple copies, the most recently studied one supplies initial preferences.
4. Repeat the read-only audit and reconcile counts. Renamed, edited, shared, nested and inaccessible sets remain independent. Overlapping unfinished spaced reviews can be converted once one is completed.
5. To recover an already retired clone, use the direct migration owner and run `npm run db:convert-clones -- --recover --copy ID`. Add `--apply` to recover a private independent set with a new ID. The command restores matching, valid schedules and the original folder when available. It preserves the archived copy record, retired-ID alias, and existing attempt history. A retry reports the same recovered ID.
