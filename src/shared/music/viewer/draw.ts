/**
 * The Music Viewer's picture: one frame of the song as light, drawn on a 2D canvas from the score (score.ts) and the
 * time alone — nothing kept between frames, every sparkle seeded by the note that made it — so the 3D view's live
 * overlay and a frame-exact video export draw exactly the same thing.
 *
 *   ┌ form strip ─────────────────────────────────────── A ── B ── A′ ┐
 *   │ Title                                           legend + meters │
 *   │ 96 BPM · bar 12 · 0:28 / 2:50                                   │
 *   │                    ◎ mandala on the circle of fifths            │
 *   │   notes as glowing points (pitch class → angle, height → radius) │
 *   │   chords as polygons, onsets as ripples, kicks as shock rings   │
 *   │ ═══════ river: notes flowing past the playhead ════════════════ │
 *   └─────────────────────────────────────────────────────── progress ┘
 *
 * Under it all an aurora that breathes with how much is playing, stars, and a pulse on every beat.
 */
import { ViewerNote, ViewerScore, firstAt } from "./score";

export const VIEWER_STYLES = ["galaxy", "mandala", "river"] as const;
export type ViewerStyle = (typeof VIEWER_STYLES)[number];

export const VIEWER_PALETTES = {
  neon: { bg: "#05040d", colors: ["#ff3cac", "#00f0ff", "#7cff4f", "#ffd23f", "#b967ff", "#ff6b35", "#05ffa1", "#fffb96"] },
  sunset: { bg: "#0d0507", colors: ["#ff6b6b", "#feca57", "#ff9ff3", "#f368e0", "#ff9f43", "#ee5253", "#fd79a8", "#ffeaa7"] },
  ocean: { bg: "#020812", colors: ["#00d2ff", "#3a7bd5", "#00ffcc", "#7f7fd5", "#91eae4", "#48dbfb", "#0abde3", "#c7ecee"] },
  aurora: { bg: "#03070a", colors: ["#a8ff78", "#78ffd6", "#e0c3fc", "#8ec5fc", "#f093fb", "#f5576c", "#4facfe", "#43e97b"] },
  chip: { bg: "#071208", colors: ["#9bbc0f", "#e0f8d0", "#88c070", "#c4f0c2", "#8bac0f", "#d0f0a0", "#a8d878", "#f8f8a8"] },
} as const;
export type ViewerPalette = keyof typeof VIEWER_PALETTES;
export const VIEWER_PALETTE_NAMES = Object.keys(VIEWER_PALETTES) as ViewerPalette[];

export interface ViewerOptions {
  style: ViewerStyle;
  palette: ViewerPalette;
  title: string;
  /** 0–2: how much light — glow sizes, aurora, ripples. */
  intensity: number;
  /** Seconds of the river ahead of the playhead. */
  ahead: number;
  /** Track names and meters. */
  legend: boolean;
}

/** A Music Viewer node's params as drawing options. */
export function viewerOptions(params: Record<string, unknown>, fallbackTitle: string): ViewerOptions {
  return {
    style: (VIEWER_STYLES as readonly string[]).includes(String(params.style)) ? (params.style as ViewerStyle) : "galaxy",
    palette: (VIEWER_PALETTE_NAMES as readonly string[]).includes(String(params.palette)) ? (params.palette as ViewerPalette) : "neon",
    title: String(params.title ?? "").trim() || fallbackTitle,
    intensity: Number.isFinite(Number(params.intensity)) ? Number(params.intensity) : 1,
    ahead: Math.max(1, Number(params.ahead) || 6),
    legend: params.legend !== false,
  };
}

const TAU = Math.PI * 2;
const RELEASE = 0.35;
const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

