import React, { useCallback, useEffect, useRef, useState } from "react";
import { DragNumberInput } from "./DragNumberInput";
import {
  LAYER_FALLBACK_COLORS,
  layerName,
} from "../shared/three/layeredTexture";
import { heightBandWeights } from "../shared/three/textureMixEngine";
import { parseCssColor, themeVar, themeVarAlpha } from "./themeVars";
import "./topography-bands-editor.css";

/**
 * Visual editor for a Topography Texture Mix's rules.
 *
 * The node decides which texture covers a point from its altitude and its
 * slope. Expressed as a column of numbers ("Snow Altitude 0.75", "Slope
 * Transition 15") that is a guessing game: nothing on screen says what 0.75
 * looks like, and the only way to find out is to change it and look at the
 * terrain.
 *
 * So the control *is* the picture. The bar draws the actual band stack over
 * the terrain's height — computed with the same smoothstep the node uses, so
 * the soft edges on screen are the soft edges you will get — and the handles
 * on it are the thresholds. Altitudes read as percentages of the terrain's
 * own height, because that is what they are: the node normalizes every
 * terrain to 0–100% before applying them, so "snow above 62%" transfers
 * between a hill and a mountain range while "snow above 0.62" means nothing
 * without knowing the bounding box.
 */

export interface TopographyBandsValue {
  shoreHeight: number;
  shoreBlend: number;
  snowHeight: number;
  snowBlend: number;
  slopeAngle: number;
  slopeBlend: number;
  baseLayer: number;
  slopeLayer: number;
  snowLayer: number;
  shoreLayer: number;
}

interface TopographyBandsEditorProps {
  /** The node's params — the editor reads the rule keys it owns. */
  params: Record<string, unknown>;
  /** Writes several rule params at once, as one undo step. */
  onChange: (patch: Record<string, unknown>) => void;
  /** How many layer slots this node has. */
  layerCount: number;
}

const BAR_WIDTH = 54;
const BAR_HEIGHT = 168;
const DIAL_SIZE = 96;

