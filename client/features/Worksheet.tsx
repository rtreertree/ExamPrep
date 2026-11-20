import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import type { StudyContent as Content } from "../../shared/content";
import { itemsOf } from "../../shared/contentItems";
import { StudyContent } from "../components/StudyContent";
import { Solution } from "../components/Solution";
import { Selector } from "../components/Selector";
import { Button, ErrorNotice, Field, LoadingRows } from "../components/ui";
import type { StudySet } from "../lib/api";
import { useResource } from "../lib/hooks";
import { libraryReturnPath } from "../lib/libraryRoute";
import "./worksheet.css";

const printOptions = [
  { value: "prompts", label: "Worksheet only" },
  { value: "both", label: "Worksheet and answer key" },
  { value: "key", label: "Answer key only" },
];
const lineOptions = [0, 2, 4, 6].map((n) => ({
  value: String(n),
  label: n ? `${n} lines` : "No lines",
}));

export default function WorksheetPage() {
  const { id } = useParams();
  const { state } = useLocation();
  const { data, error, refresh } = useResource<
    StudySet & { ownerName: string }
  >(`/sets/${id}`);
  const editor = `/sets/${id}/edit`;
  const fromEditor = state?.returnTo === editor;
  const fromResults =
    typeof state?.returnTo === "string" &&
    /^\/practice\/[A-Za-z0-9_-]+$/.test(state.returnTo);
  const library = libraryReturnPath(state?.returnTo);
  return (
    <main className="worksheet-page">
      <nav className="worksheet-nav" aria-label="Worksheet navigation">
        <Link
          className="back-link"
          to={fromResults || fromEditor ? state.returnTo : library}
          state={fromResults ? { returnTo: state.practiceReturnTo } : undefined}
        >
          <ArrowLeft size={16} aria-hidden="true" />{" "}
          {fromResults ? "Results" : fromEditor ? "Editor" : "Library"}
        </Link>
      </nav>
      {error ? (
        <ErrorNotice error={error} retry={refresh} />
      ) : data ? (
        <Worksheet
          key={data.id}
          content={data.content}
          ownerName={data.ownerName}
        />
      ) : (
        <LoadingRows label="Loading worksheet" />
      )}
    </main>
  );
}

function Worksheet({
  content,
  ownerName,
}: {
  content: Content;
  ownerName: string;
}) {
  const [layout, setLayout] = useState("prompts");
  const [lines, setLines] = useState(2);
  const items = itemsOf(content);
  const unit = content.kind === "exam" ? "question" : "card";
  const hasWrittenAnswers =
    content.kind === "flashcards" ||
    content.questions.some((q) => q.type === "written");
  const keyOnly = layout === "key";
  useEffect(() => {
    const previous = document.title;
    document.title = `${content.title} — ${keyOnly ? "Answer key" : "Worksheet"}`;
    return () => {
      document.title = previous;
    };
  }, [content.title, keyOnly]);

  return (
    <>
      <header className="worksheet-toolbar">
        <h1>Print worksheet</h1>
        <Button variant="primary" onClick={() => window.print()}>
          <Printer size={17} aria-hidden="true" /> Print or save PDF
        </Button>
      </header>
      <div className="worksheet-settings">
        <Field label="Print content">
          <Selector
            value={layout}
            options={printOptions}
            onValueChange={setLayout}
          />
        </Field>
        {!keyOnly && hasWrittenAnswers ? (
          <Field label="Writing space">
            <Selector
              value={String(lines)}
              options={lineOptions}
              onValueChange={(v) => setLines(Number(v))}
            />
          </Field>
        ) : null}
      </div>
      <article aria-label="Worksheet preview">
        {!keyOnly ? (
          <section className="worksheet-paper" aria-label="Worksheet">
            <header className="worksheet-heading">
              <p className="mono">
                {items.length} {unit}
                {items.length === 1 ? "" : "s"}
              </p>
              <h2>{content.title}</h2>
              <p>Owned by {ownerName}</p>
              <StudyContent source={content.description} />
            </header>
            <ol className="worksheet-items" aria-label="Worksheet prompts">
              {items.map((item) => (
                <li key={item.id}>
                  <StudyContent
                    source={"front" in item ? item.front : item.prompt}
                  />
                  {"type" in item && item.type === "single_choice" ? (
                    <ol className="worksheet-choices" type="A">
                      {item.options.map((option) => (
                        <li key={option.id}>
                          <StudyContent source={option.text} />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    lines > 0 && (
                      <div
                        className="worksheet-writing-space"
                        aria-hidden="true"
                      >
                        {Array.from({ length: lines }, (_, index) => (
                          <span key={index} />
                        ))}
                      </div>
                    )
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {layout !== "prompts" ? (
          <section
            className="worksheet-paper worksheet-key"
            aria-label="Answer key"
          >
            <header className="worksheet-heading">
              <p>{content.title}</p>
              <h2>Answer key</h2>
              <p>Owned by {ownerName}</p>
            </header>
            <ol className="worksheet-items">
              {items.map((item) => (
                <li key={item.id}>
                  <Solution item={item} />
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </article>
    </>
  );
}
