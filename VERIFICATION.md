# Verification — 8 November 2026

## Deployment readiness diagnostics — 8 November 2026

A subsequent release passed migrations but failed the runtime database check with
an overly generic error. The check now identifies its failing stage and translates
known PostgreSQL/Prisma codes into safe guidance for rejected credentials, missing
schema/functions, access permissions or connectivity. It never echoes raw driver
messages, SQL, bound parameters or connection strings. Four unit tests verify the
classification and secret suppression. TypeScript and 103 unit tests pass.

After the owner's data cleanup, read-only checks of the locally configured database
confirmed the account/schema and pgcrypto functions exist and no legacy credentials
remain; the local deployment readiness check passed. This does not establish that
GitHub's encrypted runtime connection matches the local connection. No database
reset, schema repair or account mutation was performed during this investigation.

## CI without Neon integration — 8 November 2026

At the owner's request, GitHub no longer runs live database/API/browser acceptance,
provisions Neon branches or schedules branch cleanup. The branch-management helper
and its tests were removed; production configuration safety tests remain. Release
now depends only on regular CI before the protected production job. No Neon API key
or integration environment is required. Local opt-in acceptance suites remain for
manual verification with a dedicated database connection, without a Neon API key.

Current change validation: TypeScript passed, **99 unit tests passed** (five local
live-database tests skipped), workflow YAML parsed and `git diff --check` passed.
No live database tests were run for this removal.

The reports below describe historical checks and the previous pipeline; they are
not requirements for the current deployment flow. See DEPLOYMENT.md for current setup.

## GitHub CI/CD follow-up — 8 November 2026

Read every project-owned Markdown file before changes; no applicable AGENTS.md
was present. The owner confirmed the ignored local database is still the dedicated
test database, and corrected the production hostname to **exam.phonet.app**.

| Check | Result |
| --- | --- |
| Lockfile installation / dependency audit | `npm ci`; 0 reported vulnerabilities |
| TypeScript, frontend and packaged Node build | Passed |
| Focused unit tests including deployment safeguards | 104 passed; 5 live tests skipped in ordinary unit execution |
| Live Neon API acceptance | 5 passed on Node; 5 passed on local Worker |
| Chromium acceptance | All 3 workflows passed on each runtime (6 total) |
| Frontend/API routing/cache smoke | Passed on Node and Worker after fixing bare `/api` handling |
| Default and production Worker dry runs | Passed; approximately 1619 KiB gzip |
| Generated Worker environment types | Regenerated from Wrangler configuration |
| YAML syntax and action compatibility | YAML parsed; checkout v6.1.0 and setup-node v6.5.0 release SHAs verified; node24 action runtimes checked |
| Configured-secret scan | Passed; local environment values absent from source |
| Docker locally | Unavailable: Docker daemon is not running; GitHub CI includes image build |
| Actual GitHub clean-checkout CI and Docker build | Passed in the initial Release run |
| Neon branch API automation | Removed from the current pipeline at the owner's request |

The new smoke check caught `/api` being served by SPA fallback in an earlier test
configuration. Both the Worker-first asset route and Worker dispatch now include
bare `/api`, and Hono returns a JSON 404 there. Targeted final smoke checks passed
on both runtimes. All API and browser acceptance tests had already passed; none
of their failures were ignored. Tests retained real auth throttling, database
sessions, ownership, snapshots and existing UI behavior. The Browser plugin was
unavailable; the existing pinned Playwright suite was used. Test accounts were
removed by the suites; disposable runtime configuration was removed in `finally`.

The folder initially had no Git repository. Its existing contents were preserved
in an initial commit and connected to the owner's verified empty GitHub repository.
GitHub integration/production environments are restricted to main, and the verified
Cloudflare account ID is configured. Main is protected with required PR CI, owner
review and resolved conversations; force pushes/deletion are disabled (owner
administrator recovery bypass remains available). No production database was used for testing,
no production migrations ran, and no public Worker deployment is claimed. Exact
remaining setup and rollback procedures are in [DEPLOYMENT.md](DEPLOYMENT.md).

The standalone workflow-validator binary could not be downloaded because the
release host/API returned errors. YAML parsing and actual GitHub workflow execution
provide the available workflow checks; full actionlint verification is not claimed.

The first real Release run passed all clean-checkout checks and the Docker build,
then stopped at missing `NEON_API_KEY` configuration. Production was skipped before
migrations or deployment. Cleanup now exits successfully when setup failed before
a branch was created; both this path and successful branch provisioning/secret
masking are covered by regression tests. Branch provisioning was never executed and has now been removed.

