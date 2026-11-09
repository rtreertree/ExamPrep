# Exam Prep — project requirements

Status: planning only. This handoff defines the application; it does not authorize implementation or deployment in this task.

## Purpose

A university student imports an exam or flashcard file created by any AI tool or by hand, saves it to a private account, and practices from it. Exam Prep displays the supplied content and records practice; generating questions happens outside the application.

## Core flow

1. Open “Create with your AI” to copy a prompt and download the [authoring skill](skills/exam-prep-author/SKILL.md) and examples, or create content manually.
2. Receive a `.examprep.json` file containing an exam or flashcard deck.
3. Sign in to Exam Prep, import the file, review its preview, and save it.
4. Practice, resume unfinished attempts, review previous results, and retry mistakes.
5. Edit the study set, save changes, and export a compatible file at any time.

## First release

| Area | Required behavior |
| --- | --- |
| Account | Register, sign in, sign out, view email, and change password using the current password. Only email and password are required at registration. |
| Library | List the current user's study sets; filter exams/flashcards; create, open, edit, export, and delete a set. |
| Create with your AI | A panel with a copyable prompt, downloadable `SKILL.md`, and example exam/flashcard files. Let students specify topic, level, language, item count, and content type. |
| Import | Accept a file or pasted JSON; validate it; preview title, type, item count, and content before saving. Errors identify the affected field. |
| Editor | Simple form editor for metadata and items, with Markdown/LaTeX preview. Add, remove, and reorder items. Recover local drafts after refresh or a crash; explicit Save updates the stored study set. |
| Exams | Single-choice questions and written answers. Navigate freely, save progress, submit, and review answers and explanations. Optional written-answer rubrics support self-assessed partial credit. |
| Flashcards | Show front, reveal back, then mark “Known” or “Review again.” Record a session summary. |
| History | List attempts with study-set title, date, status, and result; resume unfinished work, inspect completed work, or start a fresh attempt containing only mistakes. |
| Persistence | Accounts, study sets, answers, progress, and history live in Neon PostgreSQL through Prisma. |

