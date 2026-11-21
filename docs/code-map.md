# ExamPrep code map

Paths start at the repository root. Open the first file for the behavior you're changing. The other files trace the feature across layers.

| Task | Start here | Related code | Closest check |
| --- | --- | --- | --- |
| Public landing (`/`) and signed-in library (`/library`) | `client/App.tsx` | `client/features/Landing.tsx`, `client/features/AuthPage.tsx`, `client/lib/auth.tsx` | `tests/browser/landing.spec.ts` |
| AI import validation and repair | `client/lib/aiImport.ts` | `client/features/ImportPanel.tsx`, `client/lib/aiPrompt.ts`, `shared/content.ts` | `tests/ai-import.test.ts` |
| AI authoring prompt and guide | `client/lib/aiPrompt.ts` | `client/features/AIHandoffPanel.tsx`, `skills/exam-prep-author/SKILL.md`, `scripts/assets.ts` | `tests/ai-authoring.test.ts` |
| Editor, file import and export | `client/features/Editor.tsx` | `client/features/ImportPanel.tsx`, `client/lib/exportContent.ts`, `shared/content.ts` | `tests/content.test.ts`, `tests/browser/reliability.spec.ts` |
| Math and chemistry notation | `client/components/NotationEditor.tsx` | `client/components/StudyContent.tsx`, `client/lib/notation.ts` | `tests/notation.test.ts`, `tests/browser/notation.spec.ts` |
| Library, folders, ordering and library context | `client/features/Library.tsx` | `client/features/LibraryOrganization.tsx`, `client/lib/useLibraryContext.ts`, `server/setRoutes.ts`, `server/libraryOrder.ts`, `shared/listing.ts` | `tests/browser/reliability.spec.ts` |
| Set sharing and co-ownership | `server/sharing.ts` | `client/features/SetSharing.tsx`, `client/features/SharedSet.tsx`, `server/setAccess.ts`, `shared/sharing.ts` | `tests/browser/sharing.spec.ts` |
| Historical clone conversion and recovery | `scripts/convert-clones.ts` | `prisma/migrations/202611210001_live_sets/migration.sql`, `DEPLOYMENT.md` | `tests/api.integration.test.ts` |
| Admin accounts, libraries and sharing | `client/features/Admin.tsx` | `server/admin.ts`, `server/directory.ts`, `shared/directory.ts`, `scripts/promote-admin.ts` | `tests/api.integration.test.ts`, `tests/browser/workflow.spec.ts` |
| Discover, cloning and read-only set views | `client/features/Discover.tsx` | `client/features/SetReader.tsx`, `server/directory.ts`, `server/sharing.ts` | `tests/api.integration.test.ts`, `tests/browser/sharing.spec.ts`, `tests/browser/workflow.spec.ts` |
| Exam and flashcard practice | `client/features/Practice.tsx` | `client/lib/useAttempt.ts`, `client/lib/attemptNavigation.ts`, `client/lib/practiceRecovery.ts`, `server/attemptRoutes.ts` | `tests/browser/practice.spec.ts`, `tests/server-progress.test.ts` |
| Attempt grading and submission | `shared/attempts.ts` | `server/attemptRoutes.ts`, `server/snapshots.ts`, `client/features/AnswerReview.tsx` | `tests/attempts.test.ts` |
| Spaced review and insights | `server/reviewRoutes.ts` | `client/features/DueReview.tsx`, `client/features/ProgressInsights.tsx`, `server/spacedReview.ts`, `shared/spacedReview.ts` | `tests/study-progress.test.ts` |
| History and date filtering | `client/features/History.tsx` | `client/lib/historyDates.ts`, `server/history.ts`, `server/attemptRoutes.ts` | `tests/history-dates.test.ts` |
| Sign-in and password recovery | `client/features/AuthPage.tsx` | `client/lib/auth.tsx`, `client/features/PasswordRecovery.tsx`, `server/auth.ts`, `server/resetEmail.ts` | `tests/browser/account.spec.ts`, `tests/passwords.test.ts` |
| Account settings and reading preferences | `client/features/Account.tsx` | `client/lib/readingSize.ts`, `client/lib/auth.tsx` | `tests/browser/account.spec.ts` |
| Backup and restore | `client/features/AccountBackup.tsx` | `server/backup.ts`, `shared/backup.ts` | `tests/backup.test.ts`, `tests/browser/account.spec.ts` |
| API and runtime entry points | `server/app.ts` | `client/lib/api.ts`, `server/node.ts`, `server/worker.ts`, `vite.config.ts` | `npm run typecheck`, `npm run worker:check` |
| Database migrations and deployment | `prisma/schema.prisma` | `prisma/migrations/`, `wrangler.jsonc`, `.github/workflows/release.yml` | `tests/deployment.test.mjs`, `npm run worker:check` |

Append the mapped test path to `npm test --` for Vitest or `npm run test:e2e:mock --` for Playwright.

## Documentation

- Local startup and test setup are in [Start locally](../README.md#start-locally) and [Verification](../README.md#verification).
- File compatibility rules are in [Version-1 validation](../VALIDATION.md#version-1-validation). UI guidance is in [Layout and responsive system](../design.md#4-layout-and-responsive-system).
- Release order and migration steps are in [Checks and release ordering](../DEPLOYMENT.md#checks-and-release-ordering) and [Migrations and rollback](../DEPLOYMENT.md#migrations-and-rollback).
