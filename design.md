# Exam Prep — Graphite / Volt

UI direction and reusable design system for the implementing AI agent. This is a design handoff; no application UI has been implemented.

Read [requirements](REQUIREMENTS.md), [implementation plan](IMPLEMENTATION_PLAN.md), and the [content contract](skills/exam-prep-author/SKILL.md) alongside this document. This document owns appearance, layout, component anatomy, and motion. Requirements own product behavior; the content contract owns file fields and grading semantics. This dark direction supersedes the earlier light/indigo theme.

## 1. Creative direction

**Minimal, contemporary, with a little depth.** Matte charcoal surfaces, warm white typography, a restrained lime accent, and one faint background gradient. A light frosted treatment on navigation and overlays adds softness. Large titles sit above useful lists. Numbers occupy a narrow margin. Learning content gets space. Controls feel quick and precise.

The product name remains **Exam Prep**. “Graphite / Volt” is the internal theme name, not a badge or headline to add to the interface.

Four recurring visual signatures give the application its identity:

1. **The margin mark:** a 2 px lime rule identifies the active navigation item, selected editor item, or active study surface. It moves between states instead of multiplying across the page.
2. **The editorial index:** quiet monospaced ordinals, strong titles, generous row spacing, and thin dividers. Libraries and histories use lists rather than grids of decorative cards.
3. **The study object:** one simple matte framed surface for a flashcard or focused question group. The surrounding interface stays open and calm.
4. **Soft depth:** a barely visible corner gradient behind the canvas, with subtle frosted navigation. Content surfaces stay clean and visually quiet.

Creativity comes from composition, typography, and small interactions. Keep the interface specific to study material. Avoid promotional heroes, invented statistics, decorative AI sparkles, floating blobs, neon grids, rainbow gradients, and a glowing border around every element. Do not add product features to fill negative space. Glass is a subtle finish: no glossy bevels, refracted edges, luminous rims, or reflective slabs.

## 2. Visual references

These original concepts were generated with the built-in image tool for this handoff and saved in the project:

| Reference | Native size | What to follow |
| --- | --- | --- |
| [Library](design/references/library-minimal.png) | 1536 × 1024 | Current minimal finish: faint gradient, understated navigation, open list layout, accent discipline. |
| [Exam practice](design/references/exam-practice.png) | 1536 × 1024 | Focus shell, question/answer hierarchy, selected option, clear footer. |
| [Editor](design/references/editor.png) | 1536 × 1024 | Item rail, editing fields, rubric rows, separate rendered preview. |
| [Flashcard answer](design/references/flashcards-minimal.png) | 1536 × 1024 | Current minimal finish: matte study surface, subtle header frosting, large math, separated rating actions. |
| [Mobile library](design/references/mobile-library.png) | 1024 × 1536 | Collapsed navigation, readable titles, list continuity, generous tap areas. |

Use the images for composition and visual character; use the exact tokens, responsive rules, and behavior below when raster details differ. The revised Library and Flashcard references establish the material treatment; apply that same restraint to the editor, exam, and mobile layouts. Image lettering and sample counts are illustrative. Build native text/controls and token-based materials, not screenshots as UI. Use actual saved content in production. The mobile image is a composition reference at approximately 390 CSS px, not a request for a 1024 CSS px phone layout. Row-level Practice stays secondary even where a reference shows a brighter hover state; reserve the primary action hierarchy for Import.

The [current material briefs](design/minimal-concept-prompts.md) record the revised Library and Flashcard directions. The [initial screen briefs](design/concept-prompts.md) retain the layout references; this document governs their material treatment. These references are design assets, not production backgrounds.

## 3. Foundation tokens

### Color

Use semantic tokens; components reference roles rather than embedding hex values.

| Token | Value | Role |
| --- | --- | --- |
| `canvas` | `#111315` | Main background, focus view, sidebar. |
| `surface` | `#1A1D21` | Inputs, selected/hovered rows, purposeful panels. |
| `surfaceRaised` | `#20242A` | Dialogs, menus, flashcard back, elevated states. |
| `ambientTint` | `#31524B` at 12% opacity | One faint background gradient only; never a control or text color. |
| `textPrimary` | `#F5F3EC` | Main text and rendered math. |
| `textSecondary` | `#BAC0C8` | Supporting text. |
| `textMuted` | `#949CA8` | Metadata, helper text, captions. |
| `divider` | `#30343D` | Decorative separators; not the sole boundary of a control. |
| `controlBorder` | `#686E7C` | Input, outlined-button, and unselected-option boundaries. |
| `accent` | `#D9F77E` | Primary actions, active markers, selected indicators, focus. |
| `accentHover` | `#E4FF9B` | Hovered primary action. |
| `onAccent` | `#151A0A` | Labels and icons on lime. |
| `positive` | `#9DE3BB` | Correct results and confirmed success. |
| `warning` | `#F5CD86` | Unsaved conflicts, partial-credit attention, warnings. |
| `negative` | `#FF8F8F` | Errors, incorrect results, destructive emphasis. |
| `information` | `#AFC8FF` | Informational notices when a semantic accent is needed. |

