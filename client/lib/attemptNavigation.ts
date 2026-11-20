import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Attempt } from "./api";
import { useAuth } from "./auth";

let pending: { token: string; userId: string; attempt: Attempt } | undefined;

export function useOpenAttempt() {
  const navigate = useNavigate();
  const { user } = useAuth();
  return (id: string, returnTo?: string, attempt?: Attempt) => {
    const token = crypto.randomUUID();
    pending =
      user && attempt?.id === id && attempt.snapshot
        ? { token, userId: user.id, attempt }
        : undefined;
    navigate(`/practice/${id}`, { state: { returnTo, token } });
  };
}

// The route keys this component by navigation. Browser history holds only the token.
export function useInitialAttempt(id: string | undefined) {
  const { user } = useAuth();
  const token = useLocation().state?.token;
  const [entry] = useState(() => pending);
  useEffect(() => {
    if (pending === entry) pending = undefined;
  }, [entry]);
  return entry &&
    entry.token === token &&
    entry.userId === user?.id &&
    entry.attempt.id === id
    ? entry.attempt
    : undefined;
}
