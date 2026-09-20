import * as THREE from "three";
import { GreaseStroke, KeyframeDrawing, StrokePoint, resolveActiveDrawing } from "../graph/nodes/greasePencil";

export interface DrawingContext {
  camera: THREE.Camera;
  domElement: HTMLElement;
  elevationY?: number;
  mode2D?: boolean;
  objectPosition?: THREE.Vector3;
}

/**
 * Simulates calligraphic pressure based on movement velocity and time delta.
 */
export function calculateSimulatedPressure(
  prevPoint: { x: number; y: number; time: number } | null,
  currentPoint: { x: number; y: number; time: number },
  hardwarePressure = 0,
): number {
  if (hardwarePressure > 0.01) {
    return Math.min(1.0, hardwarePressure);
  }

  if (!prevPoint) return 0.65;

  const dx = currentPoint.x - prevPoint.x;
  const dy = currentPoint.y - prevPoint.y;
  const dist = Math.hypot(dx, dy);
  const dt = Math.max(1, currentPoint.time - prevPoint.time); // ms

  const speed = dist / dt; // px / ms. Typical range: 0.05 (slow) to 3.0+ (fast)

  // Dynamic ink speed curve:
  // Slower movement -> thicker stroke (up to 1.0)
  // Faster movement -> thinner, sleek tapering (down to 0.2)
  const factor = Math.exp(-speed * 0.85);
  const pressure = THREE.MathUtils.clamp(0.2 + 0.85 * factor, 0.18, 1.0);
  return pressure;
}

/**
 * Applies natural entry and/or exit tapering to a completed stroke.
 * Supports separate progressive tapering for stroke start and stroke end.
 * Uses a smooth C² transition curve over an adaptive arc window to avoid any bottleneck steps.
 */
export function applyStrokeTaper(
  points: StrokePoint[],
  taperStart = true,
  taperEnd = true,
  widenStart = false,
  widenEnd = false,
): StrokePoint[] {
  if (points.length < 2 || (!taperStart && !taperEnd && !widenStart && !widenEnd)) return points;

  const result = points.map((p) => ({ ...p }));
  // Adaptive window proportional to stroke length (up to 35% of total points, capped between 4 and 24 points)
  const windowCount = Math.max(3, Math.min(24, Math.floor(result.length * 0.35)));

  // Attack taper / widening (entry)
  const minTaperFactor = 0.20;
  if (taperStart) {
    for (let i = 0; i < windowCount; i++) {
      const t = i / windowCount;
      // Hermite smoothstep (f'(0)=0, f'(1)=0) ensures tangential blending with zero kink/step
      const ease = t * t * (3.0 - 2.0 * t);
      const factor = minTaperFactor + (1.0 - minTaperFactor) * ease;
      result[i].pressure = Math.max(0.12, result[i].pressure * factor);
    }
  } else if (widenStart) {
    for (let i = 0; i < windowCount; i++) {
      const t = i / windowCount;
      const ease = t * t * (3.0 - 2.0 * t);
      const factor = 1.0 + 0.85 * (1.0 - ease);
      result[i].pressure = Math.min(2.5, result[i].pressure * factor);
    }
  }

  // Decay taper / widening (exit)
  if (taperEnd) {
    for (let i = 0; i < windowCount; i++) {
      const idx = result.length - 1 - i;
      const t = i / windowCount;
      const ease = t * t * (3.0 - 2.0 * t);
      const factor = minTaperFactor + (1.0 - minTaperFactor) * ease;
      result[idx].pressure = Math.max(0.12, result[idx].pressure * factor);
    }
  } else if (widenEnd) {
    for (let i = 0; i < windowCount; i++) {
      const idx = result.length - 1 - i;
      const t = i / windowCount;
      const ease = t * t * (3.0 - 2.0 * t);
      const factor = 1.0 + 0.85 * (1.0 - ease);
      result[idx].pressure = Math.min(2.5, result[idx].pressure * factor);
    }
  }

  // Apply a 3-point smoothing pass over the pressure curve to ensure silky-smooth continuous width
  if (result.length >= 3) {
    const smoothed = result.map((p) => ({ ...p }));
    for (let i = 1; i < result.length - 1; i++) {
      smoothed[i].pressure =
        result[i - 1].pressure * 0.25 + result[i].pressure * 0.5 + result[i + 1].pressure * 0.25;
    }
    return smoothed;
  }

  return result;
}