A selected answer uses lime to mean **selected**, never **correct** before submission. Result correctness uses a label/icon and the appropriate semantic color. “Review again” is a neutral study action, not an error. Use neutral helper text for “Draft saved on this device.”

Selected-fill treatment: accent at 6% over `surface`; 1 px accent keyline. Focus treatment: solid 2 px accent outline with a 3 px offset. Controls use `controlBorder` until selected/focused; low-contrast dividers are only structural. Never use opacity on an entire text-bearing container to produce a muted appearance.

Checked token pairs: primary text on canvas 16.77:1; muted text on the highest surface 5.63:1; primary action labels 14.83:1; control borders against the highest surface 3.05:1. Recheck contrast when adding new combinations.

### Subtle gradient and frosted material

The page should read as a dark, minimal app at first glance. Effects are noticeable only on closer inspection. Use these named recipes through the shared material layer:

| Material | Recipe | Where it belongs |
| --- | --- | --- |
| `canvasAmbient` | Base `canvas`, plus one broad radial gradient centered near 85% horizontal / 10% vertical. `ambientTint` at 12% fades to transparent over roughly 60% of the viewport. Static; no bright center. | Workspace canvas and sign-in background. In practice/editor, halve the tint opacity or use plain canvas. |
| `frostedNavigation` | Dark fill `rgba(17, 19, 21, 0.94)`, 10 px backdrop blur, saturation 105%, ordinary divider. | Sidebar or top navigation. Keep the established shell geometry; no rounded full-height glass capsule. |
| `frostedOverlay` | Dark fill `rgba(26, 29, 33, 0.96)`, 12 px backdrop blur, normal border and one restrained shadow. | Menus, dialogs, and sheets. Dim the surrounding page without applying a second full-page blur. |
| `contentMatte` | Opaque `surface` or `canvas`, with a simple border where needed. No backdrop blur or specular effects. | Questions, flashcards, answer choices, editor inputs, rubric rows, and previews. |

Primary buttons remain solid lime. Use ordinary one-pixel borders, not gradient strokes. No animated gradient, shiny sweep, glass highlight band, refraction, bloom, or lens distortion. Never blur text, icons, or mathematical notation. Do not lower the material opacity just to make the blur more visible.

Keep at most two overlapping blurred layers, such as navigation plus an open menu; avoid nested blur inside a panel. If backdrop blur is unsupported, costly, or reduced transparency is requested, replace the material with its opaque base color. Typography, boundaries, and focus states must still work. The baseline contrast ratios above describe opaque surfaces; verify actual composited contrast over the brightest gradient region during implementation.

### Typography

Use **Instrument Sans** for headings, body, and controls; **IBM Plex Mono** only for ordinals, raw JSON/math source, and compact numeric details. KaTeX retains its math fonts. Bundle the selected font files and relevant licenses during implementation; use system sans-serif/monospace fallbacks while loading. Do not let font loading move controls or clip labels.

| Role | Desktop size / line height | Weight / tracking | Phone adjustment |
| --- | --- | --- | --- |
| Library display title | 64 / 68 px | 600 / −0.04em | 40 / 44 px |
| Page title | 36 / 44 px | 600 / −0.025em | 28 / 36 px |
| Section title | 24 / 32 px | 600 / −0.015em | 22 / 30 px |
| Study prompt | 24 / 38 px | 500 / normal | 20 / 32 px |
| Body / editor content | 16 / 26 px | 400 / normal | Same |
| Button / navigation / field label | 14 / 20 px | 500–600 / normal | Same |
| Metadata / helper | 14 / 22 px | 400 / normal | Same |
| Ordinal / caption | 12 / 18 px | 400–500 / normal | Same |

Long question prose uses natural paragraph rhythm and a maximum line length around 72 characters. Do not animate reading text character by character. Preserve authored emphasis/headings within a controlled content scale; imported content cannot restyle the application shell. Inputs remain at least 16 px for editable text on phones.

