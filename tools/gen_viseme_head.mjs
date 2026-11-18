#!/usr/bin/env node
/**
 * Builds public/demos/viseme_head.glb: a cartoon head whose mouth carries the 15 Oculus /
 * Ready Player Me viseme shape keys (viseme_sil … viseme_U), for the Lip Sync → Morph Targets demo.
 *
 *   node tools/gen_viseme_head.mjs
 *
 * Everything around the mouth — lips, the dark inside, upper teeth, tongue, the chin and the brows —
 * is built by one function from a handful of mouth gestures (jaw open, upper lip raise, width,
 * pucker, tongue …). Each viseme is just a different set of gestures; its morph target is the
 * difference between that build and the neutral one, so all meshes move together and stay glued
 * to the face. The head is a unit sphere and every face feature is projected onto it, so the chin
 * (rotated about the jaw hinge) and the lips (projected) slide over the same surface.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// GLTFExporter reads its Blob back through FileReader, which Node does not have.
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.({ target: this });
        this.onload?.({ target: this });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
        this.onloadend?.({ target: this });
        this.onload?.({ target: this });
      });
    }
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/demos/viseme_head.glb");

const VISEMES = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS",
  "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
];

// ---------------------------------------------------------------- mouth gestures

const NEUTRAL = {
  open: 0, // lower lip / jaw drop
  up: 0, // upper lip raise (shows teeth)
  width: 1, // mouth width multiplier
  push: 0, // pucker forward (also narrows)
  lip: 1, // lip thickness multiplier
  smile: 0, // corners up
  tuck: 0, // lower lip rolled up and back under the teeth (F, V)
  tongueUp: 0, // tongue tip raised to the palate (D, N, L)
  tongueOut: 0, // tongue between the teeth (TH)
  brow: 0, // eyebrows raise
};

const SHAPES = {
  viseme_sil: {},
  viseme_PP: { open: -0.012, width: 0.94, push: 0.15, lip: 0.78 },
  viseme_FF: { open: 0.01, up: 0.045, width: 1.06, tuck: 1 },
  viseme_TH: { open: 0.06, up: 0.025, width: 1.04, tongueOut: 1 },
  viseme_DD: { open: 0.09, up: 0.02, width: 1.06, tongueUp: 1 },
  viseme_kk: { open: 0.13, up: 0.025, width: 1.04 },
  viseme_CH: { open: 0.06, up: 0.035, width: 0.8, push: 0.6, lip: 1.1 },
  viseme_SS: { open: 0.03, up: 0.035, width: 1.25, smile: 0.035 },
  viseme_nn: { open: 0.07, up: 0.01, width: 1.05, tongueUp: 1 },
  viseme_RR: { open: 0.08, up: 0.02, width: 0.82, push: 0.4 },
  viseme_aa: { open: 0.34, up: 0.04, width: 1.1, brow: 0.05 },
  viseme_E: { open: 0.17, up: 0.045, width: 1.3, smile: 0.025, brow: 0.025 },
  viseme_I: { open: 0.1, up: 0.035, width: 1.42, smile: 0.055, brow: 0.01 },
  viseme_O: { open: 0.24, up: 0.05, width: 0.6, push: 0.55, lip: 1.1, brow: 0.05 },
  viseme_U: { open: 0.06, up: 0.01, width: 0.45, push: 1, lip: 1.18 },
};

// ---------------------------------------------------------------- face layout (unit sphere head)

const MOUTH_Y = -0.34; // mouth centre height on the face
const MOUTH_W = 0.3; // neutral half width
const LIP_R = 0.05; // neutral lip tube radius
const LIP_SEG = 96; // around the mouth
const LIP_TUBE = 12; // around each lip
const DISK_RINGS = 6;
const TEETH_SEG = 48;
const TONGUE_SEG = 48;
const TONGUE_RINGS = 6;

/** The face surface point under (x, y), lifted `lift` along the sphere normal. */
function onFace(x, y, lift = 0) {
  const z = Math.sqrt(Math.max(0.0001, 1 - x * x - y * y));
  const n = new THREE.Vector3(x, y, z).normalize();
  return n.clone().multiplyScalar(1 + lift);
}

