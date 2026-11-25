import Papa from "papaparse";
import { getCsv, setCsv } from "../csvStore";
import { NodeDefinition } from "../types";

/**
 * Static/tabular data for dataviz — load a CSV, pick a column. Two
 * outputs: the whole column as a List (feed it anywhere a full series is
 * useful), and a single Value at the current Row (wire Time or a counter
 * into Row to scrub through the dataset live, pairs directly into Map
 * Range — no separate "index into a list" node needed).
 */
export const CSV_READER_NODE: NodeDefinition = {
  type: "io/csv-reader",
  label: "CSV Reader",
  category: "dataviz",
  ownershipPassThrough: true,
  inputs: [{ id: "row", label: "Row", type: "value" }],

  outputs: [
    { id: "column", label: "Column", type: "list" },
    { id: "rowValues", label: "Row Values", type: "list" },
    { id: "value", label: "Value", type: "value" },
  ],
  defaultParams: { filePath: "", column: "", row: 0 },
  // The file field triggers the load (see ParamPanel's file-picker
  // handler); the column dropdown's options only exist once that load has
  // populated csvStore for this instance — hence dynamic, not static.
  dynamicParamFields: (instance) => {
    const csv = getCsv(instance.id);
    const headers = csv?.headers ?? [];
    return [
      {
        id: "filePath",
        label: "CSV File",
        kind: "file",
        accept: [".csv"],
        onLoaded: (nodeId, _path, content) => {
          const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
          setCsv(nodeId, { headers: parsed.meta.fields ?? [], rows: parsed.data });
        },
      },
      { id: "column", label: "Column", kind: "select", options: headers.length ? headers : ["(load a file)"] },
    ];
  },
  evaluate: (inputs, params, ctx) => {
    const csv = getCsv(ctx.nodeId);
    if (!csv || csv.headers.length === 0 || csv.rows.length === 0) {
      return { column: [], rowValues: [], value: 0 };
    }

    const column = String(params.column || csv.headers[0]);
    const values = csv.rows.map((row) => row[column] ?? "");

    const rawRowInput = inputs.row !== undefined ? inputs.row : params.row;
    const rowIndex = Math.min(csv.rows.length - 1, Math.max(0, Math.floor(Number(rawRowInput) || 0)));

    const selectedRowObj = csv.rows[rowIndex] ?? {};
    const rowValues = csv.headers.map((h) => {
      const rawVal = selectedRowObj[h];
      const num = Number(rawVal);
      return !isNaN(num) && rawVal !== "" ? num : rawVal ?? "";
    });

    // Keep `value` consistent with `rowValues`: a non-numeric cell returns its
    // raw string (not 0), so a column that isn't actually numeric doesn't
    // silently read as a 0 for driven behaviour.
    const rawCell = values[rowIndex];
    const parsedCell = Number(rawCell);
    const value = values.length > 0 ? (!isNaN(parsedCell) && rawCell !== "" ? parsedCell : (rawCell ?? 0)) : 0;

    return { column: values, rowValues, value };
  },
};

