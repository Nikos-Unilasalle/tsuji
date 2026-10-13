/**
 * Spatial audio, the way a game engine does it: a sound is either global (heard the same everywhere) or local — it sits at a
 * point and is heard inside a sphere that fades out. Inside the inner radius it is at full volume; from there to the outer
 * radius it falls to silence; beyond, nothing. The listener is the active camera.
 */
export type SpatialMode = "global" | "local";
export type Rolloff = "linear" | "smooth" | "natural";

export const ROLLOFFS: Rolloff[] = ["linear", "smooth", "natural"];

/** Volume factor (0..1) for a listener `distance` from a local sound. */
export function attenuation(distance: number, inner: number, outer: number, rolloff: Rolloff = "linear"): number {
  if (!Number.isFinite(distance)) return 0;
  const near = Math.max(0, inner);
  const far = Math.max(near, outer);
  if (distance <= near) return 1;
  if (distance >= far) return 0;
  const t = (distance - near) / (far - near); // 0 at the inner radius, 1 at the outer
  switch (rolloff) {
    case "smooth":
      return 1 - t * t * (3 - 2 * t);
    case "natural": {
      // Inverse-distance feel (a sound halves each time the distance from the inner radius doubles), forced to reach 0 at
      // the outer radius so the sphere has an edge.
      const raw = 1 / (1 + 4 * t);
      const floor = 1 / 5;
      return Math.max(0, (raw - floor) / (1 - floor));
    }
    default:
      return 1 - t;
  }
}

/** Volume factor for a sound, whatever its mode: 1 for global, the sphere's fall-off for local. */
export function spatialGain(
  mode: SpatialMode,
  listener: { x: number; y: number; z: number } | null,
  source: { x: number; y: number; z: number },
  inner: number,
  outer: number,
  rolloff: Rolloff,
): number {
  if (mode !== "local") return 1;
  // No camera to listen from: treat the listener as standing at the origin rather than silencing the sound.
  const l = listener ?? { x: 0, y: 0, z: 0 };
  return attenuation(Math.hypot(l.x - source.x, l.y - source.y, l.z - source.z), inner, outer, rolloff);
}

type Vec = { x: number; y: number; z: number };

/**
 * Stereo position (-1 left … +1 right) of a local sound for a listener whose right-hand direction is `right` (the camera's
 * X axis): the sound is panned by how far to the listener's side it lies. Close to the listener (inside the full-volume
 * radius, or within half a unit) the sound is "on top of you" and the pan eases back to the centre instead of flicking
 * left and right as the camera passes through it.
 */
export function stereoPan(listener: Vec | null, right: Vec | null, source: Vec, inner: number): number {
  if (!listener || !right) return 0;
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 1e-6)) return 0;
  const rl = Math.hypot(right.x, right.y, right.z) || 1;
  const side = (dx * right.x + dy * right.y + dz * right.z) / (dist * rl); // cosine of the angle to the right axis
  const ease = Math.min(1, dist / Math.max(inner, 0.5));
  return Math.max(-1, Math.min(1, side * ease));
}
