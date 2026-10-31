import * as THREE from "three";
import { BoneRotations, boneRotations, PoseOptions, SkinBone, SkinBounds, SkinWeights } from "./skinning";

/**
 * Dual quaternion skinning: the same bones and weights as linear blend
 * skinning, but each vertex blends its bones' rigid motions (a rotation and
 * a translation, as unit dual quaternions) instead of their matrices. Blended
 * matrices of bones turned far apart average into a shrunken, sheared
 * transform — the elbow that thins to a "candy wrapper", the armpit and
 * shoulder that collapse when a T-posed arm comes down. Blended dual
 * quaternions stay a rigid motion, so the volume holds.
 *
 * Everything happens in the space the bones are posed in (the rig's, or the
 * world's for Bind Space World), where each bone is truly rigid: a mesh's
 * vertices are taken there by its frame and brought back after. Stretch Bones
 * is a scale, which a rigid motion cannot carry: it is blended linearly
 * first, in the rest pose, then the rigid part is blended as above.
 */

export interface PosedDualQuats {
  /** Per bone: real part x y z w, then dual part x y z w. */
  dq: Float32Array;
  /** Per bone, with Stretch Bones: how much it lengthens (0 none), its rest direction and head; null without stretch. */
  stretch: Float32Array | null;
}

const IDENTITY = new THREE.Quaternion();

export function poseDualQuats(bones: SkinBone[], pose: THREE.Vector3[], options: PoseOptions, turns?: BoneRotations, into?: PosedDualQuats): PosedDualQuats {
  const count = bones.length;
  const out: PosedDualQuats =
    into && into.dq.length === count * 8 && !!into.stretch === options.stretch
      ? into
      : { dq: new Float32Array(count * 8), stretch: options.stretch ? new Float32Array(count * 7) : null };
  const { rotations, real } = turns ?? boneRotations(bones, pose);
  const amount = Math.max(0, Math.min(1, options.amount));
  const q = new THREE.Quaternion();
  const head1 = new THREE.Vector3();
  const t = new THREE.Vector3();

  bones.forEach((bone, i) => {
    // Turned about the rest head, which moves to the posed head: x' = R (x - h0) + h1.
    const posedHead = bone.parent >= 0 ? pose[bone.parent] : pose[bone.joint];
    q.copy(IDENTITY).slerp(rotations[i], amount);
    head1.copy(bone.head).lerp(posedHead, amount);
    t.copy(bone.head).applyQuaternion(q).negate().add(head1);
    const o = i * 8;
    out.dq[o] = q.x;
    out.dq[o + 1] = q.y;
    out.dq[o + 2] = q.z;
    out.dq[o + 3] = q.w;
    // Dual part: half the translation times the rotation.
    out.dq[o + 4] = 0.5 * (t.x * q.w + t.y * q.z - t.z * q.y);
    out.dq[o + 5] = 0.5 * (-t.x * q.z + t.y * q.w + t.z * q.x);
    out.dq[o + 6] = 0.5 * (t.x * q.y - t.y * q.x + t.z * q.w);
    out.dq[o + 7] = 0.5 * (-t.x * q.x - t.y * q.y - t.z * q.z);

    if (out.stretch) {
      const s = i * 7;
      const k = real[i] && bone.length > 0 ? (pose[bone.joint].distanceTo(pose[bone.parent]) / bone.length - 1) * amount : 0;
      out.stretch[s] = k;
      out.stretch[s + 1] = bone.dir.x;
      out.stretch[s + 2] = bone.dir.y;
      out.stretch[s + 3] = bone.dir.z;
      out.stretch[s + 4] = bone.head.x;
      out.stretch[s + 5] = bone.head.y;
      out.stretch[s + 6] = bone.head.z;
    }
  });
  return out;
}

/**
 * Skins `base` (the mesh's own vertices, `frame` taking them to the bones'
 * space) into `out` with dual quaternions; normals likewise when given.
 * Grows `bounds` to the result, as skinVertices does.
 */
