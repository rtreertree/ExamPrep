# ExamPrep

- Start with the files named in the task. For a feature request, find its row in the [code map](docs/code-map.md) for source files and tests. Use `rg -n` in the relevant files or directories and read the matching sections. Update the map when an entry point or test moves.
- Use `client/App.tsx` for page routes, `server/app.ts` for API registration, and `prisma/schema.prisma` for the data model.
- For download changes, start with `shared/content.ts` (schema), `skills/exam-prep-author/SKILL.md` (guide and examples), and `scripts/assets.ts` (generator for `public/downloads/`). Start with `prisma/schema.prisma` for generated Prisma types and `wrangler.jsonc` for Worker bindings. Open `worker-configuration.d.ts` or `package-lock.json` when the task concerns generated Worker types or dependency resolution.
- Run the closest test first, for example `npm test -- tests/attempts.test.ts`. See [verification](README.md#verification) for broader checks. Use a dedicated test database for live API and browser tests.
