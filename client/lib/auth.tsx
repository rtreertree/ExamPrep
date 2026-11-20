import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import {
  Button,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Notice,
} from "../components/ui";
import { AuthForm } from "../components/AuthForm";
type User = { id: string; email: string; role: "user" | "admin" };
const AuthContext = createContext<{
  user: User | null;
  refresh: () => Promise<void>;
  cleanupUser?: string;
  setCleanupUser: (userId?: string) => void;
}>({ user: null, refresh: async () => {}, setCleanupUser: () => {} });
export const useAuth = () => useContext(AuthContext);
export function AuthProvider({
  children,
  waitForSession = true,
}: {
  children: ReactNode;
  waitForSession?: boolean;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [expired, setExpired] = useState(false);
  const [cleanupUser, setCleanupUser] = useState<string>();
  async function refresh() {
    try {
      setError(undefined);
      const session = await api<{ user: User } | null>("/auth/get-session");
      setUser(session?.user ?? null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const expire = () => setExpired(true);
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  if (waitForSession && loading)
    return (
      <main className="auth-page">
        <LoadingRows />
      </main>
    );
  if (waitForSession && error)
    return (
      <main className="auth-page">
        <h1>Exam Prep</h1>
        <ErrorNotice error={error} retry={refresh} />
      </main>
    );
  return (
    <AuthContext.Provider
      value={{ user, refresh, cleanupUser, setCleanupUser }}
    >
      {children}
      {expired && waitForSession ? (
        <Dialog
          title="Your session has expired"
          onClose={() => setExpired(false)}
        >
          <Notice tone="warning">
            Your unsaved changes are still on this device. Sign in to continue.
            Signing into a different account will reload the page.
          </Notice>
          <AuthForm
            inline
            expectedEmail={user?.email}
            onSuccess={async () => {
              const session = await api<{ user: User }>("/auth/get-session");
              if (session.user.id !== user?.id)
                window.location.assign("/library");
              else {
                setExpired(false);
                await refresh();
              }
            }}
          />
          <div className="actions">
            <Button variant="quiet" onClick={() => setExpired(false)}>
              Return to my changes
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AuthContext.Provider>
  );
}