export function skinVerticesDualQuat(
  out: Float32Array,
  base: ArrayLike<number>,
  skin: SkinWeights,
  posed: PosedDualQuats,
  frame: THREE.Matrix4,
  normals?: { out: Float32Array; base: ArrayLike<number> },
  bounds?: SkinBounds,
): void {
  const n = skin.influences;
  const count = Math.floor(base.length / 3);
  const { dq, stretch } = posed;
  // The frame and its inverse, 3x4, and what they do to normals.
  const f = frame.elements;
  const inv = frame.clone().invert().elements;
  const fn = new THREE.Matrix3().getNormalMatrix(frame).elements;
  const invn = new THREE.Matrix3().getNormalMatrix(frame.clone().invert()).elements;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let v = 0; v < count; v++) {
    const px = base[v * 3], py = base[v * 3 + 1], pz = base[v * 3 + 2];
    // Into the bones' space.
    let x = f[0] * px + f[4] * py + f[8] * pz + f[12];
    let y = f[1] * px + f[5] * py + f[9] * pz + f[13];
    let z = f[2] * px + f[6] * py + f[10] * pz + f[14];

    const o = v * n;
    let rx = 0, ry = 0, rz = 0, rw = 0, dx = 0, dy = 0, dz = 0, dw = 0;
    let sx = 0, sy = 0, sz = 0, total = 0;
    let fx = 0, fy = 0, fz = 0, fw = 0;
    for (let k = 0; k < n; k++) {
      const w = skin.weights[o + k];
      if (w <= 0) continue;
      const b = skin.indices[o + k] * 8;
      // Same hemisphere as the first bone: q and -q are the same turn, and must not cancel.
      if (total === 0) {
        fx = dq[b]; fy = dq[b + 1]; fz = dq[b + 2]; fw = dq[b + 3];
      }
      const s = fx * dq[b] + fy * dq[b + 1] + fz * dq[b + 2] + fw * dq[b + 3] < 0 ? -w : w;
      rx += s * dq[b]; ry += s * dq[b + 1]; rz += s * dq[b + 2]; rw += s * dq[b + 3];
      dx += s * dq[b + 4]; dy += s * dq[b + 5]; dz += s * dq[b + 6]; dw += s * dq[b + 7];
      if (stretch) {
        const t = skin.indices[o + k] * 7;
        const kk = stretch[t];
        const ux = stretch[t + 1], uy = stretch[t + 2], uz = stretch[t + 3];
        const along = kk * ((x - stretch[t + 4]) * ux + (y - stretch[t + 5]) * uy + (z - stretch[t + 6]) * uz);
        sx += w * (x + along * ux);
        sy += w * (y + along * uy);
        sz += w * (z + along * uz);
      }
      total += w;
    }
    if (total <= 0) {
      out[v * 3] = px; out[v * 3 + 1] = py; out[v * 3 + 2] = pz;
      if (normals) {
        normals.out[v * 3] = normals.base[v * 3];
        normals.out[v * 3 + 1] = normals.base[v * 3 + 1];
        normals.out[v * 3 + 2] = normals.base[v * 3 + 2];
      }
    } else {
      if (stretch) {
        x = sx / total; y = sy / total; z = sz / total;
      }
      const len = Math.hypot(rx, ry, rz, rw) || 1;
      rx /= len; ry /= len; rz /= len; rw /= len;
      dx /= len; dy /= len; dz /= len; dw /= len;
      // Rotate by the real part: v + 2r x (r x v + w v).
      let cx = ry * z - rz * y + rw * x;
      let cy = rz * x - rx * z + rw * y;
      let cz = rx * y - ry * x + rw * z;
      let qx = x + 2 * (ry * cz - rz * cy);
      let qy = y + 2 * (rz * cx - rx * cz);
      let qz = z + 2 * (rx * cy - ry * cx);
      // Translate: 2 (w_r d - w_d r + r x d), the vector part.
      qx += 2 * (rw * dx - dw * rx + ry * dz - rz * dy);
      qy += 2 * (rw * dy - dw * ry + rz * dx - rx * dz);
      qz += 2 * (rw * dz - dw * rz + rx * dy - ry * dx);
      // Back to the mesh's own space.
      const ox = inv[0] * qx + inv[4] * qy + inv[8] * qz + inv[12];
      const oy = inv[1] * qx + inv[5] * qy + inv[9] * qz + inv[13];
      const oz = inv[2] * qx + inv[6] * qy + inv[10] * qz + inv[14];
      out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
      if (ox < minX) minX = ox; if (ox > maxX) maxX = ox;
      if (oy < minY) minY = oy; if (oy > maxY) maxY = oy;
      if (oz < minZ) minZ = oz; if (oz > maxZ) maxZ = oz;

      if (normals) {
        const nx0 = normals.base[v * 3], ny0 = normals.base[v * 3 + 1], nz0 = normals.base[v * 3 + 2];
        const ax = fn[0] * nx0 + fn[3] * ny0 + fn[6] * nz0;
        const ay = fn[1] * nx0 + fn[4] * ny0 + fn[7] * nz0;
        const az = fn[2] * nx0 + fn[5] * ny0 + fn[8] * nz0;
        cx = ry * az - rz * ay + rw * ax;
        cy = rz * ax - rx * az + rw * ay;
        cz = rx * ay - ry * ax + rw * az;
        const bx = ax + 2 * (ry * cz - rz * cy);
        const by = ay + 2 * (rz * cx - rx * cz);
        const bz = az + 2 * (rx * cy - ry * cx);
        let mx = invn[0] * bx + invn[3] * by + invn[6] * bz;
        let my = invn[1] * bx + invn[4] * by + invn[7] * bz;
        let mz = invn[2] * bx + invn[5] * by + invn[8] * bz;
        const nl = Math.hypot(mx, my, mz) || 1;
        normals.out[v * 3] = mx / nl; normals.out[v * 3 + 1] = my / nl; normals.out[v * 3 + 2] = mz / nl;
      }
      continue;
    }
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  if (bounds && count > 0) {
    bounds.min.set(minX, minY, minZ);
    bounds.max.set(maxX, maxY, maxZ);
  }
}
