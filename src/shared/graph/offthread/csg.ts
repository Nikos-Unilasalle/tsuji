import * as THREE from "three";
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from "three-bvh-csg";

/**
 * Boolean's CSG (three-bvh-csg) as a job. Each side arrives as the flat
 * arrays of its baked world-space geometry (bakeMeshesToGeometry — already a
 * copy, so nothing upstream owns them), the result goes back as flat arrays
 * plus groups.
 *
 * Materials cannot cross to a worker, but the CSG only ever compares them by
 * identity (which group keeps which slot, which slots merge). So the node
 * numbers its distinct materials, each side says which number every one of
 * its groups uses, the kernel stands in one placeholder per number, and the
 * result says which number each of its material slots is.
 */
export interface AttributeData {
  array: Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
  itemSize: number;
  normalized: boolean;
}

export interface GroupData {
  start: number;
  count: number;
  materialIndex: number;
}

export interface CsgSide {
  attributes: Record<string, AttributeData>;
  index: Uint16Array | Uint32Array | null;
  groups: GroupData[];
  /** Index into the node's material table for each of this side's materials (one per baked mesh). */
  materials: number[];
}

export interface BooleanJob {
  /** null: the side's parts could not be merged into one geometry. */
  a: CsgSide | null;
  b: CsgSide | null;
  operation: string;
  useGroups: boolean;
  /** How many distinct materials both sides' `materials` index into. */
  materialCount: number;
}

export interface BooleanResult {
  /** Set instead of a geometry when there is nothing to show; the node then passes its first input through. */
  error: "merge" | string | null;
  attributes: Record<string, AttributeData>;
  index: Uint32Array | null;
  groups: GroupData[];
  drawCount: number;
  /** Material-table index of each of the result's material slots (meaningful with useGroups). */
  materials: number[];
}

const OPERATIONS: Record<string, number> = { add: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };

/** Kept attributes and topology of a geometry, as plain data. The arrays are the geometry's own, not copies. */
export function geometryData(geometry: THREE.BufferGeometry): Pick<CsgSide, "attributes" | "index" | "groups"> {
  const attributes: Record<string, AttributeData> = {};
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const a = attr as THREE.BufferAttribute;
    let array = a.array as AttributeData["array"];
    // Interleaved, or a view into a larger buffer: compact copy, so transferring it moves only this.
    if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute || array.length !== a.count * a.itemSize) {
      const Ctor = array.constructor as new (n: number) => AttributeData["array"];
      const compact = new Ctor(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) compact[i * a.itemSize + k] = a.getComponent(i, k);
      array = compact;
    }
    attributes[name] = { array, itemSize: a.itemSize, normalized: a.normalized };
  }
  return {
    attributes,
    index: (geometry.index?.array as Uint16Array | Uint32Array | undefined) ?? null,
    groups: geometry.groups.map(({ start, count, materialIndex }) => ({ start, count, materialIndex: materialIndex ?? 0 })),
  };
}

/** The geometry `data` describes; takes ownership of its arrays. */
export function geometryFromData(data: Pick<CsgSide, "attributes" | "index" | "groups">, drawCount?: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(data.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  }
  if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  for (const g of data.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  if (drawCount !== undefined) geometry.setDrawRange(0, drawCount);
  return geometry;
}

/** three-bvh-csg stores its MeshBVH on `geometry.n` — null it before disposing. */
function disposeBrushGeometry(g: THREE.BufferGeometry): void {
  (g as { n?: unknown }).n = null;
  g.dispose();
}

function failed(error: string): BooleanResult {
  return { error, attributes: {}, index: null, groups: [], drawCount: 0, materials: [] };
}

export function evaluateBoolean(job: BooleanJob): BooleanResult {
  if (!job.a || !job.b) return failed("merge");
  const placeholders = Array.from({ length: job.materialCount }, () => new THREE.Material());
  const brush = (side: CsgSide) => {
    const materials = side.materials.map((i) => placeholders[i]);
    return new Brush(geometryFromData(side), materials.length > 1 ? materials : materials[0]);
  };
  const brushA = brush(job.a);
  const brushB = brush(job.b);
  try {
    const evaluator = new Evaluator();
    evaluator.useGroups = job.useGroups;
    const result = evaluator.evaluate(brushA, brushB, OPERATIONS[job.operation] ?? SUBTRACTION);
    const out = geometryData(result.geometry);
    disposeBrushGeometry(result.geometry);
    const resultMaterials = Array.isArray(result.material) ? result.material : [result.material];
    return {
      error: null,
      attributes: out.attributes,
      index: out.index as Uint32Array | null,
      groups: out.groups,
      drawCount: result.geometry.drawRange.count,
      materials: resultMaterials.map((m) => placeholders.indexOf(m as THREE.Material)),
    };
  } catch (err) {
    return failed(String(err));
  } finally {
    disposeBrushGeometry(brushA.geometry);
    disposeBrushGeometry(brushB.geometry);
  }
}