type Band = "shore" | "ground" | "peak";
type Handle = "shore" | "peak" | "slope" | "slopeFade" | null;

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = Number(params[key]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * The swatch a layer is drawn with.
 *
 * These are the same colours the compositor paints when a layer has no
 * texture wired, so the bar keeps matching the terrain. They are material
 * colours, not interface chrome — like socket and category colours, a theme
 * must not be able to repaint them (see theme.css). A layer slot that is
 * switched off borrows a chrome surface instead, because that *is* chrome.
 */
function layerColor(index: number, element?: Element | null): string {
  if (index < 0) return themeVar("--chrome-surface-raised", "#47505d", element);
  return LAYER_FALLBACK_COLORS[index % LAYER_FALLBACK_COLORS.length];
}

export const TopographyBandsEditor: React.FC<TopographyBandsEditorProps> = ({
  params,
  onChange,
  layerCount,
}) => {
  const barRef = useRef<HTMLCanvasElement | null>(null);
  const dialRef = useRef<HTMLCanvasElement | null>(null);
  const [dragging, setDragging] = useState<Handle>(null);
  const [selected, setSelected] = useState<Band>("ground");

  const shoreHeight = num(params, "shoreHeight", 0.15);
  const shoreBlend = num(params, "shoreBlend", 0.1);
  const snowHeight = num(params, "snowHeight", 0.75);
  const snowBlend = num(params, "snowBlend", 0.15);
  const slopeAngle = num(params, "slopeAngle", 35);
  const slopeBlend = num(params, "slopeBlend", 15);
  const baseLayer = num(params, "baseLayer", 0);
  const slopeLayer = num(params, "slopeLayer", 1);
  const snowLayer = num(params, "snowLayer", 2);
  const shoreLayer = num(params, "shoreLayer", -1);

  const bandLayer = (band: Band) => (band === "shore" ? shoreLayer : band === "peak" ? snowLayer : baseLayer);
  const bandLayerKey = (band: Band) => (band === "shore" ? "shoreLayer" : band === "peak" ? "snowLayer" : "baseLayer");

  /** Paints the band stack exactly as the node will resolve it. */
  const drawBar = useCallback(() => {
    const canvas = barRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = BAR_WIDTH * dpr;
    canvas.height = BAR_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, BAR_WIDTH, BAR_HEIGHT);

    const base = parseCssColor(layerColor(baseLayer, canvas));
    const peak = parseCssColor(layerColor(snowLayer, canvas));
    const shore = parseCssColor(layerColor(shoreLayer, canvas));
    const hasShore = shoreLayer >= 0;

    for (let y = 0; y < BAR_HEIGHT; y++) {
      // Top of the bar is the top of the terrain.
      const h = 1 - y / (BAR_HEIGHT - 1);

      // The node's own blend, not a lookalike — see heightBandWeights.
      const { base: wBase, peak: wPeak, shore: wShore } = heightBandWeights(h, {
        shoreHeight,
        shoreBlend,
        snowHeight,
        snowBlend,
        hasShore,
      });
      const total = wPeak + wShore + wBase || 1;

      const r = (peak[0] * wPeak + shore[0] * wShore + base[0] * wBase) / total;
      const g = (peak[1] * wPeak + shore[1] * wShore + base[1] * wBase) / total;
      const b = (peak[2] * wPeak + shore[2] * wShore + base[2] * wBase) / total;

      ctx.fillStyle = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      ctx.fillRect(0, y, BAR_WIDTH, 1);
    }

    ctx.strokeStyle = themeVar("--chrome-border", "#5a6472", canvas);
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, BAR_WIDTH - 1, BAR_HEIGHT - 1);

    // Threshold lines. The fade band is drawn as a lighter zone around each,
    // so "fading over 12%" is a thickness rather than a number to imagine.
    const lineFor = (height: number, blend: number, active: boolean) => {
      const yMid = (1 - height) * (BAR_HEIGHT - 1);
      const yTop = (1 - (height + blend * 0.5)) * (BAR_HEIGHT - 1);
      const yBot = (1 - (height - blend * 0.5)) * (BAR_HEIGHT - 1);

      ctx.fillStyle = active
        ? themeVarAlpha("--chrome-text", 0.24, "#eef2f6", canvas)
        : themeVarAlpha("--chrome-text", 0.12, "#eef2f6", canvas);
      ctx.fillRect(0, yTop, BAR_WIDTH, Math.max(1, yBot - yTop));

      // The threshold being edited is picked out with the accent, the other
      // one stays in plain text colour.
      ctx.strokeStyle = active
        ? themeVar("--accent-color", "#38bdf8", canvas)
        : themeVarAlpha("--chrome-text", 0.75, "#eef2f6", canvas);
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, yMid);
      ctx.lineTo(BAR_WIDTH, yMid);
      ctx.stroke();
    };

    lineFor(snowHeight, snowBlend, selected === "peak");
    if (hasShore) lineFor(shoreHeight, shoreBlend, selected === "shore");
  }, [baseLayer, snowLayer, shoreLayer, shoreHeight, shoreBlend, snowHeight, snowBlend, selected]);

  /** Quarter dial: flat ground at the left, a vertical wall at the right. */
  const drawDial = useCallback(() => {
    const canvas = dialRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = DIAL_SIZE * dpr;
    canvas.height = DIAL_SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, DIAL_SIZE, DIAL_SIZE);

    const cx = 8;
    const cy = DIAL_SIZE - 8;
    const radius = DIAL_SIZE - 20;
    const toAngle = (deg: number) => -(deg / 90) * (Math.PI / 2);

    // Ground colour under the threshold, cliff colour above it.
    const ground = layerColor(baseLayer, canvas);
    const cliff = layerColor(slopeLayer, canvas);

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, 0, toAngle(slopeAngle), true);
    ctx.closePath();
    ctx.fillStyle = ground;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, toAngle(slopeAngle), toAngle(90), true);
    ctx.closePath();
    ctx.fillStyle = cliff;
    ctx.fill();

    // The transition, as an arc band straddling the threshold.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, toAngle(slopeAngle - slopeBlend * 0.5), toAngle(slopeAngle + slopeBlend * 0.5), true);
    ctx.closePath();
    ctx.fillStyle = themeVarAlpha("--chrome-text", 0.25, "#eef2f6", canvas);
    ctx.fill();

    ctx.strokeStyle = themeVarAlpha("--chrome-border", 0.9, "#5a6472", canvas);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, 0, toAngle(90), true);
    ctx.closePath();
    ctx.stroke();

    // Needle
    const a = toAngle(slopeAngle);
    ctx.strokeStyle = themeVar("--accent-color", "#38bdf8", canvas);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
  }, [slopeAngle, slopeBlend, baseLayer, slopeLayer]);

  useEffect(() => {
    drawBar();
  }, [drawBar]);
  useEffect(() => {
    drawDial();
  }, [drawDial]);

  /** Height (0..1) under the pointer on the bar. */
  const heightAt = (clientY: number): number => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
  };

  const angleAt = (clientX: number, clientY: number): number => {
    const rect = dialRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const dx = clientX - (rect.left + 8);
    const dy = rect.top + rect.height - 8 - clientY;
    if (dx <= 0 && dy <= 0) return 0;
    const deg = (Math.atan2(Math.max(0, dy), Math.max(0.0001, dx)) * 180) / Math.PI;
    return Math.max(0, Math.min(90, deg));
  };

  const onBarPointerDown = (e: React.PointerEvent) => {
    const h = heightAt(e.clientY);
    // Whichever threshold is nearer takes the drag; the band it belongs to
    // becomes the selected one, so its details show below.
    const dPeak = Math.abs(h - snowHeight);
    const dShore = shoreLayer >= 0 ? Math.abs(h - shoreHeight) : Infinity;
    const handle: Handle = dPeak <= dShore ? "peak" : "shore";
    setDragging(handle);
    setSelected(handle === "peak" ? "peak" : "shore");
    (e.target as Element).setPointerCapture?.(e.pointerId);
    applyBarDrag(handle, h);
  };

  const applyBarDrag = (handle: Handle, h: number) => {
    if (handle === "peak") {
      onChange({ snowHeight: Math.max(0, Math.min(1.5, h)) });
    } else if (handle === "shore") {
      onChange({ shoreHeight: Math.max(0, Math.min(1, h)) });
    }
  };

  const onBarPointerMove = (e: React.PointerEvent) => {
    if (dragging !== "peak" && dragging !== "shore") return;
    applyBarDrag(dragging, heightAt(e.clientY));
  };

  const onDialPointerDown = (e: React.PointerEvent) => {
    setDragging("slope");
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onChange({ slopeAngle: Math.round(angleAt(e.clientX, e.clientY)) });
  };

  const onDialPointerMove = (e: React.PointerEvent) => {
    if (dragging !== "slope") return;
    onChange({ slopeAngle: Math.round(angleAt(e.clientX, e.clientY)) });
  };

  const endDrag = () => setDragging(null);

  const layerOptions = Array.from({ length: Math.max(1, layerCount) }, (_, i) => i);
  const selectedLayer = bandLayer(selected);
  const selectedHeight = selected === "peak" ? snowHeight : selected === "shore" ? shoreHeight : null;
  const selectedBlend = selected === "peak" ? snowBlend : selected === "shore" ? shoreBlend : null;
  const selectedHeightKey = selected === "peak" ? "snowHeight" : "shoreHeight";
  const selectedBlendKey = selected === "peak" ? "snowBlend" : "shoreBlend";

  return (
    <div className="topo-bands">
      <div className="topo-bands-row">
        <div className="topo-bands-column">
          <span className="topo-bands-caption">Altitude</span>
          <div className="topo-bands-bar-wrap">
            <canvas
              ref={barRef}
              className="topo-bands-bar"
              style={{ width: BAR_WIDTH, height: BAR_HEIGHT }}
              onPointerDown={onBarPointerDown}
              onPointerMove={onBarPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
            <div className="topo-bands-scale">
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            {/* Band names sit on the bands they name. */}
            <button
              type="button"
              className={`topo-bands-tag ${selected === "peak" ? "is-selected" : ""}`}
              style={{ top: 2 }}
              onClick={() => setSelected("peak")}
            >
              {layerName(params, snowLayer)}
            </button>
            <button
              type="button"
              className={`topo-bands-tag ${selected === "ground" ? "is-selected" : ""}`}
              style={{ top: BAR_HEIGHT / 2 - 9 }}
              onClick={() => setSelected("ground")}
            >
              {layerName(params, baseLayer)}
            </button>
            {shoreLayer >= 0 && (
              <button
                type="button"
                className={`topo-bands-tag ${selected === "shore" ? "is-selected" : ""}`}
                style={{ top: BAR_HEIGHT - 20 }}
                onClick={() => setSelected("shore")}
              >
                {layerName(params, shoreLayer)}
              </button>
            )}
          </div>
        </div>

        <div className="topo-bands-column">
          <span className="topo-bands-caption">Steepness</span>
          <canvas
            ref={dialRef}
            className="topo-bands-dial"
            style={{ width: DIAL_SIZE, height: DIAL_SIZE }}
            onPointerDown={onDialPointerDown}
            onPointerMove={onDialPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
          <div className="topo-bands-field">
            <label>Cliffs past</label>
            <DragNumberInput
              value={Math.round(slopeAngle)}
              step={1}
              min={0}
              max={90}
              onChange={(v) => onChange({ slopeAngle: v })}
            />
            <span className="topo-bands-unit">°</span>
          </div>
          <div className="topo-bands-field">
            <label>Softness</label>
            <DragNumberInput
              value={Math.round(slopeBlend)}
              step={1}
              min={0}
              max={60}
              onChange={(v) => onChange({ slopeBlend: v })}
            />
            <span className="topo-bands-unit">°</span>
          </div>
          <div className="topo-bands-field">
            <label>Cliffs use</label>
            <select
              value={String(slopeLayer)}
              onChange={(e) => onChange({ slopeLayer: Number(e.target.value) })}
            >
              {layerOptions.map((i) => (
                <option key={i} value={i}>
                  {layerName(params, i)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Details of whichever band is selected, so the panel stays short. */}
      <div className="topo-bands-detail">
        <div className="topo-bands-field">
          <label>{selected === "ground" ? "Ground" : selected === "peak" ? "Peaks" : "Shore"} uses</label>
          <select
            value={String(selectedLayer)}
            onChange={(e) => onChange({ [bandLayerKey(selected)]: Number(e.target.value) })}
          >
            {selected === "shore" && <option value={-1}>Off</option>}
            {layerOptions.map((i) => (
              <option key={i} value={i}>
                {layerName(params, i)}
              </option>
            ))}
          </select>
        </div>

        {selectedHeight !== null && (
          <>
            <div className="topo-bands-field">
              <label>{selected === "peak" ? "Starts at" : "Ends at"}</label>
              <DragNumberInput
                value={Math.round(selectedHeight * 100)}
                step={1}
                min={0}
                max={100}
                onChange={(v) => onChange({ [selectedHeightKey]: v / 100 })}
              />
              <span className="topo-bands-unit">%</span>
            </div>
            <div className="topo-bands-field">
              <label>Softness</label>
              <DragNumberInput
                value={Math.round((selectedBlend ?? 0) * 100)}
                step={1}
                min={0}
                max={100}
                onChange={(v) => onChange({ [selectedBlendKey]: v / 100 })}
              />
              <span className="topo-bands-unit">%</span>
            </div>
          </>
        )}

        {selected === "ground" && (
          <span className="topo-bands-hint">
            Everything between the two lines. Drag a line on the bar to move it.
          </span>
        )}
        {selected === "shore" && shoreLayer < 0 && (
          <span className="topo-bands-hint">Shore is off — pick a layer to switch it on.</span>
        )}
      </div>
    </div>
  );
};
