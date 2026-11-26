import { useCallback } from "react";
import { HelpPopover, HelpRow } from "./HelpPopover";

/*
 * The "?" beside every Group field: a pop-up explaining what a group
 * expression can say, with ready-made formulas — point at one to preview it
 * on the mesh, click it to put it in the field. Replaces the one-line syntax
 * summary that used to sit under the field.
 */

const SYNTAX: [string, string][] = [
  ["", "Empty (or *): every element"],
  ["top", "The group named top"],
  ["rim_*", "Every group whose name starts with rim_"],
  ["a b", "In a or in b (a | b works too)"],
  ["a & b", "In both a and b"],
  ["!a", "Not in a"],
  ["a ^ b", "In exactly one of a, b"],
  ["(a | b) & !c", "Parentheses group terms"],
  ["0-10:2", "Element numbers: 5, a range 0-10, every 2nd 0-10:2"],
  ["@P.y>0", "Attribute test: == != < > <= >= (no spaces)"],
  ["@weight", "Where the attribute is non-zero"],
];

const RECIPES: [string, string][] = [
  ["extrude_top", "The caps the last Extrude made"],
  ["extrude_side", "The walls the last Extrude made"],
  ["inset_inner", "The faces the last Inset shrank"],
  ["@P.y>0", "Everything above the ground plane"],
  ["@N.y>0.9", "Faces looking up (on the Face domain)"],
  ["@N.y<-0.9", "Faces looking down"],
  ["@area>0.5", "Faces bigger than 0.5 square units"],
  ["@piece==0", "The first connected piece"],
  ["0-99:2", "Every other element of the first hundred"],
  ["top & !rim_*", "Top, minus anything in a rim_ group"],
  ["selected ^ extrude_top", "Selected or a cap, but not both"],
];

const BUILTINS = "P (position) · N (normal) · id · area · piece · Cd (colour) · material_index · on edges: angle, sharp, seam, crease";

export function GroupHelpButton({
  onPick,
  onHover,
}: {
  onPick: (expression: string) => void;
  /** A formula under the pointer (null when it leaves): the viewport previews it on the mesh. */
  onHover?: (expression: string | null) => void;
}) {
  // Nothing stays previewed once the panel is gone.
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) onHover?.(null);
  }, [onHover]);
  const row = ([code, text]: [string, string]) => <HelpRow key={code + text} code={code} text={text} onPick={onPick} onHover={onHover} />;
  return (
    <HelpPopover title="Writing a group" ariaLabel="Group syntax help" onOpenChange={onOpenChange}>
      <p className="group-help-intro">
        A group is a named set of points, edges or faces — written by Select nodes, Extrude, Inset and others. This field says which
        elements the node works on. Point at a line to preview it on the mesh, click it to use it.
      </p>
      <h4>Syntax</h4>
      <div className="group-help-list">{SYNTAX.map(row)}</div>
      <h4>Useful formulas</h4>
      <div className="group-help-list">{RECIPES.map(row)}</div>
      <h4>Built-in attributes</h4>
      <p className="group-help-note">{BUILTINS}. Add .x .y .z (or .r .g .b) for one component.</p>
      <p className="group-help-note">
        A group from another domain still works: a point group used on faces takes the faces whose points are all in it. An unknown
        name selects nothing and the node says so.
      </p>
    </HelpPopover>
  );
}
