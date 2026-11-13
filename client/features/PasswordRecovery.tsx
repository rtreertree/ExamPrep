import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Button,
  ErrorNotice,
  Field,
  LoadingRows,
  Notice,
} from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useResource } from "../lib/hooks";

export function PasswordRecoveryPage({ reset = false }: { reset?: boolean }) {
  const { state } = useLocation();
  return (
    <main className="auth-page">
      <div className="auth-form">
        <div className="wordmark">Exam Prep</div>
        {reset ? <ResetPassword /> : <RequestReset />}
        <p className="auth-switch">
          <Link to="/sign-in" state={state} replace>
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

function RequestReset() {
  const availability = useResource<{ enabled: boolean }>("/account/recovery");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<Error>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/auth/request-password-reset", "POST", {
        email: email.trim(),
      });
      setSent(true);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Forgot your password?</h1>
      {availability.loading ? <LoadingRows /> : null}
      <ErrorNotice error={availability.error} retry={availability.refresh} />
      {availability.data?.enabled === false ? (
        <Notice tone="warning">
          Password recovery is unavailable on this installation.
        </Notice>
      ) : null}
      {sent ? (
        <Notice tone="success">
          If there is an account for that address, check your email for a link.
          The link expires after 30 minutes.
        </Notice>
      ) : availability.data?.enabled ? (
        <form className="stack" onSubmit={submit}>
          <p className="muted">
            Enter your account email to request a reset link.
          </p>
          <Field label="Email">
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <ErrorNotice error={error} />
          <Button type="submit" variant="primary" busy={busy}>
            Send reset link
          </Button>
        </form>
      ) : null}
    </>
  );
}

function ResetPassword() {
  const { hash } = useLocation();
  const token = new URLSearchParams(hash.slice(1)).get("token");
  const { refresh } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<Error>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/auth/reset-password", "POST", {
        token,
        newPassword: password,
      });
      setPassword("");
      setChanged(true);
      await refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Reset your password</h1>
      {changed ? (
        <Notice tone="success">
          Password reset. Sign in with your new password.
        </Notice>
      ) : token ? (
        <form className="stack" onSubmit={submit}>
          <Field label="New password" hint="Use 12–128 characters.">
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <ErrorNotice error={error} />
          <Button type="submit" variant="primary" busy={busy}>
            Reset password
          </Button>
          {error ? (
            <Link to="/forgot-password" replace>
              Request a new link
            </Link>
          ) : null}
        </form>
      ) : (
        <Notice tone="warning">
          Open the link from your reset email or{" "}
          <Link to="/forgot-password" replace>
            request a new link
          </Link>
          .
        </Notice>
      )}
    </>
  );
}
