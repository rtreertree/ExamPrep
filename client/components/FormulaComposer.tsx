import { useEffect, useRef, useState } from "react";
import { MathfieldElement, type VirtualKeyboardLayout } from "mathlive";
import "mathlive/fonts.css";
import { Button, Field } from "./ui";
import { StudyContent } from "./StudyContent";
import type { FormulaSelection } from "../lib/notation";

// Fonts are bundled by Vite. Do not fetch fonts, sounds, or a compute engine.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

const basic: VirtualKeyboardLayout = {
  label: "Basic",
  tooltip: "Numbers, fractions, roots and powers",
  rows: [
    ["x", "y", "\\frac{#0}{#?}", "\\sqrt{#0}", "#@^{#?}", "#@_{#?}"],
    ["7", "8", "9", "\\div", "(", ")"],
    ["4", "5", "6", "\\times", "=", "\\pi"],
    ["1", "2", "3", "-", "\\infty", "\\pm"],
    ["0", ".", "+", "[left]", "[right]", "[backspace]"],
  ],
};

function wideLayout(
  layout: VirtualKeyboardLayout,
  id: string,
): VirtualKeyboardLayout {
  if (!("rows" in layout)) return layout;
  const { rows, ...options } = layout;
  return { ...options, layers: [{ id: `notation-${id}`, rows }] };
}

const advanced: VirtualKeyboardLayout = {
  label: "∫ ∑",
  tooltip: "Functions and calculus",
  rows: [
    [
      "\\sin(#0)",
      "\\cos(#0)",
      "\\tan(#0)",
      "\\log_{#?}(#0)",
      "\\ln(#0)",
      "e^{#0}",
    ],
    [
      {
        latex: "\\int",
        insert: "\\int_{#?}^{#?}#0\\,dx",
        tooltip: "Definite integral",
      },
      "\\frac{d}{dx}#0",
      "\\frac{\\partial #0}{\\partial x}",
      "\\lim_{x\\to #?}#0",
      { latex: "\\sum", insert: "\\sum_{n=#?}^{#?}#0", tooltip: "Summation" },
      { latex: "\\prod", insert: "\\prod_{n=#?}^{#?}#0", tooltip: "Product" },
    ],
    [
      "\\binom{#0}{#?}",
      "#0!",
      "\\lvert#0\\rvert",
      "\\lfloor#0\\rfloor",
      "\\lceil#0\\rceil",
      "\\infty",
    ],
    ["[left]", "[right]", "[backspace]", "[undo]", "[redo]", "[hide-keyboard]"],
  ],
};
const structures: VirtualKeyboardLayout = {
  label: "[▦]",
  tooltip: "Matrices, vectors, sets and logic",
  rows: [
    [
      "\\begin{pmatrix}#0&#?\\\\#?&#?\\end{pmatrix}",
      "\\begin{bmatrix}#0&#?\\\\#?&#?\\end{bmatrix}",
      "\\begin{cases}#0&#?\\\\#?&#?\\end{cases}",
      "\\vec{#0}",
      "\\hat{#0}",
      "\\overline{#0}",
    ],
    ["\\in", "\\notin", "\\subseteq", "\\cup", "\\cap", "\\emptyset"],
    [
      "\\mathbb{R}",
      "\\mathbb{Z}",
      "\\mathbb{C}",
      "\\forall",
      "\\exists",
      "\\implies",
    ],
    ["[left]", "[right]", "[backspace]", "[undo]", "[redo]", "[hide-keyboard]"],
  ],
};
const chemistry: VirtualKeyboardLayout = {
  label: "Chem",
  tooltip: "Elements, ions and reactions",
  rows: [
    [
      "\\mathrm{H}",
      "\\mathrm{C}",
      "\\mathrm{N}",
      "\\mathrm{O}",
      "\\mathrm{Na}",
      "\\mathrm{Cl}",
    ],
    [
      "#@_{#?}",
      "#@^{#?}",
      "\\rightarrow",
      "\\rightleftharpoons",
      "\\xrightarrow{#0}",
      "\\Delta",
    ],
    [
      "\\ce{H2O}",
      "\\ce{CO2}",
      "\\ce{SO4^2-}",
      "\\ce{^{14}_{6}C}",
      "\\ce{(aq)}",
      { latex: "\\ce{v}", variants: ["\\ce{v}", "\\ce{^}"] },
    ],
    ["[left]", "[right]", "[backspace]", "[undo]", "[redo]", "[hide-keyboard]"],
  ],
};