function mouthFrame(s) {
  const width = MOUTH_W * s.width * (1 - 0.35 * s.push);
  const lip = LIP_R * s.lip;
  const hUp = lip * 0.85 + s.up;
  const hLo = lip * 0.95 + s.open;
  const lift = lip * 0.55 + s.push * 0.13;
  /** Centre line of the lip ring at angle t (0 = right corner, π/2 = top). */
  const centre = (t) => {
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const h = sn >= 0 ? hUp : hLo;
    let y = MOUTH_Y + h * sn + s.smile * Math.pow(c, 4);
    let l = lift * (0.6 + 0.4 * Math.abs(sn)); // corners sink into the cheeks
    if (sn < 0) {
      y += 0.03 * s.tuck * -sn;
      l -= 0.035 * s.tuck * -sn;
    }
    return { x: width * c, y, lift: l, nx: c / width, ny: sn / h };
  };
  const radius = (t) => {
    const sn = Math.sin(t);
    return lip * (sn >= 0 ? 0.85 : 1) * (0.5 + 0.5 * Math.pow(Math.abs(sn), 0.6));
  };
  return { width, lip, hUp, hLo, centre, radius };
}

// ---------------------------------------------------------------- per-part builders (positions only)

function buildLips(s) {
  const f = mouthFrame(s);
  const out = [];
  for (let i = 0; i <= LIP_SEG; i++) {
    const t = (i / LIP_SEG) * Math.PI * 2;
    const c = f.centre(t);
    const p = onFace(c.x, c.y, c.lift);
    const n = onFace(c.x, c.y).normalize();
    const radial = new THREE.Vector3(c.nx, c.ny, 0).normalize();
    radial.addScaledVector(n, -radial.dot(n)).normalize();
    const r = f.radius(t);
    for (let j = 0; j <= LIP_TUBE; j++) {
      const a = (j / LIP_TUBE) * Math.PI * 2;
      const q = p.clone().addScaledVector(radial, Math.cos(a) * r).addScaledVector(n, Math.sin(a) * r * 0.85);
      out.push(q.x, q.y, q.z);
    }
  }
  return out;
}

/** The dark inside: rings from the mouth centre out to just under the lips' inner edge. */
function buildInside(s) {
  const f = mouthFrame(s);
  const out = [];
  const centreY = MOUTH_Y + (f.hUp - f.hLo) * 0.25;
  out.push(...onFace(0, centreY, 0.008 + 0.04 * s.push).toArray());
  for (let k = 1; k <= DISK_RINGS; k++) {
    const u = k / DISK_RINGS;
    for (let i = 0; i < LIP_SEG; i++) {
      const t = (i / LIP_SEG) * Math.PI * 2;
      const c = f.centre(t);
      const inner = f.radius(t) * 0.3;
      const ex = c.x - (c.nx / Math.hypot(c.nx, c.ny)) * inner;
      const ey = c.y - (c.ny / Math.hypot(c.nx, c.ny)) * inner;
      const lift = THREE.MathUtils.lerp(0.008 + 0.04 * s.push, c.lift * 0.6 + 0.004, u * u);
      out.push(...onFace(THREE.MathUtils.lerp(0, ex, u), THREE.MathUtils.lerp(centreY, ey, u), lift).toArray());
    }
  }
  return out;
}

/** Upper teeth: a band hanging from the upper lip, never deeper than the gap to the lower lip. */
function buildTeeth(s) {
  const f = mouthFrame(s);
  const out = [];
  const a0 = 0.16 * Math.PI;
  const a1 = 0.84 * Math.PI;
  for (let i = 0; i <= TEETH_SEG; i++) {
    const t = a0 + ((a1 - a0) * i) / TEETH_SEG;
    const top = f.centre(t);
    const bottomLip = f.centre(-t);
    const yTop = top.y;
    const yBot = Math.max(yTop - 0.075, bottomLip.y + 0.004);
    const x = top.x * 0.93;
    for (let j = 0; j <= 2; j++) {
      const y = THREE.MathUtils.lerp(yTop, yBot, j / 2);
      out.push(...onFace(x, y, 0.016 + 0.6 * s.push * 0.13).toArray());
    }
  }
  return out;
}

