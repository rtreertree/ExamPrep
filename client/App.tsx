import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  RouterProvider,
  ScrollRestoration,
  useLocation,
} from "react-router-dom";
import { BookOpen, History, UserRound, Menu, X } from "lucide-react";
import { AuthProvider, useAuth } from "./lib/auth";
import { AuthPage, AccountPage } from "./features/Account";
import { applyReadingSize, readingSize } from "./lib/readingSize";
const LandingPage = lazy(() => import("./features/Landing"));
const PasswordRecoveryPage = lazy(() =>
  import("./features/PasswordRecovery").then((m) => ({
    default: m.PasswordRecoveryPage,
  })),
);
const LibraryPage = lazy(() =>
  import("./features/Library").then((m) => ({ default: m.LibraryPage })),
);
const EditorPage = lazy(() =>
  import("./features/Editor").then((m) => ({ default: m.EditorPage })),
);
const HistoryPage = lazy(() =>
  import("./features/History").then((m) => ({ default: m.HistoryPage })),
);
const PracticePage = lazy(() =>
  import("./features/Practice").then((m) => ({ default: m.PracticePage })),
);
const DueReviewPage = lazy(() =>
  import("./features/DueReview").then((m) => ({ default: m.DueReviewPage })),
);
import { Button, ErrorNotice, LoadingRows } from "./components/ui";
function Root() {
  const { pathname } = useLocation();
  return (
    <Suspense
      fallback={
        <main className="focus-loading">
          <LoadingRows />
        </main>
      }
    >
      <AuthProvider
        sessionErrorFallback={pathname === "/" ? <LandingPage /> : undefined}
      >
        <Outlet />
      </AuthProvider>
      <ScrollRestoration />
    </Suspense>
  );
}
function Protected({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?.id;
  useEffect(() => {
    applyReadingSize(userId ? readingSize(userId) : "standard");
    return () => applyReadingSize("standard");
  }, [userId]);
  if (!user && location.pathname === "/") return <LandingPage />;
  return user ? (
    (children ?? <Outlet />)
  ) : (
    <Navigate to="/sign-in" replace state={{ signInReturn: location }} />
  );
}
function AppShell() {
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: Event) {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);
  const links = (
    <>
      <NavLink
        to="/"
        end
        onClick={() => setOpen(false)}
        className={
          location.pathname.includes("/edit") ||
          location.pathname.startsWith("/new") ||
          location.pathname.startsWith("/review/")
            ? "active"
            : undefined
        }
      >
        <BookOpen size={20} />
        Library
      </NavLink>
      <NavLink to="/history" onClick={() => setOpen(false)}>
        <History size={20} />
        History
      </NavLink>
      <NavLink
        to="/account"
        className="account-link"
        onClick={() => setOpen(false)}
      >
        <UserRound size={20} />
        Account
      </NavLink>
    </>
  );
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar frosted-navigation">
        <div className="wordmark">Exam Prep</div>
        <nav aria-label="Main navigation">{links}</nav>
      </aside>
      <header
        ref={header}
        className="mobile-header frosted-navigation"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          setOpen(false);
          toggle.current?.focus();
        }}
      >
        <span className="wordmark">Exam Prep</span>
        <Button
          ref={toggle}
          variant="quiet"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls={open ? "mobile-navigation" : undefined}
          onClick={() => setOpen((previous) => !previous)}
        >
          {open ? <X /> : <Menu />}
        </Button>
        {open ? (
          <nav id="mobile-navigation" aria-label="Mobile navigation">
            {links}
          </nav>
        ) : null}
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="workspace-main"
        key={location.pathname}
      >
        <Outlet />
      </main>
    </div>
  );
}
const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: (
      <main className="auth-page">
        <ErrorNotice
          error={
            new Error(
              "This page could not be opened. Reload the page to try again.",
            )
          }
        />
        <a href="/">Return to library</a>
      </main>
    ),
    children: [
      { path: "/sign-in", element: <AuthPage /> },
      { path: "/forgot-password", element: <PasswordRecoveryPage /> },
      { path: "/reset-password", element: <PasswordRecoveryPage reset /> },
      {
        element: <Protected />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, element: <LibraryPage /> },
              { path: "/history", element: <HistoryPage /> },
              { path: "/review/:id", element: <DueReviewPage /> },
              { path: "/account", element: <AccountPage /> },
              { path: "/sets/:id/edit", element: <EditorPage /> },
              { path: "/new/:kind/:draftId", element: <EditorPage /> },
            ],
          },
          { path: "/practice/:id", element: <PracticePage /> },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
export default function App() {
  return <RouterProvider router={router} />;
}
