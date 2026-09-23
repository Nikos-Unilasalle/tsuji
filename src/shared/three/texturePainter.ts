export type TexturePaintTool = "paint" | "erase" | "smooth" | "eyedropper" | "fill";

export interface TexturePaintStrokeParams {
  tool: TexturePaintTool;
  color: string;
  radius: number;
  opacity: number;
  hardness: number; // 0 (soft falloff) to 1 (hard circle)
  uv: { x: number; y: number };
  prevUv?: { x: number; y: number } | null;
  symmetryX?: boolean;
  pressure?: number;
  prevPressure?: number | null;
  pressureAffects?: "both" | "size" | "opacity" | "none";
}

/**
 * Converts a hex or rgb string plus an alpha float (0-1) into an rgba(...) CSS string.
 */
export function colorWithAlpha(colorHexOrRgb: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const hex = colorHexOrRgb.trim();
  if (hex.startsWith("#")) {
    let cleanHex = hex.slice(1);
    if (cleanHex.length === 3) {
      cleanHex = cleanHex.split("").map((c) => c + c).join("");
    }
    const r = parseInt(cleanHex.slice(0, 2), 16) || 0;
    const g = parseInt(cleanHex.slice(2, 4), 16) || 0;
    const b = parseInt(cleanHex.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (hex.startsWith("rgb")) {
    const parts = hex.match(/\d+/g);
    if (parts && parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a})`;
    }
  }
  return `rgba(255, 255, 255, ${a})`;
}

/**
 * Creates an in-memory 2D HTMLCanvasElement initialized with a base color or transparent.
 */
export function createPaintCanvas(width: number, height: number, baseColor?: string): HTMLCanvasElement {
  const w = Math.max(16, width);
  const h = Math.max(16, height);

  if (typeof document === "undefined") {
    // Return in-memory mock canvas for headless / test environments
    const pixelData = new Uint8ClampedArray(w * h * 4);
    if (baseColor && baseColor !== "transparent") {
      const match = baseColor.match(/#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i);
      const r = match ? parseInt(match[1], 16) : 255;
      const g = match ? parseInt(match[2], 16) : 255;
      const b = match ? parseInt(match[3], 16) : 255;
      for (let i = 0; i < w * h; i++) {
        pixelData[i * 4] = r;
        pixelData[i * 4 + 1] = g;
        pixelData[i * 4 + 2] = b;
        pixelData[i * 4 + 3] = 255;
      }
    }

    let fillStyle: any = baseColor || "#000000";
    let arcParams: { cx: number; cy: number; r: number } | null = null;

    const mockCtx: any = {
      canvas: null,
      fillStyle: "#000000",
      globalCompositeOperation: "source-over",
      save: () => {},
      restore: () => {},
      beginPath: () => { arcParams = null; },
      arc: (cx: number, cy: number, r: number) => { arcParams = { cx, cy, r }; },
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: (x: number, y: number, rw: number, rh: number) => {
        const curStyle = String(mockCtx.fillStyle || fillStyle);
        const hexMatch = curStyle.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i);
        const rgbMatch = curStyle.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        let r = 255;
        let g = 255;
        let b = 255;
        if (hexMatch) {
          r = parseInt(hexMatch[1], 16);
          g = parseInt(hexMatch[2], 16);
          b = parseInt(hexMatch[3], 16);
        } else if (rgbMatch) {
          r = parseInt(rgbMatch[1], 10);
          g = parseInt(rgbMatch[2], 10);
          b = parseInt(rgbMatch[3], 10);
        }
        for (let py = Math.max(0, y); py < Math.min(h, y + rh); py++) {
          for (let px = Math.max(0, x); px < Math.min(w, x + rw); px++) {
            const idx = (py * w + px) * 4;
            pixelData[idx] = r;
            pixelData[idx + 1] = g;
            pixelData[idx + 2] = b;
            pixelData[idx + 3] = 255;
          }
        }
      },
      clearRect: (x: number, y: number, rw: number, rh: number) => {
        for (let py = Math.max(0, y); py < Math.min(h, y + rh); py++) {
          for (let px = Math.max(0, x); px < Math.min(w, x + rw); px++) {
            const idx = (py * w + px) * 4;
            pixelData[idx] = 0;
            pixelData[idx + 1] = 0;
            pixelData[idx + 2] = 0;
            pixelData[idx + 3] = 0;
          }
        }
      },
      fill: () => {
        if (!arcParams) return;
        const { cx, cy, r } = arcParams;
        const curStyle = String(mockCtx.fillStyle || fillStyle);
        const hexMatch = curStyle.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i);
        const rgbMatch = curStyle.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        let cr = 255;
        let cg = 255;
        let cb = 255;
        if (hexMatch) {
          cr = parseInt(hexMatch[1], 16);
          cg = parseInt(hexMatch[2], 16);
          cb = parseInt(hexMatch[3], 16);
        } else if (rgbMatch) {
          cr = parseInt(rgbMatch[1], 10);
          cg = parseInt(rgbMatch[2], 10);
          cb = parseInt(rgbMatch[3], 10);
        }
        const isErase = mockCtx.globalCompositeOperation === "destination-out";

        const x0 = Math.max(0, Math.floor(cx - r));
        const x1 = Math.min(w - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r));
        const y1 = Math.min(h - 1, Math.ceil(cy + r));
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const d = Math.hypot(px - cx, py - cy);
            if (d <= r) {
              const idx = (py * w + px) * 4;
              if (isErase) {
                pixelData[idx + 3] = 0;
              } else {
                pixelData[idx] = cr;
                pixelData[idx + 1] = cg;
                pixelData[idx + 2] = cb;
                pixelData[idx + 3] = 255;
              }
            }
          }
        }
      },
      createImageData: (sw: number, sh: number) => ({
        data: new Uint8ClampedArray(sw * sh * 4),
        width: sw,
        height: sh,
      }),
      getImageData: (x: number, y: number, sw: number, sh: number) => {
        const out = new Uint8ClampedArray(sw * sh * 4);
        for (let py = 0; py < sh; py++) {
          for (let px = 0; px < sw; px++) {
            const srcX = Math.max(0, Math.min(w - 1, x + px));
            const srcY = Math.max(0, Math.min(h - 1, y + py));
            const srcIdx = (srcY * w + srcX) * 4;
            const destIdx = (py * sw + px) * 4;
            out[destIdx] = pixelData[srcIdx];
            out[destIdx + 1] = pixelData[srcIdx + 1];
            out[destIdx + 2] = pixelData[srcIdx + 2];
            out[destIdx + 3] = pixelData[srcIdx + 3];
          }
        }
        return { data: out, width: sw, height: sh };
      },
      /**
       * Writes pixels back into the mock's buffer, including the 7-argument
       * dirty-rect form. Compositing code reads its own result back through
       * getImageData, so a no-op here (the previous behaviour) made every
       * putImageData-based path silently untestable.
       */
      putImageData: (
        img: { data: Uint8ClampedArray; width: number; height: number },
        dx: number,
        dy: number,
        dirtyX?: number,
        dirtyY?: number,
        dirtyWidth?: number,
        dirtyHeight?: number,
      ) => {
        const hasDirty = dirtyX !== undefined && dirtyY !== undefined;
        const sx0 = hasDirty ? Math.max(0, Math.floor(dirtyX)) : 0;
        const sy0 = hasDirty ? Math.max(0, Math.floor(dirtyY)) : 0;
        const sw = hasDirty ? Math.max(0, Math.floor(dirtyWidth ?? 0)) : img.width;
        const sh = hasDirty ? Math.max(0, Math.floor(dirtyHeight ?? 0)) : img.height;

        for (let py = 0; py < sh; py++) {
          for (let px = 0; px < sw; px++) {
            const srcX = sx0 + px;
            const srcY = sy0 + py;
            if (srcX >= img.width || srcY >= img.height) continue;
            const destX = dx + srcX;
            const destY = dy + srcY;
            if (destX < 0 || destY < 0 || destX >= w || destY >= h) continue;
            const srcIdx = (srcY * img.width + srcX) * 4;
            const destIdx = (destY * w + destX) * 4;
            pixelData[destIdx] = img.data[srcIdx];
            pixelData[destIdx + 1] = img.data[srcIdx + 1];
            pixelData[destIdx + 2] = img.data[srcIdx + 2];
            pixelData[destIdx + 3] = img.data[srcIdx + 3];
          }
        }
      },
    };

    const mockCanvas = {
      width: w,
      height: h,
      getContext: () => mockCtx,
      toDataURL: () => "data:image/png;base64,mock",
    } as unknown as HTMLCanvasElement;
    mockCtx.canvas = mockCanvas;
    return mockCanvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx && baseColor) {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * Applies local smoothing / blur on a region of the canvas around (cx, cy).
 */
function applySmoothStamp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
): void {
  const r = Math.max(2, Math.round(radius));
  const x0 = Math.max(0, cx - r);
  const y0 = Math.max(0, cy - r);
  const w = Math.min(width - x0, r * 2);
  const h = Math.min(height - y0, r * 2);
  if (w <= 0 || h <= 0) return;

  const imgData = ctx.getImageData(x0, y0, w, h);
  const data = imgData.data;
  const copy = new Uint8ClampedArray(data);

  const blurRadius = Math.max(1, Math.min(5, Math.floor(r * 0.25)));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x0 + x - cx;
      const dy = y0 + y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) continue;

      const falloff = 1.0 - dist / r;
      const blend = strength * falloff * 0.6;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;

      for (let ky = -blurRadius; ky <= blurRadius; ky++) {
        const ny = Math.max(0, Math.min(h - 1, y + ky));
        for (let kx = -blurRadius; kx <= blurRadius; kx++) {
          const nx = Math.max(0, Math.min(w - 1, x + kx));
          const idx = (ny * w + nx) * 4;
          sumR += copy[idx];
          sumG += copy[idx + 1];
          sumB += copy[idx + 2];
          sumA += copy[idx + 3];
          count++;
        }
      }

      const pIdx = (y * w + x) * 4;
      const avgR = sumR / count;
      const avgG = sumG / count;
      const avgB = sumB / count;
      const avgA = sumA / count;

      data[pIdx] = Math.round(copy[pIdx] + (avgR - copy[pIdx]) * blend);
      data[pIdx + 1] = Math.round(copy[pIdx + 1] + (avgG - copy[pIdx + 1]) * blend);
      data[pIdx + 2] = Math.round(copy[pIdx + 2] + (avgB - copy[pIdx + 2]) * blend);
      data[pIdx + 3] = Math.round(copy[pIdx + 3] + (avgA - copy[pIdx + 3]) * blend);
    }
  }

  ctx.putImageData(imgData, x0, y0);
}

/**
 * Draws a single circular brush stamp at (px, py) on the canvas context.
 */
function drawBrushStamp(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  radius: number,
  opacity: number,
  hardness: number,
  color: string,
  isEraser: boolean,
): void {
  ctx.save();
  if (isEraser) {
    ctx.globalCompositeOperation = "destination-out";
  } else {
    ctx.globalCompositeOperation = "source-over";
  }

  const r = Math.max(1, radius);
  const h = Math.max(0, Math.min(0.999, hardness));
  const innerR = Math.max(0, r * h);

  const grad = ctx.createRadialGradient(px, py, innerR, px, py, r);
  if (isEraser) {
    grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
    if (h > 0.05) grad.addColorStop(h, `rgba(0,0,0,${opacity})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
  } else {
    grad.addColorStop(0, colorWithAlpha(color, opacity));
    if (h > 0.05) grad.addColorStop(h, colorWithAlpha(color, opacity));
    grad.addColorStop(1, colorWithAlpha(color, 0));
  }

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Applies a paint stroke to a canvas using UV coordinates.
 * Handles continuous stroke interpolation between prevUv and uv.
 */
export function applyPaintStroke(
  canvas: HTMLCanvasElement,
  params: TexturePaintStrokeParams,
): { sampledColor?: string } {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return {};

  const width = canvas.width;
  const height = canvas.height;

  // Convert UV to Canvas pixel coordinates (WebGL V=0 at bottom, Canvas Y=0 at top)
  const normU = ((params.uv.x % 1.0) + 1.0) % 1.0;
  const normV = ((params.uv.y % 1.0) + 1.0) % 1.0;
  const currX = Math.round(normU * width);
  const currY = Math.round((1.0 - normV) * height);

  // Eyedropper tool
  if (params.tool === "eyedropper") {
    const clampedX = Math.max(0, Math.min(width - 1, currX));
    const clampedY = Math.max(0, Math.min(height - 1, currY));
    const p = ctx.getImageData(clampedX, clampedY, 1, 1).data;
    const toHex = (n: number) => n.toString(16).padStart(2, "0");
    const hex = `#${toHex(p[0])}${toHex(p[1])}${toHex(p[2])}`;
    return { sampledColor: hex };
  }

  // Fill tool
  if (params.tool === "fill") {
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = colorWithAlpha(params.color, params.opacity);
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return {};
  }

  const pStart = params.prevPressure ?? params.pressure ?? 1.0;
  const pEnd = params.pressure ?? 1.0;
  const pressureMode = params.pressureAffects ?? "both";

  // Determine line segment interpolation points
  const points: { x: number; y: number; r: number; op: number }[] = [];
  if (params.prevUv) {
    const prevNormU = ((params.prevUv.x % 1.0) + 1.0) % 1.0;
    const prevNormV = ((params.prevUv.y % 1.0) + 1.0) % 1.0;
    const prevX = Math.round(prevNormU * width);
    const prevY = Math.round((1.0 - prevNormV) * height);

    const dist = Math.hypot(currX - prevX, currY - prevY);
    // Step size ensures dense overlapping stamps for smooth strokes
    const step = Math.max(1, params.radius * 0.25);
    const count = Math.ceil(dist / step);
    for (let i = 0; i <= count; i++) {
      const t = count === 0 ? 1 : i / count;
      const p = pStart + (pEnd - pStart) * t;
      const r = pressureMode === "size" || pressureMode === "both" ? Math.max(1, params.radius * p) : params.radius;
      const op =
        pressureMode === "opacity" || pressureMode === "both"
          ? Math.max(0.01, Math.min(1.0, params.opacity * (0.15 + 0.85 * p)))
          : params.opacity;

      points.push({
        x: Math.round(prevX + (currX - prevX) * t),
        y: Math.round(prevY + (currY - prevY) * t),
        r,
        op,
      });
    }
  } else {
    const p = pEnd;
    const r = pressureMode === "size" || pressureMode === "both" ? Math.max(1, params.radius * p) : params.radius;
    const op =
      pressureMode === "opacity" || pressureMode === "both"
        ? Math.max(0.01, Math.min(1.0, params.opacity * (0.15 + 0.85 * p)))
        : params.opacity;
    points.push({ x: currX, y: currY, r, op });
  }

  const isEraser = params.tool === "erase";
  const isSmooth = params.tool === "smooth";

  for (const pt of points) {
    if (isSmooth) {
      applySmoothStamp(ctx, width, height, pt.x, pt.y, pt.r, pt.op);
      if (params.symmetryX) {
        applySmoothStamp(ctx, width, height, width - pt.x, pt.y, pt.r, pt.op);
      }
    } else {
      drawBrushStamp(ctx, pt.x, pt.y, pt.r, pt.op, params.hardness, params.color, isEraser);
      if (params.symmetryX) {
        drawBrushStamp(ctx, width - pt.x, pt.y, pt.r, pt.op, params.hardness, params.color, isEraser);
      }
    }
  }

  return {};
}

/**
 * Clears or fills the entire canvas with baseColor.
 */
export function clearPaintCanvas(canvas: HTMLCanvasElement, baseColor = "#ffffff"): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  if (baseColor === "transparent" || baseColor === "") {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

/**
 * Serializes the paint canvas to a base64 PNG data URL.
 */
export function serializePaintCanvas(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

/**
 * Restores paint canvas content from a base64 PNG data URL or image source.
 */
export function restorePaintCanvas(
  canvas: HTMLCanvasElement,
  dataUrl: string,
  onLoaded?: () => void,
): void {
  if (!dataUrl || typeof Image === "undefined") {
    onLoaded?.();
    return;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    onLoaded?.();
  };
  img.onerror = () => onLoaded?.();
  img.src = dataUrl;
}

/**
 * Exports the canvas as a downloadable PNG image.
 */
export function exportCanvasToPNG(canvas: HTMLCanvasElement, filename = "painted_texture.png"): void {
  if (typeof document === "undefined") return;
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}
