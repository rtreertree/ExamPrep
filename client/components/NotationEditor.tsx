import { lazy, Suspense, useRef, useState } from "react";
import { codePoints, type AnswerType } from "../../shared/content";
import {
  formulaSelection,
  insertFormula,
  type FormulaSelection,
} from "../lib/notation";
import { Button, Dialog } from "./ui";

const FormulaComposer = lazy(() => import("./FormulaComposer"));

type Props = {
  value: string;
  onChange: (value: string) => void;
  answerType?: AnswerType;
  id?: string;
  "aria-describedby"?: string;
  rows?: number;
  className?: string;
  readOnly?: boolean;
  maxCharacters?: number;
  "aria-invalid"?: boolean;
};

export function NotationEditor({
  value,
  onChange,
  answerType = "simple",
  id,
  rows,
  className,
  readOnly,
  maxCharacters = 20_000,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState<{
    type: "math" | "chem";
    selection: FormulaSelection;
  }>();
  const count = codePoints(value);
  const [showTools, setShowTools] = useState(false);
  function close() {
    setEditing(undefined);
    requestAnimationFrame(() => input.current?.focus());
  }
  function open(type: "math" | "chem") {
    const node = input.current!;
    setEditing({
      type,
      selection: formulaSelection(
        value,
        node.selectionStart,
        node.selectionEnd,
      ),
    });
  }
  return (
    <div className="notation-editor">
      <textarea
        ref={input}
        id={id}
        aria-describedby={
          [describedBy, id ? `${id}-count` : ""].filter(Boolean).join(" ") ||
          undefined
        }
        aria-invalid={invalid || count > maxCharacters}
        rows={rows}
        className={className}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {!readOnly ? (
        <small
          id={id ? `${id}-count` : undefined}
          className={count > maxCharacters ? "negative" : "muted"}
        >
          {count.toLocaleString()} / {maxCharacters.toLocaleString()} characters
        </small>
      ) : null}
      {!readOnly ? (
        <div
          className="notation-toolbar"
          role="group"
          aria-label="Notation tools"
        >
          <Button
            variant="quiet"
            aria-expanded={showTools}
            onClick={() => setShowTools(!showTools)}
          >
            Symbols
          </Button>
          {showTools || answerType === "math" ? (
            <Button
              variant={answerType === "math" ? "primary" : "quiet"}
              onClick={() => open("math")}
            >
              <span aria-hidden="true">∑</span> Math keyboard
            </Button>
          ) : null}
          {showTools || answerType === "chem" ? (
            <Button
              variant={answerType === "chem" ? "primary" : "quiet"}
              onClick={() => open("chem")}
            >
              <span aria-hidden="true">H₂O</span> Chemistry keyboard
            </Button>
          ) : null}
        </div>
      ) : null}
      {editing && !readOnly ? (
        <Dialog
          title={
            editing.type === "chem" ? "Chemistry notation" : "Math notation"
          }
          onClose={close}
        >
          <Suspense fallback={<p role="status">Loading notation keyboard…</p>}>
            <FormulaComposer
              type={editing.type}
              initial={editing.selection}
              onCancel={close}
              onInsert={(latex, display) => {
                const next = insertFormula(
                  value,
                  editing.selection,
                  latex,
                  display,
                );
                onChange(next.value);
                setEditing(undefined);
                requestAnimationFrame(() => {
                  input.current?.focus();
                  input.current?.setSelectionRange(next.caret, next.caret);
                });
              }}
            />
          </Suspense>
        </Dialog>
      ) : null}
    </div>
  );
}
