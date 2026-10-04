/**
 * Where the mouse is, in the coordinate space of whichever viewport it is
 * over, together with the camera that viewport is actually rendering from.
 *
 * The Mouse node cannot work this out on its own. `EvalContext` gives it a
 * renderer and an `activeCameraPose`, but the pose is resolved from the
 * graph's *Camera nodes* — it is null in the common case of a graph with no
 * Camera node, where the pane is being flown by the editor's own orbit
 * camera. A node reading only the context therefore had a pointer position
 * but nothing to unproject it with, which is exactly the "3D estimate stays
 * at 0,0,0" symptom. The viewport is the only thing that knows both its
 * canvas and its live camera, so it publishes them here (mirrors
 * inputZoneStore: a small module the panes register with, read by whoever
 * needs the answer).
 *
 * Several viewports can be registered at once (editor pane, split preview,
 * the output window). The read picks the one the pointer is inside, so the
 * node follows the pane being pointed at rather than an arbitrary one.
 */
import * as THREE from "three";

interface PointerViewport {
  element: HTMLElement;
  /** A getter, not the camera itself — the viewport swaps its camera object when toggling ortho/perspective. */
  getCamera: () => THREE.Camera;
}

const viewports: PointerViewport[] = [];

let clientX = 0;
let clientY = 0;
let seen = false;

/** Mouse buttons (PointerEvent.button: 0 left, 1 middle, 2 right) currently held down over a registered viewport. */
const pressedButtons = new Set<number>();

/**
 * How many times each button has gone down/up, ever. A Click node's evaluate
 * only samples state once a frame — a click quick enough to press and
 * release between two frames would otherwise flip `pressedButtons` on and
 * back off with nothing ever reading `true` in between, silently eating the
 * click. Comparing counts instead of the live boolean means a node catches
 * the edge even when it never observes the button actually being down.
 */
const downCounts = new Map<number, number>();
const upCounts = new Map<number, number>();

function bump(counts: Map<number, number>, button: number): void {
  counts.set(button, (counts.get(button) ?? 0) + 1);
}

function isOverAnyViewport(target: EventTarget | null): boolean {
  return target instanceof Node && viewports.some((v) => v.element.contains(target));
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (e) => {
      clientX = e.clientX;
      clientY = e.clientY;
      seen = true;
    },
    { passive: true },
  );

  // Click nodes read graph-relevant clicks only — the toolbar, the node
  // palette and the param panel all sit in the same window and must not
  // fire graph logic just because a user pressed Save.
  window.addEventListener("pointerdown", (e) => {
    // A touch tap arrives as a bare pointerdown with no pointermove first, so
    // without this the Mouse node would report where the previous tap landed.
    clientX = e.clientX;
    clientY = e.clientY;
    seen = true;
    if (isOverAnyViewport(e.target)) {
      pressedButtons.add(e.button);
      bump(downCounts, e.button);
    }
  });
  window.addEventListener("pointerup", (e) => {
    if (pressedButtons.delete(e.button)) bump(upCounts, e.button);
  });
  // A button released outside the window (dragged off, alt-tabbed) never
  // gets its pointerup — without this a Click node's isDown could get stuck
  // on `true` forever.
  window.addEventListener("blur", () => {
    for (const button of pressedButtons) bump(upCounts, button);
    pressedButtons.clear();
  });
}

/** Registers a viewport as a pointer target. Returns the unregister function. */
export function registerPointerViewport(viewport: PointerViewport): () => void {
  viewports.push(viewport);
  return () => {
    const i = viewports.indexOf(viewport);
    if (i >= 0) viewports.splice(i, 1);
  };
}

export interface PointerSample {
  /** Pixels from the viewport's top-left corner. */
  x: number;
  y: number;
  /** Normalized device coordinates, -1..1, y up. */
  ndcX: number;
  ndcY: number;
  /** False while the pointer is over some other part of the UI (the coordinates then describe where it last was, extrapolated). */
  inside: boolean;
  width: number;
  height: number;
  camera: THREE.Camera;
}

function sampleOf(viewport: PointerViewport, rect: DOMRect): PointerSample {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return {
    x,
    y,
    ndcX: (x / rect.width) * 2 - 1,
    ndcY: -(y / rect.height) * 2 + 1,
    inside: x >= 0 && x <= rect.width && y >= 0 && y <= rect.height,
    width: rect.width,
    height: rect.height,
    camera: viewport.getCamera(),
  };
}

/**
 * The pointer against the viewport it is over, or against the first laid-out
 * viewport when it is elsewhere. Null before the first pointer event, or when
 * no viewport is registered (tests, a headless evaluate call).
 */
export function readViewportPointer(): PointerSample | null {
  if (!seen) return null;
  let fallback: PointerSample | null = null;
  for (const viewport of viewports) {
    const rect = viewport.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const sample = sampleOf(viewport, rect);
    if (sample.inside) return sample;
    if (!fallback) fallback = sample;
  }
  return fallback;
}

/** Test seam — feeds a pointer position without a real pointer event. */
export function simulatePointerMove(x: number, y: number): void {
  clientX = x;
  clientY = y;
  seen = true;
}

/** Whether the given mouse button is currently held down over a registered viewport. */
export function isPointerButtonDown(button: number): boolean {
  return pressedButtons.has(button);
}

/** How many times this button has gone down / up, ever — see the `downCounts` doc above. */
export function pointerButtonEdgeCounts(button: number): { down: number; up: number } {
  return { down: downCounts.get(button) ?? 0, up: upCounts.get(button) ?? 0 };
}

/** Test seam — sets/clears a mouse button without a real pointer event or a registered viewport. */
export function simulatePointerButton(button: number, down: boolean): void {
  if (down) {
    if (!pressedButtons.has(button)) bump(downCounts, button);
    pressedButtons.add(button);
  } else {
    if (pressedButtons.delete(button)) bump(upCounts, button);
  }
}

/**
 * Test seam — a full press-then-release that never sets `pressedButtons` at
 * all, the same shape a click faster than one animation frame produces in
 * the real listeners above.
 */
export function simulatePointerClick(button: number): void {
  bump(downCounts, button);
  bump(upCounts, button);
}