The initial release excluded timers, randomization, spaced repetition, and email delivery. The current v1 adds configurable sessions, due review, and optional email-based password recovery. The current v1 also includes course organization, practice recovery, editor shortcuts, progress insights, private practice annotations, account backup, and adjustable study text size. See the [v1 study workflows](README.md#v1-study-workflows).

Built-in AI, document extraction, media attachments, public sharing, classes, payments, offline synchronization, social login, and registration email verification remain outside the current scope.

## File contract

Use UTF-8 JSON named `*.examprep.json`, with `schemaVersion: 1`. One file contains either an exam or a flashcard deck. The complete field contract and examples are in the standalone [authoring skill](skills/exam-prep-author/SKILL.md).

| Content shape | Required fields | Optional fields |
| --- | --- | --- |
| Exam document | `schemaVersion`, `kind: "exam"`, `title`, `questions` | `description` |
| Single-choice question | `id`, `type: "single_choice"`, `prompt`, `options`, `answer` (option ID) | `explanation` |
| Choice option | `id`, `text` | None |
| Written question | `id`, `type: "written"`, `prompt`, `answer` (reference text) | `explanation`, `rubric` |
| Rubric criterion | `id`, `description`, `points` (maximum) | None |
| Flashcard document | `schemaVersion`, `kind: "flashcards"`, `title`, `cards` | `description` |
| Flashcard | `id`, `front`, `back` | None |

Only the fields listed for each shape are accepted. Single-choice and written questions may coexist in one exam; a file cannot mix exam questions with flashcards. See the skill's [field rules](skills/exam-prep-author/SKILL.md#shared-field-and-identity-rules), [exam fields](skills/exam-prep-author/SKILL.md#exam-single-choice-question), [flashcard fields](skills/exam-prep-author/SKILL.md#flashcard-deck), and [validation examples](skills/exam-prep-author/SKILL.md#validation-and-error-reporting) for exact limits and behavior.

- Text content supports Markdown, inline math `$...$`, and display math `$$...$$` using KaTeX-supported LaTeX.
- Preserve item order, item IDs, text, and math through import → edit → export → re-import. Whitespace and JSON key ordering need not be identical.
- Limit each file to 2 MiB and 500 items. Validate in the browser for feedback and on the server before storage.
- Character limits apply to decoded Unicode code points; the file limit applies to UTF-8 bytes. Optional fields are omitted when unused, not set to `null`. IDs are case-sensitive and stable across edits.
- Reject unsupported versions, unknown fields, duplicate item IDs, invalid answer references, and malformed JSON. Do not silently discard data.
- Importing creates a new private study set. Re-importing never silently overwrites an existing set.
- Files contain study content only, including answer keys. Exports omit accounts, database IDs, attempts, and credentials.
- Written questions may include an optional marking rubric with point-valued criteria. Preserve rubrics through editing and export; existing version-1 files without rubrics remain valid.
- No raw HTML, executable content, embedded images, or external media. Invalid math displays a readable error without crashing the page.

## Authoring assistance and draft recovery

- “Create with your AI” prepares a prompt and downloadable instructions for use on the student's chosen AI platform. It makes no model calls and does not send study material to an external service.
- Include examples of both file types and a written question with a rubric. Keep the prompt, skill, examples, and validator aligned with the same file contract.
- Automatically preserve editor drafts on the current device, including temporarily invalid form content. Offer Restore or Discard after refresh or a crash; restoration never silently replaces the saved database version.
- Scope drafts to the signed-in account and study set, or a local draft ID for a new set. Only offer recovery after confirming the matching account; clear that account's local drafts on explicit sign-out.
- Label local draft persistence separately from database saves. Warn if local storage fails and before leaving changes that have not been saved to the account. Save still validates and explicitly updates the database.
- Compare the draft's base revision with the current set before saving. If the set changed or was deleted, offer to preserve the draft as a new set or discard it. Draft recovery is device-local; it does not add cross-device draft or offline synchronization.

## Practice rules

### Exams

- Use file order. Single-choice questions have one correct option; written questions provide a reference answer for self-assessment.
- Save answers and the current position during practice. Show Saving, Saved, or Retry; only show Saved after database confirmation.
- Submission confirms unanswered questions and freezes responses. Show solutions after submission.
- Grade single-choice questions on the server: one point for correct, zero for incorrect or unanswered.
- After submission, written questions without a rubric use Correct/Incorrect self-assessment worth 1/0 points. With a rubric, show the reference answer and let the student award whole-number points from zero to each criterion's maximum; the server validates and sums them. The question maximum is the sum of its rubric points.
- Unanswered written questions receive zero points. An answered rubric question remains pending until every criterion is assessed; an explicit zero is a completed assessment.
- Show automatic score and self-assessed score separately, each with its denominator; never imply that written answers were machine graded. Omit a category when it has no questions.
- An attempt moves from `in_progress` to `reviewing` when self-assessment remains, then `completed`. Exams without pending self-assessment complete immediately.

### Flashcards

- Use file order. Reveal a card before recording its rating; “Review again” is a recorded rating, not a scheduling algorithm.
- Save the position and ratings. Allow the student to finish early, with confirmation, and show Known, Review again, and Unreviewed counts.
- A session moves from `in_progress` to `completed`. Another practice run creates a new session.

### History integrity

- Copy the study content into an immutable snapshot when an attempt starts. Editing or deleting the original set must not change historical questions or results.
- Completed answers, ratings, and scores stay fixed. Private flags, confidence, and notes remain editable. Retrying creates a new attempt.
- Resume from the last confirmed save across devices. Handle conflicting edits explicitly rather than silently overwriting newer work.

### Retry mistakes

- Offer “Retry mistakes” on completed exam results and “Review again” on completed flashcard sessions, with the eligible item count.
- Include incorrect/unanswered single-choice questions and written questions with less than full self-assessed credit. For flashcards, include only cards rated “Review again”; exclude Known and Unreviewed cards.
- Create a new attempt from the selected items in the original attempt snapshot, preserving their order, IDs, and rubrics. Start with empty answers/ratings and fresh scores; keep the original result unchanged.
- Allow retry after the original study set was edited or deleted. Link the new attempt to the source attempt in history. When no items qualify, show “No mistakes to retry” and do not create an empty attempt.

## Screens and visual system

| Screen | Main layout and action |
| --- | --- |
| Sign in / Register | Compact email/password form with clear validation. |
| Library | Clean list of sets; primary actions Import and Create, with “Create with your AI” available from Create; navigation to History and Account. |
| Create with your AI | Topic/settings, copyable prompt, skill and example downloads, and an Import next step. |
| Import | File/paste input, validation, content preview, then Save. |
| Editor | Item list, editable fields, optional rubric criteria, and preview; draft/save status and recovery controls; stack these on mobile. |
| Practice | One question/card as the focal point, progress indicator, navigation, and save status. |
| Results / History | Separate automatic and self-assessed results, rubric point breakdowns, mistake retry actions, and an attempt list linking retries to their sources. |
| Account | Email, change-password form, and sign out. |

Follow [design.md](design.md), the authoritative **Graphite / Volt** UI direction: minimal dark charcoal surfaces, warm white typography, a restrained lime accent, a faint background gradient, and subtle frosted navigation/overlays. Content surfaces stay matte. The design document specifies exact tokens, reusable materials/components, layouts, responsive behavior, states, and animation recipes.

Use small, quick, consistent motion across navigation, editing, selection, flashcard reveal, and completion. Keep reading/answering stable and honor reduced-motion preferences. Preserve keyboard navigation, visible focus, accessible labels, and sufficient contrast, including over composited materials. Provide opaque fallbacks for blur/transparency. Long equations may scroll within their own area without overflowing the page. Include loading, empty, invalid-file, save-failure, and session-expired states.

## Technical requirements

- TypeScript throughout; React + Vite frontend and a small Hono API.
- Cloudflare Worker serves the API and frontend assets from one origin.
- Neon PostgreSQL through Prisma ORM with an edge-compatible Neon driver adapter.
- Also provide a Docker/OCI image running the same application through a Node.js entry point, with persistent data remaining in Neon.
- Portability means Workers plus container-capable hosts. Other isolate-based edge platforms may need adapters and separate verification; do not claim universal compatibility.
- Enforce ownership on every study-set and attempt operation using the authenticated session. Private responses must not enter a shared cache.
- Use maintained authentication, secure session cookies, password hashing, origin/CSRF protection, and persistent sign-in throttling. Keep all secrets server-side.

## Acceptance criteria

1. Two accounts cannot list, read, edit, export, delete, or practice each other's data, even with a guessed ID.
2. An externally authored exam and deck both import, display LaTeX, save, export, and re-import without content loss.
3. A student can create the same content manually in the editor.
4. Refreshing or signing in on another device restores confirmed practice progress.
5. Scores, self-assessments, and flashcard ratings persist correctly; repeated submission does not create duplicate results.
6. Editing or deleting a source set leaves prior attempts reviewable and unchanged.
7. Invalid files produce useful errors; imported markup cannot execute scripts or load embedded media.
8. The complete workflow works on desktop and mobile, with keyboard access and reduced motion.
9. The same workflow passes on Cloudflare Workers and in the container against a test Neon database.
10. A mistake retry contains exactly the eligible snapshot items, starts with no prior responses, and works even if the source set was changed or deleted.
11. A confirmed local draft survives refresh, can be restored or discarded, cannot appear under another account, and never silently overwrites a newer saved revision.
12. The AI helper supplies a usable prompt, skill, and valid sample files without calling an AI service.
13. Written rubrics round-trip through files and the editor; partial scores persist, out-of-range points are rejected, and questions without rubrics retain binary grading. A question with criteria worth 2 and 3 points, awarded 1 and 2, scores 3/5 and qualifies for a mistake retry.
14. Validators agree on field types, conditional fields, duplicate JSON keys, identity/reference checks, Unicode lengths, and size boundaries. Syntax/structural errors block saving; ordinary formula syntax errors appear as rendering warnings without losing source content.
