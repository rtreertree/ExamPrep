import type { Question, Card } from "../../shared/content";
import { StudyContent } from "./StudyContent";
export function Solution({ item }: { item: Question | Card }) {
  if ("back" in item) return <StudyContent source={item.back} />;
  const choice =
    item.type === "single_choice"
      ? item.options.findIndex((option) => option.id === item.answer)
      : -1;
  return (
    <>
      {item.type === "single_choice" ? (
        <div className="worksheet-solution">
          <strong>{String.fromCharCode(65 + choice)}.</strong>
          <StudyContent source={item.options[choice].text} />
        </div>
      ) : (
        <StudyContent source={item.answer} />
      )}
      {item.explanation ? (
        <StudyContent source={item.explanation} label="Explanation" />
      ) : null}
      {item.type === "written" && item.rubric ? (
        <ul aria-label="Marking rubric">
          {item.rubric.map((criterion) => (
            <li key={criterion.id}>
              <div className="worksheet-solution">
                <strong>
                  {criterion.points} {criterion.points === 1 ? "pt" : "pts"}
                </strong>
                <StudyContent source={criterion.description} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
