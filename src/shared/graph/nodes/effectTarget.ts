import type { NodeDefinition, ParamFieldDef } from "../types";

/*
 * One node per film/stylise look, applied either to the whole render (a
 * post-process pass in the effect chain) or to one object (its material
 * swapped for the stylised shader). They used to be two nodes each with the
 * same name — "Dual Tone" in Post-Process and "Dual Tone" in Transform —
 * which the palette and the search could not tell apart.
 *
 * The merged node keeps the post-process type id (so existing files load
 * unchanged) and switches its sockets, fields and evaluation on `applyTo`.
 * The object-only types (`modifier/duotone`…) stay registered but hidden:
 * files that use them still load and play.
 */

export const APPLY_TO_SCREEN = "screen";
export const APPLY_TO_OBJECT = "object";

const APPLY_TO_FIELD: ParamFieldDef = {
  id: "applyTo",
  label: "Apply To",
  kind: "select",
  options: [APPLY_TO_SCREEN, APPLY_TO_OBJECT],
  optionLabels: ["Screen (post-process)", "Object (material)"],
};

const onObject = (params: Record<string, unknown> | undefined) => params?.applyTo === APPLY_TO_OBJECT;

export function screenOrObjectEffect(screen: NodeDefinition, object: NodeDefinition): NodeDefinition {
  const screenFields = screen.paramFields ?? [];
  const objectFields = object.paramFields ?? [];
  return {
    ...screen,
    defaultParams: { ...object.defaultParams, ...screen.defaultParams, applyTo: APPLY_TO_SCREEN },
    paramFields: [APPLY_TO_FIELD, ...screenFields],
    dynamicParamFields: (instance) => [APPLY_TO_FIELD, ...(onObject(instance.params) ? objectFields : screenFields)],
    dynamicInputs: (connections, types, params) =>
      onObject(params)
        ? object.dynamicInputs?.(connections, types, params) ?? object.inputs
        : screen.dynamicInputs?.(connections, types, params) ?? screen.inputs,
    dynamicOutputs: (connections, types, params) =>
      onObject(params)
        ? object.dynamicOutputs?.(connections, types, params) ?? object.outputs
        : screen.dynamicOutputs?.(connections, types, params) ?? screen.outputs,
    evaluate: (inputs, params, ctx) =>
      onObject(params)
        ? object.evaluate(inputs, { ...object.defaultParams, ...params }, ctx)
        : screen.evaluate(inputs, params, ctx),
  };
}

/** The object-only original: still loads from old files, no longer offered in the palette or the search. */
export function legacyObjectEffect(object: NodeDefinition): NodeDefinition {
  return { ...object, hidden: true };
}
