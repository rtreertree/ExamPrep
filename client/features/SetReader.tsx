import type { ReactNode } from "react";
import type { SetReaderData } from "../../shared/directory";
import { itemsOf } from "../../shared/contentItems";
import { StudyContent } from "../components/StudyContent";
import { PageHeader } from "../components/ui";
import { Solution } from "../components/Solution";
import "./directory.css";

export default function SetReader({
  set,
  actions,
  showHeading = true,
}: {
  set: SetReaderData;
  actions?: ReactNode;
  showHeading?: boolean;
}) {
  const { content, ownerName } = set;
  return (
    <article className="stack">
      {showHeading && (
        <PageHeader
          title={content.title}
          description={"Owned by " + ownerName}
          actions={actions}
        />
      )}
      <StudyContent source={content.description} />
      <ol className="read-items">
        {itemsOf(content).map((item) => (
          <li key={item.id}>
            <StudyContent source={"front" in item ? item.front : item.prompt} />
            {"type" in item && item.type === "single_choice" && (
              <ol type="A">
                {item.options.map((option) => (
                  <li key={option.id}>
                    <StudyContent source={option.text} />
                  </li>
                ))}
              </ol>
            )}
            <details>
              <summary>{"front" in item ? "Show back" : "Show answer"}</summary>
              <Solution item={item} />
            </details>
          </li>
        ))}
      </ol>
    </article>
  );
}
