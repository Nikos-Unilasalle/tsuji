import { MapMesh } from "./mesh";
import { RiverData } from "./rivers";

/**
 * What flows down the wire between Map nodes. Each stage returns a *new*
 * MapData that carries everything before it plus its own field, so one wire is
 * enough, a stage can be swapped for another, and branching never disturbs
 * the original. `rev` identifies a result: a downstream node compares it to
 * know whether its input actually changed.
 */
export interface MapData {
  rev: number;
  mesh: MapMesh;
  /** Per point, [-1, 1]; 0 is the shoreline. */
  elevation?: Float32Array;
  /** Per point, [0, 1]; ocean points are 1. */
  moisture?: Float32Array;
  rivers?: RiverData;
  /** Per point, an index into BIOMES. */
  biomes?: Uint8Array;
}

let nextRev = 1;

export function createMapData(mesh: MapMesh, fields: Omit<MapData, "rev" | "mesh"> = {}): MapData {
  return { rev: nextRev++, mesh, ...fields };
}

export function extendMapData(base: MapData, fields: Omit<MapData, "rev" | "mesh">): MapData {
  return { ...base, ...fields, rev: nextRev++ };
}

export function isMapData(v: unknown): v is MapData {
  return !!v && typeof v === "object" && "mesh" in v && "rev" in v && typeof (v as MapData).rev === "number";
}
