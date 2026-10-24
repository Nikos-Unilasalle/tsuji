import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/**
 * How a Rig node draws its skeleton: each bone an arrow from parent joint to
 * child (shaft, then a head pointing down the chain), a ball per joint, an
 * optional body sphere — plus, as viewport helpers hidden in the output, the
 * IK controls: a ball per target, a diamond per pole linked to the joint it
 * bends, and the step circles of a walk.
 *
 * Built once per node and updated in place every frame: the instance counts
 * only change when the skeleton's topology does.
 */

export interface SkeletonViewInput {
  positions: THREE.Vector3[];
  /** Bones as [parent, child] joint indices. */
  bones: [number, number][];
  thickness: number;
  color: THREE.ColorRepresentation;
  /** Radius of the joint balls; 0 for none. */
  jointRadius: number;
  body?: { center: THREE.Vector3; radius: number } | null;
  targets?: THREE.Vector3[];
  poles?: { at: THREE.Vector3; joint: THREE.Vector3 }[];
  markerSize?: number;
  circles?: { center: THREE.Vector3; radius: number }[];
  /**
   * Coloured polylines drawn only while the node is selected (the viewport
   * shows `guides` then): a walk's foot arc, pelvis path, hand arc.
   */
  paths?: { points: THREE.Vector3[]; color: THREE.ColorRepresentation; closed?: boolean }[];
  /** Coloured balls marking draggable handles, shown with the guides. */
  knobs?: { at: THREE.Vector3; color: THREE.ColorRepresentation }[];
  knobRadius?: number;
}

export interface SkeletonView {
  group: THREE.Group;
  /** Hidden every update; a viewport showing this node's handles makes it visible (see `userData.selectionGuides`). */
  guides: THREE.Group;
  update(input: SkeletonViewInput): void;
  dispose(): void;
}

const TARGET_COLOR = 0x22c55e;
const POLE_COLOR = 0xfacc15;
const CIRCLE_COLOR = 0x94a3b8;
const CIRCLE_SEGMENTS = 40;
const UP = new THREE.Vector3(0, 1, 0);

/** Unit bone along +Y, 0 → 1, radius 1: a shaft and a head toward the child. */
function boneGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.8, 1, 0.82, 10, 1);
  shaft.translate(0, 0.41, 0);
  const head = new THREE.ConeGeometry(1.7, 0.18, 10, 1);
  head.translate(0, 0.91, 0);
  const merged = mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed()]);
  shaft.dispose();
  head.dispose();
  merged.computeVertexNormals();
  return merged;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, nodeId: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.userData.nodeId = nodeId;
  return mesh;
}

