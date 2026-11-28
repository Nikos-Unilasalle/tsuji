import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { NodeDefinition, NodeInstance, ParamFieldDef } from "../types";
import { createNodeCache, disposeObject3D } from "../nodeCaches";
import type { PolyMesh } from "../quadMesh";
import { polyMeshToGeometry, readPolyMesh } from "../mesh/polyIO";
import { readAttribute, setAttribute, isValidAttributeName } from "../mesh/polyAttributes";
import { meshTriangles, pointNeighbours, hash01 } from "../mesh/selectOps";
import { getTopology } from "../mesh/topology";
import { copyToPoints, type CopyPlacement } from "../mesh/copyToPoints";
import { buildSkeleton, buildTubes, expandLSystem, interpretTurtle, parseRules } from "../mesh/lsystem";
import { erodeHeightfield } from "../mesh/erosion";
import { heatGeodesic } from "../mesh/heatGeodesic";
import { edgeDistances } from "../mesh/selectOps";
import { createModifierMesh, primitiveOutputs } from "./object";
import { definePolyNode, valueSignature } from "./polyModifier";

/*
 * High-level procedural nodes (phase 9 of docs/parametric-modeling-plan.md):
 * projection, copy to points, L-systems, terrain erosion, geodesic distance.
 * The algorithms live in mesh/ (copyToPoints, lsystem, erosion, heatGeodesic);
 * these are their node faces. All but L-System take a mesh and hand back a
 * mesh (definePolyNode), keeping its pose, material and attributes.
 */

type V3 = [number, number, number];

// ============================================================ Ray / Project / Shrinkwrap

interface TargetBvh {
  bvh: MeshBVH;
  coords: Float32Array;
}
const bvhCache = new WeakMap<PolyMesh, TargetBvh | null>();

function targetBvh(mesh: PolyMesh): TargetBvh | null {
  if (bvhCache.has(mesh)) return bvhCache.get(mesh)!;
  const { coords } = meshTriangles(mesh);
  let result: TargetBvh | null = null;
  if (coords.length) {
    const flat = Float32Array.from(coords);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(flat, 3));
    // One vertex per triangle corner: index / 3 is the triangle, even after
    // the BVH reorders the index buffer.
    geometry.setIndex(Array.from({ length: flat.length / 3 }, (_, i) => i));
    result = { bvh: new MeshBVH(geometry), coords: flat };
  }
  bvhCache.set(mesh, result);
  return result;
}

function triangleNormal(t: TargetBvh, faceIndex: number): THREE.Vector3 {
  const index = t.bvh.geometry.index!;
  const tri = Math.floor(index.getX(faceIndex * 3) / 3);
  const c = t.coords;
  const o = tri * 9;
  const a = new THREE.Vector3(c[o], c[o + 1], c[o + 2]);
  const b = new THREE.Vector3(c[o + 3], c[o + 4], c[o + 5]);
  const d = new THREE.Vector3(c[o + 6], c[o + 7], c[o + 8]);
  return b.sub(a).cross(d.sub(a)).normalize();
}

export const RAY_PROJECT_MODES = ["nearest", "normal", "direction"] as const;

