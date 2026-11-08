import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { z } from "zod";
import { contentSchema, parseContent } from "../shared/content";
const directory = "public/downloads";
await mkdir(directory, { recursive: true });
const skill = await readFile("skills/exam-prep-author/SKILL.md", "utf8");
const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) =>
  parseContent(m[1]),
);
for (const example of examples)
  await writeFile(
    `${directory}/example-${example.kind}.examprep.json`,
    JSON.stringify(example, null, 2) + "\n",
  );
await copyFile("skills/exam-prep-author/SKILL.md", `${directory}/SKILL.md`);
await writeFile(
  `${directory}/examprep.schema.json`,
  JSON.stringify(
    {
      ...z.toJSONSchema(contentSchema),
      title: "Exam Prep version 1",
      $comment:
        "Additional application validation is required. See VALIDATION.md: duplicate JSON keys; UTF-8/byte limits; nonblank Unicode strings; unique local IDs; answer references; allowed Markdown/LaTeX.",
    },
    null,
    2,
  ) + "\n",
);
console.info("Generated schema, authoring skill, and validated examples.");

await mkdir("public/licenses", { recursive: true });
for (const font of ["instrument-sans", "ibm-plex-mono"])
  await copyFile(
    `node_modules/@fontsource/${font}/LICENSE`,
    `public/licenses/${font}.txt`,
  );
await copyFile("node_modules/katex/LICENSE", "public/licenses/katex.txt");
await copyFile("node_modules/mathlive/LICENSE.txt", "public/licenses/mathlive.txt");
