import type { FormEvent, ReactNode } from "react";
import { Button, Field } from "./ui";

export function PositionForm({
  children,
  label,
  submitLabel,
  value,
  max,
  inputMode,
  step,
  busy,
  submitDisabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  children?: ReactNode;
  label: string;
  submitLabel: string;
  value: string;
  max: number;
  inputMode?: "numeric";
  step?: number;
  busy?: boolean;
  submitDisabled?: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="stack" onSubmit={onSubmit}>
      {children}
      <Field label={label} hint={`Choose a position from 1 to ${max}.`}>
        <input
          type="number"
          inputMode={inputMode}
          min={1}
          max={max}
          step={step}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <div className="actions">
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={submitDisabled}
          type="submit"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
