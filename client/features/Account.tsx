import { Selector } from "../components/Selector";
import { useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
  type Location,
} from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { clearDeviceData } from "../lib/deviceCleanup";
import {
  readingSize,
  saveReadingSize,
  type ReadingSize,
} from "../lib/readingSize";
import { AccountBackup } from "./AccountBackup";
import {
  Button,
  Field,
  ErrorNotice,
  PageHeader,
  Notice,
  Dialog,
} from "../components/ui";
export function AuthForm({
  inline,
  onSuccess,
  expectedEmail,
  register = false,
  onModeChange,
}: {
  expectedEmail?: string;
  inline?: boolean;
  onSuccess: () => void | Promise<void>;
  register?: boolean;
  onModeChange?: () => void;
}) {
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      expectedEmail &&
      email.trim().toLowerCase() !== expectedEmail.toLowerCase()
    ) {
      setError(
        new Error(
          `Sign in as ${expectedEmail} to save these changes. To change accounts, return to your work and download a recovery copy first.`,
        ),
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(
        register ? "/auth/sign-up/email" : "/auth/sign-in/email",
        "POST",
        { email, password, ...(register ? { name: "Student" } : {}) },
      );
      await onSuccess();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>
        {register
          ? "Create your account"
          : inline
            ? "Sign in again"
            : "Welcome back"}
      </h1>
      <p className="muted">
        {register
          ? "A private space for your study material."
          : "Your next study session starts here."}
      </p>
      <form onSubmit={submit} className="stack">
        <Field label="Email">
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          hint={register ? "Use 12–128 characters." : undefined}
        >
          <input
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            minLength={register ? 12 : undefined}
            maxLength={128}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorNotice error={error} />
        <Button type="submit" variant="primary" busy={busy}>
          {register ? "Create account" : "Sign in"}
        </Button>
      </form>
      {!inline && !register ? (
        <p className="auth-switch">
          <Link to="/forgot-password" state={location.state}>
            Forgot password?
          </Link>
        </p>
      ) : null}
      {onModeChange ? (
        <p className="auth-switch">
          {register ? "Already have an account?" : "New to Exam Prep?"}{" "}
          <Button
            variant="quiet"
            onClick={() => {
              onModeChange();
              setError(undefined);
            }}
          >
            {register ? "Sign in" : "Create an account"}
          </Button>
        </p>
      ) : null}
    </>
  );
}
export function AuthPage() {
  const { user, refresh, cleanupUser, setCleanupUser } = useAuth();
  const location = useLocation();
  const destination: Location | undefined = location.state?.signInReturn;
  const [params, setParams] = useSearchParams();
  const [cleanupError, setCleanupError] = useState<Error>();
  const register = params.get("mode") === "register";
  if (user) {
    return (
      <Navigate to={destination ?? "/"} state={destination?.state} replace />
    );
  }
  return (
    <main className="auth-page">
      <div className="auth-form">
        <div className="wordmark">Exam Prep</div>
        {cleanupUser ? (
          <Notice tone="warning">
            <p>
              You are signed out. Some local study data could not be removed
              from this device. They remain tied to your account. Retry cleanup,
              or clear this site’s stored data in your browser on a shared
              device.
            </p>
            <Button
              onClick={async () => {
                try {
                  await clearDeviceData(cleanupUser);
                  setCleanupUser(undefined);
                } catch {
                  setCleanupError(
                    new Error(
                      "Device cleanup is still unavailable. Your server session has ended.",
                    ),
                  );
                }
              }}
            >
              Retry device cleanup
            </Button>
            <ErrorNotice error={cleanupError} />
          </Notice>
        ) : null}
        <AuthForm
          register={register}
          onModeChange={() =>
            setParams(register ? {} : { mode: "register" }, {
              replace: true,
              state: location.state,
            })
          }
          onSuccess={refresh}
        />
      </div>
    </main>
  );
}
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
