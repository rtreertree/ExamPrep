import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Copy,
  PenLine,
  RefreshCw,
  Timer,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  AIAuthoringDownloads,
  AIPromptGenerator,
} from "../components/AIPromptGenerator";
import { defaultAISettings } from "../lib/aiSettings";
import "./landing.css";

const studySteps = [
  {
    title: "Build your sets",
    description:
      "Create or import your own exams and flashcards, then organize them by course.",
    Icon: Copy,
  },
  {
    title: "Practice your way",
    description:
      "Run a timed exam or a quick session. Flag questions you want to revisit.",
    Icon: Timer,
  },
  {
    title: "Review what’s due",
    description:
      "Use spaced review for flashcards and revisit questions you flagged or felt unsure about.",
    Icon: RefreshCw,
  },
];

function LandingBrand() {
  return (
    <a href="#top" className="landing-brand">
      <span className="landing-brand-mark">
        <BookOpen aria-hidden="true" />
      </span>
      Exam Prep
    </a>
  );
}

function GetStartedLink() {
  return (
    <Link className="landing-primary" to="/sign-in?mode=register">
      Get started <ArrowUpRight aria-hidden="true" />
    </Link>
  );
}

function SampleFlashcard() {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="landing-demo">
      <svg
        className="landing-orbit"
        viewBox="0 0 720 610"
        fill="none"
        aria-hidden="true"
      >
        <ellipse
          cx="356"
          cy="308"
          rx="346"
          ry="263"
          transform="rotate(-16 356 308)"
          stroke="currentColor"
          strokeDasharray="7 8"
          strokeLinecap="round"
        />
        <path
          d="M301 0v101m-13-87h26M301 531v79m-13-14h26M690 274h30m-10-13v26"
          stroke="currentColor"
        />
        <circle cx="560" cy="66" r="9" fill="var(--accent)" />
      </svg>
      <div className="landing-deck">
        <button
          id="sample-flashcard"
          className="landing-flashcard"
          type="button"
          aria-label={revealed ? "Show question" : "Reveal answer"}
          aria-describedby="sample-flashcard-text"
          onClick={() => setRevealed((showAnswer) => !showAnswer)}
        >
          <span
            className="landing-card-flip"
            data-revealed={revealed}
            aria-hidden="true"
          >
            {[false, true].map((answer) => (
              <span
                className={`landing-card-face${answer ? " landing-card-answer" : ""}`}
                key={String(answer)}
              >
                <span className="landing-card-caption">
                  {answer ? "Sample answer" : "Sample flashcard"}
                </span>
                <span className="landing-equation">
                  <span className="landing-fraction">
                    <i>d</i>
                    <i>dx</i>
                  </span>
                  <span>
                    (<i>x</i>
                    <sup>2</sup>)
                  </span>
                  <span>=</span>
                  <span>
                    {answer ? (
                      <>
                        2<i>x</i>
                      </>
                    ) : (
                      "?"
                    )}
                  </span>
                </span>
                <span className="landing-card-action">
                  <RefreshCw size={17} />
                  {answer ? "Show question" : "Reveal answer"}
                </span>
              </span>
            ))}
          </span>
        </button>
      </div>
      <p id="sample-flashcard-text" className="sr-only" aria-live="polite">
        {revealed
          ? "The derivative of x squared is two x."
          : "What is the derivative of x squared?"}
      </p>
    </div>
  );
}

