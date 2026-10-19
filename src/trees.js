import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Trees: a few detailed variants (trunk, branches, clustered lumpy leaf blobs with darker
// undersides), instanced per variant and per map chunk so off-screen groups get culled.

const CHUNK = 450;
const PROPS = new Set(['bench', 'hydrant', 'trash', 'newsbox', 'pit']); // not counted as trees
const _c = new THREE.Color();

function colorize(g, fn) {
  const pos = g.attributes.position, n = pos.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), _c);
    a.set([_c.r, _c.g, _c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function prep(g) {
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

// Lumpy leaf cluster: displaced icosphere, shaded darker underneath.
function blob(rng, r, x, y, z, hex) {
  let g = new THREE.IcosahedronGeometry(r, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + (rng() - 0.5) * 0.38);
    v.y *= 0.82;
    p.setXYZ(i, v.x + x, v.y + y, v.z + z);
  }
  g.computeVertexNormals();
  const base = new THREE.Color(hex), jitter = 0.9 + rng() * 0.2;
  colorize(g, (px, py, pz, out) => {
    const t = THREE.MathUtils.clamp((py - (y - r)) / (2 * r), 0, 1);
    out.copy(base).multiplyScalar((0.6 + t * 0.6) * jitter);
  });
  return prep(g);
}

function limb(r0, r1, len, from, dir, hex) {
  const g = new THREE.CylinderGeometry(r1, r0, len, 6).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate(from.x, from.y, from.z);
  const c = new THREE.Color(hex);
  colorize(g, (x, y, z, out) => out.copy(c));
  return prep(g);
}

function makeTree(rng, { trunkH, trunkR, branches, blobs, palette }) {
  const bark = '#4a3829';
  const parts = [limb(trunkR, trunkR * 0.65, trunkH, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), bark)];
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng();
    const dir = new THREE.Vector3(Math.cos(a), 1.1, Math.sin(a));
    parts.push(limb(trunkR * 0.5, trunkR * 0.25, trunkH * 0.6, new THREE.Vector3(0, trunkH * 0.75, 0), dir, bark));
  }
  for (const [r, x, y, z] of blobs) parts.push(blob(rng, r, x, y, z, palette[(rng() * palette.length) | 0]));
  return mergeGeometries(parts);
}

// Big park tree grown recursively: trunk -> main limbs -> sub-branches, leaf clusters at the
// branch tips only, so the branch structure stays visible between the clusters.
function branchTree(rng, { trunkH, trunkR, limbs, limbLen, depth, leafR, palette, upBias }) {
  const bark = '#4a3829';
  const parts = [];
  const lean = new THREE.Vector3((rng() - 0.5) * 0.15, 1, (rng() - 0.5) * 0.15).normalize();
  parts.push(limb(trunkR, trunkR * 0.75, trunkH, new THREE.Vector3(), lean, bark));
  const top = lean.clone().multiplyScalar(trunkH);
  const grow = (from, dir, len, r, d) => {
    parts.push(limb(r, r * 0.62, len, from, dir, bark));
    const end = from.clone().addScaledVector(dir, len);
    if (d === 0) {
      parts.push(blob(rng, leafR * (0.8 + rng() * 0.4), end.x, end.y + leafR * 0.3, end.z, palette[(rng() * palette.length) | 0]));
      if (rng() < 0.5) {
        const o = leafR * 0.8;
        parts.push(blob(rng, leafR * 0.7, end.x + (rng() - 0.5) * o, end.y - leafR * 0.3, end.z + (rng() - 0.5) * o, palette[(rng() * palette.length) | 0]));
      }
      return;
    }
    const n = 2 + (rng() < 0.4 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng() * 1.2, tilt = 0.45 + rng() * 0.35;
      const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const nd = dir.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(side, Math.sin(tilt));
      nd.y += upBias;
      grow(end, nd.normalize(), len * (0.68 + rng() * 0.12), r * 0.62, d - 1);
    }
  };
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rng() * 0.6;
    const dir = new THREE.Vector3(Math.cos(a), 1.0 + upBias + rng() * 0.4, Math.sin(a)).normalize();
    const from = top.clone().multiplyScalar(0.8 + rng() * 0.2);
    grow(from, dir, limbLen * (0.85 + rng() * 0.3), trunkR * 0.6, depth);
  }
  return mergeGeometries(parts);
}