function buildTongue(s) {
  const f = mouthFrame(s);
  const out = [];
  const gap = f.hUp + f.hLo;
  const cy = MOUTH_Y - f.hLo * 0.5 + s.tongueUp * f.hLo * 0.55 + s.tongueOut * f.hLo * 0.35;
  const hw = f.width * 0.55;
  const hh = Math.max(0.01, gap * 0.28 + s.tongueOut * 0.02);
  const lift = 0.012 + s.tongueOut * 0.075 + s.tongueUp * 0.01;
  out.push(...onFace(0, cy, lift + 0.01).toArray());
  for (let k = 1; k <= TONGUE_RINGS; k++) {
    const u = k / TONGUE_RINGS;
    for (let i = 0; i < TONGUE_SEG; i++) {
      const t = (i / TONGUE_SEG) * Math.PI * 2;
      out.push(...onFace(Math.cos(t) * hw * u, cy + Math.sin(t) * hh * u, lift + 0.01 * (1 - u * u)).toArray());
    }
  }
  return out;
}

function buildBrows(s, base) {
  // base: a static arc mesh's positions; brows just lift and arch.
  const out = [];
  for (let i = 0; i < base.length; i += 3) {
    const x = base[i];
    const arch = 1 + 0.6 * (1 - Math.min(1, Math.abs(Math.abs(x) - 0.32) / 0.18));
    out.push(x, base[i + 1] + s.brow * arch, base[i + 2] + s.brow * 0.15);
  }
  return out;
}

/** The chin: everything under the mouth rotates down about the jaw hinge, staying on the sphere. */
function buildHead(s, base, baseNormals) {
  const pos = [];
  const nor = [];
  const angle = s.open * 1.05;
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const axis = new THREE.Vector3(1, 0, 0);
  const pushCentre = onFace(0, MOUTH_Y);
  for (let i = 0; i < base.length; i += 3) {
    v.set(base[i], base[i + 1], base[i + 2]);
    n.set(baseNormals[i], baseNormals[i + 1], baseNormals[i + 2]);
    const w =
      smooth(MOUTH_Y + 0.02, MOUTH_Y - 0.12, v.y) * (1 - smooth(0.32, 0.62, Math.abs(v.x))) * smooth(-0.1, 0.45, v.z);
    if (w > 0 && angle !== 0) {
      v.applyAxisAngle(axis, angle * w);
      n.applyAxisAngle(axis, angle * w);
    }
    // A pucker draws the skin around the mouth forward a little.
    const d = v.distanceTo(pushCentre);
    if (s.push > 0 && d < 0.4) v.multiplyScalar(1 + s.push * 0.05 * (1 - smooth(0, 0.4, d)));
    pos.push(v.x, v.y, v.z);
    nor.push(n.x, n.y, n.z);
  }
  return { pos, nor };
}

// ---------------------------------------------------------------- topology