### Geometry and elevation

Spacing scale: **4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80 px**. Use 8 px as the default rhythm and 4 px for internal corrections.

| Element | Rule |
| --- | --- |
| Buttons / fields / menus | 8 px radius. |
| Flashcard / dialog / upload zone | 12 px radius. |
| Pills | Only for true segmented controls if needed; avoid pill-shaped metadata. |
| Borders | 1 px; active margin marks 2 px; visible focus 2 px. |
| Controls | At least 44 px high, with 16 px horizontal padding; icon-only targets 44 × 44 px. |
| Answer option | Minimum 64 px high; grows with prose/math rather than clipping. |
| Library row | Minimum 88 px on desktop; mobile grows to fit title, metadata, and actions. |
| Elevation | Only menus/dialogs/flashcards: dark shadow, 0 16 px 48 px at black 28%; no stack of nested shadows. |
| Layer order | Base 0, sticky header/footer 10, menu 30, modal backdrop 40, modal 50, notification 60. |

Outline icons use one consistent family, 18 px default, 20 px in primary navigation, approximately 1.75 px stroke, round joins. Keep icons functional and optically centered. Use upload, plus, arrow, chevron, history, account, check, ellipsis, drag handle, and trash consistently. A simple text wordmark is sufficient; no generated logo is required.

## 4. Layout and responsive system

Two variants of one `AppShell`:

- **Workspace:** Library, History, Editor, Account. At 1200 px and above, a 216 px left sidebar contains Exam Prep, Library, History, and Account at the bottom. Main area has 48 px gutters and maximum content width 1320 px. The sidebar uses a shared active marker; it does not become a decorative dashboard.
- **Focus:** Exam/flashcard practice and results. Replace the sidebar with a 72 px header containing Library/back, set title, and save status. Center the study column at a maximum 800 px; an optional question navigator occupies a separate 176 px rail on wide screens. A sticky footer remains in document flow and reserves its own space.

| Width | Behavior |
| --- | --- |
| ≥1440 px | Full workspace sidebar; editor has 192 px item rail plus edit and preview columns, each at least 360 px. |
| 1200–1439 px | Sidebar stays; editor has a 176 px item rail and Edit/Preview tabs in the remaining region. |
| 768–1199 px | 64 px top bar with menu replaces sidebar; 32 px gutters. Editor item list is a drawer; Edit/Preview tabs share the canvas. |
| <768 px | 20 px gutters. One content column. Library actions wrap; editor has item picker and Edit/Preview tabs. Question navigation opens from a labeled question-count button. |

At phone sizes, library row title/metadata use the upper line and Practice/overflow use an action line below. Keep the complete title readable; do not shrink type to force a desktop row onto a phone. Collapse header actions into a labeled overflow menu only when space requires it, keeping the primary action visible.

Math scrolls horizontally **inside its own region** when needed; prose wraps normally. Never create page-wide horizontal scrolling. On short screens or with an on-screen keyboard, sticky bars must not cover focused fields, options, or dialog actions. Dialogs become bottom sheets on phones; tall content scrolls inside with a visible close action.

## 5. Reusable component contract

Organize the future UI into **foundations → primitives → study patterns → screens**. Screens compose shared parts and own orchestration; they do not invent new buttons, colors, save indicators, or motion curves. Keep domain validation/scoring separate from presentation.

### Primitives

| Component | Shared anatomy and allowed variants |
| --- | --- |
| `Button` | Label, optional leading/trailing icon, busy indicator; `primary`, `secondary`, `quiet`, `danger`. Busy preserves width and announces state. |
| `IconButton` | Same state/target contract, mandatory accessible name and optional tooltip; no unlabeled click target. |
| `Field` | Persistent label, input/textarea/select slot, helper, error; `default`, `focus`, `invalid`, `disabled`, `readOnly`. Placeholder never replaces label. |
| `Surface` | `flat`, `raised`, `study`, `frostedNavigation`, `frostedOverlay`; owns the named fill/border/elevation/blur recipes. Study content always uses the matte variant; no per-screen glass experiments. |
| `Tabs` | Label row, shared moving underline, panel association, keyboard selection; reused for filters and editor modes. |
| `Dialog` / `Sheet` | Title, content, action group, dismissal rules, focus management. Share one overlay/backdrop treatment. |
| `Menu` | Anchored actions, keyboard movement, clear destructive item; used for set/attempt overflow and compact headers. |
| `InlineNotice` / `Toast` | Status icon, message, optional action; persistent inline notices for work requiring attention, toast only for brief confirmation. |
| `EmptyState` / `LoadingRows` | Plain heading, useful explanation, one action; loading geometry matches the eventual rows. |