/**
 * Smooths stroke points to eliminate involuntary hand tremors and jagged vertices.
 * Performs a multi-pass weighted Laplacian filter along the 3D stroke path,
 * anchoring the stroke endpoints (first and last points) to preserve the exact start and release locations.
 *
 * @param points Raw stroke points with { x, y, z, pressure }
 * @param smoothing Smoothing intensity factor [0..1]
 */
export function smoothStrokePoints(points: StrokePoint[], smoothing: number): StrokePoint[] {
  if (points.length <= 2 || !smoothing || smoothing <= 0.01) {
    return points;
  }

  const s = Math.max(0, Math.min(1, smoothing));
  // Determine number of iterations (1 to 6 passes depending on smoothing intensity)
  const passes = Math.max(1, Math.min(6, Math.round(s * 5) + 1));
  const weight = Math.min(0.7, s * 0.65);

  let current = points.map((p) => ({ ...p }));

  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((p) => ({ ...p }));
    for (let i = 1; i < current.length - 1; i++) {
      const prev = current[i - 1];
      const curr = current[i];
      const fwd = current[i + 1];

      // Smooth position (weighted average with neighbours)
      next[i].x = curr.x * (1 - weight) + (prev.x + fwd.x) * 0.5 * weight;
      next[i].y = curr.y * (1 - weight) + (prev.y + fwd.y) * 0.5 * weight;
      next[i].z = curr.z * (1 - weight) + (prev.z + fwd.z) * 0.5 * weight;

      // Also gently smooth pressure to prevent sudden thickness pops
      next[i].pressure = curr.pressure * (1 - weight * 0.5) + (prev.pressure + fwd.pressure) * 0.5 * (weight * 0.5);
    }
    current = next;
  }

  return current;
}

/**
 * Projects a screen pointer position (clientX, clientY) into 3D world coordinates on the drawing plane.
 */
export function projectScreenToDrawingPlane(
  clientX: number,
  clientY: number,
  ctx: DrawingContext,
): THREE.Vector3 | null {
  const rect = ctx.domElement.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), ctx.camera);

  // In 2D mode, project onto horizontal ground plane at object's elevation Y
  if (ctx.mode2D) {
    const planeY = ctx.elevationY ?? (ctx.objectPosition ? ctx.objectPosition.y : 0);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const target = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, target)) {
      return target;
    }
    plane.negate();
    if (raycaster.ray.intersectPlane(plane, target)) {
      return target;
    }
  }

  // In 3D mode, project onto plane facing camera passing through the object's origin
  const planeNormal = new THREE.Vector3();
  ctx.camera.getWorldDirection(planeNormal);
  planeNormal.negate(); // Plane normal points towards camera

  const planePoint = ctx.objectPosition ? ctx.objectPosition.clone() : new THREE.Vector3(0, 0, 0);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, planePoint);

  const target = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, target)) {
    return target;
  }
  plane.negate();
  if (raycaster.ray.intersectPlane(plane, target)) {
    return target;
  }

  return null;
}

/**
 * Adds a new stroke to the specified frame drawing.
 */
export function addStrokeToFrames(
  frames: KeyframeDrawing[],
  frameIndex: number,
  stroke: GreaseStroke,
): KeyframeDrawing[] {
  const nextFrames = frames.map((f) => ({ ...f, strokes: [...f.strokes] }));
  const existing = nextFrames.find((f) => f.frame === frameIndex);

  if (existing) {
    existing.strokes.push(stroke);
  } else {
    // If drawing on a frame where a previous keyframe was held, inherit its strokes into the new keyframe
    const sorted = [...frames].sort((a, b) => a.frame - b.frame);
    let held: KeyframeDrawing | null = null;
    for (const f of sorted) {
      if (f.frame <= frameIndex) held = f;
      else break;
    }
    const baseStrokes = held && held.frame < frameIndex ? held.strokes.map((s) => ({ ...s, points: [...s.points] })) : [];
    nextFrames.push({
      frame: frameIndex,
      strokes: [...baseStrokes, stroke],
    });
    nextFrames.sort((a, b) => a.frame - b.frame);
  }

  return nextFrames;
}

