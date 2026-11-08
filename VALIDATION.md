# Version-1 validation

The standalone authoring skill is the authoritative portable contract. Browser and API import/save/export share `shared/content.ts` and `shared/json.ts`. The build generates `public/downloads/examprep.schema.json` with Zod's JSON Schema generator; it is not a separately maintained schema.

Written questions accept optional `answerType: "simple" | "math" | "chem"` in schema version 1. Omission uses the simple text keyboard without adding a field to old files. Answer and response strings retain Markdown with `$...$`/`$$` math delimiters; chemistry supports mhchem `\ce{...}` and `\pu{...}`. This preference does not change self-assessment or rubric grading, and is forbidden on choice questions and flashcards.

The JSON Schema captures strict variants, allowed fields, array bounds, ID patterns, integer rubric points, Unicode string maxima, and optional fields. A schema-only validator cannot enforce every rule. The application additionally checks:

- Exact UTF-8 byte limits including JSON whitespace, fatal UTF-8 decoding, and no byte-order mark.
- Strict JSON syntax with duplicate **decoded** object-key detection before ordinary parsing loses duplicates. Errors include JSON Pointer paths and line/column positions. JSON nesting is bounded at 64 levels as a parser resource limit; valid content shapes are much shallower.
- Nonblank strings without trimming or normalizing stored text. Unicode limits count decoded code points rather than UTF-16 code units.
- Unique item IDs within a document, unique option/criterion IDs within their question, and same-question answer references. All IDs are case-sensitive; prototype-like valid IDs are preserved safely.
- Allowed Markdown nodes, safe HTTP(S) links, and prohibited HTML, images/media, resource-loading math, and custom macro definitions. Literal code remains text. Ordinary formula syntax errors produce readable field-labeled rendering warnings; they do not block a valid document or rewrite its source.
- The 2 MiB boundary after serializing content. Export uses pretty JSON when it fits and compact JSON otherwise, so pretty-printing cannot make an accepted document invalid.

PostgreSQL JSONB and text columns cannot directly store JSON-escaped NUL or isolated surrogate code units. `server/storage.ts` applies a reversible escape **only at the storage boundary** and reverses it before validation/presentation/export. Prototype-sensitive response-map keys are also escaped before Prisma serializes JSON arguments. Literal escape-like text, tildes, Unicode, IDs, math, and order round-trip unchanged. This is not an extra portable field or a file-format conversion.

Practice records are separate from portable files. The server verifies response fields against snapshot item kinds, exact references, written-answer lengths, criterion identities, integer awards, maximum bounds, reveal-before-rating, position, ownership, revision, and status. It recomputes totals; the client cannot supply results, snapshots, ownership, or source links. Missing rubric criteria differ from explicit zero. Unanswered written questions receive zero without pending assessment. Automatic and self-assessed categories stay separate.

Database constraints check metadata consistency and basic state/position invariants. Triggers protect ownership, snapshots, source links, valid transitions, and completed results. Optimistic conditional updates prevent stale saves, and repeated/concurrent submission returns the already frozen result. Retry selection uses the source snapshot, with fresh empty responses and no inherited score.

The application validates file structure and permitted content constructs. It does not verify subject-matter correctness or author-written rubric quality.
