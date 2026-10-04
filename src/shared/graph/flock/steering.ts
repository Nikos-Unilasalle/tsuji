import {
  BURST,
  CALLED_DASH,
  CALLED_TURN,
  FlockParams,
  FlockState,
  GLIDE,
  STATE_PROFILE,
  Vec3,
  pickState,
  stateDuration,
} from "./state";

/**
 * One fixed step of the flock: neighbour search on a uniform grid, the
 * steering rules, bounded turning, speed easing and depth drift. See state.ts
 * for what each agent carries and why.
 */

/** Per-axis ceiling on neighbour-grid cells, so a tiny radius in huge bounds can't allocate millions. */
const MAX_CELLS_PER_AXIS = 48;

interface Grid {
  nx: number;
  ny: number;
  nz: number;
  minX: number;
  minY: number;
  minZ: number;
  cell: number;
}

/** Counting-sorts agents into cells one neighbour radius wide, so each agent only checks nearby cells. */
function buildGrid(state: FlockState, params: FlockParams): Grid {
  const { boundsCenter: c, boundsSize: s } = params;
  const pad = params.neighborRadius;
  const minX = c.x - s.x / 2 - pad, minY = c.y - s.y / 2 - pad, minZ = c.z - s.z / 2 - pad;
  const spanMax = Math.max(s.x, s.y, s.z) + 2 * pad;
  const cell = Math.max(params.neighborRadius, spanMax / MAX_CELLS_PER_AXIS, 1e-3);
  const nx = Math.max(1, Math.ceil((s.x + 2 * pad) / cell));
  // Plane mode measures neighbours in XZ only, so depth must not split them across cells.
  const ny = params.mode === "plane" ? 1 : Math.max(1, Math.ceil((s.y + 2 * pad) / cell));
  const nz = Math.max(1, Math.ceil((s.z + 2 * pad) / cell));
  const cells = nx * ny * nz;
  if (state.cellStart.length < cells + 1) state.cellStart = new Int32Array(cells + 1);
  const start = state.cellStart;
  start.fill(0, 0, cells + 1);
  for (let i = 0; i < state.count; i++) {
    const b = i * 3;
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((state.pos[b] - minX) / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((state.pos[b + 1] - minY) / cell)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((state.pos[b + 2] - minZ) / cell)));
    const id = (iz * ny + iy) * nx + ix;
    state.agentCell[i] = id;
    start[id + 1]++;
  }
  for (let k = 0; k < cells; k++) start[k + 1] += start[k];
  const fill = state.cellAgents;
  const cursor = start.slice(0, cells);
  for (let i = 0; i < state.count; i++) fill[cursor[state.agentCell[i]]++] = i;
  return { nx, ny, nz, minX, minY, minZ, cell };
}

const desired = { x: 0, y: 0, z: 0 };

/**
 * Turns unit vector `dir` (at index b) toward `to` by at most `maxAngle`
 * radians — a slerp clamped by angle, so a fish can't flip round in a frame
 * however hard it is pulled.
 */
function turnToward(dir: Float64Array, b: number, to: Vec3, maxAngle: number, plane: boolean): void {
  const hx = dir[b], hy = dir[b + 1], hz = dir[b + 2];
  const dot = Math.max(-1, Math.min(1, hx * to.x + hy * to.y + hz * to.z));
  const angle = Math.acos(dot);
  if (angle < 1e-6) return;
  const t = Math.min(1, maxAngle / angle);
  let tx = to.x, ty = to.y, tz = to.z;
  if (Math.PI - angle < 1e-3) {
    // Straight behind: the slerp has no plane to turn in, so pick one — the
    // horizontal one in Plane mode, any perpendicular in Volume mode.
    tx = -hz; ty = 0; tz = hx;
    if (!plane && Math.hypot(tx, tz) < 1e-6) { tx = 1; ty = 0; tz = 0; }
    const sin = Math.sin(maxAngle), cos = Math.cos(maxAngle);
    const len = Math.hypot(tx, ty, tz) || 1;
    setUnit(dir, b, hx * cos + (tx / len) * sin, hy * cos + (ty / len) * sin, hz * cos + (tz / len) * sin);
    return;
  }
  const sinA = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sinA;
  const wb = Math.sin(t * angle) / sinA;
  setUnit(dir, b, hx * wa + tx * wb, hy * wa + ty * wb, hz * wa + tz * wb);
}