/**
 * Duplicates the drawing from one frame to a target frame (classic in-betweening / breakdown workflow).
 */
export function duplicateDrawing(
  frames: KeyframeDrawing[],
  fromFrame: number,
  toFrame: number,
): KeyframeDrawing[] {
  const nextFrames = frames.map((f) => ({ ...f, strokes: [...f.strokes] }));
  const sorted = [...nextFrames].sort((a, b) => a.frame - b.frame);
  let source: KeyframeDrawing | null = null;
  for (const f of sorted) {
    if (f.frame <= fromFrame) {
      source = f;
    } else {
      break;
    }
  }

  if (!source || source.strokes.length === 0) {
    return createBlankDrawing(nextFrames, toFrame);
  }

  const clonedStrokes: GreaseStroke[] = source.strokes.map((s) => ({
    ...s,
    id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    points: s.points.map((p) => ({ ...p })),
  }));

  const existing = nextFrames.find((f) => f.frame === toFrame);
  if (existing) {
    existing.strokes = clonedStrokes;
  } else {
    nextFrames.push({
      frame: toFrame,
      strokes: clonedStrokes,
    });
    nextFrames.sort((a, b) => a.frame - b.frame);
  }

  return nextFrames;
}

/**
 * Creates or resets a blank drawing at the specified frame.
 */
export function createBlankDrawing(
  frames: KeyframeDrawing[],
  toFrame: number,
): KeyframeDrawing[] {
  const nextFrames = frames.map((f) => ({ ...f, strokes: [...f.strokes] }));
  const existing = nextFrames.find((f) => f.frame === toFrame);
  if (existing) {
    existing.strokes = [];
  } else {
    nextFrames.push({
      frame: toFrame,
      strokes: [],
    });
    nextFrames.sort((a, b) => a.frame - b.frame);
  }
  return nextFrames;
}

/**
 * Clears the drawing at the specified frame.
 */
export function clearDrawingAtFrame(
  frames: KeyframeDrawing[],
  frameIndex: number,
): KeyframeDrawing[] {
  return frames.filter((f) => f.frame !== frameIndex);
}

/**
 * Erases strokes near the given 3D position within a threshold radius.
 */
function distToSegmentSq(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-8) {
    return apx * apx + apy * apy + apz * apz;
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / abLenSq));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const cz = az + t * abz;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
}

export function eraseStrokesAtPosition(
  frames: KeyframeDrawing[],
  frameIndex: number,
  worldPos: THREE.Vector3,
  radius = 0.75,
): KeyframeDrawing[] {
  const targetDrawing = resolveActiveDrawing(frames, frameIndex);
  if (!targetDrawing) return frames;
  const activeFrame = targetDrawing.frame;
  const radSq = radius * radius;

  const nextStrokes = targetDrawing.strokes.filter((stroke) => {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return false;
    // Check points
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - worldPos.x;
      const dy = p.y - worldPos.y;
      const dz = p.z - worldPos.z;
      if (dx * dx + dy * dy + dz * dz <= radSq) {
        return false;
      }
      // Check segment
      if (i < pts.length - 1) {
        const nextP = pts[i + 1];
        if (distToSegmentSq(worldPos.x, worldPos.y, worldPos.z, p.x, p.y, p.z, nextP.x, nextP.y, nextP.z) <= radSq) {
          return false;
        }
      }
    }
    return true;
  });

  return frames.map((f) => (f.frame === activeFrame ? { ...f, strokes: nextStrokes } : f));
}

/**
 * Gently erases/thins strokes near the given position (Soft Eraser).
 * Reduces point pressure/thickness smoothly with radial falloff.
 */
