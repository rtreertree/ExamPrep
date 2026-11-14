import { Selector } from "../components/Selector";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  readingSize,
  saveReadingSize,
  type ReadingSize,
} from "../lib/readingSize";
import { AccountBackup } from "./AccountBackup";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  Notice,
  PageHeader,
} from "../components/ui";

export function AccountPage() {
  const { user, refresh, setCleanupUser } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [success, setSuccess] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [size, setSize] = useState(() =>
    user ? readingSize(user.id) : "standard",
  );
  async function change(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSuccess(false);
    try {
      await api("/auth/change-password", "POST", {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setCurrent("");
      setNew("");
      setSuccess(true);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError(undefined);
    try {
      const userId = user!.id;
      await api("/auth/sign-out", "POST", {});
      let cleanupFailed = false;
      try {
        const { clearDeviceData } = await import("../lib/deviceCleanup");
        await clearDeviceData(userId);
      } catch {
        cleanupFailed = true;
      }
      setCleanupUser(cleanupFailed ? userId : undefined);
      await refresh();
      navigate("/sign-in");
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Account"
        description="Your account and sign-in details."
      />
      <div className="account-content">
        <section>
          <h2>Email</h2>
          <p className="break-word">{user?.email}</p>
        </section>
        <section>
          <h2>Change password</h2>
          <p className="muted">
            Changing your password signs out your other devices.
          </p>
          <form className="stack" onSubmit={change}>
            <Field label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="New password" hint="Use 12–128 characters.">
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" busy={busy}>
              Change password
            </Button>
          </form>
          {success ? <Notice tone="success">Password changed.</Notice> : null}
        </section>
        <ErrorNotice error={error} />
        <section>
          <h2>Reading preferences</h2>
          <p className="muted">
            Adjust the size of questions, answers, and flashcards on this
            device.
          </p>
          <Field label="Study text size">
            <Selector
              value={size}
              onValueChange={(value) => {
                const next = value as ReadingSize;
                setSize(next);
                if (user) saveReadingSize(user.id, next);
              }}
              options={[
                { value: "standard", label: "Standard" },
                { value: "large", label: "Large" },
                { value: "extra-large", label: "Extra large" },
              ]}
            />
          </Field>
        </section>
        <AccountBackup />
        <section>
          <h2>Sign out</h2>
          <p className="muted">
            Signing out clears this account’s editor drafts and unsaved practice
            checkpoints from this device.
          </p>
          <Button onClick={() => setConfirm(true)}>Sign out</Button>
        </section>
      </div>
      {confirm ? (
        <Dialog title="Sign out?" onClose={() => setConfirm(false)}>
          <p>
            Your saved sets and practice history stay in your account. Local
            editor drafts, unsaved practice checkpoints, and AI notes will be
            removed where device storage is available.
          </p>
          <ErrorNotice error={error} retry={() => void logout()} />
          <div className="actions">
            <Button onClick={() => setConfirm(false)}>Keep studying</Button>
            <Button variant="primary" busy={busy} onClick={logout}>
              Sign out and clear drafts
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
