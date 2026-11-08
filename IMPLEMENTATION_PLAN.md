# Exam Prep — implementation plan

Read [REQUIREMENTS.md](REQUIREMENTS.md), [design.md](design.md), and the [file authoring skill](skills/exam-prep-author/SKILL.md) first. This document is a future build sequence, not application code.

The skill's [version-1 contract](skills/exam-prep-author/SKILL.md#version-1-contract) is the authoritative content schema, including field tables, allowed variants, bounds, cross-field rules, and complete examples. Keep it standalone so another AI can generate files from that single document.

## Architecture

Browser → same-origin Hono API → Prisma + Neon adapter → Neon PostgreSQL.

Keep one repository and shared business logic. Use React + Vite for screens, a shared schema module for validation/types, and separate thin Workers and Node.js entry points. No microservices or additional database are needed.

| Concern | Choice |
| --- | --- |
| Frontend | React, Vite, TypeScript; the minimal Graphite / Volt tokens, shared material recipes, controls, and motion system from `design.md`. |
| API | Hono; session middleware, validation, ownership checks, and feature services. |
| Database | Prisma ORM 7 with matching client/adapter versions, `@prisma/adapter-neon`, and Neon's serverless driver. |
| Authentication | Better Auth with its Prisma adapter and database sessions; email/password only. Free-tier Workers use PostgreSQL pgcrypto password callbacks, with a separate server-side pepper. |
| File validation | Shared Zod schema; generate a distributable JSON Schema from the same source during implementation. |
| Content rendering | Markdown renderer with math support and KaTeX; one component used in preview, practice, and review. |
| Draft recovery | Device-local IndexedDB storage scoped to account and draft/set ID; explicit Save persists valid content in Neon. |
| Deployment | Worker + static assets; alternatively a Node.js LTS server packaged in Docker. |

Pin tested stable versions in the lockfile. At planning time, Better Auth's Prisma adapter documents Prisma 7 support and a Prisma 8 incompatibility; do not install unqualified latest versions. Recheck this when building. [Better Auth Prisma adapter](https://better-auth.com/docs/adapters/prisma).