export default function FormulaComposer({
  type,
  initial,
  onInsert,
  onCancel,
}: {
  type: "math" | "chem";
  initial: FormulaSelection;
  onInsert: (latex: string, display: boolean) => void;
  onCancel: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const keyboardHost = useRef<HTMLDivElement>(null);
  const mathfield = useRef<MathfieldElement | null>(null);
  const [latex, setLatex] = useState(initial.latex);
  const [display, setDisplay] = useState(initial.display);
  useEffect(() => {
    const field = new MathfieldElement();
    mathfield.current = field;
    field.setAttribute("aria-label", "Visual formula");
    field.mathVirtualKeyboardPolicy = "manual";
    field.value = initial.latex;
    const keyboard = window.mathVirtualKeyboard;
    keyboard.container = keyboardHost.current;
    keyboard.layouts =
      type === "chem"
        ? [
            wideLayout(chemistry, "chem"),
            wideLayout(basic, "basic"),
            "numeric",
            "alphabetic",
            "greek",
            "symbols",
            wideLayout(advanced, "calculus"),
            wideLayout(structures, "structures"),
          ]
        : [
            wideLayout(basic, "basic"),
            wideLayout(advanced, "calculus"),
            wideLayout(structures, "structures"),
            "numeric",
            "symbols",
            "alphabetic",
            "greek",
            wideLayout(chemistry, "chem"),
          ];
    const change = () => setLatex(field.value);
    const focus = () => keyboard.show();
    // MathLive reconnects a blurred field after a short focus delay. Route the
    // first command directly while the source textarea still owns DOM focus,
    // otherwise a fast tap can arrive before that connection is ready.
    const command = (event: Event) => {
      if (document.activeElement !== field)
        field.executeCommand((event as CustomEvent).detail);
    };
    keyboard.addEventListener("math-virtual-keyboard-command", command);
    field.addEventListener("input", change);
    field.addEventListener("focusin", focus);
    host.current!.appendChild(field);
    field.focus();
    keyboard.show();
    keyboard.executeCommand([
      "switchKeyboardLayer",
      `notation-${type === "chem" ? "chem" : "basic"}`,
    ]);
    return () => {
      field.removeEventListener("input", change);
      field.removeEventListener("focusin", focus);
      keyboard.removeEventListener("math-virtual-keyboard-command", command);
      keyboard.hide();
      keyboard.container = null;
      keyboard.layouts = "default";
      field.remove();
      mathfield.current = null;
    };
  }, [initial.latex, type]);
  return (
    <div className="formula-composer">
      <p className="muted">
        Tap symbols to build your formula. Hold a key for more symbols. Select
        an existing formula in the text to edit it.
      </p>
      <div ref={host} className="formula-visual" />
      <div
        ref={keyboardHost}
        className="formula-keyboard"
        // This command restores mathfield focus without scrolling the dialog
        // away from the key being tapped after source editing or a layout switch.
        onPointerDownCapture={() =>
          mathfield.current?.executeCommand("showVirtualKeyboard")
        }
      />
      <Field
        label="LaTeX source"
        hint={
          type === "chem"
            ? "Use \\ce{2H2 + O2 -> 2H2O} for chemical equations, ions and isotopes."
            : "You can also type or paste LaTeX commands here, without $ delimiters."
        }
      >
        <textarea
          rows={2}
          value={latex}
          spellCheck={false}
          onChange={(event) => {
            setLatex(event.target.value);
            mathfield.current?.setValue(event.target.value, {
              silenceNotifications: true,
            });
          }}
        />
      </Field>
      <label className="formula-display">
        <input
          type="checkbox"
          checked={display}
          onChange={(event) => setDisplay(event.target.checked)}
        />{" "}
        Display on its own line
      </label>
      <div className="formula-preview" aria-label="Formula preview">
        <StudyContent
          source={latex.trim() ? `$$\n${latex}\n$$` : undefined}
          label="formula preview"
        />
      </div>
      <div className="dialog-footer actions">
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!latex.trim()}
          onClick={() => onInsert(latex, display)}
        >
          Insert formula
        </Button>
      </div>
    </div>
  );
}