// Park bench: wooden slat seat and backrest on cast-iron side frames. Faces +Z, 1.8 m long.
function benchGeometry() {
  const wood = '#7a5a3a', iron = '#25272b';
  const box = (w, h, d, x, y, z, hex, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d).rotateX(rx).translate(x, y, z);
    const c = new THREE.Color(hex);
    colorize(g, (px, py, pz, out) => out.copy(c));
    return prep(g);
  };
  const parts = [];
  for (const z of [-0.12, 0.02, 0.16]) parts.push(box(1.8, 0.045, 0.12, 0, 0.45, z, wood));
  for (const y of [0.62, 0.8]) parts.push(box(1.8, 0.11, 0.04, 0, y, -0.24 - (y - 0.62) * 0.15, wood, -0.15));
  for (const x of [-0.8, 0.8]) {
    parts.push(box(0.06, 0.45, 0.06, x, 0.225, 0.2, iron));
    parts.push(box(0.06, 0.92, 0.06, x, 0.46, -0.22, iron, -0.15));
    parts.push(box(0.06, 0.05, 0.5, x, 0.64, -0.01, iron));
    parts.push(box(0.06, 0.05, 0.44, x, 0.42, -0.01, iron));
  }
  return mergeGeometries(parts);
}

// Street furniture, all facing +Z, built from coloured primitives.
function propGeometry(kind) {
  const P = [];
  const part = (geo, hex, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    const g = geo.rotateX(rx).rotateZ(rz).translate(x, y, z);
    const c = new THREE.Color(hex);
    colorize(g, (px, py, pz, out) => out.copy(c));
    P.push(prep(g));
  };
  const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
  if (kind === 'hydrant') {
    const red = '#a8221d';
    part(cyl(0.17, 0.19, 0.08), red, 0, 0.04);
    part(cyl(0.12, 0.13, 0.55), red, 0, 0.35);
    part(new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 0.62);
    part(cyl(0.03, 0.03, 0.08, 6), '#d9c25a', 0, 0.78);
    for (const s of [-1, 1]) part(cyl(0.05, 0.05, 0.12, 8), '#d9c25a', s * 0.16, 0.45, 0, 0, Math.PI / 2);
    part(cyl(0.06, 0.06, 0.1, 8), '#d9c25a', 0, 0.42, 0.15, Math.PI / 2);
  } else if (kind === 'trash') {
    part(cyl(0.3, 0.27, 0.9, 12), '#2d3b2f', 0, 0.45);
    part(cyl(0.33, 0.33, 0.06, 12), '#1f2a21', 0, 0.9);
    part(cyl(0.26, 0.26, 0.02, 12), '#151515', 0, 0.94);
  } else if (kind === 'newsbox') {
    const col = ['#1f4a8a', '#a8221d', '#c9a227', '#2f6a35'][(Math.random() * 4) | 0];
    part(new THREE.BoxGeometry(0.46, 0.75, 0.42), col, 0, 0.58);
    part(new THREE.BoxGeometry(0.34, 0.25, 0.02), '#c9d4dc', 0, 0.75, 0.215);
    part(new THREE.BoxGeometry(0.4, 0.2, 0.36), '#202020', 0, 0.1);
  } else if (kind === 'pit') {
    part(new THREE.BoxGeometry(1.4, 0.03, 1.4), '#3a2a1d', 0, 0.015);
    for (const s of [-1, 1]) {
      part(new THREE.BoxGeometry(1.4, 0.25, 0.03), '#1f2421', 0, 0.125, s * 0.7);
      part(new THREE.BoxGeometry(0.03, 0.25, 1.4), '#1f2421', s * 0.7, 0.125, 0);
    }
  }
  return mergeGeometries(P);
}