All interactive primitives cover default, hover, active/pressed, focus-visible, disabled, busy, and error where applicable. Hover effects have keyboard equivalents; touch never relies on hover. One primary button per local action group. Primary actions use solid color; no image or animated gradient text labels.

### Study patterns

| Component | Owns / reuse |
| --- | --- |
| `PageHeader` | Heading, optional supporting text, action slot; consistent across workspace screens. |
| `StudySetRow` | Ordinal, title, kind/count metadata, Practice, overflow. Same data/anatomy across desktop and mobile. |
| `ItemRail` | Question/card rows, selected marker, add/reorder controls. Use the same selection treatment as navigation. |
| `StudyContent` | The single safe Markdown/LaTeX renderer used in import preview, editor preview, questions, flashcards, explanations, and rubrics. |
| `AnswerOption` | Ordinal, radio indicator, content slot; distinct selected, correct, incorrect, unanswered, and read-only states. |
| `RubricList` | Shared criterion text/points layout with `author`, `assess`, and `review` modes. Author mode edits maxima; assess mode awards points; review mode shows earned/max. |
| `PracticeFrame` | Header, position/progress, content slot, navigation/footer, save status. Exam and flashcard views share this frame. |
| `FlashcardStage` | One front/back object, explicit reveal action, rating action slot, measured content height, accessible flip lifecycle. |
| `SaveStatus` | Explicit database vs local-draft channel; Saving, Saved, Draft saved on this device, Could not save, Retry. Reuse everywhere. |
| `ScoreSummary` / `AttemptRow` | Separate automatic/self-assessed scores, pending status, source/retry link, real counts. No fabricated charts or combined grade. |
| `RecoveryBanner` / `AIHandoffPanel` | Draft Restore/Discard/Save as new choices; external-AI prompt and skill/example downloads. Compose standard notices, fields, and actions. |

Variants must express meaningful differences. Reuse one option row for every exam type that needs it, and one rubric layout across modes. Shared tokens own spacing/radii/type; a shared material layer owns gradients and frosting; a shared motion layer owns the named presets below. Avoid copied “almost the same” components and a single giant page containing every feature. Keep imported study content independent of app chrome.

## 6. Screen recipes

| Screen | Composition and main interactions |
| --- | --- |
| Library | “Your library”, optional supporting sentence, Import primary, Create secondary. Underline tabs All / Exams / Flashcards, then open rows. Create offers Exam, Flashcards, and Create with your AI. Overflow offers Edit, Export, Delete. Empty state: “Your first set starts here.” with Import and a quiet Create alternative. |
| Import | Dialog/sheet: file drop/select or Paste JSON tabs, then validated content preview and Save. Use a quiet dashed upload boundary, not a giant illustration. Show errors at their fields and a concise summary. Warn on malformed math while preserving the source. |
| Create with your AI | Sheet with topic, level, language, item count, and Exam/Flashcards choice; Copy prompt, Download skill, example downloads, and Import next step. Treat this as an external-tool handoff, not a fake AI chat. |
| Editor | Persistent header with set title, separate local/database save states, Export secondary and Save primary. Item rail → labeled fields → Preview. Rubric authoring uses criteria plus maxima and a derived total. Restore banner appears above fields and never replaces content without an explicit choice. |
| Exam practice | Ordinal, type label, authored prompt/math, options or written field. Navigation state reflects answered/current/unanswered, with no correctness hint before submit. Next is primary during navigation; Submit exam is secondary until the final question, where hierarchy swaps. Submit confirmation lists unanswered count. |
| Flashcards | Front cue in one study object and Reveal answer primary. After reveal, the answer replaces the cue face and Review again / Known actions appear underneath; finishing remains separate. Never place ratings inside the exported card content. |
| Results | Set title, honest status, separate automatic and self-assessed score typography, rubric point breakdowns, and answer review. Retry mistakes primary only when eligible; Back to library secondary. Pending written assessment shows “Finish self-assessment” and no finished-state celebration yet. |
| History | Open chronological attempt rows with title, date, status, real results, and resume/review action. Retry relationships appear as a small text link. Long titles wrap. |
| Sign in / Register | One 420 px form on a dark canvas with the faint ambient gradient. Wordmark and clear type provide identity. Persistent email/password labels, primary submit, secondary form switch. Errors stay near the relevant input. |
| Account | Page header, email, change-password form using shared fields, sign-out action. Keep recovery/email delivery outside the current product scope. |

