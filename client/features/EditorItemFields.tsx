import { ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import {
  freshId,
  type AnswerType,
  type Question,
  type Card,
} from "../../shared/content";
import { Button, Field } from "../components/ui";
import { Selector } from "../components/Selector";
import { NotationEditor } from "../components/NotationEditor";
import { RubricList } from "../components/RubricList";
import type { Removal } from "./editorItems";

export function ItemFields({
  item,
  disabled,
  onChange,
  path,
  onRemove,
}: {
  path: string;
  item: Question | Card;
  disabled: boolean;
  onChange: (item: Question | Card) => void;
  onRemove: (removal: Removal) => void;
}) {
  if (!("type" in item))
    return (
      <div className="stack">
        <h2>Flashcard</h2>
        <Field path={`${path}/front`} label="Front">
          <NotationEditor
            value={item.front}
            onChange={(value) => onChange({ ...item, front: value })}
          />
        </Field>
        <Field path={`${path}/back`} label="Back">
          <NotationEditor
            value={item.back}
            onChange={(value) => onChange({ ...item, back: value })}
          />
        </Field>
        <details>
          <summary>Item details</summary>
          <p className="muted mono">Stable ID: {item.id}</p>
        </details>
      </div>
    );
  const q = item;
  const optionalExplanation = (value: string) => {
    const next = { ...q };
    if (value === "") delete next.explanation;
    else next.explanation = value;
    onChange(next);
  };
  return (
    <div className="stack">
      <h2>{q.type === "written" ? "Written answer" : "Single choice"}</h2>
      <Field
        path={`${path}/prompt`}
        label="Question"
        hint="Markdown and LaTeX are supported."
      >
        <NotationEditor
          value={q.prompt}
          onChange={(value) => onChange({ ...q, prompt: value })}
        />
      </Field>
      {q.type === "single_choice" ? (
        <>
          <h3>Answer options</h3>
          {q.options.map((o, i) => (
            <div className="option-editor" key={o.id}>
              <Field
                path={`${path}/options/${i}/text`}
                label={`Option ${String.fromCharCode(65 + i)}`}
              >
                <NotationEditor
                  value={o.text}
                  onChange={(value) =>
                    onChange({
                      ...q,
                      options: q.options.map((option, n) =>
                        i === n ? { ...option, text: value } : option,
                      ),
                    })
                  }
                />
              </Field>
              <div className="actions">
                <Button
                  aria-label={`Move option ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...q.options];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    onChange({ ...q, options: next });
                  }}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  aria-label={`Move option ${i + 1} down`}
                  disabled={i === q.options.length - 1}
                  onClick={() => {
                    const next = [...q.options];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    onChange({ ...q, options: next });
                  }}
                >
                  <ArrowDown size={16} />
                </Button>
                <Button
                  variant="quiet"
                  aria-label={`Remove option ${i + 1}`}
                  disabled={q.options.length <= 2}
                  onClick={() => {
                    const options = q.options.filter((_, n) => n !== i);
                    onRemove({
                      kind: "option",
                      itemId: q.id,
                      option: o,
                      index: i,
                      wasAnswer: q.answer === o.id,
                    });
                    onChange({
                      ...q,
                      options,
                      answer: q.answer === o.id ? "" : q.answer,
                    });
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
          ))}
          <Button
            disabled={q.options.length >= 6}
            onClick={() =>
              onChange({
                ...q,
                options: [...q.options, { id: freshId(), text: "" }],
              })
            }
          >
            Add option
          </Button>
          <Field path={`${path}/answer`} label="Correct answer">
            <Selector
              value={q.answer}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...q, answer: value })}
              placeholder="Select a correct answer"
              options={[
                { value: "", label: "Select a correct answer", disabled: true },
                ...q.options.map((option, i) => ({
                  value: option.id,
                  label: `Option ${String.fromCharCode(65 + i)}`,
                })),
              ]}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Answer type"
            hint="Choose the preferred keyboard for this written answer."
          >
            <Selector
              value={q.answerType ?? "simple"}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...q, answerType: value as AnswerType })
              }
              options={[
                { value: "simple", label: "Simple · text" },
                { value: "math", label: "Math · equations and symbols" },
                { value: "chem", label: "Chem · formulas and reactions" },
              ]}
            />
          </Field>
          <Field path={`${path}/answer`} label="Reference answer">
            <NotationEditor
              value={q.answer}
              answerType={q.answerType}
              onChange={(value) => onChange({ ...q, answer: value })}
            />
          </Field>
          {q.rubric ? (
            <RubricList
              criteria={q.rubric}
              path={`${path}/rubric`}
              mode="author"
              onRemove={(criterion, index) =>
                onRemove({ kind: "criterion", itemId: q.id, criterion, index })
              }
              onChange={(rubric) => {
                if (rubric.length) onChange({ ...q, rubric });
                else {
                  const next = { ...q };
                  delete next.rubric;
                  onChange(next);
                }
              }}
            />
          ) : (
            <Button
              onClick={() =>
                onChange({
                  ...q,
                  rubric: [{ id: freshId(), description: "", points: 1 }],
                })
              }
            >
              Add marking rubric
            </Button>
          )}
        </>
      )}
      <Field path={`${path}/explanation`} label="Explanation (optional)">
        <NotationEditor
          value={q.explanation ?? ""}
          onChange={optionalExplanation}
        />
      </Field>
      <details>
        <summary>Item details</summary>
        <p className="muted mono">Stable ID: {q.id}</p>
      </details>
    </div>
  );
}
