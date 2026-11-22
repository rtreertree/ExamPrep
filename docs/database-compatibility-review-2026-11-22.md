# ExamPrep database compatibility and data integrity review

22 November 2026, Bangkok time · Production snapshot at 18:34 ICT · Source at `7e0fcae` plus existing changes in the working tree

## Executive summary

Production is on PostgreSQL 18.7 and all **8 applied migration checksums match** the repository on both supplied connections. All **9 study documents and 8 attempt snapshots** passed the current validators. The single completed score matched recomputation, and all **5 accounts** produced history-inclusive exports that the current backup reader accepted.

The most immediate risks are operational. The pooled connection in the supplied environment uses the database owner role, and live test entry points can reuse the production environment file. The previous application release also cannot represent the four live viewer memberships now in production. Rolling back to it would hide those sets from their viewers even though the database still holds the memberships.

The next priority is data recovery. Clone conversion can retire a locally edited copy on the strength of its origin receipt alone. Backup restore also accepts impossible review dates that can keep legitimate updates from replacing imported rows. The four conversions already performed retain their recovery records, and their archived contents match the current originals. Production currently has zero flashcard decks, so spaced-review findings come from code and synthetic validation.

## Production observations

| Area | Snapshot result |
| --- | --- |
| Schema and connections | Both supplied URLs reached the same Neon endpoint and database, as the same role. Both returned `transaction_read_only = on` for the audit. Verified 8 migrations, 55 valid indexes, 162 validated catalog constraints including PostgreSQL 18 NOT NULL entries, and 8 enabled application triggers. The 8 sampled function bodies matched their migration definitions. |
| Library and sharing | 9 sets, all exams, 8 published. One folder, 4 viewer memberships, 0 co-owners, 0 invitations and 2 active share links. All 4 viewer memberships use Discover grants. No stale viewer grant, inconsistent set metadata or owner/folder mismatch was found in the checks. |
| Practice and scoring | 8 attempts, of which 7 were in progress and 1 was completed. All 8 persisted scoring projections matched recomputation. Four attempts lack a set revision following conversion, including the sole completed attempt. Those rows remain usable in History. Revision-based trend logic excludes them by design. No invalid attempt chronology or attached attempt without access was found. |
| Conversion and recovery | 13 inventory records. Four converted and have recovery payloads, seven have no recorded original, one needs confirmation, and one has a receipt whose source no longer exists. The latter copy is still present. The cutover marker was recorded on 21 November at 23:04 ICT. |
| Accounts and backup | 5 accounts with credential hashes matching the current format, 1 active administrator, 8 session rows including 1 expired row, and 0 verification rows. No duplicate normalized email was found. The current export and validator accepted all 5 accounts. The expired row is a retention observation. |
| Flashcards and schedules | 0 flashcard decks and 0 schedule rows across the primary-owner, co-owner and viewer tables. No live restore write or browser write was exercised. |

