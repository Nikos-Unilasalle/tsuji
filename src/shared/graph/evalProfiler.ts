/**
 * Opt-in timing of the per-frame graph evaluation: where a frame's
 * milliseconds go, node by node, plus a few viewport phases (scene sync,
 * render) and gauges (live GPU geometries/textures, JS heap) to spot leaks.
 *
 * Off by default and free when off: evaluate.ts checks one module-level
 * variable per node. Started from the profiler overlay (Ctrl+Shift+P), from
 * the console (`__tsuji.profile.start()`), or by the headless stress bench
 * (stress.bench.test.ts).
 */

export interface NodeStat {
  nodeId: string;
  type: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  /** Sum of `counter` deltas across this node's calls — see EvalProfiler.counter. */
  allocs: number;
}

export interface TypeStat {
  type: string;
  nodes: number;
  calls: number;
  totalMs: number;
  maxMs: number;
  allocs: number;
}

export interface PhaseStat {
  name: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

export interface FrameSummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ProfileReport {
  frames: FrameSummary;
  byNode: NodeStat[];
  byType: TypeStat[];
  phases: PhaseStat[];
  gauges: Record<string, number>;
}

/** Enough for a few seconds at 60 fps — percentiles over a sliding window, not the whole session. */
const FRAME_WINDOW = 600;

export class EvalProfiler {
  readonly nodes = new Map<string, NodeStat>();
  readonly phases = new Map<string, PhaseStat>();
  readonly gauges = new Map<string, number>();
  /**
   * Optional monotonic counter sampled around each node (the bench plugs in
   * "BufferGeometries created so far"), so allocation-heavy nodes show up
   * next to slow ones.
   */
  counter: (() => number) | null = null;
  /** Type of the node whose evaluate is running right now (the innermost, inside a group), or null between nodes. */
  currentType: string | null = null;
  private frameMs: number[] = [];
  private frameCount = 0;

  recordNode(nodeId: string, type: string, ms: number, allocs = 0): void {
    let stat = this.nodes.get(nodeId);
    if (!stat) {
      stat = { nodeId, type, calls: 0, totalMs: 0, maxMs: 0, lastMs: 0, allocs: 0 };
      this.nodes.set(nodeId, stat);
    }
    stat.calls++;
    stat.totalMs += ms;
    stat.lastMs = ms;
    stat.allocs += allocs;
    if (ms > stat.maxMs) stat.maxMs = ms;
  }

  /** One top-level evaluateGraph call (a group's nested pass is not a frame). */
  recordFrame(ms: number): void {
    this.frameCount++;
    this.frameMs.push(ms);
    if (this.frameMs.length > FRAME_WINDOW) this.frameMs.shift();
    this.recordPhase("evaluate", ms);
  }

  recordPhase(name: string, ms: number): void {
    let stat = this.phases.get(name);
    if (!stat) {
      stat = { name, calls: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      this.phases.set(name, stat);
    }
    stat.calls++;
    stat.totalMs += ms;
    stat.lastMs = ms;
    if (ms > stat.maxMs) stat.maxMs = ms;
  }

  /** Top-level evaluations recorded so far — the viewport compares it before/after a tick to skip suspended ticks. */
  get frameTotal(): number {
    return this.frameCount;
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  reset(): void {
    this.nodes.clear();
    this.phases.clear();
    this.gauges.clear();
    this.frameMs = [];
    this.frameCount = 0;
  }

  report(): ProfileReport {
    const sorted = [...this.frameMs].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    const frames: FrameSummary = {
      count: this.frameCount,
      meanMs: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    };

    const byNode = [...this.nodes.values()].sort((a, b) => b.totalMs - a.totalMs);

    const types = new Map<string, TypeStat>();
    for (const n of byNode) {
      let t = types.get(n.type);
      if (!t) {
        t = { type: n.type, nodes: 0, calls: 0, totalMs: 0, maxMs: 0, allocs: 0 };
        types.set(n.type, t);
      }
      t.nodes++;
      t.calls += n.calls;
      t.totalMs += n.totalMs;
      t.allocs += n.allocs;
      if (n.maxMs > t.maxMs) t.maxMs = n.maxMs;
    }

    return {
      frames,
      byNode,
      byType: [...types.values()].sort((a, b) => b.totalMs - a.totalMs),
      phases: [...this.phases.values()].sort((a, b) => b.totalMs - a.totalMs),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  /** Plain-text tables, for the console, the overlay and the bench output. */
  format(top = 20, sortBy: "time" | "allocs" = "time"): string {
    const r = this.report();
    const ms = (v: number) => v.toFixed(2).padStart(9);
    const lines: string[] = [];
    const f = r.frames;
    lines.push(
      `evaluate: ${f.count} frames  mean ${f.meanMs.toFixed(2)} ms  p50 ${f.p50Ms.toFixed(2)}  p95 ${f.p95Ms.toFixed(2)}  max ${f.maxMs.toFixed(2)}`,
    );
    if (r.phases.length) {
      lines.push("", "phase                     mean ms    max ms");
      for (const p of r.phases) {
        lines.push(`${p.name.padEnd(22)}${ms(p.totalMs / Math.max(1, p.calls))} ${ms(p.maxMs)}`);
      }
    }
    const gaugeKeys = Object.keys(r.gauges);
    if (gaugeKeys.length) {
      lines.push("", gaugeKeys.map((k) => `${k}=${Math.round(r.gauges[k])}`).join("  "));
    }
    const frameCalls = Math.max(1, f.count);
    const withAllocs = this.counter !== null;
    const byType = sortBy === "allocs" ? [...r.byType].sort((a, b) => b.allocs - a.allocs) : r.byType;
    lines.push("", `type                              nodes  ms/frame    max ms   share${withAllocs ? "  allocs/frame" : ""}`);
    const evalTotal = r.byType.reduce((s, t) => s + t.totalMs, 0) || 1;
    for (const t of byType.slice(0, top)) {
      const allocCol = withAllocs ? (t.allocs / frameCalls).toFixed(1).padStart(14) : "";
      lines.push(
        `${t.type.slice(0, 32).padEnd(32)} ${String(t.nodes).padStart(6)}${ms(t.totalMs / frameCalls)} ${ms(t.maxMs)}  ${((100 * t.totalMs) / evalTotal).toFixed(1).padStart(5)}%${allocCol}`,
      );
    }
    lines.push("", "node                              type                         ms/call    max ms");
    for (const n of r.byNode.slice(0, top)) {
      lines.push(
        `${n.nodeId.slice(0, 32).padEnd(32)}  ${n.type.slice(0, 26).padEnd(26)}${ms(n.totalMs / Math.max(1, n.calls))} ${ms(n.maxMs)}`,
      );
    }
    return lines.join("\n");
  }
}

let active: EvalProfiler | null = null;

/** The running profiler, or null — evaluate.ts reads this once per frame. */
export function getEvalProfiler(): EvalProfiler | null {
  return active;
}

export function startEvalProfiling(): EvalProfiler {
  if (!active) active = new EvalProfiler();
  return active;
}

export function stopEvalProfiling(): EvalProfiler | null {
  const p = active;
  active = null;
  return p;
}
