import { clamp } from './util.js';

// Axis-aligned box world stored in a uniform XZ hash grid. Characters are
// vertical cylinders (feet position + radius + height).
//
// Besides plain boxes the grid can hold "volumes": a box split into nx*ny*nz blocks with an
// occupancy array (destructible buildings). Blocks with occ = 0 are empty space, so holes
// blown in a building can be flown through. Boxes with `disabled` set are ignored.
export class World {
  constructor(cell = 32) {
    this.cell = cell;
    this.boxes = [];
    this.grid = new Map();
    this.stamp = 0;
    this.out = [];
    this.res = { ground: false, wall: false, nx: 0, nz: 0 };
    this.floorAt = () => 0;
  }

  key(gx, gz) {
    return (gx + 2048) * 4096 + (gz + 2048);
  }

  insert(b) {
    const c = this.cell;
    for (let gx = Math.floor(b.minX / c); gx <= Math.floor(b.maxX / c); gx++) {
      for (let gz = Math.floor(b.minZ / c); gz <= Math.floor(b.maxZ / c); gz++) {
        const k = this.key(gx, gz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(b);
      }
    }
  }

  addBox(minX, minY, minZ, maxX, maxY, maxZ) {
    const b = { minX, minY, minZ, maxX, maxY, maxZ, stamp: 0 };
    this.boxes.push(b);
    this.insert(b);
    return b;
  }

  // v: { minX..maxZ, nx, ny, nz, occ: Uint8Array } (block sizes are derived here)
  addVolume(v) {
    v.isVolume = true;
    v.stamp = 0;
    v.sx = (v.maxX - v.minX) / v.nx;
    v.sy = (v.maxY - v.minY) / v.ny;
    v.sz = (v.maxZ - v.minZ) / v.nz;
    this.insert(v);
    return v;
  }

  removeVolume(v) {
    const c = this.cell;
    for (let gx = Math.floor(v.minX / c); gx <= Math.floor(v.maxX / c); gx++) {
      for (let gz = Math.floor(v.minZ / c); gz <= Math.floor(v.maxZ / c); gz++) {
        const list = this.grid.get(this.key(gx, gz));
        const i = list ? list.indexOf(v) : -1;
        if (i >= 0) list.splice(i, 1);
      }
    }
  }

  // Unique boxes touching the XZ rect. Returns a shared array: don't nest calls.
  query(minX, minZ, maxX, maxZ) {
    const out = this.out;
    out.length = 0;
    const s = ++this.stamp;
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
        const list = this.grid.get(this.key(gx, gz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (b.stamp !== s) {
            b.stamp = s;
            out.push(b);
          }
        }
      }
    }
    return out;
  }

