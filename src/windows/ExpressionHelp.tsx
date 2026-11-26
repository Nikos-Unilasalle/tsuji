import { ATTRIB_EXPR_FUNCTIONS } from "../shared/graph/mesh/attribExpr";
import { HelpPopover, HelpRow } from "./HelpPopover";

/*
 * The "?" beside Attribute Expression's formula fields: what a formula can
 * read, its operators, its functions sorted by job, and ready-made formulas
 * to click into the field. Replaces the paragraph of syntax that sat under
 * the fields.
 */

const VARIABLES: [string, string][] = [
  ["P", "Position (vector) — write P to move points"],
  ["N", "Normal (vector)"],
  ["id", "The element's number: 0, 1, 2…"],
  ["count", "How many elements there are"],
  ["t", "Time in seconds (f: the frame)"],
  ["a", "a b c d: the Parameters sliders, or what is wired into them"],
  ["Cd", "Any attribute by its name: Cd, pscale, weight, area…"],
  ["P.y", "One component: .x .y .z (or .r .g .b)"],
];

const OPERATORS: [string, string][] = [
  ["2 * P + 1", "+ - * / % ^ — a number with a vector applies to each component"],
  ["2x", "A number before a name multiplies it"],
  ["(1, 0, 0)", "Three numbers in brackets make a vector"],
  ["|P|", "Length of a vector (or absolute value)"],
  ["P.y > 0 ? 1 : 0", "Condition ? if true : if false — compare with < > <= >= == !="],
  ["P.y > 0 && id % 2 == 0", "&& and, || or, ! not"],
];

const RECIPES: [string, string][] = [
  ["P + N * 0.1", "Inflate along the normal (write to P)"],
  ["P + N * 0.2 * noise(P * 3)", "Noisy bumps (write to P)"],
  ["P + (0, 0.3 * sin(P.x * 4 + t * 2), 0)", "Animated wave (write to P)"],
  ["normalize(P) * 0.5", "Spherify (write to P)"],
  ["P + curl(P * 2 + t * 0.2) * 0.1", "Swirl (write to P)"],
  ["fit(P.y, 0, 2, 0, 1)", "Height gradient from 0 to 1"],
  ["P.y > 1 ? 1 : 0", "1 above y = 1, else 0 (a mask)"],
  ["rand(id)", "A random value per element"],
  ["length(P)", "Distance from the origin"],
  ["mix((1, 0, 0), (0, 0, 1), fit(P.y, 0, 2, 0, 1))", "Red-to-blue gradient by height (write to Cd)"],
  ["(rand(id), rand(id, 1), rand(id, 2))", "A random colour per element (write to Cd)"],
  ["a * sin(t * b)", "Driven by the a and b sliders"],
];

const FUNCTION_GROUPS: [string, string[]][] = [
  ["Trigonometry", ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "radians", "degrees"]],
  ["Powers & logs", ["sqrt", "cbrt", "pow", "exp", "ln", "log", "log2", "log10", "abs", "sign"]],
  ["Rounding & ranges", ["floor", "ceil", "round", "fract", "frac", "mod", "min", "max", "clamp"]],
  ["Blending", ["mix", "lerp", "step", "smoothstep", "fit"]],
  ["Vectors", ["length", "distance", "dot", "cross", "normalize", "vec"]],
  ["Noise & random", ["noise", "fbm", "vnoise", "curl", "rand"]],
];

/** The functions the formula language really has, sorted into the groups above (any unlisted one lands in "Other"). */
function groupedFunctions(): [string, string[]][] {
  const byName = new Map(ATTRIB_EXPR_FUNCTIONS.map((help) => [help.split("(")[0].trim(), help]));
  const used = new Set<string>();
  const groups: [string, string[]][] = FUNCTION_GROUPS.map(([title, names]) => [
    title,
    names.filter((n) => byName.has(n)).map((n) => (used.add(n), byName.get(n)!)),
  ]);
  const other = [...byName].filter(([n]) => !used.has(n)).map(([, help]) => help);
  if (other.length) groups.push(["Other", other]);
  return groups.filter(([, list]) => list.length > 0);
}

export function ExpressionHelpButton({ onPick }: { onPick: (formula: string) => void }) {
  const row = ([code, text]: [string, string]) => <HelpRow key={code + text} code={code} text={text} onPick={onPick} />;
  return (
    <HelpPopover title="Writing a formula" ariaLabel="Formula help" width={430}>
      <p className="group-help-intro">
        The formula runs once for every element of the Domain (each point, face…) and its result is written to the attribute named
        above it. Click a line to put it in the field.
      </p>
      <h4>Useful formulas</h4>
      <div className="group-help-list is-stacked">{RECIPES.map(row)}</div>
      <h4>What a formula can read</h4>
      <div className="group-help-list">{VARIABLES.map(row)}</div>
      <h4>Operators</h4>
      <div className="group-help-list is-stacked">{OPERATORS.map(row)}</div>
      <h4>Functions</h4>
      {groupedFunctions().map(([title, list]) => (
        <div key={title} className="expr-help-fn-group">
          <div className="expr-help-fn-title">{title}</div>
          <div className="expr-help-fn-list">
            {list.map((help) => (
              <code key={help} className="expr-help-fn">
                {help}
              </code>
            ))}
          </div>
        </div>
      ))}
      <p className="group-help-note">Vectors work everywhere a number does: sin(P) takes the sine of each component.</p>
    </HelpPopover>
  );
}
