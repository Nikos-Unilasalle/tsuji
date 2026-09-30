/**
 * Hover tooltips that show at once, for every `title` in the app.
 *
 * The browser's own `title` tooltip waits the better part of a second before
 * appearing, and nothing lets a page shorten that. So the title is taken off
 * the element the pointer enters (kept in `data-tip`, which also keeps it
 * readable to the next hover) and drawn here instead, immediately. React
 * writing a new title while it's hovered — a toggle's label flipping on
 * click — is picked up and taken off again, so the native one never gets its
 * turn.
 */

const OFFSET_PX = 8;
const EDGE_MARGIN_PX = 6;

let installed = false;

export function initInstantTooltips(doc: Document = document): void {
  if (installed) return;
  installed = true;

  const tip = doc.createElement("div");
  tip.className = "instant-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  doc.body.appendChild(tip);

  // The hovered element, watched for a new title for as long as the pointer
  // is on it — clicked (tip put away) or not.
  let anchor: HTMLElement | SVGElement | null = null;
  let dismissed = false;
  const observer = new MutationObserver(() => {
    if (anchor && adoptTitle(anchor) && !dismissed) show(anchor);
  });

  /**
   * Moves the element's title into data-tip; true when there was a new one.
   * An icon button's title is often its only name, so it becomes the
   * aria-label too, unless the element names itself.
   */
  function adoptTitle(el: Element): boolean {
    const title = el.getAttribute("title");
    if (title === null) return false;
    const label = el.getAttribute("aria-label");
    if (label === null || label === el.getAttribute("data-tip")) el.setAttribute("aria-label", title);
    el.removeAttribute("title");
    el.setAttribute("data-tip", title);
    return true;
  }

  function show(el: Element) {
    const text = el.getAttribute("data-tip");
    if (!text) {
      hide();
      return;
    }
    tip.textContent = text;
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const viewW = doc.documentElement.clientWidth;
    const viewH = doc.documentElement.clientHeight;
    // Below the element, centred on it; above it when there's no room below.
    let top = rect.bottom + OFFSET_PX;
    if (top + height > viewH - EDGE_MARGIN_PX) top = rect.top - OFFSET_PX - height;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(EDGE_MARGIN_PX, Math.min(left, viewW - width - EDGE_MARGIN_PX));
    tip.style.top = `${Math.max(EDGE_MARGIN_PX, top)}px`;
    tip.style.left = `${left}px`;
  }

  function hide() {
    tip.hidden = true;
    dismissed = true;
  }

  function release() {
    tip.hidden = true;
    observer.disconnect();
    anchor = null;
  }

  doc.addEventListener(
    "pointerover",
    (e) => {
      const target = e.target instanceof Element ? e.target.closest("[title], [data-tip]") : null;
      const el = target instanceof HTMLElement || target instanceof SVGElement ? target : null;
      if (el === anchor) return;
      release();
      if (!el) return;
      adoptTitle(el);
      anchor = el;
      dismissed = false;
      observer.observe(el, { attributes: true, attributeFilter: ["title", "data-tip"] });
      show(el);
    },
    true,
  );
  // Leaving the window, pressing, typing or scrolling all put it away.
  doc.addEventListener("pointerout", (e) => {
    if (!e.relatedTarget) release();
  });
  doc.addEventListener("pointerdown", hide, true);
  doc.addEventListener("keydown", hide, true);
  doc.addEventListener("wheel", hide, { capture: true, passive: true });
  doc.defaultView?.addEventListener("blur", release);
}
