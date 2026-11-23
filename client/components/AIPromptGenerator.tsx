import { Selector } from "./Selector";
import { useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { buildAIPrompt } from "../lib/aiPrompt";
import {
  activeQuestionMix,
  aiItemTotal,
  defaultAISettings,
  defaultQuestionMix,
  difficultyPresets,
  explanationOptions,
  hardnessLevels,
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

const contentTypes = [
  ["exam", "Exam"],
  ["flashcards", "Flashcards"],
] as const;

function PromptChoice({
  name,
  value,
  label,
  checked,
  onChange,
}: {
  name: string;
  value: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="ai-prompt-choice">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
      />
      <span>{label}</span>
    </label>
  );
}

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
  const contentTypeName = useId();
  const difficultyName = useId();
  const difficultyHint = useId();
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

  function renderDifficultyOption([value, label]: readonly [
    AISettings["difficulty"],
    string,
  ]) {
    return (
      <PromptChoice
        key={value}
        name={difficultyName}
        value={value}
        label={label}
        checked={settings.difficulty === value}
        onChange={() => update({ difficulty: value })}
      />
    );
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
      <Field label="Topic or source material">
        <textarea
          value={settings.topic}
          placeholder="e.g. Photosynthesis and cellular respiration"
          onChange={(e) => update({ topic: e.target.value })}
        />
      </Field>
      <div className="ai-prompt-grid ai-prompt-basics">
        <fieldset className="ai-prompt-choice-group">
          <legend>Content type</legend>
          <div className="ai-prompt-segments">
            {contentTypes.map(([value, label]) => (
              <PromptChoice
                key={value}
                name={contentTypeName}
                value={value}
                label={label}
                checked={settings.kind === value}
                onChange={() => update({ kind: value })}
              />
            ))}
          </div>
        </fieldset>
        <div className="ai-prompt-count">
          {mix ? (
            <div className="field">
              <span>Total questions</span>
              <output aria-label="Total questions">
                {total ?? "—"} {total === 1 ? "question" : "questions"}
              </output>
            </div>
          ) : (
            <Field
              label={exam ? "Number of questions" : "Number of flashcards"}
            >
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
        </div>
        {exam ? (
          <div className="ai-prompt-span">
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
        {!validTotal ? (
          <p className="negative ai-prompt-span ai-prompt-hint" role="status">
            {mix
              ? "Use whole numbers and a total of 1–500 questions."
              : "Enter a whole number from 1 to 500."}
          </p>
        ) : null}
        <Field label="Study level">
          <input
            value={settings.level}
            placeholder={defaultAISettings.level}
            onChange={(e) => update({ level: e.target.value })}
          />
        </Field>
        <Field label="Language">
          <input
            value={settings.language}
            placeholder={defaultAISettings.language}
            onChange={(e) => update({ language: e.target.value })}
          />
        </Field>
      </div>

      <fieldset
        className="ai-prompt-choice-group"
        aria-describedby={
          settings.difficulty === "extreme" ? difficultyHint : undefined
        }
      >
        <legend>Difficulty</legend>
        <div className="ai-prompt-segments ai-prompt-hardness">
          {hardnessLevels.map(renderDifficultyOption)}
        </div>
        <div className="ai-prompt-presets">
          {difficultyPresets.map(renderDifficultyOption)}
        </div>
        {settings.difficulty === "extreme" ? (
          <p className="muted ai-prompt-hint" id={difficultyHint}>
            {exam
              ? "Asks the AI to make every question extremely hard."
              : "Asks the AI to make every flashcard cue extremely hard."}
          </p>
        ) : null}
      </fieldset>

      <details className="ai-prompt-disclosure">
        <summary>More options</summary>
        <div className="ai-prompt-grid">
          {exam ? (
            <Field label="Answer explanations">
              <Selector
                value={settings.explanations}
                onValueChange={(value) =>
                  update({ explanations: value as AISettings["explanations"] })
                }
                options={explanationOptions.map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Field>
          ) : null}
          {exam && (!mix || (mix.written ?? 0) > 0) ? (
            <Field label="Written-question rubrics">
              <Selector
                value={settings.rubrics}
                onValueChange={(value) =>
                  update({ rubrics: value as AISettings["rubrics"] })
                }
                options={rubricOptions.map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Field>
          ) : null}
          <div className="ai-prompt-span">
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
        {!hasTopic ? (
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
