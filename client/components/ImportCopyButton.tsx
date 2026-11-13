import { useEffect, useRef, useState } from "react";
import { Button, Field } from "./ui";

export function ImportCopyButton({
  label,
  text,
  fallbackLabel,
  copiedLabel,
  onCopyFailure,
}: {
  label: string;
  text: string;
  fallbackLabel: string;
  copiedLabel: string;
  onCopyFailure?: () => void;
}) {
  const [result, setResult] = useState<{ text: string; copied: boolean }>();
  const manualCopy = useRef<HTMLTextAreaElement>(null);
  const current = result?.text === text ? result : undefined;
  const failed = current?.copied === false;

  useEffect(() => {
    if (current?.copied === false) {
      manualCopy.current?.focus();
      manualCopy.current?.select();
    }
  }, [current]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setResult({ text, copied: true });
    } catch {
      onCopyFailure?.();
      setResult({ text, copied: false });
    }
  }

  return (
    <div className="import-copy">
      <Button onClick={copy}>{current?.copied ? copiedLabel : label}</Button>
      <span role="status" className="sr-only">
        {current?.copied ? copiedLabel : ""}
      </span>
      {failed ? (
        <Field
          label={fallbackLabel}
          hint="Clipboard access failed. Copy the selected text manually."
        >
          <textarea
            className="prompt-input"
            ref={manualCopy}
            value={text}
            readOnly
          />
        </Field>
      ) : null}
    </div>
  );
}
