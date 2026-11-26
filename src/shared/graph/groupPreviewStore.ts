/*
 * What the viewport's group overlay should show beyond the selected node's
 * own group — set from the panels, read by the viewport every frame:
 *
 *  - a formula hovered in the group-syntax help (previewed before it is
 *    clicked into the field);
 *  - a Geometry Spreadsheet row under the pointer (its element lit up);
 *  - the element last picked in the viewport for a spreadsheet (its row
 *    highlighted in the table).
 *
 * Plain module state with a subscribe for React; the viewport polls it in
 * its render loop like any other ref.
 */

export interface ExpressionHover {
  nodeId: string;
  fieldId: string;
  expression: string;
}

export interface ElementRef {
  nodeId: string;
  index: number;
}

interface State {
  expressionHover: ExpressionHover | null;
  sheetHover: ElementRef | null;
  sheetFocus: ElementRef | null;
}

let state: State = { expressionHover: null, sheetHover: null, sheetFocus: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const groupPreview = {
  get: (): State => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  hoverExpression: (hover: ExpressionHover | null) => set({ expressionHover: hover }),
  hoverSheetRow: (ref: ElementRef | null) => {
    if (ref?.nodeId === state.sheetHover?.nodeId && ref?.index === state.sheetHover?.index) return;
    set({ sheetHover: ref });
  },
  focusSheetElement: (ref: ElementRef | null) => set({ sheetFocus: ref }),
};
