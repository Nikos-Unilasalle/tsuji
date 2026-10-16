import { NodeDefinition } from "../types";
import { createPRNG } from "../../math/random";

/** Text Constant node — outputs a fixed text string. */
export const TEXT_CONSTANT_NODE: NodeDefinition = {
  type: "text/constant",
  label: "Text",
  category: "text",
  pure: true,
  inputs: [],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { text: "Hello" },
  paramFields: [{ id: "text", label: "Text", kind: "text" }],
  evaluate: (_inputs, params) => ({
    text: String(params.text ?? ""),
  }),
};

/** Text Concatenate node — joins text strings with an optional separator. */
export const TEXT_CONCAT_NODE: NodeDefinition = {
  type: "text/concat",
  label: "Text Concat",
  category: "text",
  pure: true,
  inputs: [
    { id: "textA", label: "Text A", type: "text" },
    { id: "textB", label: "Text B", type: "text" },
    { id: "separator", label: "Separator", type: "text" },
  ],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { textA: "", textB: "", separator: "" },
  paramFields: [
    { id: "textA", label: "Text A", kind: "text" },
    { id: "textB", label: "Text B", kind: "text" },
    { id: "separator", label: "Separator", kind: "text" },
  ],
  evaluate: (inputs, params) => {
    const a = inputs.textA !== undefined ? String(inputs.textA) : String(params.textA ?? "");
    const b = inputs.textB !== undefined ? String(inputs.textB) : String(params.textB ?? "");
    const sep = inputs.separator !== undefined ? String(inputs.separator) : String(params.separator ?? "");

    return { text: `${a}${sep}${b}` };
  },
};

/** Text Substring node — extracts a portion of a string. */
export const TEXT_SUBSTRING_NODE: NodeDefinition = {
  type: "text/substring",
  label: "Text Substring",
  category: "text",
  pure: true,
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "start", label: "Start Index", type: "value" },
    { id: "length", label: "Length", type: "value" },
  ],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { text: "", start: 0, length: 5 },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    { id: "start", label: "Start Index", kind: "number", step: 1 },
    { id: "length", label: "Length", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const start = Math.max(0, Math.floor(inputs.start !== undefined ? Number(inputs.start) : Number(params.start) || 0));
    const lenInput = inputs.length !== undefined ? Number(inputs.length) : Number(params.length);
    const len = lenInput !== undefined && !isNaN(lenInput) ? Math.max(0, Math.floor(lenInput)) : str.length;

    return { text: str.substring(start, start + len) };
  },
};

/** Text Length node — returns the number of characters in a string. */
export const TEXT_LENGTH_NODE: NodeDefinition = {
  type: "text/length",
  label: "Text Length",
  category: "text",
  pure: true,
  inputs: [{ id: "text", label: "Text", type: "text" }],
  outputs: [{ id: "value", label: "Length", type: "value" }],
  defaultParams: { text: "" },
  paramFields: [{ id: "text", label: "Text", kind: "text" }],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    return { value: str.length };
  },
};

/** Text Case node — converts text case (UPPERCASE, lowercase, Title Case). */
export const TEXT_CASE_NODE: NodeDefinition = {
  type: "text/case",
  label: "Text Case",
  category: "text",
  pure: true,
  inputs: [{ id: "text", label: "Text", type: "text" }],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { text: "", mode: "uppercase" },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    {
      id: "mode",
      label: "Mode",
      kind: "select",
      options: ["uppercase", "lowercase", "capitalize"],
    },
  ],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const mode = String(params.mode || "uppercase");

    let result = str;
    if (mode === "uppercase") {
      result = str.toUpperCase();
    } else if (mode === "lowercase") {
      result = str.toLowerCase();
    } else if (mode === "capitalize") {
      result = str.replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return { text: result };
  },
};

/** Text Replace node — replaces occurrences of search text with replacement text. */
export const TEXT_REPLACE_NODE: NodeDefinition = {
  type: "text/replace",
  label: "Text Replace",
  category: "text",
  pure: true,
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "search", label: "Search", type: "text" },
    { id: "replace", label: "Replace", type: "text" },
  ],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { text: "", search: "", replace: "" },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    { id: "search", label: "Search", kind: "text" },
    { id: "replace", label: "Replace", kind: "text" },
  ],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const search = inputs.search !== undefined ? String(inputs.search) : String(params.search ?? "");
    const replacement = inputs.replace !== undefined ? String(inputs.replace) : String(params.replace ?? "");

    if (!search) return { text: str };
    return { text: str.split(search).join(replacement) };
  },
};

/** Text Split node — splits a text string into a list of strings by delimiter. */
export const TEXT_SPLIT_NODE: NodeDefinition = {
  type: "text/split",
  label: "Text Split",
  category: "text",
  pure: true,
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "delimiter", label: "Delimiter", type: "text" },
  ],
  outputs: [{ id: "list", label: "List", type: "list" }],
  defaultParams: { text: "", delimiter: "," },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    { id: "delimiter", label: "Delimiter", kind: "text" },
  ],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const delim = inputs.delimiter !== undefined ? String(inputs.delimiter) : String(params.delimiter ?? ",");

    const list = str ? str.split(delim) : [];
    return { list };
  },
};

