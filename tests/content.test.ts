import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseContent,
  validateContent,
  type StudyContent,
} from "../shared/content";
import { decodeFile, MAX_BYTES, parseJSON } from "../shared/json";
const exam = JSON.parse(
  readFileSync("public/downloads/example-exam.examprep.json", "utf8"),
);
const deck = JSON.parse(
  readFileSync("public/downloads/example-flashcards.examprep.json", "utf8"),
);
const clone = () => structuredClone(exam);
describe("portable content contract", () => {
  it.each([exam, deck])("round trips every field and array in $kind", (doc) =>
    expect(parseContent(JSON.stringify(validateContent(doc)))).toEqual(doc),
  );
  it("preserves absence, empty optional text, Unicode, IDs and math source", () => {
    const doc = clone();
    doc.title = "  วิชา ∫ 🦊  ";
    doc.questions[0].id = "__proto__";
    doc.description = "";
    expect(parseContent(JSON.stringify(doc))).toEqual(doc);
  });
  it.each([
    [
      "unsupported version",
      (d: any) => {
        d.schemaVersion = 2;
      },
    ],
    [
      "string version",
      (d: any) => {
        d.schemaVersion = "1";
      },
    ],
    [
      "mixed kinds",
      (d: any) => {
        d.cards = [];
      },
    ],
    [
      "unknown envelope field",
      (d: any) => {
        d.$schema = "extra";
      },
    ],
    [
      "blank title",
      (d: any) => {
        d.title = " \t\n";
      },
    ],
    [
      "overlong title",
      (d: any) => {
        d.title = "🦊".repeat(201);
      },
    ],
    [
      "duplicate question IDs",
      (d: any) => {
        d.questions[1].id = d.questions[0].id;
      },
    ],
    [
      "invalid ID",
      (d: any) => {
        d.questions[0].id = "has space";
      },
    ],
    [
      "numeric ID",
      (d: any) => {
        d.questions[0].id = 3;
      },
    ],
    [
      "missing options",
      (d: any) => {
        delete d.questions[0].options;
      },
    ],
    [
      "one option",
      (d: any) => {
        d.questions[0].options = [d.questions[0].options[0]];
      },
    ],
    [
      "seven options",
      (d: any) => {
        d.questions[0].options = Array.from({ length: 7 }, (_, i) => ({
          id: String(i),
          text: "x",
        }));
      },
    ],
    [
      "duplicate option IDs",
      (d: any) => {
        d.questions[0].options[1].id = "a";
      },
    ],
    [
      "dangling answer",
      (d: any) => {
        d.questions[0].answer = "B";
      },
    ],
    [
      "unknown option property",
      (d: any) => {
        d.questions[0].options[0].points = 1;
      },
    ],
    [
      "written options",
      (d: any) => {
        d.questions[1].options = [];
      },
    ],
    [
      "choice rubric",
      (d: any) => {
        d.questions[0].rubric = d.questions[1].rubric;
      },
    ],
    [
      "null rubric",
      (d: any) => {
        d.questions[1].rubric = null;
      },
    ],
    [
      "empty rubric",
      (d: any) => {
        d.questions[1].rubric = [];
      },
    ],
    [
      "21 criteria",
      (d: any) => {
        d.questions[1].rubric = Array.from({ length: 21 }, (_, i) => ({
          id: String(i),
          description: "x",
          points: 1,
        }));
      },
    ],
    [
      "duplicate criteria",
      (d: any) => {
        d.questions[1].rubric[1].id = "rule";
      },
    ],
    ...[0, -1, 101, 1.5, "2"].map(
      (points) =>
        [
          `invalid rubric points ${points}`,
          (d: any) => {
            d.questions[1].rubric[0].points = points;
          },
        ] as const,
    ),
    [
      "null optional",
      (d: any) => {
        d.description = null;
      },
    ],
    [
      "empty questions",
      (d: any) => {
        d.questions = [];
      },
    ],
    [
      "501 items",
      (d: any) => {
        d.questions = Array.from({ length: 501 }, (_, i) => ({
          ...d.questions[2],
          id: String(i),
        }));
      },
    ],
    [
      "blank prompt",
      (d: any) => {
        d.questions[0].prompt = "  ";
      },
    ],
    [
      "overlong text",
      (d: any) => {
        d.questions[0].prompt = "x".repeat(20001);
      },
    ],
    [
      "raw HTML",
      (d: any) => {
        d.questions[0].prompt = "<script>alert(1)</script>";
      },
    ],
    [
      "image",
      (d: any) => {
        d.questions[0].prompt = "![image](https://example.com/a.png)";
      },
    ],
    [
      "reference image",
      (d: any) => {
        d.questions[0].prompt = "![image][a]\n\n[a]: https://example.com/a.png";
      },
    ],
    [
      "unsafe link",
      (d: any) => {
        d.questions[0].prompt = "[click](javascript:alert%281%29)";
      },
    ],
    [
      "macro definition",
      (d: any) => {
        d.questions[0].prompt = "$\\newcommand{\\x}{x}$";
      },
    ],
    [
      "LaTeX resource",
      (d: any) => {
        d.questions[0].prompt = "$\\includegraphics{https://example.com/a}$";
      },
    ],
  ] as [string, (d: any) => void][])("rejects %s", (_, mutate) => {
    const d = clone();
    mutate(d);
    expect(() => validateContent(d)).toThrow();
  });
  it("preserves JSON-escaped NUL and isolated surrogates", () => {
    const d = clone();
    d.title = "NUL \0 and \uD800 ~u0000;";
    expect(parseContent(JSON.stringify(d))).toEqual(d);
  });
  it("accepts 200 Unicode code points rather than UTF-16 units", () => {
    const d = clone();
    d.title = "🦊".repeat(200);
    expect(validateContent(d).title).toBe(d.title);
  });
  it("accepts minimum and maximum option, criterion and item bounds", () => {
    const d = clone();
    d.questions[0].options = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      text: "x",
    }));
    d.questions[0].answer = "0";
    d.questions[1].rubric = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      description: "x",
      points: i ? 100 : 1,
    }));
    const first = d.questions[1];
    d.questions = [
      d.questions[0],
      ...Array.from({ length: 499 }, (_, i) => ({
        ...first,
        id: "written" + i,
      })),
    ];
    expect(validateContent(d)).toBeTruthy();
  });
  it("math syntax errors are retained for rendering warnings", () => {
    const d = clone();
    d.questions[0].prompt = "$\\frac{1}{$";
    expect(validateContent(d)).toEqual(d);
  });
  it("literal code remains text, safe ordinary links are allowed", () => {
    const d = clone();
    d.questions[0].prompt =
      '`<script>`\n\n```html\n<img src="x">\n```\n\n[Notes](https://example.com)';
    expect(validateContent(d)).toEqual(d);
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"x":{"a":1,"a":2}}',
    '[{"x":1,"x":2}]',
  ])("rejects duplicate decoded object keys: %s", (raw) =>
    expect(() => parseJSON(raw)).toThrow(/Duplicate object key/),
  );
  it.each([
    "\uFEFF{}",
    '{"x":1,}',
    "[1,]",
    "{/*x*/}",
    "01",
    "1e999",
    '{"x":"\\q"}',
    "true false",
  ])("rejects invalid JSON syntax: %s", (raw) =>
    expect(() => parseJSON(raw)).toThrow(),
  );
  it("reports duplicate field path and syntax line/column", () => {
    expect(() => parseJSON('{\n"questions":[{"id":"x","id":"y"}]}')).toThrow(
      "/questions/0/id",
    );
    expect(() => parseJSON("{\n bad}")).toThrow(/line 2, column/);
  });
  it("enforces raw UTF-8 byte boundary including whitespace", () => {
    const raw = JSON.stringify(deck);
    const exact =
      raw + " ".repeat(MAX_BYTES - new TextEncoder().encode(raw).length);
    expect(parseContent(exact)).toEqual(deck);
    expect(() => parseContent(exact + " ")).toThrow(/2 MiB/);
  });
  it("rejects malformed UTF-8 and byte-order marks", () => {
    expect(() => decodeFile(Uint8Array.from([0xc0, 0xaf]).buffer)).toThrow(
      "UTF-8",
    );
    expect(() =>
      decodeFile(Uint8Array.from([239, 187, 191, 123, 125]).buffer),
    ).toThrow("byte-order");
  });
  it("validates flashcards strictly", () => {
    for (const patch of [{ rating: "known" }, { back: " " }, { front: null }]) {
      const d = structuredClone(deck);
      Object.assign(d.cards[0], patch);
      expect(() => validateContent(d)).toThrow();
    }
    const d = structuredClone(deck);
    d.cards[1].id = "c1";
    expect(() => validateContent(d)).toThrow();
  });
});