Both application runtimes use the Neon adapter and the same PostgreSQL schema. Deployment validates Neon-specific endpoints, and core features depend on JSONB, advisory locks, triggers, sequences, and the `pgcrypto` and `pg_trgm` extensions. A move to another PostgreSQL provider would need a connection/release adapter and an extension and migration rehearsal. SQLite or MySQL would require a database-logic port. [Prisma datasource](../prisma/schema.prisma#L13) · [Runtime adapter](../server/db.ts#L1) · [Deployment connection checks](../scripts/deployment-config.mjs#L1)

## Findings and repair options

### P1 — Keep test writes off the production database

Live API and browser tests load `.env` and use `DATABASE_URL` for cleanup. The acceptance wrapper uses the same variable and relies on an opt-in flag. Its empty-branch check runs only in CI. The live browser project can also be selected directly. A locally launched app can still use production even when its URL is localhost. A wrong target lets the suite create accounts, mutate fixtures and delete records on that database. The supplied environment makes this a concrete configuration risk. This review ran the database-free test suite. [API test setup](../tests/api.integration.test.ts#L1) · [Acceptance guard](../scripts/acceptance.ts#L13) · [Acceptance target check](../scripts/acceptance.ts#L65) · [Browser cleanup](../tests/browser/workflow.spec.ts#L41)

**Fix options.** Require a separate test-only connection variable in every live entry point and verify a test marker on the database before any API mutation or cleanup. Have the wrapper pass the same validated target to the app and the test process. For CI, provision a disposable branch with credentials that have no production access and fail startup when its identity cannot be verified.

### P1 — Split runtime and migration database privileges

The pooled credential in the supplied file is the same role as the direct credential. The pooled connection owns `StudySet` and reports `TRUNCATE` and `TRIGGER` privileges on core study and auth tables and on migration history. A defective runtime query or exposed runtime credential would therefore have a wider impact than ordinary application writes. The release validates that both URLs point to the same database while allowing separate roles. [Release URL checks](../scripts/deployment-config.mjs#L27) · [Runtime adapter](../server/db.ts#L9)

**Fix options.** Keep the migration owner on the direct connection and provision a pooled application role with only the required table, view, sequence and function privileges. Test through both runtimes on a disposable Neon branch, covering auth, backup, review scheduling and trigger functions. Keep a separate read-only account for routine audits. Independently verify the Worker bindings before changing credentials.

### P1 — Rolling back across the live-set cutover hides saved sets

The prior application at `23af444` reads primary and co-owner rows for library access and has no converted-ID lookup. The current database contains **four viewer memberships and four attempts made by those viewers**. Account-scoped history is stored separately, but the prior application's library and set routes cannot represent live viewer access or the retired clone IDs. Applying the old application leaves the conversion in place. [Prior set-access code](https://github.com/rtreertree/ExamPrep/blob/23af444316d38904ee550cf4fd55c83ab612049f/server/setAccess.ts#L20) · [Current access view](../server/setAccess.ts#L21) · [Converted-ID lookup](../server/setRoutes.ts#L259) · [Rollback runbook](../DEPLOYMENT.md#L145)

**Fix options.** Mark viewer-aware builds as the minimum rollback versions after cutover. Use a forward fix or a rollback build that carries the viewer and alias paths. If recovery requires an earlier database snapshot, restore it to a separate branch and reconcile writes made after the recovery point before switching traffic.

### P1 — A verified origin receipt can retire an edited copy

The conversion script verifies provenance and access, checks downstream sharing and open-review overlap, then archives and deletes the copy. A recognized receipt bypasses the manual revision check and eligibility never compares the copy's content with the original. A learner's saved edits can therefore leave their library while remaining in a maintenance-only archive. An existing receipt also takes precedence over a manually reviewed mapping when its source is missing. Production has one copy with a missing source, and all four converted copies match their current originals. [Eligibility](../scripts/convert-clones.ts#L116) · [Recovery and source retargeting](../scripts/convert-clones.ts#L151) · [Receipt selection](../scripts/convert-clones.ts#L223) · [Recovery runbook](../DEPLOYMENT.md#L229)

**Fix options.** Limit automatic conversion to unchanged copies with exact content equivalence. Keep divergent copies independent or offer the learner a reviewed decision that preserves both versions. Add a verified archive-to-copy recovery path. Treat a missing origin as a review case and require evidence of provenance and current access before allowing any explicit remap. Add coverage for renamed, edited, missing-source and independently shared copies.

### P2 — Backup restore accepts review dates that can block future updates

The current validator accepts ISO date strings without comparing `dueAt` with `attemptStartedAt` or bounding the attempt timestamp. A synthetic archive with a due date earlier than a far-future attempt start passed on both the primary and viewer review paths. The review upsert only replaces rows from strictly earlier attempts. A future start can keep subsequent real sessions from updating the schedule, including after card content has changed. [Backup review schema](../shared/backup.ts#L54) · [Backup review validation](../shared/backup.ts#L273) · [Restore writes](../server/backup.ts#L339) · [Normal schedule update](../server/spacedReview.ts#L136)

**Fix options.** Validate date ordering and allowable clock skew before restore. For live decks, verify the card ID and fingerprint against the currently accessible deck before merging the row, and report skipped rows by reason. Use equivalent database constraints for stable invariants such as streak range and `dueAt >= attemptStartedAt`. Keep a documented replay policy for an older schedule whose card content legitimately differs.

### P2 — Backups can become too large to export or incompatible with older readers

Export builds a single combined library-and-history JSON response capped at **16 MiB**, even when the UI saves two files. The application allows repeated practice and multiple progress batches per attempt, so valid accumulated history can exceed the one-shot export cap. Separately, the current working tree adds optional `viewerReviews` to a strict version-1 history object. The checked-in reader at `7e0fcae` rejects that new field when it is present. The current restore preview also counts every viewer schedule in the file as ready, while restore only applies schedules for a viewer membership on that account. Current exports passed because production has zero viewer schedules. [Combined export and limits](../server/backup.ts#L100) · [Progress batching](../client/lib/useAttempt.ts#L20) · [Strict history schema](../shared/backup.ts#L62) · [Restore membership check](../server/backup.ts#L346) · [Preview count](../shared/backup.ts#L303)

**Fix options.** Support bounded, independently downloadable chunks tied to an archive manifest, with idempotent import receipts for each chunk. Keep old-file reading support and explicitly version any history format that old strict readers cannot accept. Check viewer schedule eligibility at preview and show applied, unchanged and inaccessible counts after restore. Exercise library-plus-history export and import at the size limit and across versions.

### P2 — Viewer promotion discards the grants that existed before promotion

Promotion moves viewer settings and schedules to co-owner storage and deletes the viewer row. Removing co-ownership later deletes the co-owner schedule and detaches attempts, even when the learner had previously saved that set through a still-valid Discover or link grant. Direct database deletion of a co-owner row also bypasses the app's attempt-detachment helper, unlike viewer deletion. Production has no co-owner rows or detached attempts in the snapshot. [Promotion and viewer deletion triggers](../prisma/migrations/202611210001_live_sets/migration.sql#L113) · [Co-owner revocation helper](../server/sharing.ts#L330) · [Co-owner review cascade](../prisma/schema.prisma#L175)

**Fix options.** Decide whether removing edit access should preserve independently granted view access. If it should, store grants independently of the effective role and downgrade the membership without moving or deleting personal data. If revocation should remove every grant, make that effect explicit and centralize attempt detachment in a database invariant or one supported write path. Test promotion, link disablement, unpublishing, revocation and resaving in sequence.

### P2 — The Prisma model and the deployed foreign keys differ

Offline SQL generated from the Prisma model declares `ON UPDATE CASCADE` on **five** live-set foreign keys. Production's migration uses default `NO ACTION` on the three viewer relations, the viewer-review membership relation, and the conversion-user relation. Existing code uses stable IDs, so this is a schema reconciliation risk. The migration checksums can match while the Prisma declarations differ. The app also needs hand-written objects such as `LibraryMembership`, custom checks and triggers that a Prisma-only schema rebuild cannot reproduce. [Model declarations](../prisma/schema.prisma#L259) · [Live-set migration](../prisma/migrations/202611210001_live_sets/migration.sql#L3) · [Prisma on custom database features](https://docs.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)

**Fix options.** Declare explicit `onUpdate: NoAction` for immutable IDs or use a forward migration if cascading updates are required. Build environments from the migration chain. Add a disposable PostgreSQL test that applies migrations from empty and from the preceding release, asserts key catalog definitions and runs the nearest live suite on both runtimes. The current CI has no database test, and `migrate deploy` does not detect drift. [CI workflow](../.github/workflows/ci.yml#L23) · [Prisma migrate deploy](https://docs.prisma.io/docs/cli/migrate/deploy)

### P2 — Database checks accept some malformed JSON shapes

The study-set metadata constraint evaluates to SQL `UNKNOWN` for missing JSON fields. PostgreSQL accepts that result for a check constraint. A read-only synthetic query verified this path with an empty JSON object. The attempt position check has a similar hole when neither item array is present. The app's validators reject those documents, and all sampled production documents and snapshots were valid. An import, repair or future writer that bypasses the app can still introduce rows that break JSON projection queries or fail later at practice start. [Initial database checks](../prisma/migrations/202611080001_initial/migration.sql#L158) · [Content validator](../shared/content.ts#L118) · [Directory projection](../server/directory.ts#L70) · [PostgreSQL check constraints](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)

**Fix options.** Add explicit presence and JSON type checks for the version, title, kind, item array, responses and scoring projections that SQL reads. Use staged validation to identify existing exceptions first. Keep rich item and rubric rules in the shared validator.

### P2 — UTC storage depends on session settings, and some tooling parses times as local

The application treats PostgreSQL `timestamp without time zone` values as UTC. Some raw SQL writes assign `CURRENT_TIMESTAMP` or `now()` to these columns, which converts through the session time zone. Both audited sessions were GMT. Separately, the standalone Neon parser interpreted the cutover's raw timestamp as Bangkok local time and displayed an instant **seven hours earlier**. The report used SQL text and the database's UTC convention for the cutover time. [Schema timestamps](../prisma/schema.prisma#L241) · [Backup UTC conversion](../server/backup.ts#L181) · [Raw timestamp writes](../server/directory.ts#L111) · [Cutover timestamp write](../scripts/convert-clones.ts#L288) · [PostgreSQL timestamp semantics](https://www.postgresql.org/docs/18/datatype-datetime.html#DATATYPE-TIMEZONES)

**Fix options.** Make write conversions explicit with `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`, verify runtime timezone settings and use explicit UTC parsing in maintenance tools. For durable instant fields, consider a staged `timestamptz` migration that explicitly interprets historical values as UTC and verifies samples across runtimes and offsets.

### P3 — Popular sets can serialize unrelated learners' writes

Progress saves, including navigation-only saves, call `markStudied`, which first takes a row lock on the shared set. Study start, due review and access changes also lock that same row. A class studying one set can queue independent learner writes behind each other while the transaction validates, reads or writes JSON and review state. Production has four viewer memberships, so no contention rate was measured. [Progress transaction](../server/attemptRoutes.ts#L96) · [Shared-row lock](../server/practice.ts#L4) · [Review start transaction](../server/spacedReview.ts#L275)

**Fix options.** Measure concurrent workload and lock waits on a disposable branch. Move per-user activity updates to per-membership rows or update activity less often. Keep serialization where permission and content changes actually need it. Consider a partial unique index for one open due review per learner and set after a duplicate preflight.

### P3 — Title and folder search can match storage escape sequences

Application search runs on encoded text. A synthetic PostgreSQL check showed that searching for `7e` matches a stored title containing only the encoded representation of a literal tilde. This affects substring search semantics and can also affect ordering for escaped characters. The codec exists to round-trip characters PostgreSQL cannot represent directly in text or JSONB. [Storage codec](../server/storage.ts#L1) · [Library search](../server/setRoutes.ts#L95) · [History search](../server/history.ts#L57) · [Directory search](../server/directory.ts#L50)

**Fix options.** Keep a separate searchable, normalized projection with an explicit policy for unrepresentable characters, or enforce a PostgreSQL-safe text contract for searchable fields and migrate existing values. Cover literal tildes, surrogate pairs, escaped characters and Thai titles in round-trip search tests.

## What to fix first

1. **Protect production access.** Isolate live test credentials, split runtime privileges and designate a rollback build that supports live viewers.
2. **Protect recovery before another conversion.** Gate conversion on content equivalence and add a tested way to recover a retired copy. Tighten schedule validation and show restore outcomes accurately.
3. **Close the compatibility gaps.** Reconcile Prisma and SQL, add migration and mixed-version tests on disposable PostgreSQL, and exercise flashcard, co-owner and backup behavior through both application runtimes.

The existing working-tree changes already address the previous draft-redirect issue, include viewer schedules in current exports, and stop active link receipts from automatically creating Discover grants. The report treats those changes as under review. The deployed Worker build was outside the production database checks. [Earlier review](review-7e0fcae.md) · [Draft routing](../client/features/Editor.tsx#L89) · [Viewer schedule export](../server/backup.ts#L95) · [Conversion grant logic](../scripts/convert-clones.ts#L140)

## Verification and repeatable checks

- Used repeatable-read, read-only transactions on the supplied connections for catalog and integrity checks. Verified applied migration checksums against the local SQL files and compared foreign-key update actions with SQL generated by `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, which used the local model only.
- Ran the repository's clone inventory in its default audit mode and checked its reported unavailable candidate against live source existence. Validated content, attempts, scoring and exports in memory using the working-tree modules. Output was aggregate-only.
- The full database-free test suite passed **161 tests** and skipped **22 live integration tests**. Type checking passed. Restore writes, production sign-in, live browser flows and Worker load were outside the audit. No application code or database data was changed.

These catalog and integrity checks can be repeated with a read-only connection.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT current_setting('server_version_num'),
       current_setting('TimeZone'),
       current_setting('transaction_read_only');

SELECT migration_name, checksum, finished_at, rolled_back_at
FROM "_prisma_migrations"
ORDER BY started_at;

SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid)
FROM pg_constraint c
WHERE c.conrelid IN (
  '"StudySetViewer"'::regclass, '"ViewerCardReview"'::regclass,
  '"CloneConversion"'::regclass
)
AND c.contype = 'f'
ORDER BY c.conname;

SELECT count(*) FILTER (WHERE "studySetRevision" IS NULL) AS unversioned,
       count(*) FILTER (WHERE "studySetId" IS NULL) AS detached,
       count(*) FILTER (WHERE (status = 'completed')
                                   <> ("completedAt" IS NOT NULL)) AS invalid_state
FROM "Attempt";

ROLLBACK;
```