export const RAY_PROJECT_NODE = definePolyNode({
  type: "modeling/ray-project",
  label: "Shrinkwrap / Project",
  category: "deform",
  group: { domain: "point", label: "Point Group" },
  dependsOnPose: true,
  inputs: [
    { id: "target", label: "Target", type: "geometry" },
    { id: "direction", label: "Direction", type: "vector" },
    { id: "offset", label: "Offset", type: "value" },
    { id: "amount", label: "Amount", type: "value" },
  ],
  outputs: [{ id: "hits", label: "Hit Count", type: "value" }],
  defaultParams: { mode: "nearest", direction: new THREE.Vector3(0, -1, 0), bidirectional: true, offset: 0, maxDistance: 0, amount: 1 },
  paramFields: [
    { id: "mode", label: "Mode", kind: "select", options: [...RAY_PROJECT_MODES], optionLabels: ["Nearest surface (shrinkwrap)", "Along point normal", "Along direction"], group: "Project" },
    { id: "direction", label: "Direction (world)", kind: "vector", step: 0.1, group: "Project", showIf: { mode: ["direction"] } },
    { id: "bidirectional", label: "Both ways", kind: "boolean", group: "Project", showIf: { mode: ["normal", "direction"] } },
    { id: "offset", label: "Offset (along hit normal)", kind: "number", step: 0.005, group: "Project" },
    { id: "maxDistance", label: "Max Distance (0 = any)", kind: "number", step: 0.05, group: "Project" },
    { id: "amount", label: "Amount", kind: "number", step: 0.05, group: "Project" },
    { id: "_attrs", label: "Writes point attributes: hit (bool), hitdist (float, -1 on a miss)", kind: "note", group: "Project" },
  ],
  run(run) {
    const target = run.otherMesh("target");
    const mesh = run.mesh;
    if (!target) {
      run.note("Connect a Target geometry", true);
      return { mesh, outputs: { hits: 0 } };
    }
    const tb = targetBvh(target);
    if (!tb) {
      run.note("The target has no faces", true);
      return { mesh, outputs: { hits: 0 } };
    }
    const mode = run.str("mode", "nearest");
    const offset = run.num("offset", 0);
    const maxDist = Math.max(0, run.num("maxDistance", 0));
    const far = maxDist > 0 ? maxDist : Infinity;
    const amount = Math.max(0, Math.min(1, run.num("amount", 1)));
    const both = run.bool("bidirectional", true);
    const { indices } = run.group("point");
    // A world direction, brought into the mesh's own space.
    const dirLocal = run.vec("direction", [0, -1, 0]).transformDirection(run.worldMatrix.clone().invert());
    const normals = mode === "normal" ? readAttribute(mesh, "point", "N")!.values : null;

    const positions = mesh.positions.map((p) => [p[0], p[1], p[2]] as V3);
    const hit = new Uint8Array(positions.length);
    const hitdist = new Float64Array(positions.length).fill(-1);
    const p = new THREE.Vector3();
    const ray = new THREE.Ray();
    let hits = 0;
    for (const i of indices) {
      p.set(...positions[i]);
      let point: THREE.Vector3 | null = null;
      let normal: THREE.Vector3 | null = null;
      let dist = 0;
      if (mode === "nearest") {
        const info = tb.bvh.closestPointToPoint(p, undefined, 0, far);
        if (info && info.distance <= far) {
          point = info.point.clone();
          normal = triangleNormal(tb, info.faceIndex);
          dist = info.distance;
        }
      } else {
        const dir = mode === "normal" ? new THREE.Vector3(normals![i * 3], normals![i * 3 + 1], normals![i * 3 + 2]) : dirLocal.clone();
        if (dir.lengthSq() < 1e-12) continue;
        dir.normalize();
        const cast = (d: THREE.Vector3) => {
          ray.set(p, d);
          return tb.bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
        };
        let best = cast(dir);
        if (both) {
          const back = cast(dir.clone().negate());
          if (back && (!best || back.distance < best.distance)) best = back;
        }
        if (best) {
          point = best.point.clone();
          normal = best.faceIndex !== undefined && best.faceIndex !== null ? triangleNormal(tb, best.faceIndex) : null;
          dist = best.distance;
        }
      }
      if (!point) continue;
      if (normal && offset !== 0) point.addScaledVector(normal, offset);
      if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
      positions[i] = [p.x + (point.x - p.x) * amount, p.y + (point.y - p.y) * amount, p.z + (point.z - p.z) * amount];
      hit[i] = 1;
      hitdist[i] = dist;
      hits++;
    }
    run.note(`${hits} / ${indices.length} points hit`);
    let out: PolyMesh = { ...mesh, positions };
    out = setAttribute(out, "point", "hit", "bool", hit);
    out = setAttribute(out, "point", "hitdist", "float", hitdist);
    return { mesh: out, outputs: { hits } };
  },
});

// ============================================================ Copy to Points

const MAX_COPY_FACES = 2_000_000;

function orthoBasis(primary: THREE.Vector3, hint: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const a = primary.clone().normalize();
  let b = hint.clone().addScaledVector(a, -hint.dot(a));
  if (b.lengthSq() < 1e-10) {
    const alt = Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    b = alt.addScaledVector(a, -alt.dot(a));
  }
  return [a, b.normalize()];
}