The free-tier follow-up at the end of this document supersedes the original password-hashing and paid-tier configuration notes below.

The application was built and exercised against the user-confirmed dedicated Neon test database. No public deployment or production-data modification was performed. Disposable test accounts were confirmed cleaned up after the final run.

| Check | Result |
| --- | --- |
| Shared validation, grading, and reversible-storage tests | **82 passed** |
| Real database API acceptance, packaged Node entry point | **4 passed** |
| Real database API acceptance, local Cloudflare Worker | **4 passed** |
| Chromium browser workflows, packaged Node entry point | **3 passed** |
| Chromium browser workflows, local Cloudflare Worker | **3 passed** |
| TypeScript checks and production build | Passed |
| Prisma schema validation and migration status | Passed; initial migration applied to test database |
| Worker dry-run package and generated binding types | Passed; no deployment |
| Complete dependency audit | **0 reported vulnerabilities** |
| Configured-secret scan of source/public/build artifacts | Passed |
| Both origins: HTML security headers and JSON API routing | Passed |
| Docker image build/run | **Unavailable: local Docker engine is not running** |

Tested versions include Node 24.14.0, React 19.3.1, Vite 7.3.7, Hono 4.13.17, Prisma/client/Neon adapter 7.10.1, Better Auth 1.7.18, Zod 4.6.7, Wrangler 4.158.0, Vitest 5.1.0, and Playwright 1.65.0. Exact dependencies and transitive resolutions are pinned in the lockfile.

## Behavior exercised

The API suite covers two-account isolation across protected operations, authenticated reads and export, strict duplicate-key rejection, concurrent revision checks, cross-session resume, repeated/concurrent submission, frozen responses, invalid rubric bounds, separate automatic/self-assessed scores, source edits/deletion, immutable snapshots, mistake selection, fresh retry responses, flashcard reveal/early finish/counts, account password changes, session revocation/logout, and private pagination across 31 records. Direct database checks confirm that snapshot/result mutation is rejected. Unusual valid IDs, Unicode, JSON-escaped NUL, isolated surrogate escapes, and storage-escape-like literal text are tested without changing their public content.

The browser flows exercise registration, verified clipboard prompt copying, import by paste and file, validation errors, Markdown/math rendering, draft restore/discard, conflicts and Save as new, manual exam/deck creation, rubric authoring/reordering, export preservation, exam save/refresh/resume, submission, binary assessment and 3/5 rubric credit, mistake retry, flashcard reveal/ratings/summary, history listing/resume/completed review, and explicit sign-out. Failure injection verifies retained inputs after failed saves and expired sessions, plus unavailable device storage. Account switching verifies that another account cannot recover the first account's draft.

The final rubric test types a two-digit award, waits beyond ordinary answer debounce, and confirms that assessment remains pending until the field is left. It also exercises prototype-like question/criterion IDs, invalid formula warnings, and locally scrolling long inline/display formulas at 320 px.

The persistent auth limiter remained enabled throughout. Closely spaced test runs correctly produced HTTP 429; test helpers respect the server's retry interval rather than disabling throttling.

## Browser and visual verification

The Browser plugin was unavailable, so verification used the repository's Playwright Chromium tests against `http://127.0.0.1:8787` (packaged Node) and `http://127.0.0.1:8788` (local Worker). Page title/identity, meaningful content, primary interactions, framework-error absence, and console health were checked. Expected injected failures and server throttling were distinguished from application errors.

The accepted references are `design/references/library-minimal.png`, `flashcards-minimal.png`, `exam-practice.png`, `editor.png`, and `mobile-library.png`, with the written tokens/layout rules in `design.md` taking precedence. Reference images and latest browser screenshots were inspected with `view_image`. Desktop screenshots use the native **1536 × 1024** reference size; responsive checks cover **1280, 768, 390, and 320 px**. Editor and practice also run in short 540 px viewports with focused fields. Reduced motion, keyboard tabs, dialog Escape/dismissal, returned focus, horizontal overflow containment, and formula readability were checked.