const GREEN = ['#3f7a35', '#4b8a3a', '#356d2e', '#5a8f3a'];
const AUTUMN = ['#c7832d', '#d4a72c', '#a8452a', '#b8692a', '#6f8a35'];

function buildVariants(rng) {
  const crown = (n, cy, spread, rMin, rMax) => {
    const out = [[rMax, 0, cy + rMax * 0.3, 0]];
    for (let i = 1; i < n; i++) {
      const a = (i / (n - 1)) * Math.PI * 2 + rng() * 0.5;
      out.push([rMin + rng() * (rMax - rMin), Math.cos(a) * spread, cy + (rng() - 0.3) * spread * 0.7, Math.sin(a) * spread]);
    }
    return out;
  };
  const tall = [[1.6, 0, 4.6, 0], [1.5, 0.5, 5.8, 0.3], [1.3, -0.4, 6.9, -0.2], [1.0, 0.1, 7.9, 0.1]];
  const parkOak = { trunkH: 4.2, trunkR: 0.5, limbs: 4, limbLen: 4.2, depth: 2, leafR: 1.9, upBias: 0.25 };
  const parkElm = { trunkH: 5.5, trunkR: 0.42, limbs: 3, limbLen: 4.6, depth: 2, leafR: 1.7, upBias: 0.6 }; // tall vase shape
  return {
    parkOak: branchTree(rng, { ...parkOak, palette: GREEN }),
    parkOakAutumn: branchTree(rng, { ...parkOak, palette: AUTUMN }),
    parkElm: branchTree(rng, { ...parkElm, palette: GREEN }),
    parkElmAutumn: branchTree(rng, { ...parkElm, palette: AUTUMN }),
    bench: benchGeometry(),
    hydrant: propGeometry('hydrant'),
    trash: propGeometry('trash'),
    newsbox: propGeometry('newsbox'),
    pit: propGeometry('pit'),
    oak: makeTree(rng, { trunkH: 2.8, trunkR: 0.3, branches: 3, blobs: crown(5, 4.4, 1.5, 1.4, 2.1), palette: GREEN }),
    oakAutumn: makeTree(rng, { trunkH: 2.8, trunkR: 0.3, branches: 3, blobs: crown(5, 4.4, 1.5, 1.4, 2.1), palette: AUTUMN }),
    tall: makeTree(rng, { trunkH: 3.6, trunkR: 0.25, branches: 2, blobs: tall, palette: GREEN }),
    street: makeTree(rng, { trunkH: 2.3, trunkR: 0.14, branches: 3, blobs: crown(3, 3.5, 0.8, 1.0, 1.35), palette: ['#4e8f3c', '#5f9a3e'] }),
    streetAutumn: makeTree(rng, { trunkH: 2.3, trunkR: 0.14, branches: 3, blobs: crown(3, 3.5, 0.8, 1.0, 1.35), palette: ['#c9a02e', '#b8762a'] }),
  };
}

