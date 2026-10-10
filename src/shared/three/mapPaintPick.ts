import * as THREE from "three";
import type { TerrainGridConfig } from "./terrainEngine";

export interface MapPaintHit {
  /** World-space point under the cursor, where the brush ring is drawn. */
  point: THREE.Vector3;
  /** Surface normal there (world space), to lay the ring flat on a slope. */
  normal: THREE.Vector3;
  /** Position on the map, 0..1 — what the paint layer is indexed by. */
  x: number;
  y: number;
  /** How wide the whole map is in world units, to turn a brush radius into a ring size. */
  worldWidth: number;
}

/**
 * Where on the map the cursor is. The brush is aimed at whatever Terrain is
 * on screen (nearest hit wins), which is what you'd expect — you paint the
 * mountain you can see — and falls back to the flat ground plane when there
 * is none yet. Aiming happens here, in the viewport, not in the graph, so Map
 * Paint needs no wire to the Terrain it paints and the graph stays acyclic.
 */
export function pickMapPaintHit(
  raycaster: THREE.Raycaster,
  camera: THREE.Camera,
  ndc: THREE.Vector2,
  results: Map<string, Record<string, unknown>> | null | undefined,
  node: { params: Record<string, unknown> },
): MapPaintHit | null {
  raycaster.setFromCamera(ndc, camera);
  let best: { hit: THREE.Intersection; mesh: THREE.Mesh } | null = null;
  for (const res of results?.values() ?? []) {
    const mesh = res.geometry;
    if (!(mesh instanceof THREE.Mesh) || !mesh.userData?.isTerrain) continue;
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (hit && (!best || hit.distance < best.hit.distance)) best = { hit, mesh };
  }
  if (best) {
    const cfg = best.mesh.userData.terrainConfig as TerrainGridConfig | undefined;
    if (cfg && cfg.width > 0 && cfg.depth > 0) {
      const local = best.mesh.worldToLocal(best.hit.point.clone());
      const normal = best.hit.face
        ? best.hit.face.normal.clone().transformDirection(best.mesh.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      return {
        point: best.hit.point.clone(),
        normal,
        x: local.x / cfg.width + 0.5,
        y: local.z / cfg.depth + 0.5,
        worldWidth: cfg.width * best.mesh.getWorldScale(new THREE.Vector3()).x,
      };
    }
  }
  const width = Number(node.params.width) || 40;
  const depth = Number(node.params.depth) || 40;
  const ground = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ground)) return null;
  const x = ground.x / width + 0.5;
  const y = ground.z / depth + 0.5;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { point: ground, normal: new THREE.Vector3(0, 1, 0), x, y, worldWidth: width };
}