export function createSkeletonView(nodeId: string): SkeletonView {
  const group = new THREE.Group();
  group.userData.nodeId = nodeId;

  const boneMaterial = new THREE.MeshStandardMaterial({ color: 0x9a5b2e, roughness: 0.6 });
  const boneGeo = boneGeometry();
  const ballGeo = new THREE.SphereGeometry(1, 16, 12);
  const poleGeo = new THREE.OctahedronGeometry(1);
  const targetMaterial = new THREE.MeshStandardMaterial({ color: TARGET_COLOR, roughness: 0.4 });
  const poleMaterial = new THREE.MeshStandardMaterial({ color: POLE_COLOR, roughness: 0.4 });
  const linkMaterial = new THREE.LineBasicMaterial({ color: POLE_COLOR, transparent: true, opacity: 0.6 });
  const circleMaterial = new THREE.LineBasicMaterial({ color: CIRCLE_COLOR, transparent: true, opacity: 0.8 });

  let bones = instanced(boneGeo, boneMaterial, 1, nodeId);
  let joints = instanced(ballGeo, boneMaterial, 1, nodeId);
  let targets = instanced(ballGeo, targetMaterial, 1, nodeId);
  let poles = instanced(poleGeo, poleMaterial, 1, nodeId);
  const body = new THREE.Mesh(ballGeo, boneMaterial);
  body.userData.nodeId = nodeId;
  const links = new THREE.LineSegments(new THREE.BufferGeometry(), linkMaterial);
  const circles = new THREE.LineSegments(new THREE.BufferGeometry(), circleMaterial);
  // Fat lines: a 1 px guide is lost against a checker floor.
  const pathMaterial = new LineMaterial({ vertexColors: true, linewidth: 3, transparent: true, opacity: 0.95, depthTest: false });
  const paths = new LineSegments2(new LineSegmentsGeometry(), pathMaterial);
  paths.renderOrder = 997;
  paths.frustumCulled = false;
  const viewSize = new THREE.Vector2();
  paths.onBeforeRender = (renderer) => {
    renderer.getSize(viewSize);
    pathMaterial.resolution.copy(viewSize);
  };
  const knobMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  let knobs = instanced(ballGeo, knobMaterial, 8, nodeId);
  knobs.renderOrder = 999;
  knobs.userData.isHelper = true;
  const guides = new THREE.Group();
  guides.add(paths, knobs);
  guides.visible = false;
  paths.userData.isHelper = true;
  paths.userData.nodeId = nodeId;
  group.add(guides);
  group.userData.selectionGuides = guides;
  for (const helper of [targets, poles, links, circles]) helper.userData.isHelper = true;
  for (const obj of [bones, joints, body, targets, poles, links, circles]) {
    obj.castShadow = obj === bones || obj === joints || obj === body;
    obj.userData.nodeId = nodeId;
    group.add(obj);
  }

  /** Swaps in a bigger InstancedMesh when `count` outgrows the current one. */
  function ensure(mesh: THREE.InstancedMesh, count: number): THREE.InstancedMesh {
    if (count <= mesh.instanceMatrix.count) return mesh;
    const next = instanced(mesh.geometry, mesh.material as THREE.Material, count, nodeId);
    next.castShadow = mesh.castShadow;
    next.userData = { ...mesh.userData };
    group.add(next);
    group.remove(mesh);
    mesh.dispose();
    return next;
  }

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function setBalls(mesh: THREE.InstancedMesh, points: THREE.Vector3[], radius: number) {
    mesh.count = radius > 0 ? points.length : 0;
    scale.setScalar(radius);
    points.forEach((p, i) => mesh.setMatrixAt(i, matrix.compose(p, quat.identity(), scale)));
    mesh.instanceMatrix.needsUpdate = true;
  }

  function update(input: SkeletonViewInput) {
    const { positions } = input;
    boneMaterial.color.set(input.color);
    const thickness = Math.max(0, input.thickness);

    bones = ensure(bones, input.bones.length);
    bones.count = 0;
    for (const [a, b] of input.bones) {
      const from = positions[a];
      const to = positions[b];
      if (!from || !to) continue;
      dir.subVectors(to, from);
      const length = dir.length();
      if (length < 1e-9) continue;
      quat.setFromUnitVectors(UP, dir.divideScalar(length));
      bones.setMatrixAt(bones.count++, matrix.compose(from, quat, scale.set(thickness, length, thickness)));
    }
    bones.instanceMatrix.needsUpdate = true;
    bones.computeBoundingSphere();

    joints = ensure(joints, positions.length);
    setBalls(joints, positions, input.jointRadius);

    if (input.body && input.body.radius > 0) {
      body.visible = true;
      body.position.copy(input.body.center);
      body.scale.setScalar(input.body.radius);
    } else {
      body.visible = false;
    }

    const markerSize = Math.max(0, input.markerSize ?? 0.05);
    const targetPoints = input.targets ?? [];
    targets = ensure(targets, targetPoints.length);
    setBalls(targets, targetPoints, markerSize);

    const poleList = input.poles ?? [];
    poles = ensure(poles, poleList.length);
    setBalls(poles, poleList.map((p) => p.at), markerSize * 0.8);

    const linkPoints = poleList.flatMap((p) => [p.at, p.joint]);
    links.geometry.dispose();
    links.geometry = new THREE.BufferGeometry().setFromPoints(linkPoints);

    const circlePoints: THREE.Vector3[] = [];
    for (const c of input.circles ?? []) {
      for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
        for (const s of [k, k + 1]) {
          const a = (s / CIRCLE_SEGMENTS) * Math.PI * 2;
          circlePoints.push(new THREE.Vector3(c.center.x + Math.cos(a) * c.radius, c.center.y, c.center.z + Math.sin(a) * c.radius));
        }
      }
    }
    circles.geometry.dispose();
    circles.geometry = new THREE.BufferGeometry().setFromPoints(circlePoints);

    guides.visible = false;
    const pathPoints: number[] = [];
    const pathColors: number[] = [];
    const color = new THREE.Color();
    for (const path of input.paths ?? []) {
      color.set(path.color);
      const pts = path.points;
      const segments = path.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < segments; k++) {
        for (const p of [pts[k], pts[(k + 1) % pts.length]]) {
          pathPoints.push(p.x, p.y, p.z);
          pathColors.push(color.r, color.g, color.b);
        }
      }
    }
    paths.geometry.dispose();
    const pathGeometry = new LineSegmentsGeometry();
    // Never empty: a fat line with no instance attributes cannot be drawn, and one of zero length shows nothing.
    pathGeometry.setPositions(pathPoints.length > 0 ? pathPoints : [0, 0, 0, 0, 0, 0]);
    pathGeometry.setColors(pathColors.length > 0 ? pathColors : [0, 0, 0, 0, 0, 0]);
    paths.geometry = pathGeometry;

    const knobList = input.knobs ?? [];
    if (knobList.length > knobs.instanceMatrix.count) {
      const next = instanced(ballGeo, knobMaterial, knobList.length, nodeId);
      next.renderOrder = knobs.renderOrder;
      next.userData = { ...knobs.userData };
      guides.add(next);
      guides.remove(knobs);
      knobs.dispose();
      knobs = next;
    }
    knobs.count = knobList.length;
    scale.setScalar(Math.max(0, input.knobRadius ?? 0.03));
    knobList.forEach((k, i) => {
      knobs.setMatrixAt(i, matrix.compose(k.at, quat.identity(), scale));
      knobs.setColorAt(i, color.set(k.color));
    });
    knobs.instanceMatrix.needsUpdate = true;
    if (knobs.instanceColor) knobs.instanceColor.needsUpdate = true;
  }

  function dispose() {
    for (const mesh of [bones, joints, targets, poles, knobs]) mesh.dispose();
    boneGeo.dispose();
    ballGeo.dispose();
    poleGeo.dispose();
    links.geometry.dispose();
    circles.geometry.dispose();
    paths.geometry.dispose();
    for (const m of [boneMaterial, targetMaterial, poleMaterial, linkMaterial, circleMaterial, pathMaterial, knobMaterial]) m.dispose();
  }

  return { group, guides, update, dispose };
}
