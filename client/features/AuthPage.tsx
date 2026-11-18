import { useState } from "react";
import {
  Navigate,
  useLocation,
  useSearchParams,
  type Location,
} from "react-router-dom";
import { AuthForm } from "../components/AuthForm";
import { Button, ErrorNotice, Notice } from "../components/ui";
import { useAuth } from "../lib/auth";

export function AuthPage() {
  const { user, refresh, cleanupUser, setCleanupUser } = useAuth();
  const location = useLocation();
  const destination: Location | undefined = location.state?.signInReturn;
  const [params, setParams] = useSearchParams();
  const [cleanupError, setCleanupError] = useState<Error>();
  const register = params.get("mode") === "register";
  if (user) {
    return (
      <Navigate
        to={destination ?? "/library"}
        state={destination?.state}
        replace
      />
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
                  const { clearDeviceData } =
                    await import("../lib/deviceCleanup");
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