export const COPY_TO_POINTS_NODE = definePolyNode({
  type: "modeling/copy-to-points",
  label: "Copy to Points",
  category: "instance",
  group: { domain: "point", label: "Target Points" },
  inputs: [
    { id: "source", label: "Source", type: "geometry" },
    { id: "sources", label: "Variants (Geometry List)", type: "list" },
  ],
  outputs: [{ id: "copies", label: "Copy Count", type: "value" }],
  defaultParams: {
    orient: "normal",
    alignAxis: "y",
    upHint: new THREE.Vector3(0, 0, 1),
    scale: 1,
    usePscale: true,
    variantMode: "attribute",
    seed: 0,
    copyAttributes: false,
  },
  paramFields: [
    { id: "orient", label: "Orient", kind: "select", options: ["normal", "none"], optionLabels: ["By N (or orient / up attributes)", "None (keep source axes)"], group: "Copies" },
    { id: "alignAxis", label: "Axis aligned to N", kind: "select", options: ["y", "z"], optionLabels: ["+Y", "+Z (Houdini)"], group: "Copies", showIf: { orient: ["normal"] } },
    { id: "upHint", label: "Up Hint (no up attribute)", kind: "vector", step: 0.1, group: "Copies", showIf: { orient: ["normal"] } },
    { id: "scale", label: "Scale", kind: "number", step: 0.05, group: "Copies" },
    { id: "usePscale", label: "Scale by pscale / scale attributes", kind: "boolean", group: "Copies" },
    { id: "variantMode", label: "Variant", kind: "select", options: ["attribute", "random", "cycle"], optionLabels: ["variant attribute (int)", "Random", "Cycle by point"], group: "Variants" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Variants" },
    { id: "copyAttributes", label: "Copy target point attributes", kind: "boolean", group: "Attributes" },
    { id: "_attrs", label: "Reads N, orient (vec3 direction), up, pscale, scale, variant. Writes copy (int, point + face).", kind: "note", group: "Attributes" },
  ],
  run(run) {
    const target = run.mesh;
    const variants: PolyMesh[] = [];
    const add = (v: unknown) => {
      if (!(v instanceof THREE.Object3D)) return;
      const read = readPolyMesh(v);
      // Copies are placed in the source's own space (its pose is ignored), like Houdini.
      if (read && read.mesh.positions.length) variants.push(read.mesh);
    };
    add(run.inputs.source);
    if (Array.isArray(run.inputs.sources)) run.inputs.sources.forEach(add);
    if (!variants.length) {
      run.note("Connect a Source geometry (or a list of variants)", true);
      return { mesh: target, outputs: { copies: 0 } };
    }
    const { indices } = run.group("point");
    const orient = run.str("orient", "normal") === "normal";
    const alignZ = run.str("alignAxis", "y") === "z";
    const upHint = run.vec("upHint", [0, 0, 1]);
    const baseScale = run.num("scale", 1);
    const usePscale = run.bool("usePscale", true);
    const mode = run.str("variantMode", "attribute");
    const seed = run.num("seed", 0);
    const N = readAttribute(target, "point", "N")!.values;
    const stored = (name: string) => (target.attributes?.point?.[name] ? readAttribute(target, "point", name) : null);
    const orientAttr = stored("orient");
    const upAttr = stored("up");
    const pscale = usePscale ? stored("pscale") : null;
    const scaleAttr = usePscale ? stored("scale") : null;
    const variantAttr = stored("variant");
    if (mode === "attribute" && variants.length > 1 && !variantAttr) run.note("No variant attribute: every copy uses the first source");
    if (orientAttr && orientAttr.size !== 3) run.note("orient must be a vec3 direction: ignored", true);

    const placements: CopyPlacement[] = [];
    let faces = 0;
    const m = new THREE.Matrix4();
    for (const i of indices) {
      const vCount = variants.length;
      let variant = 0;
      if (vCount > 1) {
        if (mode === "random") variant = Math.floor(hash01(i, seed) * vCount);
        else if (mode === "cycle") variant = i % vCount;
        else if (variantAttr) variant = Math.round(variantAttr.values[i * variantAttr.size]) || 0;
        variant = ((variant % vCount) + vCount) % vCount;
      }
      const vf = variants[variant].faces.length;
      if (faces + vf > MAX_COPY_FACES) {
        run.note(`Stopped at ${placements.length} copies (${MAX_COPY_FACES.toLocaleString()} faces)`, true);
        break;
      }
      faces += vf;
      const p = target.positions[i];
      const s = new THREE.Vector3(baseScale, baseScale, baseScale);
      if (pscale) s.multiplyScalar(Number.isFinite(pscale.values[i]) ? pscale.values[i] : 1);
      if (scaleAttr && scaleAttr.size === 3) s.multiply(new THREE.Vector3(scaleAttr.values[i * 3], scaleAttr.values[i * 3 + 1], scaleAttr.values[i * 3 + 2]));
      const basis = new THREE.Matrix4();
      if (orient) {
        const dir =
          orientAttr && orientAttr.size === 3
            ? new THREE.Vector3(orientAttr.values[i * 3], orientAttr.values[i * 3 + 1], orientAttr.values[i * 3 + 2])
            : new THREE.Vector3(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
        const hint = upAttr && upAttr.size === 3 ? new THREE.Vector3(upAttr.values[i * 3], upAttr.values[i * 3 + 1], upAttr.values[i * 3 + 2]) : upHint.clone();
        if (dir.lengthSq() > 1e-12) {
          // Y (or Z) along the direction, the other one toward the hint; X completes a right-handed frame.
          const [a, b] = orthoBasis(dir, hint);
          if (alignZ) {
            const x = new THREE.Vector3().crossVectors(b, a);
            basis.makeBasis(x, b, a);
          } else {
            const x = new THREE.Vector3().crossVectors(a, b);
            basis.makeBasis(x, a, b);
          }
        }
      }
      m.makeScale(s.x, s.y, s.z).premultiply(basis).setPosition(p[0], p[1], p[2]);
      placements.push({ point: i, variant, matrix: Array.from(m.elements) });
    }
    const out = copyToPoints(variants, target, placements, { copyTargetAttributes: run.bool("copyAttributes", false) });
    run.note(`${placements.length} copies, ${out.faces.length} faces`);
    return { mesh: out, outputs: { copies: placements.length } };
  },
});

// ============================================================ L-System

const MAX_SEGMENTS = 200_000;
const MAX_TUBE_VERTICES = 2_000_000;

interface LState {
  tube?: THREE.Mesh;
  skeleton?: THREE.Mesh;
  signature?: string;
  outputs?: Record<string, unknown>;
  notes?: { text: string; warn: boolean }[];
}
const lStates = createNodeCache<LState>((s) => {
  if (s.tube) disposeObject3D(s.tube);
  if (s.skeleton) disposeObject3D(s.skeleton);
});
const lMaterial = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.8 });