function lipIndices() {
  const idx = [];
  const row = LIP_TUBE + 1;
  for (let i = 0; i < LIP_SEG; i++) {
    for (let j = 0; j < LIP_TUBE; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return idx;
}

/** Centre vertex 0, then `rings` rings of `seg` vertices: faces wind towards +z. */
function discIndices(seg, rings) {
  const idx = [];
  for (let i = 0; i < seg; i++) idx.push(0, 1 + i, 1 + ((i + 1) % seg));
  for (let k = 1; k < rings; k++) {
    const r0 = 1 + (k - 1) * seg;
    const r1 = 1 + k * seg;
    for (let i = 0; i < seg; i++) {
      const i1 = (i + 1) % seg;
      idx.push(r0 + i, r1 + i, r1 + i1, r0 + i, r1 + i1, r0 + i1);
    }
  }
  return idx;
}

function teethIndices() {
  const idx = [];
  for (let i = 0; i < TEETH_SEG; i++) {
    for (let j = 0; j < 2; j++) {
      const a = i * 3 + j;
      const b = (i + 1) * 3 + j;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return idx;
}

// ---------------------------------------------------------------- assembly

const shapeOf = (name) => ({ ...NEUTRAL, ...SHAPES[name] });

function normalsOf(positions, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return Array.from(g.getAttribute("normal").array);
}

/** A mesh whose base and 15 morph targets all come from `build(shape)`. */
function morphMesh(name, build, index, material, normalsFrom = null) {
  const base = build(shapeOf("viseme_sil"));
  const basePos = base.pos ?? base;
  const baseNor = base.nor ?? normalsOf(basePos, index);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(basePos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(baseNor, 3));
  if (index) g.setIndex(index);
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [];
  g.morphAttributes.normal = [];
  for (const v of VISEMES) {
    const t = build(shapeOf(v));
    const pos = t.pos ?? t;
    const nor = t.nor ?? normalsOf(pos, index);
    g.morphAttributes.position.push(new THREE.Float32BufferAttribute(pos.map((x, i) => x - basePos[i]), 3));
    g.morphAttributes.normal.push(new THREE.Float32BufferAttribute(nor.map((x, i) => x - baseNor[i]), 3));
  }
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  mesh.updateMorphTargets();
  // updateMorphTargets keys the dictionary by the attributes' names; name them by viseme instead.
  mesh.morphTargetDictionary = Object.fromEntries(VISEMES.map((v, i) => [v, i]));
  mesh.morphTargetInfluences = VISEMES.map(() => 0);
  return mesh;
}

const mat = (name, color, extra = {}) =>
  new THREE.MeshStandardMaterial({ name, color, roughness: 0.55, metalness: 0, ...extra });

const head = new THREE.Group();
head.name = "VisemeHead";

// Skin: a dense sphere, blushed cheeks through vertex colours.
const sphere = new THREE.SphereGeometry(1, 128, 96);
sphere.rotateY(Math.PI / 2); // seam to the back
const skinPos = Array.from(sphere.getAttribute("position").array);
const skinNor = Array.from(sphere.getAttribute("normal").array);
const skin = new THREE.Color(0xffc49b);
const blush = new THREE.Color(0xff6f8a);
const colors = [];
for (let i = 0; i < skinPos.length; i += 3) {
  const p = new THREE.Vector3(skinPos[i], skinPos[i + 1], skinPos[i + 2]);
  let k = 0;
  for (const sx of [-1, 1]) k = Math.max(k, 1 - p.distanceTo(onFace(0.5 * sx, -0.18)) / 0.24);
  const c = skin.clone().lerp(blush, Math.max(0, k) * 0.75);
  colors.push(c.r, c.g, c.b);
}
// Only the chin and the skin around the mouth ever move, so the skin is split in two: a static
// skull, and a small patch carrying the morph targets. A vertex on the seam has a zero delta in
// every target, so the two halves never part.
const skinIndex = Array.from(sphere.index.array);
const skinTargets = VISEMES.map((v) => buildHead(shapeOf(v), skinPos, skinNor));
const moves = new Uint8Array(skinPos.length / 3);
for (const t of skinTargets) {
  for (let i = 0; i < t.pos.length; i++) if (Math.abs(t.pos[i] - skinPos[i]) > 1e-6) moves[(i / 3) | 0] = 1;
}
/** The sub-mesh of the skin made of the triangles `keep` accepts, its vertices renumbered. */
function skinPart(keep) {
  const remap = new Map();
  const order = [];
  const index = [];
  for (let f = 0; f < skinIndex.length; f += 3) {
    const tri = skinIndex.slice(f, f + 3);
    if (!keep(tri)) continue;
    for (const v of tri) {
      if (!remap.has(v)) {
        remap.set(v, order.length);
        order.push(v);
      }
      index.push(remap.get(v));
    }
  }
  const pick = (arr) => order.flatMap((v) => [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]]);
  return { order, index, pick };
}
const skinMat = mat("Skin", 0xffffff, { vertexColors: true, roughness: 0.6 });
const skull = skinPart((tri) => !tri.some((v) => moves[v]));
const skullGeo = new THREE.BufferGeometry();
skullGeo.setAttribute("position", new THREE.Float32BufferAttribute(skull.pick(skinPos), 3));
skullGeo.setAttribute("normal", new THREE.Float32BufferAttribute(skull.pick(skinNor), 3));
skullGeo.setAttribute("color", new THREE.Float32BufferAttribute(skull.pick(colors), 3));
skullGeo.setIndex(skull.index);
const skullMesh = new THREE.Mesh(skullGeo, skinMat);
skullMesh.name = "Head";
head.add(skullMesh);

const chin = skinPart((tri) => tri.some((v) => moves[v]));
const chinMesh = morphMesh(
  "Chin",
  (s) => {
    const t = buildHead(s, skinPos, skinNor);
    return { pos: chin.pick(t.pos), nor: chin.pick(t.nor) };
  },
  chin.index,
  skinMat,
);
chinMesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(chin.pick(colors), 3));
head.add(chinMesh);

head.add(morphMesh("Lips", buildLips, lipIndices(), mat("Lips", 0xd8344f, { roughness: 0.35 })));
head.add(
  morphMesh("MouthInside", buildInside, discIndices(LIP_SEG, DISK_RINGS), mat("MouthInside", 0x3a0a18, { roughness: 0.9 })),
);
head.add(morphMesh("Teeth", buildTeeth, teethIndices(), mat("Teeth", 0xfffaf0, { roughness: 0.25 })));
head.add(morphMesh("Tongue", buildTongue, discIndices(TONGUE_SEG, TONGUE_RINGS), mat("Tongue", 0xf06a84, { roughness: 0.4 })));

// Brows: two arched bars, raised by the open vowels.
const browGeo = (() => {
  const parts = [];
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      const x = sx * (0.16 + 0.3 * u);
      const y = 0.5 + 0.06 * Math.sin(u * Math.PI);
      pts.push(onFace(x, y, 0.02));
    }
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.03, 8, false));
  }
  const merged = new THREE.BufferGeometry();
  const pos = [...parts[0].getAttribute("position").array, ...parts[1].getAttribute("position").array];
  const off = parts[0].getAttribute("position").count;
  const idx = [...parts[0].index.array, ...Array.from(parts[1].index.array, (i) => i + off)];
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setIndex(idx);
  return merged;
})();
const browBase = Array.from(browGeo.getAttribute("position").array);
head.add(morphMesh("Brows", (s) => buildBrows(s, browBase), Array.from(browGeo.index.array), mat("Brows", 0x4a2a18)));

