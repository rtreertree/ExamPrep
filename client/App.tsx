import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  RouterProvider,
  ScrollRestoration,
  useLocation,
} from "react-router-dom";
import {
  BookOpen,
  Compass,
  Shield,
  History,
  UserRound,
  Menu,
  X,
} from "lucide-react";
import { AuthProvider, useAuth } from "./lib/auth";
import { AuthPage } from "./features/AuthPage";
import { applyReadingSize, readingSize } from "./lib/readingSize";
const Discover = lazy(() => import("./features/Discover"));
const Admin = lazy(() => import("./features/Admin"));
const AccountPage = lazy(() =>
  import("./features/Account").then((m) => ({ default: m.AccountPage })),
);
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
const SharedSetPage = lazy(() => import("./features/SharedSet"));
const SavedSetPage = lazy(() =>
  import("./features/SharedSet").then((m) => ({ default: m.SavedSetPage })),
);
const WorksheetPage = lazy(() => import("./features/Worksheet"));
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
      <AuthProvider waitForSession={pathname !== "/"}>
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
  return user ? (
    (children ?? <Outlet />)
  ) : (
    <Navigate to="/sign-in" replace state={{ signInReturn: location }} />
  );
}
function AdminPage() {
  return useAuth().user?.role === "admin" ? (
    <Admin />
  ) : (
    <Navigate to="/library" replace />
  );
}
function AppShell() {
  const { user } = useAuth();
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
        to="/library"
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
      <NavLink to="/discover" onClick={() => setOpen(false)}>
        <Compass size={20} />
        Discover
      </NavLink>
      {user?.role === "admin" && (
        <NavLink to="/admin" onClick={() => setOpen(false)}>
          <Shield size={20} />
          Admin
        </NavLink>
      )}
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
        <a href="/library">Return to library</a>
      </main>
    ),
    children: [
      { index: true, element: <LandingPage /> },
      { path: "/share", element: <SharedSetPage /> },
      { path: "/sign-in", element: <AuthPage /> },
      { path: "/forgot-password", element: <PasswordRecoveryPage /> },
      { path: "/reset-password", element: <PasswordRecoveryPage reset /> },
      {
        element: <Protected />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: "/library", element: <LibraryPage /> },
              { path: "/discover/:id?", element: <Discover /> },
              { path: "/admin", element: <AdminPage /> },
              { path: "/admin/users/:userId", element: <AdminPage /> },
              { path: "/admin/sets/:setId?", element: <AdminPage /> },
              { path: "/history", element: <HistoryPage /> },
              { path: "/review/:id", element: <DueReviewPage /> },
              { path: "/account", element: <AccountPage /> },
              { path: "/sets/:id/view", element: <SavedSetPage /> },
              { path: "/sets/:id/edit", element: <EditorPage /> },
              { path: "/new/:kind/:draftId", element: <EditorPage /> },
            ],
          },
          { path: "/practice/:id", element: <PracticePage /> },
          { path: "/sets/:id/worksheet", element: <WorksheetPage /> },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
export default function App() {
  return <RouterProvider router={router} />;
}
