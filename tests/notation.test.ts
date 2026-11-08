import { expect, it } from "vitest";
import { formulaSelection, insertFormula } from "../client/lib/notation";

it("edits a formula at the caret while preserving surrounding prose and Unicode", () => {
  const source = "สมการ 🦊 $x^2$ has a solution.";
  const selection = formulaSelection(
    source,
    source.indexOf("x^2") + 1,
    source.indexOf("x^2") + 1,
  );
  expect(selection.latex).toBe("x^2");
  expect(insertFormula(source, selection, "\\frac{1}{2}", false).value).toBe(
    "สมการ 🦊 $\\frac{1}{2}$ has a solution.",
  );
});
it("replaces selected text and returns the insertion caret", () => {
  const source = "Use this here";
  const result = insertFormula(
    source,
    formulaSelection(source, 4, 8),
    "\\ce{H2O}",
    false,
  );
  expect(result.value).toBe("Use $\\ce{H2O}$ here");
  expect(result.caret).toBe(result.value.indexOf(" here"));
});
it("retains display formulas and separates new display formulas from prose", () => {
  const source =
    "Before\n\n$$\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\n$$\n\nAfter";
  const selection = formulaSelection(source, 15, 15);
  expect(selection.display).toBe(true);
  expect(insertFormula(source, selection, "x", true).value).toBe(
    "Before\n\n$$\nx\n$$\n\nAfter",
  );
  expect(
    insertFormula("AB", formulaSelection("AB", 1, 1), "x", true).value,
  ).toBe("A\n\n$$\nx\n$$\n\nB");
});
it("does not treat escaped dollars as formula delimiters or overwrite prose spanning formulas", () => {
  expect(formulaSelection("Cost \\$5 and \\$6", 8, 8).latex).toBe("");
  expect(formulaSelection("Before $x$ after", 0, 16)).toMatchObject({
    start: 0,
    end: 16,
    latex: "Before $x$ after",
  });
});