const rgbCache = new Map<string, [number, number, number]>();
function rgba(hex: string, a: number): string {
  let c = rgbCache.get(hex);
  if (!c) {
    const h = hex.replace("#", "");
    c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    rgbCache.set(hex, c);
  }
  return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** How much a note is sounding at t, 0–1: full at its onset, settling while held, fading after its end. */
export function envelope(n: ViewerNote, t: number): number {
  if (t < n.on) return 0;
  if (t < n.off) return 1 - 0.4 * Math.min(1, (t - n.on) / Math.max(0.25, n.off - n.on));
  return 0.6 * Math.exp(-(t - n.off) / (RELEASE / 3));
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Which kind of hit a percussion note is, by the General MIDI-ish numbers the kits use. */
function hitKind(pitch: number): "kick" | "snare" | "hat" | "tom" {
  if (pitch <= 37) return "kick";
  if (pitch <= 40) return "snare";
  if (pitch === 42 || pitch === 44 || pitch === 46 || pitch >= 51) return "hat";
  return "tom";
}

export function drawViewer(ctx: CanvasRenderingContext2D, w: number, h: number, score: ViewerScore, time: number, o: ViewerOptions): void {
  const pal = VIEWER_PALETTES[o.palette] ?? VIEWER_PALETTES.neon;
  const colorOf = (track: number) => pal.colors[track % pal.colors.length];
  const u = Math.min(w, h) / 1080;
  const k = Math.max(0, Math.min(2, o.intensity));
  const dur = Math.max(0.001, score.duration);
  const t = time < 0 ? time : time % dur;
  const beat = (t * score.bpm) / 60;
  const pulse = t >= 0 ? Math.exp(-(beat - Math.floor(beat)) * 5) : 0;

  // The notes around now: those that may still sound, and (for the river) those coming.
  const ahead = Math.max(1, o.ahead);
  const past = ahead * 0.45;
  const from = firstAt(score.notes, t - Math.max(score.longest, past) - RELEASE);
  const to = firstAt(score.notes, t + ahead);
  const near = score.notes.slice(from, to);
  const sounding = near.filter((n) => n.on <= t && t < n.off + RELEASE);
  const activity = new Array(score.tracks.length).fill(0);
  let energy = 0;
  for (const n of sounding) {
    const e = envelope(n, t) * n.velocity * Math.min(1.5, 0.4 + (score.tracks[n.track]?.level ?? 1));
    activity[n.track] += e;
    energy += e;
  }
  const glow = 1 - Math.exp(-energy * 0.5);

  // ── background: deep colour, a breathing aurora, stars ───────────────────
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  for (let b = 0; b < 4; b++) {
    const x = w * (0.5 + 0.38 * Math.sin(t * 0.06 + b * 2.1));
    const y = h * (0.45 + 0.3 * Math.cos(t * 0.045 + b * 1.7));
    const r = Math.max(w, h) * (0.42 + 0.12 * Math.sin(t * 0.09 + b));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(pal.colors[(b * 3) % pal.colors.length], (0.07 + 0.16 * glow + 0.04 * pulse) * (0.5 + k / 2)));
    g.addColorStop(1, rgba(pal.colors[(b * 3) % pal.colors.length], 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  for (let i = 0; i < 170; i++) {
    const x = hash(i) * w;
    const y = hash(i + 0.37) * h;
    const tw = 0.5 + 0.5 * Math.sin(t * (0.6 + hash(i + 0.7) * 2.2) + i);
    ctx.fillStyle = `rgba(255,255,255,${(0.08 + 0.3 * tw * (0.6 + 0.4 * glow)).toFixed(3)})`;
    const s = u * (0.7 + hash(i + 0.9) * 1.6);
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();

  // ── mandala ───────────────────────────────────────────────────────────────
  if (o.style !== "river") {
    const cx = w / 2;
    const cy = o.style === "mandala" ? h * 0.52 : h * 0.44;
    const R = Math.min(w, h) * (o.style === "mandala" ? 0.34 : 0.26);
    const span = Math.max(12, score.hi - score.lo);
    const angleOf = (pitch: number) => -Math.PI / 2 + ((((Math.round(pitch) % 12) + 12) % 12) * 7 % 12) / 12 * TAU;
    const radiusOf = (pitch: number) => R * (0.3 + 0.7 * Math.min(1, Math.max(0, (pitch - score.lo) / span)));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // rings and the circle of fifths
    ctx.lineWidth = u;
    for (const f of [0.3, 0.65, 1]) {
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.03 * pulse})`;
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, TAU);
      ctx.stroke();
    }
    const litPcs = new Set(sounding.filter((n) => !score.tracks[n.track]?.drums && envelope(n, t) > 0.3).map((n) => ((Math.round(n.pitch) % 12) + 12) % 12));
    ctx.font = `600 ${Math.round(15 * u)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let pc = 0; pc < 12; pc++) {
      const a = angleOf(pc);
      const lit = litPcs.has(pc);
      ctx.fillStyle = lit ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.28)";
      ctx.fillText(NOTE_NAMES[pc], cx + Math.cos(a) * R * 1.13, cy + Math.sin(a) * R * 1.13);
      ctx.strokeStyle = `rgba(255,255,255,${lit ? 0.5 : 0.12})`;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02);
      ctx.lineTo(cx + Math.cos(a) * R * 1.06, cy + Math.sin(a) * R * 1.06);
      ctx.stroke();
    }

    // the step ring: one bead per step of the bar, the current one lit
    if (t >= 0) {
      const perBar = Math.max(1, score.stepsPerBeat * 4);
      const stepF = beat * score.stepsPerBeat;
      const cur = Math.floor(stepF) % perBar;
      const rot = t * 0.04;
      for (let s = 0; s < perBar; s++) {
        const a = -Math.PI / 2 + rot + (s / perBar) * TAU;
        const since = (((cur - s) % perBar) + perBar) % perBar;
        const lit = Math.exp(-since * 0.9);
        ctx.fillStyle = rgba(pal.colors[0], 0.12 + 0.85 * lit);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * 1.24, cy + Math.sin(a) * R * 1.24, u * (s % score.stepsPerBeat === 0 ? 4 : 2.5) * (1 + lit * 0.6), 0, TAU);
        ctx.fill();
      }
    }

    // chords: each track's sounding notes joined, around the circle
    const byTrack = new Map<number, { a: number; x: number; y: number; e: number }[]>();
    for (const n of sounding) {
      if (score.tracks[n.track]?.drums) continue;
      const e = envelope(n, t);
      if (e < 0.25) continue;
      const a = angleOf(n.pitch);
      const r = radiusOf(n.pitch);
      const list = byTrack.get(n.track) ?? [];
      list.push({ a, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, e });
      byTrack.set(n.track, list);
    }
    for (const [track, pts] of byTrack) {
      if (pts.length < 2) continue;
      pts.sort((p, q) => p.a - q.a);
      const e = pts.reduce((s, p) => s + p.e, 0) / pts.length;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = rgba(colorOf(track), (0.05 + 0.12 * e) * (0.5 + k / 2));
      ctx.fill();
      ctx.strokeStyle = rgba(colorOf(track), 0.55 * e);
      ctx.lineWidth = 1.5 * u;
      ctx.stroke();
    }

    // notes: spokes, glows, ripples; hits: shock rings, sparks, twinkles
    for (const n of near) {
      if (n.on > t) continue;
      const age = t - n.on;
      const color = colorOf(n.track);
      const e = envelope(n, t);
      if (score.tracks[n.track]?.drums) {
        const kind = hitKind(n.pitch);
        const seed = n.on * 97 + n.track;
        if (kind === "kick" && age < 0.9) {
          const f = age / 0.9;
          ctx.strokeStyle = rgba(color, (1 - f) * (1 - f) * 0.8 * n.velocity * (0.5 + k / 2));
          ctx.lineWidth = u * 10 * (1 - f) + u;
          ctx.beginPath();
          ctx.arc(cx, cy, R * (0.12 + f * 1.5), 0, TAU);
          ctx.stroke();
        } else if (kind === "snare" && age < 0.6) {
          const f = age / 0.6;
          ctx.strokeStyle = `rgba(255,255,255,${((1 - f) * 0.75 * n.velocity).toFixed(3)})`;
          ctx.lineWidth = 2 * u;
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * TAU + hash(seed) * TAU;
            const r0 = R * (0.18 + f * 0.5);
            const r1 = R * (0.24 + f * 1.1);
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
            ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            ctx.stroke();
          }
        } else if (age < 0.35) {
          const f = age / 0.35;
          const a = hash(seed) * TAU;
          const r = R * (kind === "hat" ? 1.24 + hash(seed + 1) * 0.15 : 0.9);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          const g = ctx.createRadialGradient(x, y, 0, x, y, u * 22 * (1 + f));
          g.addColorStop(0, rgba(color, (1 - f) * n.velocity));
          g.addColorStop(1, rgba(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, u * 22 * (1 + f), 0, TAU);
          ctx.fill();
        }
        continue;
      }
      const a = angleOf(n.pitch);
      const r = radiusOf(n.pitch);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (age < 1.4) {
        const f = age / 1.4;
        ctx.strokeStyle = rgba(color, (1 - f) * (1 - f) * 0.7 * n.velocity * (0.5 + k / 2));
        ctx.lineWidth = 1.5 * u;
        ctx.beginPath();
        ctx.arc(x, y, u * (6 + f * 80 * (0.6 + k / 2)), 0, TAU);
        ctx.stroke();
      }
      if (e <= 0.01) continue;
      ctx.strokeStyle = rgba(color, 0.18 * e);
      ctx.lineWidth = u;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      const size = u * (10 + 30 * n.velocity * e) * (0.6 + k * 0.4);
      const g = ctx.createRadialGradient(x, y, 0, x, y, size);
      g.addColorStop(0, rgba("#ffffff", 0.9 * e));
      g.addColorStop(0.25, rgba(color, 0.85 * e));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }

    // the core, beating
    const core = R * 0.11 * (1 + 0.25 * pulse + 0.35 * glow);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2.2);
    cg.addColorStop(0, "rgba(255,255,255,0.9)");
    cg.addColorStop(0.35, rgba(pal.colors[0], 0.6 + 0.3 * glow));
    cg.addColorStop(1, rgba(pal.colors[1], 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, core * 2.2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ── river ─────────────────────────────────────────────────────────────────
  if (o.style !== "mandala") {
    const y0 = o.style === "river" ? h * 0.2 : h * 0.77;
    const y1 = o.style === "river" ? h * 0.86 : h * 0.95;
    const px = w * 0.28;
    const pps = w / (ahead + past);
    const span = Math.max(12, score.hi - score.lo);
    const drumLane = (y1 - y0) * 0.12;
    const pitchY = (p: number) => y1 - drumLane - ((p - score.lo) / span) * (y1 - y0 - drumLane - 4 * u);
    const bar = Math.max(2.5 * u, Math.min(12 * u, ((y1 - y0) / (span + 1)) * 0.85));
    ctx.save();
    // fade the river's edges into the night
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, y0 - 6 * u, w, y1 - y0 + 12 * u);
    ctx.globalCompositeOperation = "lighter";
    // beat lines
    if (t >= 0) {
      const spb = 60 / score.bpm;
      for (let b = Math.ceil((t - past) / spb); b * spb < t + ahead; b++) {
        const x = px + (b * spb - t) * pps;
        const downbeat = b % 4 === 0;
        ctx.fillStyle = `rgba(255,255,255,${downbeat ? 0.09 : 0.035})`;
        ctx.fillRect(x, y0, downbeat ? 1.5 * u : u, y1 - y0);
      }
    }
    for (const n of near) {
      const x0 = px + (n.on - t) * pps;
      const x1 = Math.max(x0 + 3 * u, px + (n.off - t) * pps);
      if (x1 < 0 || x0 > w) continue;
      const color = colorOf(n.track);
      const playing = n.on <= t && t < n.off;
      const done = n.off <= t;
      const fade = done ? Math.max(0, 1 - (t - n.off) / past) : 1;
      const alpha = playing ? 1 : done ? 0.3 * fade : 0.45;
      if (score.tracks[n.track]?.drums) {
        const y = y1 - drumLane / 2 + (hash(n.track) - 0.5) * drumLane * 0.6;
        const s = u * (3 + 5 * n.velocity) * (playing || (n.on <= t && t - n.on < 0.15) ? 1.8 : 1);
        ctx.fillStyle = rgba(color, done ? 0.35 * fade : 0.8);
        ctx.beginPath();
        ctx.moveTo(x0, y - s);
        ctx.lineTo(x0 + s, y);
        ctx.lineTo(x0, y + s);
        ctx.lineTo(x0 - s, y);
        ctx.closePath();
        ctx.fill();
        continue;
      }
      const y = pitchY(n.pitch) - bar / 2;
      ctx.fillStyle = rgba(color, alpha * (0.4 + 0.6 * n.velocity));
      if (playing) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 18 * u * (0.5 + k / 2);
      }
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x0, y, x1 - x0, bar, bar / 2);
      else ctx.rect(x0, y, x1 - x0, bar);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (playing) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(px, y + bar / 2, bar * 0.7, 0, TAU);
        ctx.fill();
      }
    }
    // the playhead
    const pg = ctx.createLinearGradient(0, y0, 0, y1);
    pg.addColorStop(0, rgba(pal.colors[0], 0));
    pg.addColorStop(0.5, rgba(pal.colors[0], 0.8 + 0.2 * pulse));
    pg.addColorStop(1, rgba(pal.colors[0], 0));
    ctx.fillStyle = pg;
    ctx.fillRect(px - u, y0, 2 * u, y1 - y0);
    ctx.restore();
  }

  // ── text: title, time, form, legend, progress ─────────────────────────────
  ctx.save();
  const m = 48 * u;
  // form strip
  if (score.form.length > 0) {
    const fy = 22 * u;
    const fw = w - 2 * m;
    score.form.forEach((s) => {
      const x = m + (s.from / dur) * fw;
      const sw = Math.max(2, ((s.to - s.from) / dur) * fw - 3 * u);
      const isNow = t >= s.from && t < s.to;
      const color = pal.colors[(s.letter.charCodeAt(0) - 65 + pal.colors.length * 4) % pal.colors.length];
      ctx.fillStyle = rgba(color, isNow ? 0.95 : 0.35);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, fy, sw, 6 * u, 3 * u);
      else ctx.rect(x, fy, sw, 6 * u);
      ctx.fill();
      ctx.font = `700 ${Math.round(13 * u)}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = isNow ? "#fff" : "rgba(255,255,255,0.4)";
      if (sw > 14 * u) ctx.fillText(s.letter, x, fy + 10 * u);
    });
    ctx.fillStyle = "#fff";
    ctx.fillRect(m + (Math.max(0, t) / dur) * fw - u, fy - 4 * u, 2 * u, 14 * u);
  }
  // title
  const ty = score.form.length > 0 ? 92 * u : 72 * u;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${Math.round(46 * u)}px system-ui, -apple-system, sans-serif`;
  const tg = ctx.createLinearGradient(m, 0, m + 520 * u, 0);
  tg.addColorStop(0, pal.colors[0]);
  tg.addColorStop(0.5, pal.colors[1]);
  tg.addColorStop(1, pal.colors[2]);
  ctx.fillStyle = tg;
  ctx.shadowColor = rgba(pal.colors[0], 0.6);
  ctx.shadowBlur = 24 * u * (0.3 + glow);
  ctx.fillText(o.title || "Untitled", m, ty);
  ctx.shadowBlur = 0;
  ctx.font = `500 ${Math.round(17 * u)}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  const barNo = Math.floor(Math.max(0, beat) / 4) + 1;
  const beatNo = (Math.floor(Math.max(0, beat)) % 4) + 1;
  const section = score.form.find((s) => t >= s.from && t < s.to);
  ctx.fillText(`${Math.round(score.bpm)} BPM · bar ${barNo}.${beatNo}${section ? ` · section ${section.letter}` : ""} · ${clock(Math.max(0, t))} / ${clock(dur)}`, m, ty + 32 * u);

  // legend with meters
  if (o.legend && score.tracks.length > 0) {
    const rowH = Math.min(24 * u, (h * 0.62) / score.tracks.length);
    const lx = w - m - 230 * u;
    let ly = ty - 30 * u;
    ctx.font = `500 ${Math.round(Math.min(14 * u, rowH * 0.62))}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    score.tracks.forEach((tr, i) => {
      const a = Math.min(1, activity[i]);
      const color = colorOf(i);
      ctx.fillStyle = rgba(color, 0.35 + 0.65 * a);
      ctx.beginPath();
      ctx.arc(lx, ly, rowH * 0.22 * (1 + a * 0.5), 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${(0.45 + 0.5 * a).toFixed(3)})`;
      ctx.textAlign = "left";
      const name = tr.name.length > 22 ? `${tr.name.slice(0, 21)}…` : tr.name;
      ctx.fillText(name, lx + 12 * u, ly);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(lx + 160 * u, ly - 2 * u, 70 * u, 4 * u);
      ctx.fillStyle = rgba(color, 0.9);
      ctx.fillRect(lx + 160 * u, ly - 2 * u, 70 * u * a, 4 * u);
      ly += rowH;
    });
  }
  // progress
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, h - 4 * u, w, 4 * u);
  const pgr = ctx.createLinearGradient(0, 0, w, 0);
  pgr.addColorStop(0, pal.colors[0]);
  pgr.addColorStop(1, pal.colors[1]);
  ctx.fillStyle = pgr;
  ctx.fillRect(0, h - 4 * u, (Math.max(0, t) / dur) * w, 4 * u);
  ctx.restore();
}