function setUnit(arr: Float64Array, b: number, x: number, y: number, z: number): void {
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return;
  arr[b] = x / len;
  arr[b + 1] = y / len;
  arr[b + 2] = z / len;
}

/** Inward push that grows as an agent gets within `margin` of a face of the bounds. */
function edgePush(p: number, lo: number, hi: number, margin: number): number {
  if (margin <= 0) return p < lo ? 1 : p > hi ? -1 : 0;
  if (p < lo + margin) { const k = Math.min(1.5, (lo + margin - p) / margin); return k * k; }
  if (p > hi - margin) { const k = Math.min(1.5, (p - (hi - margin)) / margin); return -k * k; }
  return 0;
}

/** Advances the whole flock by `dt` seconds. */
export function stepFlock(state: FlockState, params: FlockParams, dt: number): void {
  if (dt <= 0 || state.count === 0) return;
  const plane = params.mode === "plane";
  const { boundsCenter: c, boundsSize: s } = params;
  const lo = { x: c.x - s.x / 2, y: c.y - s.y / 2, z: c.z - s.z / 2 };
  const hi = { x: c.x + s.x / 2, y: c.y + s.y / 2, z: c.z + s.z / 2 };
  const margin = Math.max(0, Math.min(params.edgeMargin, Math.min(s.x, s.z) / 2));
  const r = Math.max(1e-3, params.neighborRadius);
  const r2 = r * r;
  const sep = Math.max(1e-3, params.separationDistance);
  const sep2 = sep * sep;
  const grid = buildGrid(state, params);
  const { pos, dir } = state;
  const maxPitchSin = Math.sin(Math.max(0, Math.min(Math.PI / 2, params.maxPitch)));

  for (let i = 0; i < state.count; i++) {
    const b = i * 3;
    const rng = state.rng[i];
    const px = pos[b], py = pos[b + 1], pz = pos[b + 2];

    if (params.swimStates) {
      state.stateTimer[i] -= dt;
      if (state.stateTimer[i] <= 0) {
        const next = pickState(rng);
        state.swimState[i] = next;
        state.stateTimer[i] = stateDuration(next, rng);
      }
    } else if (state.scatterLeft[i] <= 0 && state.callLeft[i] <= 0) {
      state.swimState[i] = GLIDE;
    }

    if (state.callDelay[i] >= 0) {
      state.callDelay[i] -= dt;
      if (state.callDelay[i] < 0) {
        state.callDelay[i] = -1;
        state.callLeft[i] = params.callDuration * (0.8 + 0.4 * rng());
        state.swimState[i] = BURST;
        state.stateTimer[i] = STATE_PROFILE[BURST].max;
      }
    }

    // Wander drifts as a damped random walk, so turns are slow arcs rather than jitter.
    state.wander[i] += (-state.wander[i] * 0.6 + (rng() - 0.5) * 3) * dt;
    state.wanderPitch[i] += (-state.wanderPitch[i] * 0.8 + (rng() - 0.5) * 2) * dt;

    let cx = 0, cy = 0, cz = 0, ax = 0, ay = 0, az = 0, sx = 0, sy = 0, sz = 0, n = 0;
    const cell = state.agentCell[i];
    const gx = cell % grid.nx;
    const gy = Math.floor(cell / grid.nx) % grid.ny;
    const gz = Math.floor(cell / (grid.nx * grid.ny));
    for (let dz = -1; dz <= 1; dz++) {
      const zz = gz + dz;
      if (zz < 0 || zz >= grid.nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= grid.ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= grid.nx) continue;
          const id = (zz * grid.ny + yy) * grid.nx + xx;
          for (let k = state.cellStart[id]; k < state.cellStart[id + 1]; k++) {
            const j = state.cellAgents[k];
            if (j === i) continue;
            const ob = j * 3;
            const ox = pos[ob] - px, oy = pos[ob + 1] - py, oz = pos[ob + 2] - pz;
            const d2 = ox * ox + (plane ? 0 : oy * oy) + oz * oz;
            if (d2 > r2) continue;
            n++;
            cx += ox; cy += oy; cz += oz;
            ax += dir[ob]; ay += dir[ob + 1]; az += dir[ob + 2];
            if (d2 < sep2 && d2 > 1e-12) {
              const w = (sep2 - d2) / (sep2 * Math.sqrt(d2));
              sx -= ox * w; sy -= oy * w; sz -= oz * w;
            }
          }
        }
      }
    }

    const hx = dir[b], hy = dir[b + 1], hz = dir[b + 2];
    const cw = Math.cos(state.wander[i]), sw = Math.sin(state.wander[i]);
    desired.x = (hx * cw - hz * sw) * params.wander;
    desired.y = plane ? 0 : (hy + state.wanderPitch[i] * 0.5) * params.wander;
    desired.z = (hx * sw + hz * cw) * params.wander;
    // A little forward bias keeps a lone, unpulled agent swimming on instead of stalling.
    desired.x += hx * 0.4; desired.y += hy * 0.4; desired.z += hz * 0.4;

    if (n > 0) {
      const cl = Math.hypot(cx, plane ? 0 : cy, cz) || 1;
      desired.x += (cx / cl) * params.cohesion;
      if (!plane) desired.y += (cy / cl) * params.cohesion;
      desired.z += (cz / cl) * params.cohesion;
      const al = Math.hypot(ax, plane ? 0 : ay, az) || 1;
      desired.x += (ax / al) * params.alignment;
      if (!plane) desired.y += (ay / al) * params.alignment;
      desired.z += (az / al) * params.alignment;
      desired.x += sx * params.separation;
      if (!plane) desired.y += sy * params.separation;
      desired.z += sz * params.separation;
    }

    const ex = edgePush(px, lo.x, hi.x, margin);
    const ez = edgePush(pz, lo.z, hi.z, margin);
    const ey = plane ? 0 : edgePush(py, lo.y, hi.y, Math.min(margin, s.y / 2));
    desired.x += ex * params.edge * 2;
    desired.y += ey * params.edge * 2;
    desired.z += ez * params.edge * 2;

    const called = state.callLeft[i] > 0;
    const pullWeight = called ? Math.max(params.targetWeight, 2.5) : params.targetWeight;
    let callSpeed = 0;
    if (pullWeight > 0) {
      const tp = called ? state.callPoint : params.target;
      const tx = tp.x - px, ty = plane ? 0 : tp.y - py, tz = tp.z - pz;
      const dist = Math.hypot(tx, ty, tz);
      // Dash while far, ease to a cruise on arrival — the koi rush in, then mill about.
      if (called) callSpeed = 1 + (CALLED_DASH - 1) * Math.min(1, dist / (3 * Math.max(1e-3, params.arriveRadius)));
      if (dist > 1e-6) {
        const arrive = Math.max(1e-3, params.arriveRadius);
        const near = Math.max(0, 1 - dist / arrive);
        const pull = pullWeight * Math.min(1, dist / arrive + 0.25);
        desired.x += (tx / dist) * pull;
        desired.y += (ty / dist) * pull;
        desired.z += (tz / dist) * pull;
        // Circling: a sideways push that peaks at the target, in the plane around Y.
        const side = params.circle * pullWeight * near * (state.reactMul[i] >= 1 ? 1 : -1);
        desired.x += (-tz / dist) * side;
        desired.z += (tx / dist) * side;
      }
    }

    if (state.scatterLeft[i] > 0) {
      state.scatterLeft[i] -= dt;
      const fx = px - state.scatterPoint.x, fy = plane ? 0 : py - state.scatterPoint.y, fz = pz - state.scatterPoint.z;
      const fl = Math.hypot(fx, fy, fz);
      if (fl > 1e-6) {
        desired.x += (fx / fl) * 4;
        desired.y += (fy / fl) * 4;
        desired.z += (fz / fl) * 4;
      } else {
        desired.x += hx * 4; desired.z += hz * 4;
      }
    }
    if (called) state.callLeft[i] -= dt;

    const dl = Math.hypot(desired.x, desired.y, desired.z);
    const swim = state.swimState[i];
    // An answering fish keeps its own mood but never dawdles: a coast or a
    // hover drawn mid-call would strand it halfway to the point.
    const profile = STATE_PROFILE[swim];
    const turnMul = called ? Math.max(profile.turn, CALLED_TURN) : profile.turn;
    const speedMul = called ? Math.max(profile.speed, callSpeed) : profile.speed;
    if (dl > 1e-6) {
      desired.x /= dl; desired.y /= dl; desired.z /= dl;
      const prevX = hx, prevZ = hz;
      turnToward(dir, b, desired, params.turnRate * state.turnMul[i] * turnMul * dt, plane);
      if (plane) {
        dir[b + 1] = 0;
        setUnit(dir, b, dir[b], 0, dir[b + 2]);
      } else if (Math.abs(dir[b + 1]) > maxPitchSin) {
        const y = Math.sign(dir[b + 1]) * maxPitchSin;
        const flat = Math.hypot(dir[b], dir[b + 2]) || 1;
        const k = Math.sqrt(1 - y * y) / flat;
        dir[b] *= k; dir[b + 2] *= k; dir[b + 1] = y;
      }
      // Signed yaw rate drives the bank; smoothed so a twitchy frame doesn't flip the roll.
      const yawRate = Math.atan2(prevX * dir[b + 2] - prevZ * dir[b], prevX * dir[b] + prevZ * dir[b + 2]) / dt;
      const rollTarget = Math.max(-1.2, Math.min(1.2, -yawRate * params.bank * 0.25));
      state.roll[i] += (rollTarget - state.roll[i]) * Math.min(1, dt * 4);
    }

    let targetSpeed = params.speed * state.speedMul[i] * speedMul;
    if (state.scatterLeft[i] > 0) targetSpeed = Math.max(targetSpeed, params.speed * STATE_PROFILE[BURST].speed);
    const accel = swim === BURST || called ? 6 : 1.6;
    state.speed[i] += (targetSpeed - state.speed[i]) * Math.min(1, dt * accel);

    const v = state.speed[i];
    pos[b] += dir[b] * v * dt;
    pos[b + 2] += dir[b + 2] * v * dt;

    if (plane) {
      state.depthTimer[i] -= dt;
      if (called) state.depthTarget[i] = hi.y;
      else if (state.depthTimer[i] <= 0) {
        state.depthTarget[i] = lo.y + (hi.y - lo.y) * rng();
        state.depthTimer[i] = 3 + 6 * rng();
      }
      pos[b + 1] += (state.depthTarget[i] - pos[b + 1]) * Math.min(1, dt * (called ? 1.5 : 0.35));
    } else {
      pos[b + 1] += dir[b + 1] * v * dt;
    }

    // Steering keeps agents inside; this only catches what a weak Edge weight lets slip out.
    const slack = margin + params.speed;
    pos[b] = Math.min(hi.x + slack, Math.max(lo.x - slack, pos[b]));
    pos[b + 1] = Math.min(hi.y + (plane ? 0 : slack), Math.max(lo.y - (plane ? 0 : slack), pos[b + 1]));
    pos[b + 2] = Math.min(hi.z + slack, Math.max(lo.z - slack, pos[b + 2]));

    const effort = swim === BURST ? 2.2 : 1;
    state.phase[i] = (state.phase[i] + dt * Math.PI * 2 * (0.5 + 1.2 * effort * v / Math.max(1e-3, params.speed))) % (Math.PI * 200);
  }
}