export function eraseStrokesSoft(
  frames: KeyframeDrawing[],
  frameIndex: number,
  worldPos: THREE.Vector3,
  radius = 0.85,
  strength = 0.3,
): KeyframeDrawing[] {
  const targetDrawing = resolveActiveDrawing(frames, frameIndex);
  if (!targetDrawing) return frames;
  const activeFrame = targetDrawing.frame;

  const radSq = radius * radius;
  const nextStrokes: GreaseStroke[] = [];

  for (const stroke of targetDrawing.strokes) {
    let anyHit = false;
    const newPoints = stroke.points.map((p) => {
      const dx = p.x - worldPos.x;
      const dy = p.y - worldPos.y;
      const dz = p.z - worldPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= radSq) {
        anyHit = true;
        const falloff = 1.0 - Math.sqrt(distSq) / radius;
        const nextPr = Math.max(0.01, (p.pressure ?? 0.6) - strength * falloff);
        return { ...p, pressure: nextPr };
      }
      return p;
    });

    if (anyHit) {
      // If all points have diminished to near zero, remove the stroke
      const visiblePoints = newPoints.filter((p) => p.pressure > 0.03);
      if (visiblePoints.length >= 2) {
        nextStrokes.push({ ...stroke, points: newPoints });
      }
    } else {
      nextStrokes.push(stroke);
    }
  }

  return frames.map((f) => (f.frame === activeFrame ? { ...f, strokes: nextStrokes } : f));
}

/**
 * Tints strokes near the given position towards the target color (Tint brush).
 */
export function tintStrokesAtPosition(
  frames: KeyframeDrawing[],
  frameIndex: number,
  worldPos: THREE.Vector3,
  targetColorHex: string,
  radius = 0.85,
  strength = 0.4,
): KeyframeDrawing[] {
  const targetDrawing = resolveActiveDrawing(frames, frameIndex);
  if (!targetDrawing) return frames;
  const activeFrame = targetDrawing.frame;

  const radSq = radius * radius;
  const targetCol = new THREE.Color(targetColorHex);
  const curCol = new THREE.Color();

  const nextStrokes = targetDrawing.strokes.map((stroke) => {
    let hit = false;
    const pts = stroke.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dx = p.x - worldPos.x;
      const dy = p.y - worldPos.y;
      const dz = p.z - worldPos.z;
      if (dx * dx + dy * dy + dz * dz <= radSq) {
        hit = true;
        break;
      }
      if (i < pts.length - 1) {
        const nextP = pts[i + 1];
        if (distToSegmentSq(worldPos.x, worldPos.y, worldPos.z, p.x, p.y, p.z, nextP.x, nextP.y, nextP.z) <= radSq) {
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      curCol.set(stroke.color || "#38bdf8");
      curCol.lerp(targetCol, strength);
      return { ...stroke, color: `#${curCol.getHexString()}` };
    }
    return stroke;
  });

  return frames.map((f) => (f.frame === activeFrame ? { ...f, strokes: nextStrokes } : f));
}

export interface GeometryHitResult {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  mesh: THREE.Mesh;
}

/**
 * Projects a screen pointer position (clientX, clientY) onto a 3D target geometry (e.g. Box, Sphere, Mesh),
 * returning the surface intersection point (slightly offset along the normal) and surface normal.
 * If paintGroup is provided, coordinates are expressed in paintGroup's local coordinate system.
 */
export function projectScreenToTargetGeometry(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
  targetObj: THREE.Object3D,
  paintGroup?: THREE.Object3D | null,
): GeometryHitResult | null {
  const rect = domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  // Update target transforms
  targetObj.updateMatrixWorld(true);

  // Intersect with meshes in targetObj, ignoring stroke overlay meshes
  const hits = raycaster.intersectObject(targetObj, true).filter((h) => {
    if (!(h.object instanceof THREE.Mesh)) return false;
    if (h.object.userData?.isStrokeMesh) return false;
    return true;
  });

  if (hits.length === 0) return null;

  const hit = hits[0];
  const hitMesh = hit.object as THREE.Mesh;

  let normal = new THREE.Vector3(0, 1, 0);
  if (hit.face) {
    normal.copy(hit.face.normal);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hitMesh.matrixWorld);
    normal.applyMatrix3(normalMatrix).normalize();
  }

  // Slight surface offset along normal (0.003) to prevent Z-fighting with coplanar triangles
  const worldPoint = hit.point.clone().addScaledVector(normal, 0.003);

  let localPoint = worldPoint;
  let localNormal = normal;

  if (paintGroup) {
    paintGroup.updateMatrixWorld(true);
    localPoint = paintGroup.worldToLocal(worldPoint.clone());
    const invMat = new THREE.Matrix4().copy(paintGroup.matrixWorld).invert();
    localNormal = normal.clone().transformDirection(invMat).normalize();
  }

  return {
    point: localPoint,
    normal: localNormal,
    mesh: hitMesh,
  };
}
