# Review of commit `7e0fcae` — live set sharing and clone conversion

Compared [`7e0fcae` with its parent `23af444`](https://github.com/rtreertree/ExamPrep/compare/23af444316d38904ee550cf4fd55c83ab612049f...7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269). All three findings below are established by code inspection.

## 1. Revoking a share link can leave a converted clone in the recipient’s library

**Severity · Medium.** A learner originally copied a set through a share link. The set is also published when conversion runs, and the learner has never saved it through Discover. Disabling the link should remove that learner’s saved membership. The documented exception applies when the learner separately saved the Discover listing. [Sharing behavior](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/README.md#L116)

The normal save path sets `discovered` according to how the learner saved the set. Conversion instead writes the source’s `published` flag into `discovered`, alongside the receipt’s link nonce. When the owner disables the link, the database clears the nonce and retains the viewer row because `discovered` is true. The set therefore stays in the learner’s library while published. [Normal save](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/server/sharing.ts#L155-L166) · [Conversion](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/scripts/convert-clones.ts#L140-L148) · [Revocation triggers](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/prisma/migrations/202611210001_live_sets/migration.sql#L95-L111)

## 2. “Continue” opens the live reader for a converted clone with a local draft

**Severity · Medium.** A learner leaves unsaved edits on a device before their clone is converted. On that device, **Local drafts → Continue** still links to the old clone’s editor. The learner should be able to recover those edits independently of their permission to edit the live source. [Local draft entry](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/client/features/Library.tsx#L728-L742) · [Draft recovery controls](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/client/features/Editor.tsx#L651-L664)

While the learner retains access to the source, the API resolves the old clone ID to the source set. The editor loads the local draft under the old ID, then redirects to the live reader because the returned ID differs. That redirect happens before the recovery controls render. The draft remains on the device, but opening its library entry never displays the unsaved work. [Clone ID lookup](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/server/setRoutes.ts#L259-L268) · [Draft lookup](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/client/features/Editor.tsx#L78-L87) · [Reader redirect](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/client/features/Editor.tsx#L108-L125)

## 3. A history backup omits the learner’s review schedules for view-only decks

**Severity · Medium.** A learner saves a live flashcard deck, completes a due review, and downloads a library backup with practice history enabled. The backup screen says the history file includes review schedules, so the learner can reasonably expect to recover the card streaks and due dates from that backup. [Backup screen](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/client/features/AccountBackup.tsx#L112-L116)

Spaced review stores the learner’s schedule in `ViewerCardReview`. The export excludes viewer sets and reads schedule rows only from the primary-owner and co-owner tables. It includes the learner’s attempts with the viewer set reference cleared, but the archive contains no corresponding schedule rows to restore. [Viewer schedule table](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/server/spacedReview.ts#L55-L71) · [Schedule write](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/server/spacedReview.ts#L136-L144) · [Backup export](https://github.com/rtreertree/ExamPrep/blob/7e0fcae94dad0bcf5c3ef78ca2a9663f1c748269/server/backup.ts#L72-L94)

## Verification

All 16 tests passed across the three unit suites run with `npm test -- tests/backup.test.ts tests/study-progress.test.ts tests/server-progress.test.ts`. Live database and browser behavior remain unverified for these scenarios.
