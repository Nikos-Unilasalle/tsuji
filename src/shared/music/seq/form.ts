/**
 * A song's form, read off its Sections (graph/nodes/musicAlgo.ts): which bars each lane plays in → lettered sections.
 * Shared by the Arrangement HUD (three/SectionsHud.tsx) and the Music Viewer (music/viewer).
 */

const FORM_COLORS = ["#d946ef", "#38bdf8", "#84cc16", "#f59e0b", "#f43f5e", "#a78bfa", "#2dd4bf", "#facc15"];

/** How alike two sets of lanes are (Jaccard: shared over all), 0–1. */
function likeness(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const all = a.size + b.size - shared;
  return all === 0 ? 1 : shared / all;
}

/**
 * The song's form, read off the lanes: bars where the same lanes play are one run; neighbouring runs that share most
 * of their lanes (a part coming in over the others) are one section; a section like an earlier one gets its letter —
 * primed when it is not quite the same (A B A′). Silence has no letter.
 */
export function songForm(masks: readonly boolean[][], total: number): { from: number; to: number; letter: string; color: string }[] {
  const setAt = (b: number) => new Set(masks.flatMap((m, i) => (m[b] ? [i] : [])));
  const runs: { from: number; to: number; lanes: Set<number> }[] = [];
  for (let b = 0; b < total; b++) {
    const lanes = setAt(b);
    const last = runs[runs.length - 1];
    if (last && last.to === b && likeness(last.lanes, lanes) === 1) last.to = b + 1;
    else runs.push({ from: b, to: b + 1, lanes });
  }
  // Neighbours alike enough: one section (its lanes, all that play in it).
  const sections: { from: number; to: number; lanes: Set<number> }[] = [];
  for (const r of runs) {
    const last = sections[sections.length - 1];
    if (last && r.lanes.size > 0 && last.lanes.size > 0 && likeness(last.lanes, r.lanes) >= 0.5) {
      last.to = r.to;
      for (const x of r.lanes) last.lanes.add(x);
    } else sections.push({ ...r, lanes: new Set(r.lanes) });
  }
  const seen: Set<number>[] = [];
  const out: { from: number; to: number; letter: string; color: string }[] = [];
  for (const sct of sections) {
    if (sct.lanes.size === 0) continue;
    let k = seen.findIndex((s) => likeness(s, sct.lanes) >= 0.6);
    const again = k >= 0;
    const same = again && likeness(seen[k], sct.lanes) === 1;
    if (!again) k = seen.push(sct.lanes) - 1;
    const base = k < 26 ? String.fromCharCode(65 + k) : `#${k + 1}`;
    out.push({ from: sct.from, to: sct.to, letter: again && !same ? `${base}′` : base, color: FORM_COLORS[k % FORM_COLORS.length] });
  }
  return out;
}

