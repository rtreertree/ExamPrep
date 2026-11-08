import {
  cloneElement,
  createContext,
  useContext,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { X, ChevronDown, Check } from "lucide-react";
import { ApiError } from "../lib/api";
import { issuesOf, issueLabel } from "../lib/issues";
import type { Issue } from "../../shared/json";
export const FieldIssues = createContext<Issue[]>([]);
export function Button({
  variant = "secondary",
  busy,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`button ${variant} ${className}`}
    >
      {children}
      {busy ? <span className="busy-label">…</span> : null}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
  path,
}: {
  path?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const issue = useContext(FieldIssues).find((i) => i.path === path);
  const control = isValidElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>(children)
    ? cloneElement(children, {
        id,
        "aria-describedby":
          [hint ? `${id}-hint` : "", issue ? `${id}-error` : ""]
            .filter(Boolean)
            .join(" ") || undefined,
        "aria-invalid": !!issue,
      })
    : children;
  return (
    <div className="field" data-field-path={path}>
      <label htmlFor={id}>{label}</label>
      {control}
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
      {issue ? (
        <small className="negative" id={`${id}-error`}>
          {issue.message}
        </small>
      ) : null}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "warning" | "success";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function ErrorNotice({
  error,
  retry,
  onIssue,
}: {
  error?: Error;
  retry?: () => void;
  onIssue?: (issue: Issue) => void;
}) {
  if (!error) return null;
  const issues = issuesOf(error);
  return (
    <Notice tone="error">
      <p>
        {issues.length
          ? "Some fields need attention before saving."
          : error.message}
      </p>
      {issues.length ? (
        <>
          <ul>
            {issues.map((i, n) => (
              <li key={n}>
                {onIssue ? (
                  <Button variant="quiet" onClick={() => onIssue(i)}>
                    {issueLabel(i)}
                  </Button>
                ) : (
                  issueLabel(i)
                )}
              </li>
            ))}
          </ul>
          <details>
            <summary>Technical details</summary>
            <ul>
              {issues.map((i, n) => (
                <li key={n}>
                  <code>{i.path}</code> {i.message}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      {error instanceof ApiError && error.reference ? (
        <p>Reference: {error.reference}</p>
      ) : null}
      {retry ? <Button onClick={retry}>Retry</Button> : null}
    </Notice>
  );
}
export function LoadingRows() {
  return (
    <div role="status" aria-label="Loading" className="loading-rows">
      {[1, 2, 3].map((i) => (
        <div key={i} />
      ))}
    </div>
  );
}
export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
  display,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  display?: boolean;
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className={display ? "display" : ""}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
export function SaveStatus({
  state,
  local = false,
  retry,
}: {
  state: string;
  local?: boolean;
  retry?: () => void;
}) {
  return (
    <span
      role="status"
      className={`save-status ${state === "Could not save" ? "negative" : ""}`}
    >
      {state === "Saved" ? (
        <span
          className={`save-check ${local ? "" : "positive"}`}
          aria-hidden="true"
        >
          <Check size={14} />
        </span>
      ) : null}
      {state === "Saved"
        ? local
          ? "Draft saved on this device"
          : "Saved to your account"
        : state}
      {retry ? (
        <Button variant="quiet" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}
export function Tabs({
  value,
  onChange,
  tabs,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  tabs: { value: string; label: string }[];
  label: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current!;
    const measure = () => {
      const selected = node.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      if (!selected || !node.clientWidth) {
        node.removeAttribute("data-indicator-ready");
        return;
      }
      node.style.setProperty("--tab-left", `${selected.offsetLeft}px`);
      node.style.setProperty("--tab-width", `${selected.offsetWidth}px`);
      node.setAttribute("data-indicator-ready", "");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node
      .querySelectorAll('button[role="tab"]')
      .forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [value, tabs]);
  return (
    <div ref={ref} className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, i) => (
        <button
          key={tab.value}
          id={`${id}-${tab.value}`}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          aria-controls={
            tab.value === value
              ? `${label.toLowerCase().replaceAll(" ", "-")}-${tab.value}`
              : undefined
          }
          tabIndex={tab.value === value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(e) => {
            let n: number | undefined;
            if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
            if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
            if (e.key === "Home") n = 0;
            if (e.key === "End") n = tabs.length - 1;
            if (n !== undefined) {
              e.preventDefault();
              onChange(tabs[n].value);
              e.currentTarget.parentElement
                ?.querySelectorAll<HTMLElement>('[role="tab"]')
                [n]?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
      <span className="tabs-indicator" aria-hidden="true" />
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog frosted-overlay"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-header">
        <h2 id={id}>{title}</h2>
        <Button variant="quiet" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
export function Menu({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node))
        ref.current?.removeAttribute("open");
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  return (
    <details
      ref={ref}
      className="menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          ref.current?.removeAttribute("open");
          ref.current?.querySelector("summary")?.focus();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const nodes = [
            ...(ref.current?.querySelectorAll<HTMLElement>(
              ".menu-content button,.menu-content a",
            ) ?? []),
          ];
          const index = nodes.indexOf(document.activeElement as HTMLElement);
          nodes[
            (index + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) %
              nodes.length
          ]?.focus();
        }
      }}
    >
      <summary className="button secondary">
        {label}
        <ChevronDown size={16} />
      </summary>
      <div
        className="menu-content frosted-overlay"
        onClick={() => ref.current?.removeAttribute("open")}
      >
        {children}
      </div>
    </details>
  );
}
