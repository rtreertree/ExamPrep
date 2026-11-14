import { memo, useState } from "react";
import { itemsOf } from "../../shared/contentItems";
import type { StudyContent as Content } from "../../shared/content";
import { Field } from "./ui";
import { Selector } from "./Selector";
import { StudyContent } from "./StudyContent";
import { RubricList } from "./RubricList";

export const ContentPreview = memo(function ContentPreview({
  content,
  selectedIndex,
}: {
  content: Content;
  selectedIndex?: number;
}) {
  const [index, setIndex] = useState(0);
  const items = itemsOf(content);
  const selected = Math.min(
    selectedIndex ?? index,
    Math.max(0, items.length - 1),
  );
  const item = items[selected];
  return (
    <div className="content-preview">
      <h3>{content.title}</h3>
      <p className="muted">
        {content.kind === "exam" ? "Exam" : "Flashcards"} · {items.length}{" "}
        {content.kind === "exam"
          ? items.length === 1
            ? "question"
            : "questions"
          : items.length === 1
            ? "card"
            : "cards"}
      </p>
      <StudyContent source={content.description} label="description" />
      {selectedIndex === undefined && items.length > 1 ? (
        <Field label="Preview item">
          <Selector
            value={String(selected)}
            onValueChange={(value) => setIndex(Number(value))}
            options={items.map((_, i) => ({
              value: String(i),
              label: `Item ${i + 1}`,
            }))}
          />
        </Field>
      ) : null}
      {item ? (
        <section key={item.id}>
          <span className="mono muted">
            {selectedIndex === undefined
              ? "Item"
              : `Preview of ${content.kind === "exam" ? "question" : "card"}`}{" "}
            {selected + 1} of {items.length}
          </span>
          {"type" in item ? (
            <>
              <StudyContent
                source={item.prompt}
                label={`question ${selected + 1}`}
              />
              {item.type === "single_choice"
                ? item.options.map((o, j) => (
                    <div className="preview-option" key={o.id}>
                      <span className="mono">
                        {String.fromCharCode(65 + j)}
                      </span>
                      <StudyContent source={o.text} label={`option ${j + 1}`} />
                    </div>
                  ))
                : null}
              <details>
                <summary>Show solution and explanation</summary>
                {item.type === "single_choice" ? (
                  <p>
                    Correct option:{" "}
                    {item.options.some((o) => o.id === item.answer)
                      ? String.fromCharCode(
                          65 +
                            item.options.findIndex((o) => o.id === item.answer),
                        )
                      : "Select a correct answer in the editor"}
                  </p>
                ) : (
                  <>
                    <h4>Reference answer</h4>
                    <StudyContent
                      source={item.answer}
                      label="reference answer"
                    />
                    {item.rubric ? (
                      <RubricList criteria={item.rubric} mode="review" />
                    ) : null}
                  </>
                )}
                <StudyContent source={item.explanation} label="explanation" />
              </details>
            </>
          ) : (
            <>
              <StudyContent source={item.front} label="card front" />
              <details>
                <summary>Show back</summary>
                <StudyContent source={item.back} label="card back" />
              </details>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
});
