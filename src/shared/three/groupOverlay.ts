import * as THREE from "three";
import type { PolyMesh } from "../graph/quadMesh";
import { domainEdges, type AttrDomain } from "../graph/mesh/polyAttributes";
import { triangulateFace } from "../graph/mesh/triangulate";

/*
 * Draws groups on a mesh in the editor viewport: selected faces tinted,
 * selected edges as bright lines, selected points (and corners) as dots,
 * the rest of the mesh as a faint wireframe so the selection reads against
 * it. Editor-only — never built by an output (camera / export) viewport.
 *
 * Each layer is rebuilt only when its key changes (mesh signature +
 * expression + colour), so a still selection costs nothing per frame.
 */

export interface GroupLayer {
  /** Changes whenever what is drawn changes (mesh, mask, colour). */
  key: string;
  mesh: PolyMesh;
  matrix: THREE.Matrix4;
  domain: AttrDomain;
  mask: Uint8Array;
  color: THREE.ColorRepresentation;
  /** Draw the whole mesh as a faint wireframe under this layer. */
  context?: boolean;
  /** Strong single-element highlight (spreadsheet hover): thicker dots, opaque faces. */
  emphasis?: boolean;
}

interface Built {
  key: string;
  object: THREE.Group;
}

const disposeTree = (object: THREE.Object3D) =>
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });

function buildLayer(layer: GroupLayer): THREE.Group {
  const { mesh, domain, mask } = layer;
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrix.copy(layer.matrix);
  group.renderOrder = 10;
  const color = new THREE.Color(layer.color);
  const P = mesh.positions;

  if (layer.context) {
    const pos: number[] = [];
    for (const [a, b] of domainEdges(mesh)) pos.push(...P[a], ...P[b]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x0b1020, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    lines.renderOrder = 9;
    group.add(lines);
  }

  if (domain === "face") {
    const tri: number[] = [];
    const edges: number[] = [];
    mesh.faces.forEach((face, f) => {
      if (!mask[f]) return;
      for (const [a, b, c] of triangulateFace(P, face)) tri.push(...P[face[a]], ...P[face[b]], ...P[face[c]]);
      for (let i = 0; i < face.length; i++) edges.push(...P[face[i]], ...P[face[(i + 1) % face.length]]);
    });
    if (tri.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: layer.emphasis ? 0.85 : 0.42,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      fill.renderOrder = 10;
      group.add(fill);
      const outline = new THREE.BufferGeometry();
      outline.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
      const lines = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }));
      lines.renderOrder = 11;
      group.add(lines);
    }
  } else if (domain === "edge") {
    const pos: number[] = [];
    domainEdges(mesh).forEach(([a, b], e) => {
      if (mask[e]) pos.push(...P[a], ...P[b]);
    });
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthWrite: false }));
      lines.renderOrder = 11;
      group.add(lines);
      // Lines are one pixel wide in WebGL: dots at both ends make thin edges findable.
      const dots = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, depthWrite: false }));
      dots.renderOrder = 11;
      group.add(dots);
    }
  } else {
    const pos: number[] = [];
    if (domain === "point") {
      P.forEach((p, v) => {
        if (mask[v]) pos.push(...p);
      });
    } else {
      // Corners: each a little way from its point toward its face's centre, so the corners of one point stay apart.
      let c = 0;
      for (const face of mesh.faces) {
        let cx = 0, cy = 0, cz = 0;
        for (const v of face) {
          cx += P[v][0];
          cy += P[v][1];
          cz += P[v][2];
        }
        cx /= face.length;
        cy /= face.length;
        cz /= face.length;
        for (const v of face) {
          if (mask[c]) pos.push(P[v][0] + (cx - P[v][0]) * 0.2, P[v][1] + (cy - P[v][1]) * 0.2, P[v][2] + (cz - P[v][2]) * 0.2);
          c++;
        }
      }
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const dots = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color, size: layer.emphasis ? 12 : 7, sizeAttenuation: false, depthWrite: false }),
      );
      dots.renderOrder = 11;
      group.add(dots);
    }
  }
  return group;
}

export interface GroupOverlay {
  group: THREE.Group;
  /** Shows exactly these layers; unchanged keys are kept as they are. */
  sync(layers: GroupLayer[]): void;
  clear(): void;
}

export function createGroupOverlay(): GroupOverlay {
  const group = new THREE.Group();
  group.name = "group-overlay";
  // Never pickable: clicks go through to the objects underneath.
  group.raycast = () => {};
  let built: Built[] = [];

  const clear = () => {
    for (const b of built) {
      group.remove(b.object);
      disposeTree(b.object);
    }
    built = [];
  };

  return {
    group,
    clear,
    sync(layers) {
      const next: Built[] = [];
      const keep = new Set(layers.map((l) => l.key));
      for (const b of built) {
        if (keep.has(b.key)) continue;
        group.remove(b.object);
        disposeTree(b.object);
      }
      for (const layer of layers) {
        const existing = built.find((b) => b.key === layer.key);
        if (existing) {
          existing.object.matrix.copy(layer.matrix);
          next.push(existing);
          continue;
        }
        const object = buildLayer(layer);
        object.traverse((o) => (o.raycast = () => {}));
        group.add(object);
        next.push({ key: layer.key, object });
      }
      built = next;
    },
  };
}
