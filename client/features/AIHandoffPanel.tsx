import { useEffect, useRef, useState } from "react";
import {
  AIAuthoringDownloads,
  AIPromptGenerator,
} from "../components/AIPromptGenerator";
import { Button, Dialog, Notice } from "../components/ui";
import {
  aiSettingsKey,
  defaultAISettings,
  readAISettings,
  type AISettings,
} from "../lib/aiSettings";
import { useAuth } from "../lib/auth";
import { useUnsaved } from "../lib/hooks";

export function AIHandoffPanel({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (settings: AISettings) => void;
}) {
  const { user } = useAuth();
  const userId = user!.id;
  const [initial] = useState(() => {
    try {
      return { value: readAISettings(userId), failed: false };
    } catch {
      return { value: undefined, failed: true };
    }
  });
  const [settings, setSettings] = useState(initial.value ?? defaultAISettings);
  const [storageFailed, setStorageFailed] = useState(initial.failed);
  const serializedSettings = JSON.stringify(settings);
  const lastSaved = useRef(serializedSettings);
  const unsaved = storageFailed && serializedSettings !== lastSaved.current;
  const [leaving, setLeaving] = useState<"close" | "import">();
  const keepEditing = useRef<HTMLButtonElement>(null);
  useUnsaved(unsaved);
  useEffect(() => {
    if (leaving && unsaved) keepEditing.current?.focus();
  }, [leaving, unsaved]);
  useEffect(() => {
    try {
      localStorage.setItem(aiSettingsKey(userId), serializedSettings);
      lastSaved.current = serializedSettings;
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [userId, serializedSettings]);
  function leave(destination: "close" | "import") {
    if (unsaved) setLeaving(destination);
    else if (destination === "close") onClose();
    else onImport(settings);
  }
  return (
    <Dialog title="Create with your AI" onClose={() => leave("close")}>
      <p className="muted">
        Choose what to study, copy the prompt into your AI tool, then import its
        result here.
      </p>
      {storageFailed ? (
        <Notice tone="warning">
          Device storage is unavailable. Copy your prompt before leaving to keep
          your work.
        </Notice>
      ) : null}
      <AIPromptGenerator settings={settings} onChange={setSettings} />
      <div className="stack ai-handoff-import">
        <div>
          <h3>Bring back your result</h3>
          <p className="muted">
            Paste the JSON or upload the file to preview your study set.
          </p>
        </div>
        <Button onClick={() => leave("import")}>Import AI result</Button>
      </div>
      {leaving && unsaved ? (
        <Notice tone="warning">
          <p>
            Your changes have not been saved on this device. Copy the prompt
            before leaving, or return to keep working.
          </p>
          <div className="actions">
            <Button ref={keepEditing} onClick={() => setLeaving(undefined)}>
              Keep editing
            </Button>
            <Button
              onClick={() =>
                leaving === "close" ? onClose() : onImport(settings)
              }
            >
              Leave without saving changes
            </Button>
          </div>
        </Notice>
      ) : null}
      <AIAuthoringDownloads />
      {!storageFailed ? (
        <p className="muted ai-draft-note">
          Notes and settings are saved on this device until you sign out.
        </p>
      ) : null}
    </Dialog>
  );
}
