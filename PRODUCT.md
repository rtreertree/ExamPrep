# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Exam Prep was built for university students who want to turn course material into practice exams and flashcards, resume studying across devices, and revisit mistakes. Students can also share sets with classmates and co-edit them. How much to prioritize collaboration in future work is open.

## Product Purpose

Help students build a private study library and practice from material they choose. A student should be able to create or import a study set, resume from a confirmed save, understand their results, and decide what to practice next.

## Positioning

Students can author material by hand or with an AI tool of their choice and bring it into the same editor and practice flows. **Create with your AI** prepares a prompt for use outside Exam Prep. The app validates, previews, and saves the returned content. The same portable study-set format supports import and export.

## Operating Context

- Students organize exams and flashcard decks in a personal library. They can choose a quick session, run a timed exam simulation, or study flashcards that are due for review. Exam simulations leave submission under the student's control.
- Students can review past attempts, retry mistakes, and revisit items they flagged or rated with low confidence. They can save selected items as a review set or print a worksheet for offline practice.
- Owners can share a live, view-only set or invite a registered user to co-edit it. Viewers can save a live reference. Discover lists sets published by admins, and an editable copy is independent of its source. Each student has their own practice history, notes, and review schedule.

## Capabilities and Constraints

- The version 1 `.examprep.json` contract supports single-choice and written exam questions, optional marking rubrics, and front/back flashcards. Study text supports Markdown, LaTeX, and chemistry notation. Study-set exports contain answer keys. Library and optional history backups are separate from study-set exports. [Authoring contract](skills/exam-prep-author/SKILL.md)
- The app grades single-choice answers automatically. Students assess written answers against a reference answer or rubric. Results show automatic and self-assessed scores separately. Each attempt snapshots the study material so it stays reviewable after the original is edited or deleted.
- Classmates gain access to content through explicit sharing, co-ownership, or Discover publication. Personal study data stays private. Authoring and practice provide device-local recovery, while confirmed practice progress is saved to the account. Recovery asks before overwriting conflicting work.

## Brand Commitments

The product name is **Exam Prep**. The repository's existing design handoff records the interface direction. [Design handoff](design.md)

## Evidence on Hand

- [Project requirements](REQUIREMENTS.md) describe the original audience, core flow, and acceptance criteria. [Current workflows](README.md#v1-study-workflows) describe the shipped additions.
- The public landing page includes an interactive sample flashcard. Downloadable examples cover both study formats. [Landing page source](client/features/Landing.tsx) · [Example exam](public/downloads/example-exam.examprep.json) · [Example flashcards](public/downloads/example-flashcards.examprep.json)

## Product Principles

1. Keep study content portable and editable so students can choose how they author and reuse it.
2. Make save and recovery status explicit so students know which work they can resume.
3. Keep results tied to the material the student practiced and show how each score was determined.
4. Make sharing deliberate and keep each student's practice progress private.

## Accessibility & Inclusion

Support desktop and mobile web, keyboard navigation, visible focus, accessible control labels, and reduced motion. Preserve adjustable study text size and keep long equations readable within the study area. [Accessibility requirements](REQUIREMENTS.md#screens-and-visual-system)