// Breakable things: collision radius r and height h at scale 1, and what they turn into.
const BREAK = {
  parkOak: { r: 0.55, h: 13, tree: true }, parkOakAutumn: { r: 0.55, h: 13, tree: true, autumn: true },
  parkElm: { r: 0.5, h: 15, tree: true }, parkElmAutumn: { r: 0.5, h: 15, tree: true, autumn: true },
  oak: { r: 0.35, h: 7, tree: true }, oakAutumn: { r: 0.35, h: 7, tree: true, autumn: true }, tall: { r: 0.3, h: 9, tree: true },
  street: { r: 0.2, h: 5, tree: true }, streetAutumn: { r: 0.2, h: 5, tree: true, autumn: true },
  bench: { r: 0.95, h: 1 }, trash: { r: 0.35, h: 1 }, newsbox: { r: 0.3, h: 1.1 }, hydrant: { r: 0.22, h: 0.8, water: true },
};
const BREAK_SPEED = 20; // m/s: faster than this you smash through instead of bumping into things
const REGROW_TIME = 60, REGROW_DIST = 120, CELL = 10;
const _d = new THREE.Object3D(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _axis = new THREE.Vector3();
const _p = new THREE.Vector3(), _hit = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Trees, benches and street furniture: instanced per variant and per map chunk.
// Each instance is also registered in a coarse grid so the player, powers and flying cars
// can break it: trees topple, small props fly off as debris, hydrants gush water.
export class TreeField {
  constructor(rng) {
    this.rng = rng;
    this.groups = new Map(); // `${variant}|${chunk}` -> instances
    this.grid = new Map(); // cell -> breakable records
    this.active = []; // records being animated (falling / flying / regrowing)
    this.dirty = new Set();
    this.geysers = [];
    this.ctx = null;
  }

  bind(ctx) {
    this.ctx = ctx;
  }

  // kind: 'park' (tall branching Central Park trees), 'garden' (medium mixed trees for small
  // parks) or 'street' (young sidewalk trees)
  add(x, y, z, kind = 'garden', scale = 1) {
    const r = this.rng();
    let v;
    if (kind === 'street') v = r < 0.22 ? 'streetAutumn' : 'street';
    else if (kind === 'park') v = r < 0.2 ? 'parkOakAutumn' : r < 0.35 ? 'parkElmAutumn' : r < 0.7 ? 'parkOak' : 'parkElm';
    else v = r < 0.3 ? 'oakAutumn' : r < 0.55 ? 'tall' : 'oak';
    this.push(v, x, y, z, this.rng() * Math.PI * 2, scale * (0.85 + this.rng() * 0.35), 0.85 + this.rng() * 0.25);
  }

  // Bench facing direction rotY (0 = facing +Z).
  addBench(x, y, z, rotY) {
    this.push('bench', x, y, z, rotY, 1, 1);
  }

  // Street furniture: 'hydrant' | 'trash' | 'newsbox' | 'pit'
  addProp(kind, x, y, z, rotY = 0) {
    this.push(kind, x, y, z, rotY, 1, 1);
  }

  push(v, x, y, z, ry, s, tint) {
    const key = `${v}|${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = { v, list: [] }));
    g.list.push([x, y, z, ry, s, tint]);
  }

  build(scene) {
    const geos = buildVariants(this.rng);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    let count = 0;
    for (const { v, list } of this.groups.values()) {
      const m = new THREE.InstancedMesh(geos[v], mat, list.length);
      const info = BREAK[v];
      list.forEach(([x, y, z, ry, s, tint], i) => {
        this.setBase(m, i, x, y, z, ry, s);
        m.setColorAt(i, _c.setRGB(tint, tint, tint));
        if (info) {
          const rec = { m, i, v, info, x, y, z, ry, s, alive: true, anim: null };
          const k = this.cellKey(x, z);
          let cell = this.grid.get(k);
          if (!cell) this.grid.set(k, (cell = []));
          cell.push(rec);
        }
      });
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = m.receiveShadow = true;
      m.computeBoundingSphere();
      scene.add(m);
      if (!PROPS.has(v)) count += list.length;
    }
    return count;
  }

  setBase(m, i, x, y, z, ry, s) {
    _d.position.set(x, y, z);
    _d.quaternion.setFromAxisAngle(UP, ry);
    _d.scale.setScalar(s);
    _d.updateMatrix();
    m.setMatrixAt(i, _d.matrix);
    this.dirty.add(m);
  }

  cellKey(x, z) {
    return Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
  }

  // Calls fn(rec) for every standing breakable within r of (x, z).
  near(x, z, r, fn) {
    const c0x = Math.floor((x - r) / CELL), c1x = Math.floor((x + r) / CELL);
    const c0z = Math.floor((z - r) / CELL), c1z = Math.floor((z + r) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const cell = this.grid.get(cx * 100003 + cz);
        if (!cell) continue;
        for (const rec of cell) if (rec.alive && Math.hypot(rec.x - x, rec.z - z) < r + rec.info.r * rec.s) fn(rec);
      }
    }
  }

  // Break one object. dir: horizontal push direction, speed: how hard it was hit.
  smash(rec, dir, speed) {
    if (!rec.alive) return;
    const fx = this.ctx.fx, info = rec.info;
    rec.alive = false;
    _hit.set(rec.x, rec.y + 0.5, rec.z);
    if (info.tree) {
      // Topple away from the impact, pivoting at the base
      _axis.set(dir.z, 0, -dir.x).normalize();
      rec.anim = { type: 'fall', t: 0, angle: 0, w: 0.6 + speed * 0.02, axis: _axis.clone() };
      const leaf = info.autumn ? [[0.55, 0.32, 0.1], [0.4, 0.2, 0.06]] : [[0.22, 0.4, 0.15], [0.14, 0.28, 0.1]];
      const top = rec.y + info.h * rec.s * 0.65;
      for (let i = 0; i < 40; i++) {
        fx.smoke(rec.x + (Math.random() - 0.5) * 3 * rec.s, top + (Math.random() - 0.5) * 3, rec.z + (Math.random() - 0.5) * 3 * rec.s,
          dir.x * speed * 0.15 + (Math.random() - 0.5) * 6, Math.random() * 4, dir.z * speed * 0.15 + (Math.random() - 0.5) * 6,
          1.4 + Math.random(), 0.35, 0.25, leaf[0], leaf[1], -3, 1.5);
      }
    } else {
      rec.anim = {
        type: 'debris', t: 0,
        pos: new THREE.Vector3(rec.x, rec.y, rec.z),
        vel: new THREE.Vector3(dir.x * speed * 0.6, 4 + speed * 0.15, dir.z * speed * 0.6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
        q: new THREE.Quaternion().setFromAxisAngle(UP, rec.ry),
      };
      if (info.water) this.geysers.push({ x: rec.x, y: rec.y, z: rec.z, t: 8 });
    }
    // Splinters / bits
    const bits = info.tree ? [0.35, 0.25, 0.15] : rec.v === 'bench' ? [0.4, 0.28, 0.16] : [0.55, 0.55, 0.55];
    for (let i = 0; i < 18; i++) {
      fx.smoke(_hit.x, _hit.y, _hit.z, dir.x * speed * 0.2 + (Math.random() - 0.5) * 8, 2 + Math.random() * 5, dir.z * speed * 0.2 + (Math.random() - 0.5) * 8,
        0.9 + Math.random() * 0.5, 0.18, 0.12, bits, bits, -18, 0.5);
    }
    this.ctx.player.shake(info.tree ? 0.18 : 0.08, 0.15);
    this.active.push(rec);
  }

  // Area damage (explosions, powers, punches): break everything inside r.
  damageRadius(center, r, knock) {
    let n = 0;
    this.near(center.x, center.z, r, (rec) => {
      if (Math.abs(rec.y - center.y) > rec.info.h * rec.s + r) return;
      _p.set(rec.x - center.x, 0, rec.z - center.z);
      if (_p.lengthSq() < 1e-4) _p.set(1, 0, 0);
      this.smash(rec, _p.normalize(), Math.max(10, knock * 1.5));
      n++;
    });
    return n;
  }

  // A fast-moving body (player, car) of radius r at pos with velocity vel.
  sweepBody(pos, r, height, vel, solid) {
    const speed = Math.hypot(vel.x, vel.z);
    let bump = null;
    this.near(pos.x, pos.z, r, (rec) => {
      if (pos.y > rec.y + Math.min(rec.info.h * rec.s * 0.45, 4) || pos.y + height < rec.y) return;
      if (speed > BREAK_SPEED) this.smash(rec, _p.set(vel.x, 0, vel.z).normalize(), speed);
      else if (solid && rec.info.tree) bump = rec;
    });
    return bump;
  }

  update(dt) {
    const p = this.ctx.player;
    // The hero smashes through things at speed; tree trunks are solid at normal speed.
    if (!p.dead) {
      const bump = this.sweepBody(p.pos, p.radius + 0.15, p.height, p.vel, true);
      if (bump) {
        const minD = bump.info.r * bump.s + p.radius;
        _p.set(p.pos.x - bump.x, 0, p.pos.z - bump.z);
        const d = _p.length() || 1;
        if (d < minD) {
          _p.multiplyScalar(1 / d);
          p.pos.x = bump.x + _p.x * minD;
          p.pos.z = bump.z + _p.z * minD;
          const vn = p.vel.x * _p.x + p.vel.z * _p.z;
          if (vn < 0) {
            p.vel.x -= _p.x * vn;
            p.vel.z -= _p.z * vn;
          }
        }
      }
    }

    for (let k = this.active.length - 1; k >= 0; k--) {
      const rec = this.active[k], a = rec.anim;
      if (a) {
        a.t += dt;
        if (a.type === 'fall') {
          if (a.angle < 1.48) {
            a.w += (2.5 + a.angle * 4) * dt; // gravity speeds up the fall
            a.angle = Math.min(1.48, a.angle + a.w * dt);
          }
          const shrink = a.t > 4 ? Math.max(0, 1 - (a.t - 4)) : 1;
          _d.position.set(rec.x, rec.y - (1 - shrink) * 0.5, rec.z);
          _q.setFromAxisAngle(a.axis, a.angle);
          _q2.setFromAxisAngle(UP, rec.ry);
          _d.quaternion.multiplyQuaternions(_q, _q2);
          _d.scale.setScalar(rec.s * shrink);
          if (shrink <= 0) rec.anim = null;
        } else {
          a.vel.y -= 20 * dt;
          a.pos.addScaledVector(a.vel, dt);
          if (a.pos.y < rec.y) {
            a.pos.y = rec.y;
            a.vel.y *= -0.3;
            a.vel.x *= 0.6;
            a.vel.z *= 0.6;
            a.spin.multiplyScalar(0.6);
          }
          _q.setFromEuler(new THREE.Euler(a.spin.x * dt, a.spin.y * dt, a.spin.z * dt));
          a.q.premultiply(_q);
          const shrink = a.t > 3.5 ? Math.max(0, 1 - (a.t - 3.5) * 2) : 1;
          _d.position.copy(a.pos);
          _d.quaternion.copy(a.q);
          _d.scale.setScalar(rec.s * shrink);
          if (shrink <= 0) rec.anim = null;
        }
        _d.updateMatrix();
        rec.m.setMatrixAt(rec.i, _d.matrix);
        this.dirty.add(rec.m);
        if (!rec.anim) rec.regrow = REGROW_TIME;
      } else {
        // Gone: grow back once the player has been away for a while
        rec.regrow -= dt;
        if (rec.regrow <= 0 && Math.hypot(p.pos.x - rec.x, p.pos.z - rec.z) > REGROW_DIST) {
          rec.alive = true;
          this.setBase(rec.m, rec.i, rec.x, rec.y, rec.z, rec.ry, rec.s);
          this.active.splice(k, 1);
        }
      }
    }

    // Burst hydrants
    const fx = this.ctx.fx;
    for (let k = this.geysers.length - 1; k >= 0; k--) {
      const gz = this.geysers[k];
      gz.t -= dt;
      for (let i = 0; i < 4; i++) {
        fx.smoke(gz.x + (Math.random() - 0.5) * 0.3, gz.y + 0.5, gz.z + (Math.random() - 0.5) * 0.3,
          (Math.random() - 0.5) * 2, 9 + Math.random() * 4, (Math.random() - 0.5) * 2, 1.2, 0.4, 1.2,
          [0.75, 0.85, 0.95], [0.55, 0.65, 0.75], -14, 0.3);
      }
      if (gz.t <= 0) this.geysers.splice(k, 1);
    }

    for (const m of this.dirty) m.instanceMatrix.needsUpdate = true;
    this.dirty.clear();
  }
}