## 7. Motion direction: small, quick, consistent

Use animation across navigation, selection, import, editing, studying, and completion, with short distances and clear feedback. Coverage across interactions provides richness; individual effects remain minimal. Keep motion tied to user actions and data changes, so a screen at rest settles into stillness. The gradient and frosted materials do not animate.

### Shared motion tokens

| Token | Value | Use |
| --- | --- | --- |
| `instant` | 100 ms | Press/release, simple color response. |
| `quick` | 160 ms | Icons, field focus, small state changes. |
| `standard` | 240 ms | Notices, content disclosure, selector movement. |
| `travel` | 320 ms | Route transitions, drawers, list movement. |
| `flip` | 480 ms | Flashcard reveal. |
| `finish` | 320 ms | A simple completion fade after confirmed persistence. |
| `easeOut` | cubic-bezier(0.22, 1, 0.36, 1) | Entering and settling. |
| `easeInOut` | cubic-bezier(0.65, 0, 0.35, 1) | Shared underline/progress travel. |
| `easeExit` | cubic-bezier(0.4, 0, 1, 1) | Brief exits; use 140 ms. |

### Choreography recipes

| Event / reusable preset | Standard motion | Reduced-motion equivalent |
| --- | --- | --- |
| First workspace entry | Header fades/rises 8 px in 320 ms; first six list rows follow at 35 ms intervals, each 240 ms. Run once per route entry. | Immediate layout or 80 ms opacity fade; no stagger. |
| Workspace route change | Shared shell stays fixed; outgoing content fades 140 ms, incoming content enters 8 px over 240 ms. Keep focus/scroll intentional. | Replace content with at most 80 ms fade. |
| Navigation / tabs | One active marker/underline travels to the new item in 240 ms. | Marker moves instantly. |
| Button press | Translate down 1 px for 100 ms; arrow advances 3 px on hover/focus and returns on exit. No moving text label. | Color/border change only. |
| Library row hover/focus | Surface tint enters in 160 ms; active margin line reveals vertically; Practice arrow advances 3 px. A broad warm-white light at 5.5% may follow a fine pointer within the hovered row. | Instant fill/marker change; no pointer light. |
| Matte flashcard hover | The same local surface light follows a fine pointer; border and shadow deepen in 240 ms. Text and the card stay fixed. Disable the light for reduced transparency. | Static surface; no pointer light. |
| Menu / dialog / sheet | Menu fades/translates 4 px in 160 ms; dialog enters 12 px in 240 ms; phone sheet travels 24 px in 320 ms. Backdrop fades, never blurs the whole study canvas. | Opacity only, at most 80 ms. |
| File drag/drop | Boundary changes to lime; upload icon lifts 4 px on drag entry and settles on drop. Validated preview enters 240 ms. | Immediate border/preview state. |
| Copy prompt / download | Copy icon changes to check over 160 ms; short confirmation text. No pretend success before the operation succeeds. | Instant check and confirmation. |
| Editor item selection | Margin marker moves; field/preview group crossfades in 160 ms. Inputs remain usable immediately. | Immediate content switch. |
| Add / remove / reorder item | Affected rows slide into new positions over 240 ms; added row fades in. Provide Move up/down controls for keyboard users. | Instant reorder with an announcement. |
| Draft recovery notice | Notice opens 4 px over 160 ms; restored fields receive a static confirmation label. | Instant notice and static confirmation. |
| Answer selection | Radio inner dot scales 0.8→1 and keyline changes over 160 ms. The question and options stay fixed. | Instant dot/keyline change. |
| Next / previous question | Current question exits 12 px in navigation direction over 140 ms; next enters from the opposite side over 240 ms. Math/text move as one surface, never per glyph. | Opacity-only content swap. |
| Answer/card progress | Fill length interpolates in 240 ms; displayed counts update immediately. | Fill jumps to the actual value. |
| Flashcard reveal | One 180° Y-axis flip over 480 ms, perspective 1200 px, no bounce. Swap visible/accessible face halfway; rating actions appear after settling. | Replace front with back using at most 80 ms fade; ratings appear immediately. |
| Flashcard rating / next card | Rated card shifts 12 px out and fades over 160 ms; next card settles from 12 px over 240 ms. Any rating direction is accompanied by its explicit label. | Replace card immediately; announce rating/position. |
| Database save | Busy indicator only if pending beyond 200 ms; confirmed save replaces it with a check over 160 ms. Never make a fake delay to show the effect. | Static busy text, then confirmed text. |
| Submit / finish | After a successful server response, final score groups fade into place over 320 ms. Values are immediately readable; no light sweep, count-up, or celebration effect. | Immediate final values and a static confirmation. |
| Mistake retry | Eligible count becomes the new practice count; header transitions into PracticeFrame over 320 ms and a fresh progress line starts at zero. | Immediate new attempt with a clear title/count. |
| Error / conflict | Border/status changes in 160 ms; concise inline explanation. Do not shake the whole form or hide error text in a disappearing toast. | Instant state with persistent explanation. |

