# Exam Prep

A private exam and flashcard application. TypeScript, React/Vite, Hono, Better Auth, Prisma 7, and Neon PostgreSQL. AI authoring happens outside the app. The repository's requirements, implementation plan, design, and authoring skill remain the product references; their earlier “planning only” wording predates this implementation.

## Start locally

Use Node **24.14+** (the tested version is 24.14.0) and npm. All direct dependencies are exact-pinned; commit and use `package-lock.json` with `npm ci`.

1. Create a **dedicated Neon test/development branch**. Keep production data separate.
2. `cp .env.example .env`. Set `DATABASE_URL` to the pooled Neon URL, `DATABASE_URL_UNPOOLED` to the direct migration URL, `BETTER_AUTH_URL=http://127.0.0.1:8787`, and separate cryptographically random `BETTER_AUTH_SECRET` and `PASSWORD_PEPPER` values of at least 32 characters each. Keep an encrypted backup of the pepper: it must remain stable to verify existing passwords. These files are ignored. Never use `VITE_` prefixes for secrets.
3. `npm ci`
4. `npm run db:migrate`
5. `npm run build`
6. `npm start` and open [Exam Prep](http://127.0.0.1:8787).

Register an account in the application. There are no seeded users, sets, or simulated saves. The supplied examples are available in Create → Create with your AI, or under `public/downloads`.

For frontend development, set `BETTER_AUTH_URL=http://127.0.0.1:5173` in `.env`, run `npm run dev:api` and `npm run dev` in separate terminals, and visit port 5173. Vite proxies `/api` to port 8787. Use one consistent hostname; cookies and trusted origins depend on it. Rebuild and restore the public origin when testing the packaged app.

## Cloudflare Workers

The Worker serves the API and Vite static assets on one origin. Copy the four **runtime** settings (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `PASSWORD_PEPPER`) into an ignored `.dev.vars` for local `npm run dev:worker`; keep its URL equal to the local Worker origin. Node and Worker must use the same pepper when sharing a database. Do not put the migration connection into Worker secrets.

```sh
npm run build
npm run worker:check
npm run dev:worker
```

GitHub CI/CD, exact secrets, domain setup, migration ordering and rollback are documented in [DEPLOYMENT.md](DEPLOYMENT.md). PR checks use no secrets. Reviewed `main` changes run API/browser acceptance on a disposable Neon branch, then the **production** GitHub environment deploys the Worker and assets together. Actions → **Release** also supports manual deployment from `main`. Production migration/deployment scripts are restricted to that job; use the workflow instead of deploying the top-level local Worker configuration.

The release keeps the existing `cloudflare:check` readiness guard. It uses the deployment database and is read-only apart from a transient hashing probe; it refuses remaining old-format credentials. Use `npm run cloudflare:check -- --local` to check an intentional localhost origin. `/api` and `/api/*` reach Hono and never fall back to the SPA. Public version previews are disabled to avoid sharing production resources. No production migration or public deployment was performed during local validation.

The configuration targets **Workers Free**: there is no paid-only CPU setting, the Worker is minified, and static assets bypass application execution. Better Auth still owns registration, sign-in, password changes, sessions, and throttling. Its password callbacks delegate slow hashing to native PostgreSQL `pgcrypto` bcrypt at cost **12**, installed by the second migration. The Worker performs only a small native HMAC-SHA384 pre-hash with a separate secret pepper, then awaits the database. Its 64-character base64 output avoids bcrypt's 72-byte truncation and NUL limitations without truncating Unicode passwords. This follows [OWASP's peppered bcrypt pre-hash recipe](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pre-hashing-passwords-with-bcrypt). No plaintext password or pepper is sent to SQL; SQL parameters must still be treated as sensitive. Keep TLS enabled and do not log query parameters.

The deployment check enforces a conservative 3-MiB compressed Worker budget, static asset limits, HTTPS/TLS settings, pepper configuration, pgcrypto availability, and credential migration readiness. Cloudflare Free still has platform quotas, including **10 ms CPU per request** and **100,000 Worker requests per day**. Moving password work to Neon removes that expensive calculation from Worker CPU; it does not guarantee every allowed large document or peak workload fits 10 ms. Local workerd does not enforce production CPU accounting. Before production reliance, measure registration, sign-in, password changes, maximum-size imports, grading, and retries on the actual free account. Neon compute/storage quotas are separate. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).

### Existing password migration

Old Better Auth scrypt hashes cannot be converted without a successful password verification. Apply migrations, configure the stable pepper, and run the updated **Node** application with `npm start`. Each existing account owner saves any editor drafts, signs out, and signs in once with their current password. Normal sign-out clears device drafts; alternatively, sign in through a separate private browser window to preserve the current browser session. A successful verification upgrades that credential with compare-and-set; account IDs, sessions, study sets, and historical attempts remain intact. Incorrect passwords do not change records. Then run `npm run cloudflare:check` against the database intended for deployment. It blocks deployment readiness until every credential uses the supported format. Workers deliberately refuse old hashes instead of falling back to CPU-heavy scrypt. Do not delete users, reset passwords, or reduce hashing strength to bypass the check. Keep the Node migration path available until all required accounts have upgraded.

