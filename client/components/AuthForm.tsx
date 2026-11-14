import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { Button, ErrorNotice, Field } from "./ui";

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