/** Text Trim node — cuts a fixed number of characters off each end of a string. */
export const TEXT_TRIM_NODE: NodeDefinition = {
  type: "text/trim",
  label: "Text Trim",
  category: "text",
  pure: true,
  inputs: [
    { id: "text", label: "Text", type: "text" },
    { id: "start", label: "Start (chars)", type: "value" },
    { id: "end", label: "End (chars)", type: "value" },
  ],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { text: "", start: 0, end: 0 },
  paramFields: [
    { id: "text", label: "Text", kind: "text" },
    { id: "start", label: "Start (chars)", kind: "number", step: 1 },
    { id: "end", label: "End (chars)", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const str = inputs.text !== undefined ? String(inputs.text) : String(params.text ?? "");
    const start = Math.max(0, Math.floor(inputs.start !== undefined ? Number(inputs.start) : Number(params.start) || 0));
    const end = Math.max(0, Math.floor(inputs.end !== undefined ? Number(inputs.end) : Number(params.end) || 0));

    // start+end past the string's own length would otherwise wrap the slice
    // end around to before its start (str.length - end going negative) and
    // silently return everything from `start` on, instead of "".
    const stop = Math.max(start, str.length - end);
    return { text: str.slice(start, stop) };
  },
};

/** Text Compare / Contains node — evaluates string comparisons (contains, equals, startsWith, endsWith). */
export const TEXT_COMPARE_NODE: NodeDefinition = {
  type: "text/compare",
  label: "Text Compare",
  category: "text",
  pure: true,
  inputs: [
    { id: "textA", label: "Text A", type: "text" },
    { id: "textB", label: "Text B", type: "text" },
  ],
  outputs: [{ id: "value", label: "Result", type: "value" }],
  defaultParams: { textA: "", textB: "", mode: "equals", ignoreCase: true },
  paramFields: [
    { id: "textA", label: "Text A", kind: "text" },
    { id: "textB", label: "Text B", kind: "text" },
    {
      id: "mode",
      label: "Mode",
      kind: "select",
      options: ["equals", "contains", "startsWith", "endsWith"],
    },
    { id: "ignoreCase", label: "Ignore Case", kind: "boolean" },
  ],
  evaluate: (inputs, params) => {
    let a = inputs.textA !== undefined ? String(inputs.textA) : String(params.textA ?? "");
    let b = inputs.textB !== undefined ? String(inputs.textB) : String(params.textB ?? "");
    const mode = String(params.mode || "equals");
    const ignoreCase = Boolean(params.ignoreCase ?? true);

    if (ignoreCase) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }

    let match = false;
    if (mode === "contains") {
      match = a.includes(b);
    } else if (mode === "startsWith") {
      match = a.startsWith(b);
    } else if (mode === "endsWith") {
      match = a.endsWith(b);
    } else {
      match = a === b;
    }

    return { value: match ? 1 : 0 };
  },
};

const RANDOM_TEXT_CHARSETS: Record<string, string> = {
  letters: "abcdefghijklmnopqrstuvwxyz",
  alphanumeric: "abcdefghijklmnopqrstuvwxyz0123456789",
  digits: "0123456789",
};

/** A small, on-theme word bank — placeholder text that reads as "graph node" rather than "lorem ipsum". */
const RANDOM_TEXT_WORDS = [
  "node", "graph", "curve", "vertex", "vector", "matrix", "surface", "light",
  "pulse", "orbit", "stream", "signal", "array", "particle", "texture",
  "trail", "wave", "field", "mesh", "spline", "prism", "socket", "render",
  "cascade", "drift", "flux", "spiral", "shard", "beacon", "lattice",
];

/** Random Text node — a seeded, reproducible random string: words for placeholder labels, or raw characters for ids/codes. */
export const TEXT_RANDOM_NODE: NodeDefinition = {
  type: "text/random",
  label: "Random Text",
  category: "text",
  pure: true,
  inputs: [
    { id: "seed", label: "Seed", type: "value" },
    { id: "length", label: "Length", type: "value" },
  ],
  outputs: [{ id: "text", label: "Text", type: "text" }],
  defaultParams: { seed: 0, length: 3, mode: "words" },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: ["words", "letters", "alphanumeric", "digits"] },
    { id: "length", label: "Length (words or characters)", kind: "number", step: 1 },
    { id: "seed", label: "Seed", kind: "number", step: 1 },
  ],
  evaluate: (inputs, params) => {
    const seed = inputs.seed !== undefined ? Number(inputs.seed) : Number(params.seed) || 0;
    // Not `Number(params.length) || 1`: that treats an explicit 0 the same
    // as "unset" and silently produces one word/char anyway. length=0 has to
    // mean "nothing", the same as every loop bound elsewhere in the graph.
    const rawLength = inputs.length !== undefined ? Number(inputs.length) : Number(params.length);
    const length = Math.max(0, Math.floor(Number.isFinite(rawLength) ? rawLength : 3));
    const mode = String(params.mode || "words");
    const rng = createPRNG(seed);

    if (mode === "words") {
      const words: string[] = [];
      for (let i = 0; i < length; i++) {
        words.push(RANDOM_TEXT_WORDS[Math.floor(rng() * RANDOM_TEXT_WORDS.length)]);
      }
      return { text: words.join(" ") };
    }

    const charset = RANDOM_TEXT_CHARSETS[mode] ?? RANDOM_TEXT_CHARSETS.letters;
    let out = "";
    for (let i = 0; i < length; i++) {
      out += charset[Math.floor(rng() * charset.length)];
    }
    return { text: out };
  },
};
