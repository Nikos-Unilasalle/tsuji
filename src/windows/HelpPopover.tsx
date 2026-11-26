import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./group-help.css";

/*
 * A "?" beside a param field that opens a help panel: floating, draggable by
 * its title bar, and left open while you type in the field (it closes with
 * its ×, Escape, or the "?" again). It reopens where it was last dropped.
 */

const lastPosition = new Map<string, { left: number; top: number }>();

export function HelpPopover({
  title,
  ariaLabel,
  width = 390,
  onOpenChange,
  children,
}: {
  title: string;
  ariaLabel: string;
  width?: number;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const clamp = (left: number, top: number) => {
    const height = popRef.current?.offsetHeight ?? 400;
    return {
      left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
      top: Math.max(8, Math.min(window.innerHeight - Math.min(height, 120), top)),
    };
  };

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const remembered = lastPosition.get(title);
    if (remembered) {
      setPos(clamp(remembered.left, remembered.top));
      return;
    }
    const r = buttonRef.current.getBoundingClientRect();
    const height = popRef.current?.offsetHeight ?? 480;
    setPos({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, r.left - width - 10)),
      top: Math.max(8, Math.min(window.innerHeight - height - 8, r.top - 40)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !pos || (e.target as HTMLElement).closest("button")) return;
    drag.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy);
    setPos(next);
    lastPosition.set(title, next);
  };
  const onHeadUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={"group-help-btn" + (open ? " is-open" : "")}
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        ?
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="group-help-pop"
            role="dialog"
            aria-label={title}
            style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
          >
            <div
              className="group-help-head"
              onPointerDown={onHeadDown}
              onPointerMove={onHeadMove}
              onPointerUp={onHeadUp}
              onPointerCancel={onHeadUp}
              title="Drag to move"
            >
              <span className="group-help-grip" aria-hidden="true">
                ⠿
              </span>
              <strong>{title}</strong>
              <button type="button" className="group-help-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="group-help-body">{children}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** One clickable line of a help panel: the snippet, and what it does. */
export function HelpRow({
  code,
  text,
  onPick,
  onHover,
}: {
  code: string;
  text: string;
  onPick: (code: string) => void;
  onHover?: (code: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="group-help-row"
      onClick={() => onPick(code)}
      onMouseEnter={() => onHover?.(code)}
      onMouseLeave={() => onHover?.(null)}
    >
      <code>{code || "(empty)"}</code>
      <span>{text}</span>
    </button>
  );
}