function StudyMaterials() {
  const [settings, setSettings] = useState(defaultAISettings);

  return (
    <section
      className="landing-materials"
      id="get-materials"
      aria-labelledby="landing-materials-title"
    >
      <div className="landing-container">
        <p className="landing-kicker">Create your first set</p>
        <div className="landing-study-intro">
          <h2 id="landing-materials-title">How to get study material</h2>
          <p>
            Bring a topic or your notes. Use your AI to generate a set, or{" "}
            <a href="#editor-path">write one in the Exam Prep editor</a>.
          </p>
        </div>

        <div className="landing-material-grid">
          <div className="landing-material-guide">
            <h3>Use your AI</h3>
            <ol>
              <li>
                <h4>Choose what to study</h4>
                <p>
                  Add a topic or notes in the{" "}
                  <a href="#prompt-generator">prompt builder</a>. Customize the
                  questions or cards if you like.
                </p>
              </li>
              <li>
                <h4>Copy the prompt into your AI tool</h4>
                <p>The prompt includes the file format and your settings.</p>
              </li>
              <li>
                <h4>Import the result</h4>
                <p>
                  Sign in and open <strong>Library → Import</strong>. Paste the
                  JSON or upload the file, then review the set before saving.
                </p>
              </li>
            </ol>
            <AIAuthoringDownloads />
          </div>

          <section
            className="landing-prompt-panel"
            id="prompt-generator"
            aria-labelledby="landing-prompt-title"
            tabIndex={-1}
          >
            <h3 id="landing-prompt-title">Prompt generator</h3>
            <AIPromptGenerator settings={settings} onChange={setSettings} />
          </section>
        </div>

        <section
          className="landing-editor-path"
          id="editor-path"
          aria-labelledby="landing-editor-title"
          tabIndex={-1}
        >
          <PenLine size={27} aria-hidden="true" />
          <div>
            <h3 id="landing-editor-title">Write it yourself in the editor</h3>
            <p>
              After signing in, choose <strong>Library → Create → Exam</strong>{" "}
              or <strong>Flashcards</strong>. Add exam questions and answers or
              flashcard fronts and backs, then save the set to your library.
            </p>
          </div>
          <Link className="button secondary" to="/sign-in">
            Sign in to use the editor{" "}
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
        </section>
      </div>
    </section>
  );
}

export default function LandingPage() {
  useEffect(() => {
    // The landing page mounts after the browser's initial fragment lookup.
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, []);

  return (
    <div className="landing" id="top">
      <a className="skip-link" href="#landing-main">
        Skip to content
      </a>
      <div className="landing-intro">
        <header className="landing-header landing-container">
          <LandingBrand />
          <nav aria-label="Site navigation">
            <a className="landing-how-link" href="#how-it-works">
              How it works
            </a>
            <a className="landing-materials-link" href="#get-materials">
              Get materials
            </a>
            <Link className="landing-sign-in" to="/sign-in">
              Sign in
            </Link>
          </nav>
        </header>
        <main id="landing-main" tabIndex={-1}>
          <section
            className="landing-hero landing-container"
            aria-labelledby="landing-title"
          >
            <div className="landing-hero-copy">
              <h1 id="landing-title">
                Study on <span>your terms.</span>
              </h1>
              <p>
                Build your own practice exams and flashcards. Study at your
                pace, then come back to what needs work.
              </p>
              <div className="landing-actions">
                <GetStartedLink />
                <a className="landing-demo-link" href="#sample-flashcard">
                  Try a flashcard <ArrowDown aria-hidden="true" />
                </a>
              </div>
            </div>
            <SampleFlashcard />
          </section>

          <section
            className="landing-study"
            id="how-it-works"
            aria-labelledby="landing-study-title"
          >
            <div className="landing-container">
              <p className="landing-kicker">The study loop</p>
              <div className="landing-study-intro">
                <h2 id="landing-study-title">Make it stick.</h2>
                <p>
                  From the first practice question to the next review, keep all
                  your study material in one place.
                </p>
              </div>
              <ol className="landing-steps" role="list">
                {studySteps.map(({ title, description, Icon }, index) => (
                  <li key={title}>
                    <span className="landing-step-number" aria-hidden="true">
                      0{index + 1} /
                    </span>
                    <Icon className="landing-step-icon" aria-hidden="true" />
                    <h3>{title}</h3>
                    <p>{description}</p>
                    {index === 0 ? (
                      <a className="landing-step-link" href="#get-materials">
                        How to get materials{" "}
                        <ArrowDown size={15} aria-hidden="true" />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <StudyMaterials />

          <section
            className="landing-container landing-cta"
            aria-labelledby="landing-cta-title"
          >
            <h2 id="landing-cta-title">Ready to study?</h2>
            <GetStartedLink />
          </section>
        </main>
      </div>
      <footer className="landing-footer">
        <div className="landing-container">
          <LandingBrand />
          <Link to="/sign-in">Sign in</Link>
        </div>
      </footer>
    </div>
  );
}