  // Push a cylinder out of boxes. Steps up ledges lower than stepH, lands on roofs.
  resolve(pos, r, h, vel, dt, stepH = 0.6) {
    const res = this.res;
    res.ground = false;
    res.wall = false;
    res.nx = 0;
    res.nz = 0;
    const floor = this.floorAt(pos.x, pos.z);
    if (pos.y <= floor + 0.001) {
      pos.y = floor;
      if (vel.y < 0) vel.y = 0;
      res.ground = true;
    }
    const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.disabled) continue;
      if (b.isVolume) this.resolveVolume(pos, r, h, vel, dt, stepH, b, res);
      else this.resolveBox(pos, r, h, vel, dt, stepH, b, res);
    }
    return res;
  }

  resolveBox(pos, r, h, vel, dt, stepH, b, res) {
    if (pos.y > b.maxY + 0.01 || pos.y + h <= b.minY) return;
    const cx = clamp(pos.x, b.minX, b.maxX);
    const cz = clamp(pos.z, b.minZ, b.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return;

    const up = b.maxY - pos.y;
    if (up <= Math.max(stepH, -vel.y * dt + 0.05)) {
      pos.y = b.maxY;
      if (vel.y < 0) vel.y = 0;
      res.ground = true;
      return;
    }
    const down = pos.y + h - b.minY;
    if (b.minY > 0.5 && down < Math.max(0.4, vel.y * dt + 0.05)) {
      pos.y = b.minY - h;
      if (vel.y > 0) vel.y = 0;
      return;
    }

    let nx, nz, pen;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2);
      nx = dx / d;
      nz = dz / d;
      pen = r - d;
    } else {
      // Center is inside the footprint: leave through the nearest side.
      const l = pos.x - b.minX, rr = b.maxX - pos.x, f = pos.z - b.minZ, bk = b.maxZ - pos.z;
      const m = Math.min(l, rr, f, bk);
      if (m === l) { nx = -1; nz = 0; pen = l + r; }
      else if (m === rr) { nx = 1; nz = 0; pen = rr + r; }
      else if (m === f) { nx = 0; nz = -1; pen = f + r; }
      else { nx = 0; nz = 1; pen = bk + r; }
    }
    pos.x += nx * pen;
    pos.z += nz * pen;
    const vn = vel.x * nx + vel.z * nz;
    if (vn < 0) {
      vel.x -= nx * vn;
      vel.z -= nz * vn;
    }
    res.wall = true;
    res.nx = nx;
    res.nz = nz;
  }

  // Treat each solid block the cylinder overlaps as a box.
  resolveVolume(pos, r, h, vel, dt, stepH, v, res) {
    const ix0 = Math.max(0, Math.floor((pos.x - r - v.minX) / v.sx)), ix1 = Math.min(v.nx - 1, Math.floor((pos.x + r - v.minX) / v.sx));
    const iz0 = Math.max(0, Math.floor((pos.z - r - v.minZ) / v.sz)), iz1 = Math.min(v.nz - 1, Math.floor((pos.z + r - v.minZ) / v.sz));
    const iy0 = Math.max(0, Math.floor((pos.y - 0.1 - v.minY) / v.sy)), iy1 = Math.min(v.ny - 1, Math.floor((pos.y + h - v.minY) / v.sy));
    if (ix0 > ix1 || iz0 > iz1 || iy0 > iy1) return;
    const b = _vb;
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          if (!v.occ[(iy * v.nz + iz) * v.nx + ix]) continue;
          this.resolveBox(pos, r, h, vel, dt, stepH, cellBox(v, ix, iy, iz, b), res);
        }
      }
    }
  }

  // Distance along unit `d` to the first solid thing or the floor, capped at maxDist.
  // Boxes (and blocks) containing the origin are ignored. Sets this.hitNormal.
  raycastHit(o, d, maxDist) {
    let best = maxDist, normal = null;
    if (d.y < -1e-6) {
      let t = -o.y / d.y;
      if (t >= 0 && this.floorAt(o.x + d.x * t, o.z + d.z * t) < 0) t = (-0.3 - o.y) / d.y;
      if (t >= 0 && t < best) {
        best = t;
        normal = UP_N;
      }
    }
    const step = this.cell;
    for (let t0 = 0; t0 < best; t0 += step) {
      const t1 = Math.min(t0 + step, best);
      const ax = o.x + d.x * t0, az = o.z + d.z * t0;
      const bx = o.x + d.x * t1, bz = o.z + d.z * t1;
      const list = this.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.disabled) continue;
        const t = b.isVolume ? rayVolume(o, d, b, best) : rayBox(o, d, b);
        if (t > 0 && t < best) {
          best = t;
          normal = AXIS_N[_hitAxis][d[AXES[_hitAxis]] > 0 ? 0 : 1];
        }
      }
    }
    this.hitNormal = normal;
    return best;
  }

  raycast(o, d, maxDist) {
    return this.raycastHit(o, d, maxDist);
  }

  groundY(x, z, fromY = 600) {
    const t = this.raycast({ x, y: fromY, z }, DOWN, fromY + 10);
    return fromY - t;
  }

  pointInside(x, y, z) {
    const list = this.query(x, z, x, z);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.disabled || !(x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && y > b.minY && y < b.maxY)) continue;
      if (!b.isVolume || volumeSolidAt(b, x, y, z)) return true;
    }
    return false;
  }
}

const _vb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
const UP_N = Object.freeze({ x: 0, y: 1, z: 0 });
const AXES = ['x', 'y', 'z'];
// Face normals per axis: [hit while moving +axis, hit while moving -axis]
const AXIS_N = [
  [Object.freeze({ x: -1, y: 0, z: 0 }), Object.freeze({ x: 1, y: 0, z: 0 })],
  [Object.freeze({ x: 0, y: -1, z: 0 }), Object.freeze({ x: 0, y: 1, z: 0 })],
  [Object.freeze({ x: 0, y: 0, z: -1 }), Object.freeze({ x: 0, y: 0, z: 1 })],
];
let _hitAxis = 0; // axis of the entry face from the last rayBox / rayVolume call