// Static features: eyes, nose, ears.
const addStatic = (name, geo, material, at, scale = [1, 1, 1]) => {
  const m = new THREE.Mesh(geo, material);
  m.name = name;
  m.position.copy(at);
  m.scale.set(...scale);
  head.add(m);
  return m;
};
for (const [sx, side] of [[-1, "L"], [1, "R"]]) {
  const eye = onFace(0.3 * sx, 0.22, -0.06);
  addStatic(`Eye${side}`, new THREE.SphereGeometry(0.17, 32, 24), mat("EyeWhite", 0xffffff, { roughness: 0.2 }), eye, [1, 1.15, 0.8]);
  const pupil = onFace(0.29 * sx, 0.2, 0.06);
  addStatic(`Pupil${side}`, new THREE.SphereGeometry(0.075, 24, 16), mat("Pupil", 0x1b1830, { roughness: 0.15 }), pupil, [1, 1.2, 0.6]);
  const glint = onFace(0.27 * sx, 0.24, 0.09);
  addStatic(`Glint${side}`, new THREE.SphereGeometry(0.022, 16, 12), mat("Glint", 0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.6 }), glint);
  addStatic(`Ear${side}`, new THREE.SphereGeometry(0.2, 24, 16), mat("Ear", 0xffb48a, { roughness: 0.6 }), new THREE.Vector3(0.98 * sx, -0.02, -0.05), [0.45, 1, 0.8]);
}
addStatic("Nose", new THREE.SphereGeometry(0.13, 32, 24), mat("Nose", 0xff9f7f, { roughness: 0.45 }), onFace(0, -0.04, 0.05), [1.1, 0.9, 1]);

// Slightly wider than tall reads friendlier; a linear scale keeps every morph delta consistent.
head.scale.set(1.06, 0.98, 1);

// Nothing is textured: UVs would only add weight.
head.traverse((o) => o.isMesh && o.geometry.deleteAttribute("uv"));

const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(head, { binary: true });
writeFileSync(OUT, Buffer.from(glb));

for (const o of head.children) if (o.isMesh) console.log(o.name, o.geometry.getAttribute("position").count, o.geometry.morphAttributes.position?.length ?? 0);
let verts = 0;
head.traverse((o) => o.isMesh && (verts += o.geometry.getAttribute("position").count));
console.log(`wrote ${OUT} (${(glb.byteLength / 1024).toFixed(0)} KB, ${verts} vertices, ${VISEMES.length} visemes)`);