Prisma documents the Neon adapter for Workers. Keep its client/connection lifecycle inside each Worker request and close it reliably, including failure paths. [Prisma Workers guide](https://docs.prisma.io/docs/orm/v7/prisma-client/deployment/edge/deploy-to-cloudflare), [Neon connection lifecycle](https://neon.com/docs/serverless/serverless-driver).

## Data model

| Record | Main fields and behavior |
| --- | --- |
| Auth records | Use Better Auth's generated User, Session, Account, and Verification models as required by the selected version. Email is unique; credentials and sessions remain library-managed. |
| StudySet | `id`, `userId`, `title`, `kind`, validated `content` JSONB, integer `revision`, creation/update timestamps. Metadata columns must match the JSON. |
| Attempt | `id`, `userId`, nullable `studySetId`, nullable `sourceAttemptId` for retries, immutable `snapshot` JSONB, `status`, `responses` JSONB, `position`, `result` JSONB, integer `revision`, start/update/completion timestamps. |

Responses map item IDs to selected options or written text/self-assessments for exams, and ratings for flashcards. Rubric self-assessments map criterion IDs to awarded points; distinguish missing assessments from an explicit zero. Results store separate automatic/self-assessed earned and maximum points or flashcard counts. Validate against the immutable snapshot and compute totals server-side; student-awarded rubric points are self-assessment inputs, not automatic grades.

Use these planned shapes inside the Attempt JSONB fields; they are never accepted as imported content fields:

| Stored field | Planned shape and rules |
| --- | --- |
| `snapshot` | A complete validated exam/deck document from the content contract. A retry stores the eligible subset as a valid document with the same item IDs and order. Immutable after creation. |
| `position` | Zero-based index within snapshot questions/cards; integer from 0 through item count minus 1. New attempts start at 0. |
| `responses[questionId]` for single choice | `{ "selectedOptionId": "b" }`; ID must exist in that snapshot question. No response entry means unanswered. Clearing an answer removes its entry. |
| `responses[questionId]` for written | `{ "text": "Student answer" }` during practice; text up to 20,000 Unicode code points. Empty/whitespace-only text counts as unanswered. After submission, add either `selfAssessment: "correct"` or `"incorrect"` for rubric-free questions, or `criterionPoints: { "rule": 1, "result": 2 }` for rubric questions. Never accept both grading forms. |
| `responses[cardId]` for flashcards | `{ "revealed": true, "rating": "review_again" }`; persist reveal state as a boolean, with optional rating `"known"` or `"review_again"`. Absence of an entry means unrevealed/unrated. Rating requires reveal, and omission of rating means Unreviewed. |
| `result` for exams | Derived `automatic` and `selfAssessed` category objects with `earnedPoints`, `maxPoints`, and `pendingCount`. Include only categories present in the snapshot. Pending self-assessments contribute no earned points yet, keep their maximum in the denominator, and must be visibly labeled pending. |
| `result` for flashcards | Derived integer counts `known`, `reviewAgain`, and `unreviewed`; their sum must equal the snapshot card count. |

Initialize `responses` as an empty object; `result` is absent/database-null before submission. Missing self-assessment means pending only for answered written questions. At submission, the server assigns zero to unanswered written questions without requiring self-assessment. Criterion keys must belong to the snapshot rubric, awards must be integers within each criterion's bounds, and all criteria are required before completion. Results are recomputed after each permitted assessment update. Student-written text uses the same safe Markdown/math renderer.

The progress API validates mutations against attempt kind and status: responses/ratings may change while `in_progress`; only written self-assessment may change while `reviewing`; completed attempts are read-only. Resume position may be saved for either unfinished status. The client cannot alter snapshot, ownership, result, or source links. Grade against the snapshot even if the source set has since changed.

Local editor drafts store form state, account ID, set/local draft ID, base revision, and update time. They may contain unfinished content that fails file validation. Keep these separate from StudySet records, recover only for the matching signed-in user, and clear that user's drafts on explicit sign-out. Refresh the draft baseline after a successful Save without dropping edits made while the request was pending.

Index study sets by owner and update time; attempts by owner/start time and source set. Deleting a set clears its attempt references but preserves snapshots. Use conditional revision updates for concurrent edits, and transactional/idempotent submission so retries cannot grade twice or overwrite a finished attempt. Use database constraints as well as application validation.

## API surface

| Route | Responsibility |
| --- | --- |
| `/api/auth/*` | Better Auth handlers for registration, session, sign-in/out, and password changes. |
| `GET /api/sets`, `POST /api/sets` | Paginated private library; create from an imported or manually authored document. |
| `GET /api/sets/:id`, `PUT /api/sets/:id`, `DELETE /api/sets/:id` | Read, save a valid revision, or delete an owned set. |
| `GET /api/sets/:id/export` | Download the content as `.examprep.json`, including answer keys. |
| `POST /api/sets/:id/attempts` | Create an attempt with a server-side snapshot of the owned set. |
| `GET /api/attempts`, `GET /api/attempts/:id` | Paginated history and resumable/reviewable attempt details. |
| `PATCH /api/attempts/:id/progress` | Save allowed answers, position, ratings, or post-submit written self-assessment, with a revision check. |
| `POST /api/attempts/:id/submit` | Freeze answers, compute results, and transition status according to the requirements. |
| `POST /api/attempts/:id/retry` | Check ownership and completed status, select eligible mistakes from the source snapshot on the server, and create a fresh subset attempt linked by `sourceAttemptId`. Return a clear no-items response without creating an empty attempt. |

Derive `userId` from the session, never the request body. Return 401 when unauthenticated, 404 for unavailable/not-owned records, 409 for revision conflicts, 413 for oversized input, and structured validation errors for invalid documents. Authoring/export endpoints expose answers by design; the practice interface hides solutions until the appropriate stage. This is a personal study tool, not a proctored testing system.

## Build sequence

### 1. Establish compatibility and the file contract

- Set up the TypeScript project, Worker/Node entry points, and a dedicated test Neon database or branch.
- Prove a Prisma read/write and an email/password sign-up/sign-in on both runtimes before building full screens. Enable the Workers compatibility flags required by the selected dependencies.
- Check auth hashing performance against the selected Worker CPU budget. For Workers Free, delegate native cost-12 bcrypt to PostgreSQL pgcrypto using the OWASP HMAC-SHA384/base64 pre-hash recipe and a separate stable server-side pepper; do not run a slow KDF in the Worker or reduce its work factor. Upgrade existing scrypt credentials only after successful verification on Node, and block deployment readiness until migration is complete. Real deployed CPU verification is still required, including maximum-size content operations.
- Implement the version-1 schema and valid/invalid fixtures from the authoring skill, including JSON-escaped math and optional written-answer rubrics. Model strict document/question variants and enforce uniqueness/reference rules explicitly. Keep rubric-free files valid. Publish the derived JSON Schema alongside the skill; document checks requiring application logic, including unique IDs and answer references.
- Reject duplicate object keys while reading raw JSON, before ordinary parsing loses that information. Enforce raw byte limits and decoded Unicode character limits consistently in browser and server. Validate safe content constructs separately from ordinary formula rendering warnings.
- Cover empty/mismatched documents, missing/extra fields, wrong types, duplicate IDs/keys, dangling answer references, 2–6 options, 1–20 rubric criteria, 1–100 criterion points, 1–500 items, Unicode, and file-size boundaries. Verify the full exam example totals automatic 1/1 and self-assessed 4/6 under its stated awards, and the deck example produces exactly one retry card.

Done when both runtime checks pass and the same validator accepts/rejects the same fixtures in browser and server.

### 2. Build accounts and the private library

- Generate auth models, add StudySet/Attempt models, and create reviewed Prisma migrations.
- Implement account screens, session handling, ownership checks, and private library CRUD.
- Keep registration to email/password; supply any library-required display name internally.
- Configure secure cookies, trusted origins, and database-backed authentication throttling rather than instance-local counters.

Done when account isolation and session expiry/logout checks pass. Better Auth supports Hono handlers and email/password flows. [Hono integration](https://better-auth.com/docs/integrations/hono), [Email/password authentication](https://better-auth.com/docs/authentication/email-password).

### 3. Build import, editor, and export

- Establish the shared AppShell, primitives, content renderer, rubric modes, and motion presets from [design.md](design.md); compose screens from these components rather than duplicating their styles or behavior.
- Build “Create with your AI” with topic, level, language, count, and type inputs; a copyable prompt; skill/example downloads; and a clear next step to import the generated file. Use bundled assets that are validated against the shared contract; no AI API integration.
- Implement file/paste validation, preview, and save.
- Build the form editor and shared Markdown/math renderer, including optional rubric criteria with descriptions and point values; prevent invalid saves and show unsaved changes.
- Debounce local draft writes, report confirmed device-local persistence separately from database Save, and offer Restore/Discard on reopening. Cover new sets, invalid intermediate form state, storage failures, explicit sign-out cleanup, and base-revision conflicts. A changed/deleted source offers Save as new or Discard; never silently overwrite it.
- Disable raw HTML and media rendering, allow only safe link schemes, and keep KaTeX `trust` disabled with expansion/size bounds. Escape math error messages. [KaTeX security guidance](https://katex.org/docs/security.html).
- Export the current valid editor content, whether saved or not, without silently saving it; preserve IDs and math.

Done when import → edit → export → re-import preserves all supported content, helper downloads validate, and local draft recovery survives refresh without account leakage or overwriting newer work. Invalid content cannot bypass server validation.

### 4. Build practice and history

- Create immutable attempt snapshots and enforce allowed state transitions.
- Build exam navigation, saved responses, server grading, and written self-assessment. Rubric-free questions retain binary grading; rubric questions use per-criterion whole-number points with server-validated bounds and totals, and remain in review until all required assessments are present.
- Build flashcard reveal/rating, early finish, and counts.
- Save selections/ratings promptly and debounce written text. Flush pending saves before navigation/submission; retain edits and show Retry on failure.
- Add resume and historical review; handle revision conflicts without silent data loss.
- Add mistake retry actions with eligible counts. Filter completed snapshot items by less-than-full exam credit or “Review again” flashcard ratings, preserve their order and rubrics, and start a linked attempt with no inherited responses. Handle empty selections and deleted source sets.

Done when refresh/resume, binary/partial-credit scoring, repeated submission, correct mistake selection, and source-edit/delete history preservation all pass. Verify that criteria worth 2 and 3 points awarded 1 and 2 total 3/5, and that completing a retry leaves its source result unchanged.

### 5. Finish the visual system and deployment packages

- Apply [design.md](design.md) across all screens, including its minimal dark palette, faint gradient, selective frosted materials, reusable components, focus/workspace shells, and quiet animation recipes. Compare against the current visual references; verify responsive layouts, readable math, composited contrast, opaque blur fallbacks, keyboard use, focus, motion interruptions, and reduced motion.
- Package Vite assets with the Worker and configure SPA fallback without swallowing `/api/*` requests. [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).
- Package the same frontend and Hono services in a multi-stage Docker build using the Node adapter; support `PORT`, health checks, graceful shutdown, and runtime environment variables. No durable local disk is required. [Hono Node.js adapter](https://hono.dev/docs/getting-started/nodejs).
- Document local startup, migrations, secrets, Worker deployment, and container startup. Run the acceptance workflow on both targets.

Done when a fresh checkout can build both packages and the test deployment checks pass.

## Configuration and delivery

Required configuration: `DATABASE_URL` for the pooled Neon runtime connection, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL` for the public origin. Use a separate direct migration connection, such as `DATABASE_URL_UNPOOLED`, configured for the selected Prisma version. Apply migrations from development/CI, never in a request handler or on every container startup.

Use local ignored secret files during development, Worker secrets in Cloudflare, and injected secrets in containers. Runtime settings are `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and a separate stable `PASSWORD_PEPPER`; the direct migration URL belongs only in migration tooling. Back up the pepper securely and keep it consistent across runtimes sharing credentials. Do not place credentials in browser bundles, images, logs, or committed examples. Rotate the database password shared in the original request before deployment; these documents intentionally contain no connection credentials.

The implementing agent should deliver application source, Prisma migrations, the shared schema and fixtures, the portable authoring skill and helper downloads, focused tests, Worker configuration, Dockerfile, and a short setup guide. Validate schema/round-trip behavior, grading/state transitions, mistake retry, draft recovery, two-account isolation, and one complete browser workflow on each runtime. Report any unsupported deployment target or unverified check explicitly. Password recovery and email delivery remain outside this plan's implementation scope.
