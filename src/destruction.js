import * as THREE from 'three';
import { CELLS, ROOF_UV } from './citytex.js';
import { cellBox } from './collision.js';

// Destructible, hollow buildings made of blocks.
//
// Buildings normally live inside big merged meshes (cheap to draw). The first time one is
// damaged it is "fractured": every box-shaped wall becomes
//   - a shell of facade blocks (1 m thick outer walls, full blocks at the corners) and
//   - concrete floor slabs, one per storey plus the roof,
// so each level is hollow and you can stand inside it once you've broken in. Both are block
// grids (collision volumes in the World) drawn as InstancedMeshes; a shader maps the facade
// texture by world position so the blocks look exactly like the original building.
//
// Hits knock blocks out. After every hit a flood fill from the ground finds blocks that are no
// longer connected to it (floors hang off the walls; they don't hold each other up through the
// air between them). Each disconnected piece falls as one rigid chunk, tilting, and smashes
// into rubble where it lands, crushing what is below, so collapses can cascade. Once most of
// a building is gone the rest crumbles. A minute after the last damage it is restored.

const RESTORE = 60; // seconds after the last damage
const BLOCK = 4; // block width/depth in metres (one window bay)
const WALL = 1; // outer wall thickness in metres
const SLAB = 0.4; // floor slab thickness in metres
const CRUMBLE_AT = 0.2; // remaining fraction at which the whole building comes down
const MAX_DEBRIS = 220;
const _c = new THREE.Color(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), ZERO = new THREE.Vector3(0, 0, 0);
const IDQ = new THREE.Quaternion();
const _b = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

// Facade material that computes UVs from world position (so any block shows the right part
// of the building's facade). Same maths as THREE.BoxGeometry's UV layout used by the city.
function worldUVMaterial(base, wall) {
  const m = base.clone();
  const uniforms = {
    uB: { value: new THREE.Vector4(wall.cx, wall.cz, wall.w, wall.d) },
    uO: { value: new THREE.Vector2(wall.ou, wall.ov) },
    uS: { value: new THREE.Vector2(wall.cell[0] * CELLS, wall.cell[1] * CELLS) },
    uY0: { value: wall.y0 },
  };
  const roof = ROOF_UV.toFixed(8);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uB; uniform vec2 uO; uniform vec2 uS; uniform float uY0;')
      .replace('#include <uv_vertex>', `
  vec2 fuv = vec2(${roof}, ${roof});
  {
    mat4 im = modelMatrix;
    #ifdef USE_INSTANCING
      im = modelMatrix * instanceMatrix;
    #endif
    vec3 wp = (im * vec4(position, 1.0)).xyz;
    vec3 wn = normalize(mat3(im) * normal);
    if (abs(wn.y) < 0.5) {
      float along = abs(wn.x) > 0.5
        ? (wn.x > 0.0 ? (uB.y + uB.w * 0.5 - wp.z) : (wp.z - (uB.y - uB.w * 0.5)))
        : (wn.z > 0.0 ? (wp.x - (uB.x - uB.z * 0.5)) : (uB.x + uB.z * 0.5 - wp.x));
      fuv = vec2(uO.x + along / uS.x, uO.y + (wp.y - uY0) / uS.y);
    }
  }
  #if defined( USE_UV ) || defined( USE_ANISOTROPY )
    vUv = fuv;
  #endif
  #ifdef USE_MAP
    vMapUv = ( mapTransform * vec3( fuv, 1 ) ).xy;
  #endif
  #ifdef USE_EMISSIVEMAP
    vEmissiveMapUv = ( emissiveMapTransform * vec3( fuv, 1 ) ).xy;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = ( normalMapTransform * vec3( fuv, 1 ) ).xy;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = ( roughnessMapTransform * vec3( fuv, 1 ) ).xy;
  #endif
  #ifdef USE_METALNESSMAP
    vMetalnessMapUv = ( metalnessMapTransform * vec3( fuv, 1 ) ).xy;
  #endif
`);
  };
  m.customProgramCacheKey = () => 'facade-world-uv';
  return m;
}

