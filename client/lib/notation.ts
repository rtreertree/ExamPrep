export type FormulaSelection = {
  start: number;
  end: number;
  latex: string;
  display: boolean;
};

// Only replace a formula when the selection is inside its delimiters, or
// explicitly selects it. Surrounding prose stays byte-for-byte unchanged.
export function formulaSelection(
  source: string,
  start: number,
  end: number,
): FormulaSelection {
  const formulas =
    /(?<![\\$])\$\$([\s\S]*?)\$\$|(?<![\\$])\$(?!\$)((?:\\.|[^$\n])*)\$(?!\$)/g;
  for (const match of source.matchAll(formulas)) {
    const from = match.index!;
    const to = from + match[0].length;
    if (start >= from && end <= to && (start < to || end > start))
      return {
        start: from,
        end: to,
        latex: (match[1] ?? match[2]).trim(),
        display: match[1] !== undefined,
      };
  }
  return { start, end, latex: source.slice(start, end), display: false };
}

export function insertFormula(
  source: string,
  selection: FormulaSelection,
  latex: string,
  display: boolean,
) {
  const formula = display ? `$$\n${latex.trim()}\n$$` : `$${latex.trim()}$`;
  const before = source.slice(0, selection.start);
  const after = source.slice(selection.end);
  const inserted = display
    ? `${before && !before.endsWith("\n\n") ? "\n\n" : ""}${formula}${after && !after.startsWith("\n\n") ? "\n\n" : ""}`
    : formula;
  return {
    value: before + inserted + after,
    caret: before.length + inserted.length,
  };
}
