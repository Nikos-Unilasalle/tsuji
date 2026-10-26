import type { DanceMove } from "./bipedDance";

/**
 * Dice: a choreography rolled from a seed, for the poses wired in. Phrased
 * the way dancers count: two bars at a time, a call and an answer — the
 * answer often the call again, mirrored — moves landing mostly on the strong
 * beats, now and then a bar left to the groove, and the loop's last bar
 * ending on a held pose. Same seed, same lanes, same loop: same dance.
 */

/** A small seeded generator (mulberry32): 0..1. */
function random(seed: number): () => number {
  let a = Math.floor(seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function diceChoreography(lanes: number[], loopBeats: number, seed: number): DanceMove[] {
  if (lanes.length === 0 || !(loopBeats >= 1)) return [];
  const rnd = random(Number.isFinite(seed) ? seed : 0);
  const pick = <T>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
  const bars = Math.max(1, Math.floor(loopBeats / 4));

  // One bar of moves, beats from the bar's start: mostly on 1 and 3, sometimes 2 and 4.
  const rollBar = (): DanceMove[] => {
    if (rnd() < 0.15) return [];
    const out: DanceMove[] = [];
    let beat = pick([0, 0, 0, 1, 2]);
    while (beat < 4) {
      const length = Math.min(4 - beat, pick([1, 1, 2, 2, 3]));
      out.push({ lane: pick(lanes), start: beat, length, mirror: rnd() < 0.35 });
      beat += length + pick([0, 1, 1, 2]);
      if (rnd() < 0.35) break;
    }
    return out;
  };

  const moves: DanceMove[] = [];
  const place = (bar: number, list: DanceMove[]) => list.forEach((m) => moves.push({ ...m, start: m.start + bar * 4 }));
  for (let bar = 0; bar < bars; bar += 2) {
    const call = rollBar();
    place(bar, call);
    if (bar + 1 >= bars) break;
    const echo = rnd() < 0.5;
    place(bar + 1, echo ? call.map((m) => ({ ...m, mirror: !m.mirror })) : rollBar());
  }
  // The finale: the loop's last bar ends on a held pose.
  if (bars >= 2 && rnd() < 0.7) {
    const last = (bars - 1) * 4;
    for (let i = moves.length - 1; i >= 0; i--) if (moves[i].start >= last + 2) moves.splice(i, 1);
    const cut = moves.findIndex((m) => m.start < last + 2 && m.start + m.length > last + 2);
    if (cut >= 0) moves[cut] = { ...moves[cut], length: last + 2 - moves[cut].start };
    moves.push({ lane: pick(lanes), start: last + 2, length: 2, mirror: rnd() < 0.5 });
  }
  return moves.filter((m) => m.start + m.length <= loopBeats);
}