// Hide / show a piece of a merged mesh by collapsing its vertices to one point.
function collapse(part) {
  if (part.hidden) return;
  const attr = part.mesh.geometry.attributes.position, a = attr.array, s = part.start * 3, e = (part.start + part.count) * 3;
  part.saved = a.slice(s, e);
  for (let i = s; i < e; i += 3) {
    a[i] = part.x;
    a[i + 1] = part.y;
    a[i + 2] = part.z;
  }
  attr.needsUpdate = true;
  part.hidden = true;
}
function uncollapse(part) {
  if (!part.hidden) return;
  const attr = part.mesh.geometry.attributes.position;
  attr.array.set(part.saved, part.start * 3);
  attr.needsUpdate = true;
  part.saved = null;
  part.hidden = false;
}

// Real shape of block i of volume v: centre and size (wall shell / slab / full block).
function blockShape(v, i, centre, size) {
  const ix = i % v.nx, iz = Math.floor(i / v.nx) % v.nz, iy = Math.floor(i / (v.nx * v.nz));
  const b = cellBox(v, ix, iy, iz, _b);
  centre.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
  if (size) size.set(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  return centre;
}

export class Destruction {
  constructor(ctx, { styleMats }) {
    this.ctx = ctx;
    this.mats = styleMats;
    this.active = new Set(); // fractured groups waiting to be restored
    this.bodies = []; // falling chunks
    this.debris = new Map(); // style -> { mesh, items }
    // Unit block with a white vertex-colour attribute (instance colour tints it)
    this.blockGeo = new THREE.BoxGeometry(1, 1, 1);
    this.blockGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(this.blockGeo.attributes.position.count * 3).fill(1), 3));
    // Bare concrete for floor slabs, with a faint warm glow so interiors aren't pitch black
    this.slabMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, emissive: '#3a3026', emissiveIntensity: 0.35 });
  }

  // ------------------------------------------------------------------ damage
  // Knock blocks out of any building within radius of point. Returns blocks removed.
  damage(point, radius, push = null) {
    if (this.ctx.pocket?.inside) return this.ctx.pocket.damage(point, radius, push); // (its ruins break instead)
    const world = this.ctx.world;
    const groups = new Set();
    for (const b of world.query(point.x - radius, point.z - radius, point.x + radius, point.z + radius)) {
      if (!b.group || b.group.round || b.group.erased || b.minY > point.y + radius || b.maxY < point.y - radius) continue;
      if (point.x < b.minX - radius || point.x > b.maxX + radius || point.z < b.minZ - radius || point.z > b.maxZ + radius) continue;
      groups.add(b.group);
    }
    let removed = 0;
    for (const g of groups) {
      this.fracture(g);
      let n = 0;
      for (const v of g.vols) n += this.carve(v, point, radius, push);
      if (!n) continue;
      removed += n;
      const r2 = (radius + 1) * (radius + 1);
      for (const part of g.parts) if ((part.x - point.x) ** 2 + (part.y - point.y) ** 2 + (part.z - point.z) ** 2 < r2) collapse(part);
      g.restoreT = RESTORE;
      this.active.add(g);
      this.settle(g);
    }
    if (removed) {
      this.dust(point, radius, Math.min(50, 8 + removed * 2));
      const d = this.ctx.player.pos.distanceTo(point);
      this.ctx.player.shake(Math.min(0.6, 0.08 + removed * 0.03) * Math.max(0.2, 1 - d / 120), 0.35);
    }
    return removed;
  }

  // Remove the blocks whose solid parts are inside the sphere.
  carve(v, p, r, push) {
    const rr = r + Math.min(v.sx, v.sz) * 0.4; // a small hit still takes the block it touches
    const ix0 = Math.max(0, Math.floor((p.x - rr - v.minX) / v.sx)), ix1 = Math.min(v.nx - 1, Math.floor((p.x + rr - v.minX) / v.sx));
    const iy0 = Math.max(0, Math.floor((p.y - rr - v.minY) / v.sy)), iy1 = Math.min(v.ny - 1, Math.floor((p.y + rr - v.minY) / v.sy));
    const iz0 = Math.max(0, Math.floor((p.z - rr - v.minZ) / v.sz)), iz1 = Math.min(v.nz - 1, Math.floor((p.z + rr - v.minZ) / v.sz));
    let n = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const i = (iy * v.nz + iz) * v.nx + ix;
          if (!v.occ[i]) continue;
          blockShape(v, i, _v);
          if (_v.distanceToSquared(p) > rr * rr) continue;
          v.occ[i] = 0;
          v.group.alive--;
          this.hide(v, i);
          // Chunks fly away from the impact
          _w.subVectors(_v, p).setY(0);
          if (_w.lengthSq() < 1e-4) _w.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          _w.normalize();
          if (push) _w.addScaledVector(push, 0.7).normalize();
          const sp = 5 + Math.random() * 8;
          this.spawnDebris(v, i, _v, _w.x * sp, 2 + Math.random() * 5, _w.z * sp);
          n++;
        }
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ fracturing
  fracture(g) {
    if (g.vols) return;
    const world = this.ctx.world;
    g.vols = [];
    g.total = 0;
    for (const w of g.walls) {
      if (w.part) collapse(w.part);
      if (w.style === 'store') continue; // shopfront shell: hidden, the blocks behind it show instead
      if (w.box) w.box.disabled = true;
      const nx = Math.max(1, Math.round(w.w / BLOCK)), nz = Math.max(1, Math.round(w.d / BLOCK));
      const ny = Math.max(1, Math.round(w.h / w.cell[1])), sy = w.h / ny;
      const edge = (i) => {
        const ix = i % nx, iz = Math.floor(i / nx) % nz;
        return ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1;
      };
      // Outer walls: only the edge blocks exist
      const shell = this.addVolume(g, w, {
        minX: w.cx - w.w / 2, maxX: w.cx + w.w / 2, minY: w.y0, maxY: w.y0 + w.h, minZ: w.cz - w.d / 2, maxZ: w.cz + w.d / 2,
        nx, ny, nz, shell: WALL,
      }, edge, this.mats[w.style] && worldUVMaterial(this.mats[w.style], w));
      // Floors: a slab at the bottom of every storey plus the roof (one extra layer on top);
      // the grid is shifted down by the slab thickness so slab tops sit at floor level.
      this.addVolume(g, w, {
        minX: shell.minX, maxX: shell.maxX, minY: w.y0 - SLAB, maxY: w.y0 - SLAB + (ny + 1) * sy, minZ: shell.minZ, maxZ: shell.maxZ,
        nx, ny: ny + 1, nz, slab: SLAB,
      }, (i) => !edge(i) || nx <= 2 || nz <= 2, this.slabMat);
    }
    g.alive = g.total;
    g.bodies = 0;
  }

  addVolume(g, w, spec, filled, material) {
    const n = spec.nx * spec.ny * spec.nz;
    spec.occ = new Uint8Array(n);
    for (let i = 0; i < n; i++) spec.occ[i] = filled(i) ? 1 : 0;
    const v = this.ctx.world.addVolume(spec);
    v.group = g;
    v.wall = w;
    const mesh = new THREE.InstancedMesh(this.blockGeo, material, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = mesh.receiveShadow = true;
    const base = _c.set(w.color), tint = new THREE.Color();
    for (let i = 0; i < n; i++) {
      if (!v.occ[i]) {
        mesh.setMatrixAt(i, _m.compose(ZERO, IDQ, _s.set(1e-4, 1e-4, 1e-4)));
        mesh.setColorAt(i, tint.setRGB(1, 1, 1));
        continue;
      }
      blockShape(v, i, _v, _w);
      mesh.setMatrixAt(i, _m.compose(_v, IDQ, _w));
      // Walls carry the street-grime gradient; slabs are plain concrete
      const f = v.slab ? 1 : w.grime + (1 - w.grime) * Math.min(1, (_v.y - w.y0) / w.h);
      mesh.setColorAt(i, v.slab ? tint.set('#9a958d') : tint.copy(base).multiplyScalar(f));
      g.total++;
    }
    mesh.computeBoundingSphere();
    this.ctx.scene.add(mesh);
    v.mesh = mesh;
    g.vols.push(v);
    return v;
  }

  hide(v, i) {
    v.mesh.setMatrixAt(i, _m.compose(ZERO, IDQ, _s.set(1e-4, 1e-4, 1e-4)));
    v.mesh.instanceMatrix.needsUpdate = true;
  }

  // Calls fn(volIndex, blockIndex) for every solid block touching block i of volume k:
  // the 6 neighbours in its own grid (slabs don't touch the slabs above/below them) and any
  // block in the building's other grids just beyond each of its faces.
  neighbours(g, k, i, fn) {
    const v = g.vols[k], nx = v.nx, nz = v.nz;
    const ix = i % nx, iz = Math.floor(i / nx) % nz, iy = Math.floor(i / (nx * nz));
    const occ = v.occ;
    if (ix > 0 && occ[i - 1]) fn(k, i - 1);
    if (ix < nx - 1 && occ[i + 1]) fn(k, i + 1);
    if (iz > 0 && occ[i - nx]) fn(k, i - nx);
    if (iz < nz - 1 && occ[i + nx]) fn(k, i + nx);
    if (!v.slab) {
      if (iy > 0 && occ[i - nx * nz]) fn(k, i - nx * nz);
      if (iy < v.ny - 1 && occ[i + nx * nz]) fn(k, i + nx * nz);
    }
    // Probe just outside the full grid cell sideways (thin wall blocks still reach the slabs
    // next to them) at the bottom, middle and top of the block's real height, and above/below.
    const b = cellBox(v, ix, iy, iz, _b), e = 0.05;
    const x0 = v.minX + ix * v.sx, x1 = x0 + v.sx, z0 = v.minZ + iz * v.sz, z1 = z0 + v.sz;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const probes = [[cx, b.minY - e, cz], [cx, b.maxY + e, cz]];
    for (const y of [b.minY + e, (b.minY + b.maxY) / 2, b.maxY - e]) probes.push([x0 - e, y, cz], [x1 + e, y, cz], [cx, y, z0 - e], [cx, y, z1 + e]);
    for (let kk = 0; kk < g.vols.length; kk++) {
      if (kk === k) continue;
      const o = g.vols[kk];
      for (const [x, y, z] of probes) {
        if (x < o.minX || x >= o.maxX || y < o.minY || y >= o.maxY || z < o.minZ || z >= o.maxZ) continue;
        const ii = (Math.floor((y - o.minY) / o.sy) * o.nz + Math.floor((z - o.minZ) / o.sz)) * o.nx + Math.floor((x - o.minX) / o.sx);
        if (o.occ[ii]) fn(kk, ii);
      }
    }
  }

  // Flood fill from the ground; everything unreached falls.
  settle(g) {
    const seen = g.vols.map((v) => new Uint8Array(v.occ.length));
    const qk = [], qi = [];
    g.vols.forEach((v, k) => {
      if (v.minY > 0.5) return; // only grids standing on the ground anchor the building
      const layer = v.nx * v.nz;
      for (let i = 0; i < layer; i++) {
        if (v.occ[i]) {
          seen[k][i] = 1;
          qk.push(k);
          qi.push(i);
        }
      }
    });
    const visit = (k, i) => {
      if (!seen[k][i]) {
        seen[k][i] = 1;
        qk.push(k);
        qi.push(i);
      }
    };
    for (let h = 0; h < qk.length; h++) this.neighbours(g, qk[h], qi[h], visit);

    if (g.alive <= g.total * CRUMBLE_AT) {
      this.crumble(g);
      return;
    }
    // Group the unsupported blocks into connected pieces; each falls on its own.
    for (let k = 0; k < g.vols.length; k++) {
      const v = g.vols[k];
      for (let i = 0; i < v.occ.length; i++) {
        if (!v.occ[i] || seen[k][i]) continue;
        const ck = [k], ci = [i];
        seen[k][i] = 1;
        for (let h = 0; h < ck.length; h++) {
          this.neighbours(g, ck[h], ci[h], (kk, ii) => {
            if (!seen[kk][ii]) {
              seen[kk][ii] = 1;
              ck.push(kk);
              ci.push(ii);
            }
          });
        }
        this.drop(g, ck.map((kk, h) => [kk, ci[h]]));
      }
    }
  }

  // ------------------------------------------------------------------ falling chunks
  item(g, k, i) {
    const v = g.vols[k];
    const c = new THREE.Vector3(), size = new THREE.Vector3();
    blockShape(v, i, c, size);
    return { v, i, c, size };
  }

  drop(g, items) {
    let minY = Infinity, cx = 0, cz = 0;
    const list = items.map(([k, i]) => {
      const it = this.item(g, k, i);
      it.v.occ[i] = 0; // no longer solid: it's falling
      g.alive--;
      minY = Math.min(minY, it.c.y - it.size.y / 2);
      cx += it.c.x;
      cz += it.c.z;
      return it;
    });
    cx /= list.length;
    cz /= list.length;
    // How far it can fall: lowest gap under its bottom layer (other buildings, rubble, ground)
    const world = this.ctx.world;
    let land = Infinity;
    const bottom = list.filter((it) => it.c.y - it.size.y / 2 <= minY + 0.5);
    const samples = Math.min(40, bottom.length);
    for (let s = 0; s < samples; s++) {
      const it = bottom[Math.floor((s / samples) * bottom.length)];
      land = Math.min(land, minY - world.groundY(it.c.x, it.c.z, minY - 0.05));
    }
    if (!isFinite(land)) land = minY;
    // Ledges, fire escapes and roof gear on the falling part go with it
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const it of list) {
      x0 = Math.min(x0, it.c.x);
      x1 = Math.max(x1, it.c.x);
      z0 = Math.min(z0, it.c.z);
      z1 = Math.max(z1, it.c.z);
    }
    for (const part of g.parts) {
      if (part.y > minY - 1 && part.x > x0 - 4 && part.x < x1 + 4 && part.z > z0 - 4 && part.z < z1 + 4) collapse(part);
    }
    const a = Math.random() * Math.PI * 2;
    this.bodies.push({
      g, list, land: Math.max(0, land), off: 0, vy: 0, tilt: 0, w: 0.05 + Math.random() * 0.25,
      axis: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), pivot: new THREE.Vector3(cx, minY, cz), size: list.length,
      extent: Math.max(x1 - x0, z1 - z0) / 2 + 4,
    });
    g.bodies++;
    g.restoreT = RESTORE;
  }

  // Too little left standing: the remainder sinks into the ground in a cloud of dust.
  crumble(g) {
    const list = [];
    g.vols.forEach((v, k) => {
      for (let i = 0; i < v.occ.length; i++) {
        if (!v.occ[i]) continue;
        v.occ[i] = 0;
        list.push(this.item(g, k, i));
      }
    });
    g.alive = 0;
    for (const part of g.parts) collapse(part);
    if (!list.length) return;
    let cx = 0, cz = 0, top = 0;
    for (const it of list) {
      cx += it.c.x;
      cz += it.c.z;
      top = Math.max(top, it.c.y);
    }
    this.bodies.push({
      g, list, crumble: true, off: 0, vy: -4, tilt: 0, w: 0, axis: new THREE.Vector3(1, 0, 0),
      pivot: new THREE.Vector3(cx / list.length, 0, cz / list.length), size: list.length, depth: top + 2, extent: 20,
    });
    g.bodies++;
    this.ctx.hud?.message?.('BUILDING DESTROYED', 1.5);
  }

  updateBodies(dt) {
    const fx = this.ctx.fx;
    for (let b = this.bodies.length - 1; b >= 0; b--) {
      const body = this.bodies[b];
      body.vy = body.crumble ? Math.max(-14, body.vy - 6 * dt) : Math.max(-60, body.vy - 25 * dt);
      body.off += body.vy * dt;
      body.tilt += body.w * dt;
      _q.setFromAxisAngle(body.axis, body.tilt);
      const shake = body.crumble ? 0.25 : 0;
      const dirty = new Set();
      for (const it of body.list) {
        _v.copy(it.c).sub(body.pivot).applyQuaternion(_q).add(body.pivot);
        _v.y += body.off;
        if (shake) _v.x += (Math.random() - 0.5) * shake;
        it.v.mesh.setMatrixAt(it.i, _m.compose(_v, _q, it.size));
        dirty.add(it.v.mesh);
      }
      for (const m of dirty) m.instanceMatrix.needsUpdate = true;
      // Dust pouring off the falling mass
      const it = body.list[(Math.random() * body.list.length) | 0];
      if (Math.random() < 0.8) {
        fx.smoke(it.c.x, it.c.y + body.off, it.c.z, (Math.random() - 0.5) * 3, 1, (Math.random() - 0.5) * 3, 2.5, 2, 6, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 0.6);
      }
      if (body.crumble) {
        if (Math.random() < 0.6) this.dust(_v.set(body.pivot.x + (Math.random() - 0.5) * 30, 1, body.pivot.z + (Math.random() - 0.5) * 30), 6, 3);
        if (-body.off >= body.depth) this.finish(body, b, false);
      } else if (-body.off >= body.land) this.finish(body, b, true);
    }
  }

  // A falling chunk hits the ground (or what's under it): rubble, dust, crushing damage.
  finish(body, index, impact) {
    this.bodies.splice(index, 1);
    body.g.bodies--;
    body.g.restoreT = RESTORE;
    for (const it of body.list) this.hide(it.v, it.i);
    if (!impact) return;
    let sx = 0, sz = 0, n = 0;
    const sample = Math.min(80, body.list.length);
    _q.setFromAxisAngle(body.axis, body.tilt);
    for (let s = 0; s < sample; s++) {
      const it = body.list[Math.floor((s / sample) * body.list.length)];
      _v.copy(it.c).sub(body.pivot).applyQuaternion(_q).add(body.pivot);
      _v.y += body.off;
      sx += _v.x;
      sz += _v.z;
      n++;
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
      this.spawnDebris(it.v, it.i, _v, Math.cos(a) * sp, 3 + Math.random() * 6, Math.sin(a) * sp);
    }
    const land = new THREE.Vector3(sx / n, body.pivot.y - body.land + 1, sz / n);
    this.dust(land, body.extent, Math.min(90, 20 + body.size));
    // Crush whatever is underneath: thugs, cars, trees and the building below it
    this.ctx.enemies.damageRadius(land, body.extent, 160, 18, 0, { type: 'power' });
    const d = this.ctx.player.pos.distanceTo(land);
    this.ctx.player.shake(Math.min(1.2, 0.2 + body.size / 150) * Math.max(0.15, 1 - d / 200), 0.6);
    if (land.y > 1.5) this.damage(land.setY(land.y - 1), Math.min(7, 2 + body.size / 40));
  }

  dust(p, r, n) {
    const fx = this.ctx.fx;
    for (let i = 0; i < n; i++) {
      fx.smoke(p.x + (Math.random() - 0.5) * r * 1.4, p.y + (Math.random() - 0.3) * r * 0.6, p.z + (Math.random() - 0.5) * r * 1.4,
        (Math.random() - 0.5) * 8, Math.random() * 3, (Math.random() - 0.5) * 8, 3 + Math.random() * 2.5, 3, 9,
        [0.52, 0.49, 0.45], [0.33, 0.31, 0.29], 0.25, 0.5);
    }
  }

  // ------------------------------------------------------------------ debris & restore
  debrisPool(key, material) {
    let pool = this.debris.get(key);
    if (pool) return pool;
    // Unit box textured with one facade cell (or plain concrete), tinted per instance
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.25 + uv.getX(i) / CELLS, 0.25 + uv.getY(i) / CELLS);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count * 3).fill(1), 3));
    const mesh = new THREE.InstancedMesh(geo, material, MAX_DEBRIS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    this.ctx.scene.add(mesh);
    pool = { mesh, items: [] };
    this.debris.set(key, pool);
    return pool;
  }

  spawnDebris(v, i, at, vx, vy, vz) {
    const slab = !!v.slab;
    const pool = slab ? this.debrisPool('slab', this.slabMat) : this.debrisPool(v.wall.style, this.mats[v.wall.style]);
    if (pool.items.length >= MAX_DEBRIS) pool.items.shift(); // oldest chunk disappears
    blockShape(v, i, _s, _w);
    const s = 0.35 + Math.random() * 0.4;
    pool.items.push({
      pos: at.clone(), vel: new THREE.Vector3(vx, vy, vz), q: new THREE.Quaternion(),
      spin: new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7),
      size: new THREE.Vector3(Math.max(0.4, _w.x * s), Math.max(0.3, _w.y * s), Math.max(0.4, _w.z * s)),
      color: slab ? '#9a958d' : v.wall.color, t: 0,
    });
  }

  // Wipe a whole building out of existence at once (no rubble). It comes back after `after` seconds.
  erase(g, after = 120) {
    const world = this.ctx.world;
    for (let b = this.bodies.length - 1; b >= 0; b--) {
      const body = this.bodies[b];
      if (body.g !== g) continue;
      for (const it of body.list) this.hide(it.v, it.i);
      this.bodies.splice(b, 1);
    }
    for (const v of g.vols ?? []) {
      world.removeVolume(v);
      this.ctx.scene.remove(v.mesh);
      if (v.mesh.material !== this.slabMat) v.mesh.material.dispose();
      v.mesh.dispose();
    }
    g.vols = null;
    for (const w of g.walls) {
      if (w.box) w.box.disabled = true;
      if (w.part) collapse(w.part);
    }
    for (const part of g.parts) collapse(part);
    g.erased = true;
    g.bodies = 0;
    g.restoreT = after;
    this.active.add(g);
  }

  // Pull blocks out of a building whole, for effects that carry them off (the Watcher's lift):
  // fractures it, removes every block whose centre passes take(centre), and returns them as
  // { pos, size, slab, color }. Roof gear passing take() goes too. Restores like any damage.
  extract(g, take) {
    this.fracture(g);
    const out = [];
    for (const v of g.vols) {
      for (let i = 0; i < v.occ.length; i++) {
        if (!v.occ[i]) continue;
        const c = blockShape(v, i, new THREE.Vector3(), _s);
        if (!take(c)) continue;
        const size = _s.clone(); // (before hide(), which reuses _s)
        v.occ[i] = 0;
        g.alive--;
        this.hide(v, i);
        out.push({ pos: c, size, slab: !!v.slab, color: v.slab ? '#9a958d' : v.wall.color });
      }
    }
    for (const part of g.parts) if (take(_v.set(part.x, part.y, part.z))) collapse(part);
    g.restoreT = RESTORE;
    this.active.add(g);
    return out;
  }

  // Bring an erased building back right away.
  unerase(g) {
    if (!g.erased) return;
    this.active.delete(g);
    this.restore(g);
  }

  restore(g) {
    const world = this.ctx.world;
    g.erased = false;
    for (const v of g.vols ?? []) {
      world.removeVolume(v);
      this.ctx.scene.remove(v.mesh);
      if (v.mesh.material !== this.slabMat) v.mesh.material.dispose();
      v.mesh.dispose();
    }
    g.vols = null;
    for (const w of g.walls) {
      if (w.box) w.box.disabled = false;
      if (w.part) uncollapse(w.part);
    }
    for (const part of g.parts) uncollapse(part);
  }

  update(dt) {
    this.updateBodies(dt);
    for (const g of this.active) {
      if (g.bodies > 0) continue;
      g.restoreT -= dt;
      if (g.restoreT <= 0) {
        this.restore(g);
        this.active.delete(g);
      }
    }
    const world = this.ctx.world;
    for (const pool of this.debris.values()) {
      const { mesh, items } = pool;
      for (let k = items.length - 1; k >= 0; k--) {
        const d = items[k];
        d.t += dt;
        d.vel.y -= 22 * dt;
        d.pos.addScaledVector(d.vel, dt);
        const floor = world.floorAt(d.pos.x, d.pos.z) + d.size.y * 0.3;
        if (d.pos.y < floor) {
          d.pos.y = floor;
          d.vel.y *= -0.25;
          d.vel.x *= 0.5;
          d.vel.z *= 0.5;
          d.spin.multiplyScalar(0.5);
        }
        d.q.premultiply(_q.setFromEuler(_e.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt)));
        if (d.t > 10) items.splice(k, 1);
      }
      items.forEach((d, i) => {
        const shrink = d.t > 9 ? Math.max(0.01, 1 - (d.t - 9)) : 1;
        mesh.setMatrixAt(i, _m.compose(d.pos, d.q, _s.copy(d.size).multiplyScalar(shrink)));
        mesh.setColorAt(i, _c.set(d.color));
      });
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
