import { NotationEditor } from "./NotationEditor";
import { ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import { freshId, type Criterion } from "../../shared/content";
import { own } from "../../shared/attempts";
import { Button, Field } from "./ui";
import { StudyContent } from "./StudyContent";
type Props = {
  criteria: Criterion[];
  mode: "author" | "assess" | "review";
  awards?: Record<string, number>;
  onAward?: (id: string, points: number | undefined, commit: boolean) => void;
  onChange?: (criteria: Criterion[]) => void;
  disabled?: boolean;
};
export function RubricList({
  criteria,
  mode,
  awards,
  onAward,
  onChange,
  disabled,
}: Props) {
  return (
    <section className="rubric">
      <h3>Marking rubric</h3>
      {mode === "assess" ? (
        <p className="muted">
          Points save when you leave a field or press Enter.
        </p>
      ) : null}
      {criteria.map((c, i) => (
        <div className="rubric-row" key={c.id}>
          {mode === "author" ? (
            <>
              <Field label={`Criterion ${i + 1}`}>
                <NotationEditor
                  value={c.description}
                  onChange={(value) =>
                    onChange?.(
                      criteria.map((r, n) =>
                        n === i ? { ...r, description: value } : r,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Maximum points">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={Number.isNaN(c.points) ? "" : c.points}
                  onChange={(e) =>
                    onChange?.(
                      criteria.map((r, n) =>
                        n === i
                          ? {
                              ...r,
                              points:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            }
                          : r,
                      ),
                    )
                  }
                />
              </Field>
              <div className="actions">
                <Button
                  aria-label={`Move criterion ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...criteria];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    onChange?.(next);
                  }}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  aria-label={`Move criterion ${i + 1} down`}
                  disabled={i === criteria.length - 1}
                  onClick={() => {
                    const next = [...criteria];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    onChange?.(next);
                  }}
                >
                  <ArrowDown size={16} />
                </Button>
                <Button
                  variant="quiet"
                  aria-label={`Remove criterion ${i + 1}`}
                  onClick={() => onChange?.(criteria.filter((_, n) => n !== i))}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </>
          ) : (
            <>
              <StudyContent
                source={c.description}
                label={`criterion ${i + 1}`}
              />
              {mode === "assess" ? (
                <Field
                  label={`Points for criterion ${i + 1} (maximum ${c.points})`}
                >
                  <input
                    type="number"
                    min={0}
                    max={c.points}
                    step={1}
                    disabled={disabled}
                    value={awards ? (own(awards, c.id) ?? "") : ""}
                    onChange={(e) =>
                      onAward?.(
                        c.id,
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                        false,
                      )
                    }
                    onBlur={(e) =>
                      onAward?.(
                        c.id,
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                        true,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </Field>
              ) : (
                <span className="mono">
                  {awards && own(awards, c.id) !== undefined
                    ? `${own(awards, c.id)} / `
                    : ""}
                  {c.points} points
                </span>
              )}
            </>
          )}
        </div>
      ))}
      {mode === "author" ? (
        <Button
          disabled={criteria.length >= 20}
          onClick={() =>
            onChange?.([
              ...criteria,
              { id: freshId(), description: "", points: 1 },
            ])
          }
        >
          Add criterion
        </Button>
      ) : null}
      <p className="muted mono">
        {criteria.reduce(
          (n, c) => n + (Number.isFinite(c.points) ? c.points : 0),
          0,
        )}{" "}
        points total
      </p>
    </section>
  );
}
