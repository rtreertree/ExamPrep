import { useEffect, useRef, type HTMLAttributes } from "react";

/** A quiet pointer light on matte surfaces; content never moves with the pointer. */
export function SurfaceLight({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const media = matchMedia(
      "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
    );
    let frame = 0;
    let x = 0;
    let y = 0;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      node.removeAttribute("data-lit");
    };
    const move = (event: PointerEvent) => {
      if (!media.matches || event.pointerType === "touch") return;
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = node.getBoundingClientRect();
        node.style.setProperty("--light-x", `${x - rect.left}px`);
        node.style.setProperty("--light-y", `${y - rect.top}px`);
        node.setAttribute("data-lit", "");
      });
    };
    node.addEventListener("pointermove", move, { passive: true });
    node.addEventListener("pointerleave", clear);
    node.addEventListener("pointercancel", clear);
    media.addEventListener("change", clear);
    return () => {
      clear();
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", clear);
      node.removeEventListener("pointercancel", clear);
      media.removeEventListener("change", clear);
    };
  }, []);
  return <div ref={ref} className={`surface-light ${className}`} {...props} />;
}
