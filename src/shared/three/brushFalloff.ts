export type BrushFalloff = "smooth" | "linear" | "sphere" | "flat";

export function calculateFalloff(distNorm: number, type: BrushFalloff): number {
  if (distNorm >= 1.0) return 0;
  if (distNorm <= 0) return 1;
  switch (type) {
    case "linear":
      return 1.0 - distNorm;
    case "sphere":
      return Math.sqrt(Math.max(0, 1.0 - distNorm * distNorm));
    case "flat":
      return 1.0;
    case "smooth":
    default:
      return (1.0 + Math.cos(Math.PI * distNorm)) * 0.5;
  }
}

/**
 * Normalizes a stroke's strength against frame time so slower frames don't
 * under/over-shoot relative to faster ones — every brush multiplies its own
 * per-tool constant by this instead of raw `strength`.
 */
export function strokeBaseStrength(strength: number, deltaTime: number | undefined): number {
  const dt = deltaTime ?? 0.016;
  const rate = Math.min(2.0, dt * 60.0);
  return strength * rate;
}