const L_FIELDS: ParamFieldDef[] = [
  { id: "axiom", label: "Axiom", kind: "text", group: "Grammar" },
  { id: "rules", label: "Rules (one per line, F=...)", kind: "text", group: "Grammar" },
  { id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Grammar" },
  {
    id: "preset",
    label: "Preset",
    kind: "select",
    options: ["custom", "plant", "bush", "koch", "tree3d"],
    group: "Grammar",
    presets: {
      plant: { axiom: "X", rules: "X=F+[[X]-X]-F[-FX]+X\nF=FF", angle: 25, iterations: 4, stepScale: 1 },
      bush: { axiom: "F", rules: "F=FF+[+F-F-F]-[-F+F+F]", angle: 22.5, iterations: 3, stepScale: 1 },
      koch: { axiom: "F", rules: "F=F+F-F-F+F", angle: 90, iterations: 3, stepScale: 1 },
      tree3d: { axiom: "A", rules: "A=F[&+A][&-A][&\\A][&/A]\nF=F", angle: 30, iterations: 5, stepScale: 0.75 },
    },
  },
  { id: "_alphabet", label: "F G draw · f g move · + − yaw · & ^ pitch · \\ / roll · | turn back · [ ] branch · ! thinner", kind: "note", group: "Grammar" },
  { id: "angle", label: "Angle (°)", kind: "number", step: 0.5, group: "Turtle" },
  { id: "step", label: "Step Length", kind: "number", step: 0.01, group: "Turtle" },
  { id: "stepScale", label: "Step Scale per Branch", kind: "number", step: 0.05, group: "Turtle" },
  { id: "jitter", label: "Random Angle (±°)", kind: "number", step: 0.5, group: "Turtle" },
  { id: "seed", label: "Seed", kind: "number", step: 1, group: "Turtle" },
  { id: "radius", label: "Tube Radius", kind: "number", step: 0.005, group: "Tube" },
  { id: "widthScale", label: "Radius Scale per Branch", kind: "number", step: 0.05, group: "Tube" },
  { id: "sides", label: "Tube Sides", kind: "number", step: 1, group: "Tube" },
  { id: "caps", label: "Cap Ends", kind: "boolean", group: "Tube" },
];

const L_DEFAULTS = {
  preset: "bush",
  axiom: "F",
  rules: "F=FF+[+F-F-F]-[-F+F+F]",
  iterations: 3,
  angle: 22.5,
  step: 0.1,
  stepScale: 1,
  jitter: 0,
  seed: 0,
  radius: 0.01,
  widthScale: 0.8,
  sides: 6,
  caps: true,
};

export const LSYSTEM_NODE: NodeDefinition = {
  type: "modeling/l-system",
  label: "L-System",
  category: "generators",
  inputs: [
    { id: "iterations", label: "Iterations", type: "value" },
    { id: "angle", label: "Angle (°)", type: "value" },
    { id: "jitter", label: "Random Angle (±°)", type: "value" },
    { id: "seed", label: "Seed", type: "value" },
  ],
  outputs: [
    { id: "geometry", label: "Tubes", type: "geometry" },
    { id: "skeleton", label: "Skeleton (edges)", type: "geometry" },
    { id: "matrix", label: "Matrix", type: "matrix" },
    { id: "segments", label: "Segments", type: "value" },
    { id: "string", label: "String", type: "text" },
  ],
  defaultParams: L_DEFAULTS,
  paramFields: L_FIELDS,
  dynamicParamFields: (instance: NodeInstance) => [
    ...L_FIELDS,
    ...(lStates.get(instance.id)?.notes ?? []).map((n, i) => ({
      id: `_status${i}`,
      label: (n.warn ? "⚠ " : "") + n.text,
      kind: "note" as const,
      ...(n.warn ? { tone: "warn" as const } : {}),
      group: "Status",
    })),
  ],
  evaluate: (inputs, params, ctx) => {
    const get = (id: string) => (inputs[id] !== undefined ? inputs[id] : params[id] !== undefined ? params[id] : (L_DEFAULTS as Record<string, unknown>)[id]);
    const num = (id: string, fb: number) => {
      const n = Number(get(id));
      return Number.isFinite(n) ? n : fb;
    };
    let state = lStates.get(ctx.nodeId);
    if (!state) lStates.set(ctx.nodeId, (state = {}));
    const keys = ["axiom", "rules", "iterations", "angle", "step", "stepScale", "jitter", "seed", "radius", "widthScale", "sides", "caps"];
    const signature = keys.map((k) => `${k}=${valueSignature(get(k))}`).join("|");
    const emit = () => {
      for (const obj of [state!.tube!, state!.skeleton!]) {
        obj.matrixAutoUpdate = false;
        obj.matrix.identity();
        obj.userData = { ...obj.userData, nodeId: ctx.nodeId };
      }
      return { ...primitiveOutputs(state!.tube!), skeleton: state!.skeleton, ...state!.outputs };
    };
    if (state.tube && state.skeleton && state.signature === signature) return emit();

    const notes: { text: string; warn: boolean }[] = [];
    const { rules, errors } = parseRules(String(get("rules") ?? ""));
    errors.forEach((e) => notes.push({ text: `Rules: ${e}`, warn: true }));
    const iterations = Math.max(0, Math.min(12, Math.round(num("iterations", 3))));
    const expansion = expandLSystem(String(get("axiom") ?? ""), rules, iterations, MAX_SEGMENTS * 20);
    if (expansion.truncated) notes.push({ text: `String too long: stopped after ${expansion.iterations} iterations`, warn: true });
    const sides = Math.max(3, Math.min(32, Math.round(num("sides", 6))));
    const maxSegments = Math.min(MAX_SEGMENTS, Math.floor(MAX_TUBE_VERTICES / (2 * sides)));
    const turtle = interpretTurtle(expansion, {
      angle: num("angle", 22.5),
      step: num("step", 0.1),
      stepScale: num("stepScale", 1),
      widthScale: num("widthScale", 0.8),
      jitter: num("jitter", 0),
      seed: num("seed", 0),
      maxSegments,
    });
    if (turtle.truncated) notes.push({ text: `Capped at ${maxSegments.toLocaleString()} segments`, warn: true });
    const caps = Boolean(get("caps"));
    const tubes = buildTubes(turtle, { radius: num("radius", 0.01), sides, caps });
    const skeleton = buildSkeleton(turtle);
    notes.push({ text: `${expansion.symbols.length} symbols, ${turtle.segments} segments, ${tubes.faces.length} faces`, warn: false });

    if (!state.tube) state.tube = createModifierMesh();
    if (!state.skeleton) state.skeleton = createModifierMesh();
    for (const [obj, mesh] of [[state.tube, tubes], [state.skeleton, skeleton]] as const) {
      obj.geometry?.dispose();
      obj.geometry = polyMeshToGeometry(mesh);
      obj.material = lMaterial;
    }
    state.signature = signature;
    state.notes = notes;
    const preview = expansion.symbols.length > 10_000 ? expansion.symbols.slice(0, 10_000) + "…" : expansion.symbols;
    state.outputs = { segments: turtle.segments, string: preview };
    return emit();
  },
};

// ============================================================ HeightField Erode

export const HEIGHTFIELD_ERODE_NODE = definePolyNode({
  type: "modeling/heightfield-erode",
  label: "Erode Terrain",
  category: "generators",
  group: { domain: "point", label: "Erodible Points" },
  inputs: [{ id: "seed", label: "Seed", type: "value" }],
  outputs: [{ id: "steps", label: "Droplet Steps", type: "value" }],
  defaultParams: {
    up: "y",
    iterations: 10,
    droplets: 500,
    rain: 1,
    erosion: 0.3,
    deposition: 0.3,
    capacity: 4,
    evaporation: 0.02,
    maxSteps: 60,
    thermal: 1,
    talus: 35,
    thermalRate: 0.5,
    seed: 0,
    fixBorder: true,
  },
  paramFields: [
    { id: "up", label: "Up Axis", kind: "select", options: ["y", "z", "x"], group: "Heightfield" },
    { id: "fixBorder", label: "Keep Border Fixed", kind: "boolean", group: "Heightfield" },
    { id: "iterations", label: "Iterations", kind: "number", step: 1, group: "Hydraulic" },
    { id: "droplets", label: "Droplets / Iteration", kind: "number", step: 50, group: "Hydraulic" },
    { id: "rain", label: "Rain (water / droplet)", kind: "number", step: 0.1, group: "Hydraulic" },
    { id: "erosion", label: "Erosion Rate", kind: "number", step: 0.05, group: "Hydraulic" },
    { id: "deposition", label: "Deposition Rate", kind: "number", step: 0.05, group: "Hydraulic" },
    { id: "capacity", label: "Sediment Capacity", kind: "number", step: 0.5, group: "Hydraulic" },
    { id: "evaporation", label: "Evaporation", kind: "number", step: 0.01, group: "Hydraulic" },
    { id: "maxSteps", label: "Max Droplet Steps", kind: "number", step: 5, group: "Hydraulic" },
    { id: "seed", label: "Seed", kind: "number", step: 1, group: "Hydraulic" },
    { id: "thermal", label: "Thermal Passes / Iteration", kind: "number", step: 1, group: "Thermal" },
    { id: "talus", label: "Talus Angle (°)", kind: "number", step: 1, group: "Thermal" },
    { id: "thermalRate", label: "Thermal Rate", kind: "number", step: 0.05, group: "Thermal" },
    { id: "_attrs", label: "Writes point attributes: flow (water passed), sediment (height change, + deposited / − eroded)", kind: "note", group: "Thermal" },
  ],
  run(run) {
    const mesh = run.mesh;
    const axis = run.str("up", "y");
    const up: V3 = axis === "x" ? [1, 0, 0] : axis === "z" ? [0, 0, 1] : [0, 1, 0];
    const n = mesh.positions.length;
    const { mask } = run.group("point");
    const frozen = new Uint8Array(n);
    for (let i = 0; i < n; i++) frozen[i] = mask[i] ? 0 : 1;
    const border = new Uint8Array(n);
    const topo = getTopology(mesh);
    for (const [a, b] of topo.edges) {
      if (topo.edgeFaces(a, b).length < 2) border[a] = border[b] = 1;
    }
    if (run.bool("fixBorder", true)) for (let i = 0; i < n; i++) if (border[i]) frozen[i] = 1;
    const res = erodeHeightfield(mesh.positions, pointNeighbours(mesh), {
      up,
      iterations: run.num("iterations", 10),
      droplets: run.num("droplets", 500),
      rain: run.num("rain", 1),
      erosion: run.num("erosion", 0.3),
      deposition: run.num("deposition", 0.3),
      capacity: run.num("capacity", 4),
      evaporation: run.num("evaporation", 0.02),
      maxSteps: run.num("maxSteps", 60),
      thermal: run.num("thermal", 1),
      talus: run.num("talus", 35),
      thermalRate: run.num("thermalRate", 0.5),
      seed: run.num("seed", 0),
      frozen,
      border,
    });
    if (res.limited) run.note("Droplet budget capped (4M steps): fewer droplets per iteration", true);
    let out: PolyMesh = { ...mesh, positions: res.positions };
    out = setAttribute(out, "point", "flow", "float", res.flow);
    out = setAttribute(out, "point", "sediment", "float", res.sediment);
    return { mesh: out, outputs: { steps: res.steps } };
  },
});

// ============================================================ Geodesic Distance

export const GEODESIC_DISTANCE_NODE = definePolyNode({
  type: "modeling/geodesic-distance",
  label: "Surface Distance (Geodesic)",
  category: "attribute",
  group: { domain: "point", label: "Source Points" },
  outputs: [{ id: "maxDistance", label: "Max Distance", type: "value" }],
  defaultParams: { group: "0", name: "geodesic", method: "heat", timeScale: 1, normalize: false },
  paramFields: [
    { id: "name", label: "Attribute Name", kind: "text", group: "Distance" },
    { id: "method", label: "Method", kind: "select", options: ["heat", "edges"], optionLabels: ["Heat method (smooth, true surface distance)", "Edge paths (Dijkstra)"], group: "Distance" },
    { id: "timeScale", label: "Heat Time Scale", kind: "number", step: 0.1, group: "Distance" },
    { id: "normalize", label: "Normalize to 0–1", kind: "boolean", group: "Distance" },
    { id: "_unreach", label: "Points no source can reach (other islands) get -1", kind: "note", group: "Distance" },
  ],
  run(run) {
    const mesh = run.mesh;
    const name = run.str("name", "geodesic").trim() || "geodesic";
    if (!isValidAttributeName(name)) {
      run.note(`"${name}" is not a valid attribute name`, true);
      return { mesh, outputs: { maxDistance: 0 } };
    }
    const expr = String(run.params.group ?? "0");
    const { indices } = run.group("point");
    if (!expr.trim() || expr.trim() === "*") run.note("Every point is a source: distances are all 0", true);
    if (!indices.length) {
      run.note("No source points", true);
      return { mesh: setAttribute(mesh, "point", name, "float", new Float64Array(mesh.positions.length).fill(-1)), outputs: { maxDistance: 0 } };
    }
    let distance: Float64Array;
    if (run.str("method", "heat") === "edges") {
      distance = edgeDistances(mesh, indices).dist.map((d) => (Number.isFinite(d) ? d : -1));
    } else {
      const res = heatGeodesic(mesh, indices, { timeScale: run.num("timeScale", 1) });
      if (res.method !== "heat") run.note(`Heat method failed (${res.reason}): edge distances used`, true);
      distance = res.distance;
    }
    let max = 0;
    for (const d of distance) if (d > max) max = d;
    if (run.bool("normalize", false) && max > 0) distance = distance.map((d) => (d < 0 ? -1 : d / max));
    return { mesh: setAttribute(mesh, "point", name, "float", distance), outputs: { maxDistance: max } };
  },
});

export const PROCEDURAL_NODES: NodeDefinition[] = [RAY_PROJECT_NODE, COPY_TO_POINTS_NODE, LSYSTEM_NODE, HEIGHTFIELD_ERODE_NODE, GEODESIC_DISTANCE_NODE];