export function volumeSolidAt(v, x, y, z) {
  const ix = Math.floor((x - v.minX) / v.sx), iy = Math.floor((y - v.minY) / v.sy), iz = Math.floor((z - v.minZ) / v.sz);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= v.nx || iy >= v.ny || iz >= v.nz) return false;
  if (!v.occ[(iy * v.nz + iz) * v.nx + ix]) return false;
  const b = cellBox(v, ix, iy, iz, _vb);
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
}

// The solid part of one block. Volumes can be:
//   v.slab  = floor slabs: only the bottom v.slab metres of each block are solid
//   v.shell = outer walls: edge blocks are v.shell thick on the outside face (corners stay full)
export function cellBox(v, ix, iy, iz, b) {
  b.minX = v.minX + ix * v.sx;
  b.maxX = b.minX + v.sx;
  b.minY = v.minY + iy * v.sy;
  b.maxY = b.minY + v.sy;
  b.minZ = v.minZ + iz * v.sz;
  b.maxZ = b.minZ + v.sz;
  if (v.slab) b.maxY = b.minY + v.slab;
  else if (v.shell && v.nx > 1 && v.nz > 1) {
    const ex = ix === 0 || ix === v.nx - 1, ez = iz === 0 || iz === v.nz - 1;
    if (ex && !ez) {
      if (ix === 0) b.maxX = b.minX + v.shell;
      else b.minX = b.maxX - v.shell;
    } else if (ez && !ex) {
      if (iz === 0) b.maxZ = b.minZ + v.shell;
      else b.minZ = b.maxZ - v.shell;
    }
  }
  return b;
}

// Slab test; returns [tEnter, tExit] in _span or false.
const _span = [0, 0];
function slab(o, d, b) {
  let tmin = 0, tmax = Infinity, axis = 0, k = 0;
  for (const [oa, da, mn, mx] of [
    [o.x, d.x, b.minX, b.maxX],
    [o.y, d.y, b.minY, b.maxY],
    [o.z, d.z, b.minZ, b.maxZ],
  ]) {
    if (Math.abs(da) < 1e-9) {
      if (oa < mn || oa > mx) return false;
    } else {
      let t1 = (mn - oa) / da, t2 = (mx - oa) / da;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) {
        tmin = t1;
        axis = k;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    k++;
  }
  _hitAxis = axis;
  _span[0] = tmin;
  _span[1] = tmax;
  return true;
}

function rayBox(o, d, b) {
  return slab(o, d, b) ? _span[0] : -1; // 0 when the origin is inside: caller treats as no hit
}

// March through a volume's blocks; returns the distance to the first solid surface or -1.
// Each occupied block is tested once against its real shape (wall shell, slab, full block).
// A block whose solid part contains the origin is ignored (e.g. a camera inside rubble).
function rayVolume(o, d, v, maxT) {
  if (!slab(o, d, v)) return -1;
  const t0 = _span[0], t1 = Math.min(_span[1], maxT);
  const step = Math.min(v.sx, v.sy, v.sz) * 0.35;
  let last = -1, skip = -1;
  const ox = Math.floor((o.x - v.minX) / v.sx), oy = Math.floor((o.y - v.minY) / v.sy), oz = Math.floor((o.z - v.minZ) / v.sz);
  if (ox >= 0 && oy >= 0 && oz >= 0 && ox < v.nx && oy < v.ny && oz < v.nz) {
    const oi = (oy * v.nz + oz) * v.nx + ox, b = cellBox(v, ox, oy, oz, _vb);
    if (v.occ[oi] && o.x >= b.minX && o.x <= b.maxX && o.y >= b.minY && o.y <= b.maxY && o.z >= b.minZ && o.z <= b.maxZ) skip = oi;
  }
  for (let t = t0 + 1e-4; t <= t1 + step; t += step) {
    const tt = Math.min(t, t1);
    const ix = Math.min(v.nx - 1, Math.max(0, Math.floor((o.x + d.x * tt - v.minX) / v.sx)));
    const iy = Math.min(v.ny - 1, Math.max(0, Math.floor((o.y + d.y * tt - v.minY) / v.sy)));
    const iz = Math.min(v.nz - 1, Math.max(0, Math.floor((o.z + d.z * tt - v.minZ) / v.sz)));
    const i = (iy * v.nz + iz) * v.nx + ix;
    if (i === last) continue;
    last = i;
    if (!v.occ[i] || i === skip) continue;
    if (slab(o, d, cellBox(v, ix, iy, iz, _vb)) && _span[0] > 0 && _span[0] <= t1) return _span[0];
  }
  return -1;
}
