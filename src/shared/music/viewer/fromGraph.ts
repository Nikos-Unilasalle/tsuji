/**
 * The Music Viewer's score from a graph as evaluated: the tracks wired into Music Out, named after their voices, and
 * the song's form read off its Sections nodes (when it has any).
 */
import type { Graph } from "../../graph/types";
import { alignSections, isTrack, type TrackDescription } from "../engine/description";
import { parseBars } from "../../graph/nodes/musicAlgo";
import { songForm } from "../seq/form";
import { buildScore, type ViewerScore, type ViewerSection } from "./score";

type Results = { get(id: string): Record<string, unknown> | undefined } | null | undefined;

/** The tracks Music Out mixes, in socket order, each with a name: its voice node's own name, else its preset. */
export function viewerTracks(graph: Graph, results: Results): { desc: TrackDescription; name: string }[] {
  const out = graph.nodes.find((n) => n.type === "music/out");
  if (!out || !results) return [];
  const wires = graph.connections
    .filter((c) => c.toNode === out.id && c.toSocket.startsWith("track"))
    .sort((a, b) => Number(a.toSocket.slice(5)) - Number(b.toSocket.slice(5)));
  const tracks: { desc: TrackDescription; name: string }[] = [];
  for (const c of wires) {
    const v = results.get(c.fromNode)?.[c.fromSocket];
    if (!isTrack(v)) continue;
    let voice = graph.nodes.find((n) => n.id === c.fromNode);
    // A Sections after the voice: named after the voice behind it.
    for (let hops = 0; hops < 8 && voice?.type === "music/sections" && !String(voice.params.name ?? "").trim(); hops++) {
      const into = graph.connections.find((w) => w.toNode === voice!.id && w.toSocket === "sequence");
      voice = into ? graph.nodes.find((n) => n.id === into.fromNode) : undefined;
    }
    const name = String(voice?.params.name ?? "").trim() || String(voice?.params.preset ?? "").trim() || (v.kind === "drums" ? "Drums" : voice?.id ?? v.id);
    tracks.push({ desc: v, name });
  }
  const descs = alignSections(tracks.map((t) => t.desc));
  return tracks.map((t, i) => ({ ...t, desc: descs[i] }));
}

/** The song's form in seconds, from every Sections node's bars. */
export function viewerForm(graph: Graph, bpm: number, stepsPerBeat: number): ViewerSection[] {
  const sections = graph.nodes.filter((n) => n.type === "music/sections");
  if (sections.length === 0) return [];
  const masks = sections.map((n) => parseBars(String(n.params.bars ?? "")));
  const total = Math.max(0, ...masks.map((m) => m.length));
  if (total === 0) return [];
  const barLength = Math.max(1, Math.round(Number(sections[0].params.barLength) || 16));
  const barSeconds = (barLength / Math.max(1, stepsPerBeat)) * (60 / Math.max(1, bpm));
  return songForm(masks, total).map((f) => ({ from: f.from * barSeconds, to: f.to * barSeconds, letter: f.letter }));
}

export function viewerScoreFromGraph(graph: Graph, results: Results, seconds: number): ViewerScore {
  const tracks = viewerTracks(graph, results);
  const clock = tracks[0]?.desc.seq.clock;
  return buildScore(tracks, seconds, clock ? viewerForm(graph, clock.bpm, clock.stepsPerBeat) : []);
}

/**
 * viewerScoreFromGraph, remembered: the score is built again only when a track (by identity), a name, the Sections or
 * the length change — so a live view can ask every frame.
 */
export function scoreCache(): (graph: Graph, results: Results, seconds: number) => ViewerScore {
  let key: unknown[] = [];
  let score: ViewerScore | null = null;
  return (graph, results, seconds) => {
    const tracks = viewerTracks(graph, results);
    const sections = graph.nodes.filter((n) => n.type === "music/sections").map((n) => `${n.params.bars}|${n.params.barLength}`).join(";");
    const next = [seconds, sections, ...tracks.flatMap((t) => [t.desc, t.name])];
    if (!score || next.length !== key.length || next.some((x, i) => x !== key[i])) {
      const clock = tracks[0]?.desc.seq.clock;
      score = buildScore(tracks, seconds, clock ? viewerForm(graph, clock.bpm, clock.stepsPerBeat) : []);
      key = next;
    }
    return score;
  };
}
