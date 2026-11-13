import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./selector.css";

type SelectorOption = { value: string; label: string; disabled?: boolean };

type SelectorProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  value: string;
  options: readonly SelectorOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
} & ({ editable?: false } | { editable: true; maxLength?: number });

export function Selector({
  id,
  value,
  options,
  onValueChange,
  disabled,
  placeholder,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...mode
}: SelectorProps) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const typeAhead = useRef({ query: "", time: 0 });
  const revealActive = useRef(true);
  const [expanded, setExpanded] = useState(false);
  const [activeValue, setActiveValue] = useState<string>();
  const [confirmation, setConfirmation] = useState(0);

  const editable = mode.editable === true;
  const selected = options.find((option) => option.value === value);
  const query = editable ? value.trim().toLocaleLowerCase() : "";
  const visibleOptions = query
    ? options.filter((option) =>
        option.label.toLocaleLowerCase().includes(query),
      )
    : options;
  const open = expanded && !disabled && visibleOptions.length > 0;
  const activeIndex = visibleOptions.findIndex(
    (option) => option.value === activeValue && !option.disabled,
  );
  const topLayer =
    open && typeof HTMLElement.prototype.showPopover === "function";
  const optionId = (index: number) => `${listId}-option-${index}`;

  function activate(option?: SelectorOption, reveal = true) {
    revealActive.current = reveal;
    setActiveValue(option?.value);
  }

  function close() {
    setExpanded(false);
    activate();
    typeAhead.current.query = "";
  }

  function showOptions() {
    if (!editable) activate(selected?.disabled ? undefined : selected);
    setExpanded(true);
  }

  function choose(option: SelectorOption) {
    if (option.disabled || control.current?.matches(":disabled")) return;
    if (option.value !== value) {
      onValueChange(option.value);
      setConfirmation((previous) => previous + 1);
    }
    close();
  }

  useLayoutEffect(() => {
    const anchor = control.current;
    const popup = panel.current;
    if (!topLayer || !anchor || !popup) return;

    function position(anchor: HTMLElement, popup: HTMLElement) {
      const gap = 6;
      const margin = 8;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight =
        viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom =
        viewportTop + (viewport?.height ?? window.innerHeight);
      const bounds = anchor.getBoundingClientRect();
      if (
        !bounds.width ||
        bounds.bottom <= viewportTop ||
        bounds.top >= viewportBottom
      ) {
        setExpanded(false);
        return;
      }

      const below = viewportBottom - bounds.bottom - gap - margin;
      const above = bounds.top - viewportTop - gap - margin;
      const width = Math.min(
        bounds.width,
        viewportRight - viewportLeft - 2 * margin,
      );
      const left = Math.min(
        Math.max(bounds.left, viewportLeft + margin),
        viewportRight - margin - width,
      );

      popup.style.width = `${width}px`;
      const desiredHeight = Math.min(popup.scrollHeight + 2, 288);
      const opensAbove =
        (editable && above >= desiredHeight) ||
        (below < desiredHeight && above > below);
      popup.dataset.side = opensAbove ? "above" : "below";
      popup.style.left = `${left}px`;
      popup.style.maxHeight = `${Math.max(0, Math.min(288, opensAbove ? above : below))}px`;
      // Fixed coordinates are relative to the layout viewport.
      popup.style.top = opensAbove ? "auto" : `${bounds.bottom + gap}px`;
      popup.style.bottom = opensAbove
        ? `${document.documentElement.clientHeight - bounds.top + gap}px`
        : "auto";
    }

    const update = (event?: Event) => {
      if (event?.target !== popup) position(anchor, popup);
    };
    popup.showPopover();
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(anchor);
    if (rows.current) observer.observe(rows.current);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    const viewport = window.visualViewport;
    viewport?.addEventListener("scroll", update);
    viewport?.addEventListener("resize", update);
    return () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      viewport?.removeEventListener("resize", update);
    };
  }, [editable, topLayer]);

  useLayoutEffect(() => {
    const popup = panel.current;
    const list = rows.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!popup || !list || !row) return;

    function markRow(popup: HTMLElement, list: HTMLElement, row: HTMLElement) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      list.style.setProperty("--selector-marker-top", `${top + 6}px`);
      list.style.setProperty(
        "--selector-marker-height",
        `${row.offsetHeight - 12}px`,
      );
      if (revealActive.current) {
        if (top < popup.scrollTop) popup.scrollTop = top - 4;
        else if (bottom > popup.scrollTop + popup.clientHeight)
          popup.scrollTop = bottom - popup.clientHeight + 4;
      }
    }

    const update = () => markRow(popup, list, row);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    observer.observe(popup);
    return () => observer.disconnect();
  }, [open, activeIndex, activeValue]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setExpanded(false);
        setActiveValue(undefined);
        typeAhead.current.query = "";
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (key === "Tab") {
      close();
      return;
    }
    if (event.altKey) return;

    const active = visibleOptions[activeIndex];
    if (key === "Enter" || (!editable && key === " ")) {
      if (editable && (!open || !active)) {
        close();
        return;
      }
      event.preventDefault();
      if (open && active) choose(active);
      else if (open) close();
      else showOptions();
      return;
    }

    const arrow = key === "ArrowDown" || key === "ArrowUp";
    const edge = !editable && (key === "Home" || key === "End");
    if (arrow || edge) {
      if (!visibleOptions.length) return;
      event.preventDefault();
      const backwards = key === "ArrowUp" || key === "End";
      const candidates = backwards
        ? [...visibleOptions].reverse()
        : visibleOptions;
      const start =
        edge || !open || !active ? 0 : candidates.indexOf(active) + 1;
      const next = candidates.slice(start).find((option) => !option.disabled);
      if (next) activate(next);
      setExpanded(true);
      return;
    }
    if (editable || key.length !== 1) return;
    event.preventDefault();
    const letter = key.toLocaleLowerCase();
    const now = performance.now();
    const previous =
      now - typeAhead.current.time < 500 ? typeAhead.current.query : "";
    const repeated = previous === letter;
    const query = repeated ? letter : previous + letter;
    typeAhead.current = { query, time: now };

    const start = repeated ? activeIndex + 1 : Math.max(0, activeIndex);
    const candidates = [
      ...visibleOptions.slice(start),
      ...visibleOptions.slice(0, start),
    ];
    const match = candidates.find(
      (option) =>
        !option.disabled && option.label.toLocaleLowerCase().startsWith(query),
    );
    if (match) {
      activate(match);
      setExpanded(true);
    }
  }

  const combobox = {
    id,
    role: "combobox",
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant":
      open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    disabled,
    onBlur: close,
    onKeyDown: handleKeyDown,
  } as const;

  return (
    <div ref={root} className="selector">
      {editable ? (
        <div className="selector-editable">
          <input
            {...combobox}
            ref={(node) => {
              control.current = node;
            }}
            className="selector-input"
            aria-autocomplete="list"
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            maxLength={mode.maxLength}
            onClick={showOptions}
            onChange={(event) => {
              const next = event.target.value;
              onValueChange(next);
              activate();
              setExpanded(next.trim().length > 0);
            }}
          />
          {confirmation > 0 ? (
            <Check
              key={confirmation}
              className="selector-confirmation"
              size={18}
              aria-hidden="true"
            />
          ) : null}
        </div>
      ) : (
        <button
          {...combobox}
          ref={(node) => {
            control.current = node;
          }}
          type="button"
          className="selector-trigger"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            if (open) close();
            else showOptions();
          }}
        >
          <span className="selector-value">
            {selected?.label ?? placeholder ?? value}
          </span>
          <span className="selector-icon" aria-hidden="true">
            <ChevronDown className="selector-chevron" size={18} />
            {confirmation > 0 ? (
              <Check
                key={confirmation}
                className="selector-confirmation"
                size={18}
              />
            ) : null}
          </span>
        </button>
      )}
      {open ? (
        <div
          ref={panel}
          id={listId}
          role="listbox"
          aria-label="Options"
          className="selector-panel"
          popover={topLayer ? "manual" : undefined}
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest('[role="option"]'))
              event.preventDefault();
          }}
        >
          <div ref={rows} className="selector-rows">
            <span
              aria-hidden="true"
              className="selector-marker"
              hidden={activeIndex < 0}
            />
            {visibleOptions.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={activeIndex === index}
                className="selector-option"
                onPointerMove={(event) => {
                  if (event.pointerType === "mouse" && !option.disabled)
                    activate(option, false);
                }}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.value === value ? (
                  <Check size={16} aria-hidden="true" />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
