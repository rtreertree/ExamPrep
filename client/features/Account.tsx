import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { clearDrafts } from "../lib/drafts";
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
}: {
  inline?: boolean;
  onSuccess: () => void | Promise<void>;
}) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function submit(e: FormEvent) {
    e.preventDefault();
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
      {!inline ? (
        <p className="auth-switch">
          {register ? "Already have an account?" : "New to Exam Prep?"}{" "}
          <Button
            variant="quiet"
            onClick={() => {
              setRegister(!register);
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
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  if (user) return <Navigate to="/" replace />;
  return (
    <main className="auth-page">
      <div className="auth-form">
        <div className="wordmark">Exam Prep</div>
        <AuthForm
          onSuccess={async () => {
            await refresh();
            navigate("/");
          }}
        />
      </div>
    </main>
  );
}
export function AccountPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [success, setSuccess] = useState(false);
  const [confirm, setConfirm] = useState(false);
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
      await clearDrafts(user!.id);
      await api("/auth/sign-out", "POST", {});
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
          <h2>Sign out</h2>
          <p className="muted">
            Signing out clears this account’s editor drafts from this device.
          </p>
          <Button onClick={() => setConfirm(true)}>Sign out</Button>
        </section>
      </div>
      {confirm ? (
        <Dialog title="Sign out?" onClose={() => setConfirm(false)}>
          <p>
            Your saved sets and practice history stay in your account. Local
            editor drafts will be removed.
          </p>
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
