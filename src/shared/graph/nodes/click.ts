import { fromBoolean } from "../sockets";
import { NodeDefinition } from "../types";
import { createNodeCache } from "../nodeCaches";
import { perSession, sessionKey } from "../sessionState";
import { isPointerButtonDown, pointerButtonEdgeCounts } from "../pointerStore";

interface ClickState {
  seenDown: number;
  seenUp: number;
}

/** Per render loop, so each viewport sees every click once — see sessionState.ts. */
const stateCache = createNodeCache<Map<string, ClickState>>();

/** PointerEvent.button values, by name — matches the param select below. */
const BUTTONS: Record<string, number> = { left: 0, middle: 1, right: 2 };

/**
 * Mouse Click node — detects a mouse button pressed over the viewport,
 * mirroring Keyboard's isDown/pressed pair (`io/keyboard`) but for the
 * pointer instead of a key. `released` is the one addition: a click's *end*
 * is often the useful edge (drop a dragged object, confirm a placement), and
 * it isn't derivable from isDown/pressed alone without a second node.
 *
 * `pressed`/`released` come from pointerStore's down/up *counts*, not from
 * comparing isDown across frames — a click quick enough to press and release
 * between two evaluate() calls would otherwise flip the live boolean on and
 * back off with this node never once observing it `true`, silently eating
 * the click. Counting edges catches it either way.
 *
 * Only a press that started over a registered viewport counts — see
 * pointerStore's isOverAnyViewport — so clicking Save or a node in the graph
 * editor doesn't also fire whatever this is wired into.
 */
export const CLICK_NODE: NodeDefinition = {
  type: "io/click",
  label: "Mouse Click",
  category: "io",
  inputs: [],
  outputs: [
    { id: "isDown", label: "Is Down", type: "value" },
    { id: "pressed", label: "Pressed", type: "value" },
    { id: "released", label: "Released", type: "value" },
  ],
  defaultParams: { button: "left" },
  paramFields: [{ id: "button", label: "Button", kind: "select", options: ["left", "middle", "right"] }],
  evaluate: (_inputs, params, ctx) => {
    const button = BUTTONS[String(params.button ?? "left")] ?? 0;
    const isDown = isPointerButtonDown(button);
    const { down, up } = pointerButtonEdgeCounts(button);

    let sessions = stateCache.get(ctx.nodeId);
    if (!sessions) stateCache.set(ctx.nodeId, (sessions = new Map()));
    const key = sessionKey(ctx);
    const prev = sessions.get(key);
    // No prior read (the node's first frame): if the button is already down,
    // back-date the seen count by one so this first read still reports the
    // rising edge — same as Keyboard's own first-frame behavior, "already
    // held when the node appeared" counts as just pressed. A first read
    // while up never reports `released`; there is nothing to have released.
    const baseline = prev ?? { seenDown: isDown ? down - 1 : down, seenUp: up };
    perSession(sessions, key, () => baseline);
    sessions.set(key, { seenDown: down, seenUp: up });

    const pressed = down !== baseline.seenDown;
    const released = prev !== undefined && up !== baseline.seenUp;

    return {
      isDown: fromBoolean(isDown),
      pressed: fromBoolean(pressed),
      released: fromBoolean(released),
    };
  },
};