### Motion boundaries

- Prefer transform/opacity for movement. Animate deliberate list/notice layout changes only through the shared preset, without making an answer move away from the pointer.
- At most one major transition per region at a time. Retarget from the current state when interrupted; do not queue stale motion. Rapid question navigation must land on the most recent action.
- Keep typing, clicking, and focus responsive. Motion never delays persistence, creates an additional required click, or disguises loading. A card cannot accept duplicate ratings while transitioning; announce/save the first action and provide the next card promptly.
- No infinite ambient animation, typing effect, confetti, cycling gradients, light sweeps, scroll-jacking, detached cursor follower, or zoom applied to mathematical notation. Use short state transitions. The canvas gradient and frosting stay static; pointer light is confined to the hovered matte row or flashcard.
- Use natural document scrolling. No parallax on reading content. Keep browser focus and assistive-technology reading order in sync with what is visible.
- Honor `prefers-reduced-motion` from the first frame and whenever it changes. Remove 3D, travel, stagger, and sweeps; preserve explicit state, focus, and save feedback. Opposite flashcard faces must never both be exposed to assistive technology or keyboard focus.

## 8. Interaction and state consistency

Every screen needs loading, empty, ready, busy, error, and session-expired treatments where relevant. Reuse components rather than replacing the entire page with a spinner. Loading rows are static low-contrast shapes or a brief opacity pulse in standard motion; no shimmer in reduced motion. Reserve their dimensions to prevent jumps.

Keep essential status adjacent to the affected task. “Draft saved on this device” is different from “Saved to your account.” If a save fails, preserve the input, show “Could not save” and Retry, and keep the failure visible. Draft conflicts offer Restore/Discard or Save as new according to requirements. Toasts must not be the only place containing data-loss or session-expiry information.

Use semantic form controls and headings. Radio options operate as one labeled group. Reordering has non-drag controls. Dialogs trap focus and return it to the trigger. Sticky navigation never steals the user's typing focus. Keyboard shortcuts, if later added, must be documented and must not activate inside text fields.

Long mathematical expressions, long words, Unicode course titles, multiline options, and 20,000-character content fields must retain the same visual system without fixed-height clipping. Card content may expand; measure front/back surfaces before a flip and use ordinary scrolling for long cards. On small/short screens, use the fade reveal if a 3D flip would crop content.

## 9. Rules for the implementing agent

1. Start with the token layer, shared material recipes, typography, AppShell variants, primitives, and shared motion presets. Establish their states before composing whole screens.
2. Build Library, one exam question, one flashcard, and the rubric editor from those parts; extend the same families to the remaining screens. All required product screens still need completion.
3. Treat each page as composition. Feature modules own study-specific presentation, services own persistence/scoring, and one renderer owns Markdown/math behavior.
4. Do not introduce a new accent, type scale, radius, panel style, icon family, or transition for an isolated screen. Add a named reusable variant when a real case requires one.
5. Preserve real content and product flow. Do not seed fake progress/analytics, add password recovery, or turn the app into a landing page to resemble a reference.
6. Verify desktop at 1536 × 1024, a 1280 px laptop, a 768 px tablet, and phones at 390 px and 320 px widths, including short heights and an open keyboard. Check standard and reduced motion.
7. Compare rendered screens with the appropriate visual references for hierarchy, spacing, palette, type, control anatomy, and responsive composition. Record intentional differences caused by this written contract or real content.
8. Check navigation, import errors, invalid math, editor draft recovery, partial-credit assessment, flashcard reveal/rating, save failure, results, and mistake retry. Verify motion interruptions and keyboard paths as well as still screenshots.

The design is complete when every screen shares the same minimal character: dark matte surfaces, warm type, restrained lime, a hint of gradient/frosting, consistent components, and quiet interactions.