| Comparison point | Reference / written rule | Verified implementation or intentional difference |
| --- | --- | --- |
| Workspace composition | Open editorial list, narrow sidebar, margin mark | Native lists, 216 px sidebar, shared lime selection; no decorative dashboard cards |
| Palette/material | Matte charcoal, faint ambient tint, selective frosting | Shared tokens/material recipes; matte questions/cards, frosted navigation/overlays with opaque fallbacks |
| Typography | Instrument Sans, IBM Plex Mono, KaTeX fonts | Locally bundled fonts/licenses; 64 px desktop / 40 px phone library heading; stable math rendering |
| Controls | Solid lime primary, outlined secondary, 44 px targets | Shared buttons, fields, menus, tabs, rubric controls; row Practice stays secondary |
| Focus view | 72 px header, centered study column, stable answer rows | Shared exam/deck frame; maximum 800 px study content and readable local math overflow |
| Responsive rows | 20 px phone gutters; actions on their own line | No page-wide overflow at 390 or 320 px; full titles remain readable |
| Real content/copy | Example image lettering/counts are illustrative | Actual imported/manual data and real counts; “Your library”, Import, Create, filters, Library/History/Account preserved |
| Motion | Quiet reveal with one accessible face; reduced-motion alternative | Midpoint face swap, rating actions after settling, timer cleanup, immediate reduced-motion/short-screen reveal |

Visual fixes made during verification: correct field-label associations, locally served fonts under CSP, larger option formulas, non-mirrored flashcard reveal, and screenshots taken after real rows load and animation settles. Intentional differences from raster concepts follow written geometry/type tokens and actual authored content; no image is used as an application background. The implementation was visually verified against the accepted minimal direction.

Calculated contrast checks include muted text on raised surfaces **5.63:1**, muted text over the brightest ambient gradient **6.31:1**, primary text over composited navigation **16.71:1**, control borders against the highest surface **3.05:1**, and primary action labels **14.83:1**.

Screenshots and temporary browser output were produced outside the repository and removed after inspection. The checked-in browser tests reproduce them in `/tmp`.

## Remaining verification limits

- Docker packaging is delivered, but its image could not be built or launched without a running Docker engine. The actual packaged Node entry point passed the database and browser suites directly.
- Workers verification used the local workerd runtime and real Neon persistence. No public Worker was deployed; paid-tier production CPU accounting for password hashing was not benchmarked. Secure hashing defaults were retained.
- Chromium desktop/mobile emulation and reduced motion were exercised. Physical devices, a real mobile software keyboard, assistive-technology sessions, Safari/Firefox, and engines without backdrop-filter support were not available in this run. Short focused-field viewports cover available-space behavior; opaque fallback recipes are present in CSS.

## Free-tier follow-up — 8 November 2026

Removed the paid-only CPU allowance and enabled Worker minification. Better Auth now delegates password hashing/verification to PostgreSQL pgcrypto bcrypt at cost 12 after an HMAC-SHA384/base64 pre-hash using a separate stable `PASSWORD_PEPPER`. This keeps the expensive KDF out of Worker execution and preserves long/Unicode/NUL password input without bcrypt truncation. The pgcrypto migration was applied only to the dedicated test database. Local ignored runtime files received the same generated pepper; no credential values were written to source or documentation.

| Follow-up check | Result |
| --- | --- |
| Shared/domain/storage/password unit tests | **98 passed** |
| Live database API acceptance, packaged Node | **5 passed** |
| Live database API acceptance, local Worker | **5 passed** |
| Complete study browser workflow, Node | **1 passed** |
| Complete study browser workflow, local Worker | **1 passed** |
| TypeScript and production build | Passed |
| Minified Worker dry-run package | Passed; **1619 KiB compressed** |
| Static asset count | **105 files** |
| Dependency audit after adding pinned JSONC parser | **0 reported vulnerabilities** |
| Configured-secret scan of source/public/build files | Passed; **190 files** checked |
| Free-tier deployment readiness | Package/settings/database hashing passed; **blocked by one existing legacy credential** |
| Real Cloudflare Free CPU enforcement | **Not verified; no public deployment performed** |

New password tests cover parameterized SQL, cost bounds, Unicode normalization, long suffixes, NUL, pepper mismatch, random salts, wrong passwords, sanitized database errors, malformed hash rejection, and compare-and-set migration. Live tests exercise the same account ID and study content before/after migration. Node upgrades a verified legacy credential; Worker refuses it without running scrypt, then accepts the migrated credential. Existing password-change/session-revocation and ownership tests still pass.

The existing non-test account was not modified by test cleanup or reset. Its owner must sign out and sign in once on the updated Node application to migrate it. `npm run cloudflare:check -- --local` correctly reports this remaining requirement; it must not be bypassed for deployment. Production migrations and secret provisioning remain deployment setup steps. Preserve/back up `PASSWORD_PEPPER` and supply the same value to runtimes sharing a database. Old application versions cannot verify the new hash format.

Workers Free retains request, CPU, memory, and other platform quotas; Neon has separate compute/storage quotas. Local workerd/API/browser success does not establish production CPU compliance for every accepted workload. Measure authentication and maximum-size import/grading operations on the target free account before production reliance. Docker image execution and other previously listed unavailable checks were not repeated.