`PASSWORD_PEPPER` is a long-lived credential, separate from the rotatable session secret. Use different peppers for production and test databases, and the same pepper across runtimes sharing one database. Changing or losing it makes its existing hashes unverifiable. Restore the original pepper if configuration drifts; password recovery/email delivery remain outside scope. A rollback to the old application cannot read new password hashes, so retain this password adapter when rolling back other application changes.

Prisma generates separate Node and Cloudflare loaders from the **same schema** because their WebAssembly loading mechanisms differ. Both use the Neon adapter; both call the same Hono routes and domain rules. Each request creates a client and disconnects it in `finally`, including auth and failure paths. No database pools or request state are reused across Worker requests.

## Container package

```sh
docker build -t exam-prep .
docker run --rm --env-file .env -p 8787:8787 exam-prep
```

Use an HTTPS reverse proxy and set `BETTER_AUTH_URL` to its exact external origin for production. The image uses Node 24.14.0, a non-root user, production dependencies, static assets, a health check, `PORT`, and graceful shutdown. Secrets are injected at runtime and excluded from build context. Neon holds all durable account data; local container disk is disposable. Migrations are never applied automatically during startup.

The Node server replaces incoming IP headers with the actual socket address before authentication throttling. Behind a proxy, requests may share a proxy IP counter; do not blindly trust arbitrary forwarded headers. The Worker trusts only Cloudflare's `cf-connecting-ip`. Better Auth's database-backed rate limiter permits five requests per minute on registration, sign-in, and password changes, with a broader per-route limit elsewhere.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm run worker:check
```

`npm test` runs the shared file/grading/storage tests and skips live database tests. To run the real database acceptance suite, start either local runtime against a **dedicated test branch**, then explicitly opt in:

```sh
RUN_DATABASE_TESTS=1 TEST_BASE_URL=http://127.0.0.1:8787 npx vitest run tests/api.integration.test.ts
node --import tsx scripts/compatibility.ts http://127.0.0.1:8787
npx playwright install chromium
npm run test:e2e
```

For automated startup, API/browser/smoke tests on **both** runtimes, and server
cleanup, use `TEST_DATABASE_CONFIRMED=1 npm run test:acceptance` after building and
installing Chromium. This uses ports 8791/8792 and the dedicated test database in
`.env`; it never overwrites `.dev.vars` or targets the production domain.

The integration and browser suites use unique disposable accounts and delete those accounts and their owned records afterward. They read the ignored `.env` for cleanup, so its database **must match the runtime being tested**. Never run them against production. Keep browser tests sequential because the real persistent auth limiter is enabled. Rapid repeated test runs can correctly hit throttling; allow the 60-second window to expire.

Browser tests expect a running **built** app. Set `TEST_BASE_URL` to the Worker origin to repeat them there; that runtime's `BETTER_AUTH_URL` must match. Screenshots and browser output go to `/tmp`, not source control. Browser plugin availability and executed checks are recorded in [verification notes](VERIFICATION.md).

## Implementation notes

- [Portable contract](skills/exam-prep-author/SKILL.md), [generated JSON Schema](public/downloads/examprep.schema.json), and [additional validation](VALIDATION.md). `npm run generate` republishes the skill and extracts/validates its two canonical examples.
- Local editor drafts use account-scoped IndexedDB. Recovery is explicit; drafts can contain invalid intermediate forms. Explicit Save validates and writes to Neon. Sign-out clears that account's device drafts.
- Practice saves show confirmation only after the server responds. Conflicts retain local input and offer a download plus loading the confirmed revision. Editor conflicts offer Save as new or Discard. Browser unload/navigation warns about unconfirmed work; practice is not offline-synchronized.
- Attempts snapshot content at creation. Source deletion clears the reference, preserving historical content/results. Server grading and assessments use only that snapshot. Submission is idempotent; completed attempts are read-only.
- The API caps request bodies at 8 MiB, with a separate exact 2 MiB content-file limit. Library/history pages contain 30 metadata records; SQL projections keep full documents and response snapshots out of list payloads. Authoring exports include answer keys intentionally.
- `/api/health` checks the process; authenticated `/api/ready` also checks the database. Private responses use `no-store`; same-origin mutations, secure HTTPS cookies, content security policy, and safe Markdown/KaTeX rendering are enforced.
- Fonts and math assets are bundled locally with licenses. There are no AI SDKs, analytics calls, external fonts, or external content/media loads.

Password recovery, email delivery/verification, built-in AI, and the other documented exclusions are not implemented.
