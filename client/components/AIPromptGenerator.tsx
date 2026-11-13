import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buildAIPrompt } from "../lib/aiPrompt";
import {
  activeQuestionMix,
  aiItemTotal,
  defaultQuestionMix,
  difficultyOptions,
  explanationOptions,
  MAX_AI_ITEMS,
  rubricOptions,
  validAIItemTotal,
  type AISettings,
} from "../lib/aiSettings";
import { Button, ErrorNotice, Field } from "./ui";
import "./ai-prompt.css";

const questionFormats = [
  ["choice", "Multiple-choice questions"],
  ["trueFalse", "True/false questions"],
  ["written", "Written questions"],
] as const;

export function AIAuthoringDownloads() {
  return (
    <details className="ai-downloads">
      <summary>Optional instructions and examples</summary>
      <div className="download-links">
        <a href="/downloads/SKILL.md" download>
          Download SKILL.md
        </a>
        <a href="/downloads/example-exam.examprep.json" download>
          Example exam with rubric
        </a>
        <a href="/downloads/example-flashcards.examprep.json" download>
          Example flashcards
        </a>
        <a href="/downloads/examprep.schema.json" download>
          JSON Schema
        </a>
      </div>
    </details>
  );
}

export function AIPromptGenerator({
  settings,
  onChange,
}: {
  settings: AISettings;
  onChange: (settings: AISettings) => void;
}) {
  const preview = useRef<HTMLDetailsElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [result, setResult] = useState<{ prompt: string; error?: Error }>();
  const prompt = buildAIPrompt(settings);
  const current = result?.prompt === prompt ? result : undefined;
  const copied = current && !current.error;
  const exam = settings.kind === "exam";
  const mix = activeQuestionMix(settings);
  const total = aiItemTotal(settings);
  const validTotal = validAIItemTotal(total);
  const hasTopic = !!settings.topic.trim();

  function update(changes: Partial<AISettings>) {
    setResult(undefined);
    onChange({ ...settings, ...changes });
  }

  async function copyPrompt() {
    if (!hasTopic || !validTotal) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setResult({ prompt });
    } catch {
      if (!preview.current || promptInput.current?.value !== prompt) return;
      preview.current.open = true;
      promptInput.current.focus();
      promptInput.current.select();
      setResult({
        prompt,
        error: new Error(
          "Clipboard access failed. Copy the selected prompt manually.",
        ),
      });
    }
  }

  return (
    <div className="ai-prompt-builder">
      <div className="ai-prompt-grid">
        <div className="ai-prompt-source">
          <Field label="Topic or source material">
            <textarea
              value={settings.topic}
              placeholder="e.g. Photosynthesis and cellular respiration"
              onChange={(e) => update({ topic: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Content type">
          <select
            value={settings.kind}
            onChange={(e) =>
              update({
                kind: e.target.value === "flashcards" ? "flashcards" : "exam",
              })
            }
          >
            <option value="exam">Exam</option>
            <option value="flashcards">Flashcards</option>
          </select>
        </Field>
        {mix ? (
          <div className="field">
            <span className="ai-prompt-total-label">Item count</span>
            <output aria-label="Total questions">
              {total ?? "—"} {total === 1 ? "question" : "questions"}
            </output>
          </div>
        ) : (
          <Field label="Item count">
            <input
              type="number"
              min={1}
              max={MAX_AI_ITEMS}
              value={settings.count ?? ""}
              onChange={(e) =>
                update({
                  count: Number.isNaN(e.target.valueAsNumber)
                    ? null
                    : e.target.valueAsNumber,
                })
              }
            />
          </Field>
        )}
        <Field label="Level">
          <input
            value={settings.level}
            onChange={(e) => update({ level: e.target.value })}
          />
        </Field>
        <Field label="Language">
          <input
            value={settings.language}
            onChange={(e) => update({ language: e.target.value })}
          />
        </Field>
      </div>

      <details className="ai-prompt-disclosure">
        <summary>Customize</summary>
        {exam ? (
          <div className="ai-question-mix">
            <label className="ai-exact-mix">
              <input
                type="checkbox"
                checked={settings.exactMix}
                onChange={(e) =>
                  update({
                    exactMix: e.target.checked,
                    mix: settings.mix ?? defaultQuestionMix(settings.count),
                  })
                }
              />
              Set exact counts by question type
            </label>
            {mix ? (
              <div className="ai-question-counts">
                {questionFormats.map(([format, label]) => (
                  <Field key={format} label={label}>
                    <input
                      type="number"
                      min={0}
                      max={MAX_AI_ITEMS}
                      value={mix[format] ?? ""}
                      onChange={(e) =>
                        update({
                          mix: {
                            ...mix,
                            [format]: Number.isNaN(e.target.valueAsNumber)
                              ? null
                              : e.target.valueAsNumber,
                          },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="ai-prompt-grid">
          <Field label="Difficulty">
            <select
              value={settings.difficulty}
              onChange={(e) =>
                update({
                  difficulty: e.target.value as AISettings["difficulty"],
                })
              }
            >
              {difficultyOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {exam ? (
            <Field label="Answer explanations">
              <select
                value={settings.explanations}
                onChange={(e) =>
                  update({
                    explanations: e.target.value as AISettings["explanations"],
                  })
                }
              >
                {explanationOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {exam && (!mix || (mix.written ?? 0) > 0) ? (
            <Field label="Written-question rubrics">
              <select
                value={settings.rubrics}
                onChange={(e) =>
                  update({ rubrics: e.target.value as AISettings["rubrics"] })
                }
              >
                {rubricOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <div className="ai-prompt-source">
            <Field label="Extra instructions (optional)">
              <textarea
                value={settings.instructions}
                placeholder={
                  exam
                    ? "e.g. Focus on applying concepts to new situations"
                    : "e.g. Include common mistakes on the back of each card"
                }
                onChange={(e) => update({ instructions: e.target.value })}
              />
            </Field>
          </div>
        </div>
      </details>

      <div className="ai-prompt-copy">
        <p className="muted">Paste the copied prompt into your AI tool.</p>
        <Button
          variant="primary"
          disabled={!hasTopic || !validTotal}
          onClick={copyPrompt}
        >
          {copied ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Copy size={18} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
        {!validTotal ? (
          <p className="negative" role="status">
            {mix
              ? "Use whole numbers and a total of 1–500 questions."
              : "Enter a whole number from 1 to 500."}
          </p>
        ) : !hasTopic ? (
          <p className="muted">Add a topic or notes to copy the prompt.</p>
        ) : null}
        <span className="sr-only" role="status">
          {copied ? "Prompt copied to clipboard." : ""}
        </span>
      </div>
      <details className="ai-prompt-disclosure" ref={preview}>
        <summary>Preview prompt</summary>
        {hasTopic && validTotal ? (
          <Field label="Prompt to copy">
            <textarea
              ref={promptInput}
              readOnly
              className="prompt-input"
              value={prompt}
            />
          </Field>
        ) : (
          <p className="muted">
            Complete the topic and item count to see your prompt.
          </p>
        )}
      </details>
      <ErrorNotice error={current?.error} />
    </div>
  );
}
