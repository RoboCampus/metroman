import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Low-poly cars built from extruded side profiles. Each car type is two InstancedMeshes
// (painted body + unlit lights), so hundreds of cars cost a handful of draw calls.
// Vertex colour WHITE = paint (tinted per instance), anything else keeps its own colour.
// Cars face -Z; lengths along Z, width along X.

const PAINT = '#ffffff', GLASS = '#1a2430', TIRE = '#111111', HUB = '#9a9a9a', TRIMC = '#2a2a2a';

const TYPES = {
  sedan: {
    body: [[-2.3, 0.32], [-2.3, 0.72], [-2.0, 0.86], [-0.9, 0.98], [1.6, 1.0], [2.22, 0.94], [2.3, 0.72], [2.3, 0.32]],
    cabin: [[-0.9, 0.97], [-0.3, 1.4], [0.75, 1.4], [1.55, 0.99]],
    roof: [-0.3, 0.75, 1.4], width: 1.78, wheelZ: 1.42, wheelR: 0.34, lightY: 0.7,
  },
  suv: {
    body: [[-2.4, 0.4], [-2.4, 0.92], [-2.1, 1.08], [-1.1, 1.15], [1.95, 1.15], [2.4, 1.1], [2.45, 0.92], [2.45, 0.4]],
    cabin: [[-1.1, 1.14], [-0.6, 1.72], [2.0, 1.72], [2.25, 1.14]],
    roof: [-0.6, 2.0, 1.72], width: 1.95, wheelZ: 1.55, wheelR: 0.4, lightY: 0.85,
  },
};

const _c = new THREE.Color();
function colorize(g, hex) {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  _c.set(hex);
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([_c.r, _c.g, _c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
// HDR colours (above 1) so lights bloom.
function glowColorize(g, r, gg, b) {
  g = colorize(g, '#000');
  const a = g.attributes.color.array;
  for (let i = 0; i < a.length; i += 3) a.set([r, gg, b], i);
  return g;
}

function extrude(points, width, bevel) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 2,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2); // profile x -> world z, extrusion -> world x
  return g;
}

function buildModel(name) {
  const t = TYPES[name === 'taxi' ? 'sedan' : name];
  const W = t.width, front = t.body[0][0], rear = t.body[t.body.length - 1][0];
  const body = [
    colorize(extrude(t.body, W, 0.06), PAINT),
    colorize(extrude(t.cabin, W - 0.2, 0.04), GLASS),
    colorize(new THREE.BoxGeometry(W - 0.22, 0.06, t.roof[1] - t.roof[0]).translate(0, t.roof[2] + 0.02, (t.roof[0] + t.roof[1]) / 2), PAINT),
    // B-pillar splits the side windows
    colorize(new THREE.BoxGeometry(W - 0.16, t.roof[2] - t.cabin[0][1], 0.1).translate(0, (t.roof[2] + t.cabin[0][1]) / 2, (t.roof[0] + t.roof[1]) / 2), PAINT),
    colorize(new THREE.BoxGeometry(W + 0.04, 0.2, 0.14).translate(0, 0.42, front - 0.02), TRIMC),
    colorize(new THREE.BoxGeometry(W + 0.04, 0.2, 0.14).translate(0, 0.42, rear + 0.02), TRIMC),
    colorize(new THREE.BoxGeometry(W * 0.55, 0.16, 0.05).translate(0, 0.62, front - 0.04), TRIMC),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (W / 2 - 0.02), z = sz * t.wheelZ;
      body.push(colorize(new THREE.CylinderGeometry(t.wheelR, t.wheelR, 0.26, 14).rotateZ(Math.PI / 2).translate(x, t.wheelR, z), TIRE));
      body.push(colorize(new THREE.CylinderGeometry(t.wheelR * 0.55, t.wheelR * 0.55, 0.27, 10).rotateZ(Math.PI / 2).translate(x, t.wheelR, z), HUB));
    }
  }
  const lights = [];
  for (const sx of [-1, 1]) {
    lights.push(glowColorize(new THREE.BoxGeometry(0.38, 0.13, 0.06).translate(sx * W * 0.34, t.lightY, front - 0.02), 2.4, 2.3, 2.0));
    lights.push(glowColorize(new THREE.BoxGeometry(0.42, 0.12, 0.06).translate(sx * W * 0.34, t.lightY + 0.06, rear + 0.02), 2.2, 0.12, 0.08));
  }
  if (name === 'taxi') lights.push(glowColorize(new THREE.BoxGeometry(0.55, 0.2, 0.22).translate(0, t.roof[2] + 0.15, 0.2), 2.2, 1.9, 0.7));
  return { body: mergeGeometries(body), lights: mergeGeometries(lights) };
}

const PALETTE = ['#e8e8e8', '#1d1d1f', '#8a1c1c', '#1c3f8a', '#5a6068', '#b0b4b8', '#2f5a3a', '#6b1f3a'];
const MIX = [['taxi', 0.45], ['sedan', 0.35], ['suv', 0.2]];
// Cars further than FAR (Manhattan distance) from the player are recycled onto lanes within NEAR.
const NEAR = 300, FAR = 650;
// Physical size per model [width, height, length] and damage model.
const DIMS = { taxi: [1.9, 1.5, 4.7], sedan: [1.9, 1.5, 4.7], suv: [2.05, 1.8, 5.0] };
const CAR_HP = 100, SMOKE_HP = 55, FIRE_HP = 25, WRECK_TIME = 25;
const WRECK_COLOR = new THREE.Color('#1a1918');
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

// Cars follow lanes until something hits them; then they become physics bodies that slide,
// tumble, take damage, smoke, burn and explode. Call bind(ctx) once the game exists.
export class Traffic {
  // lanes: { axis: 'x'|'z', c: lane coordinate, a, b: travel range, dir: ±1 }
  constructor(scene, lanes, rng, total = 260) {
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.55 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.lanes = lanes;
    this.cars = [];
    this.types = MIX.map(([name, share]) => {
      const model = buildModel(name), n = Math.round(total * share);
      const body = new THREE.InstancedMesh(model.body, bodyMat, n);
      const lights = new THREE.InstancedMesh(model.lights, lightMat, n);
      for (const m of [body, lights]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
      }
      body.castShadow = true;
      scene.add(body, lights);
      const T = { name, body, lights, dims: DIMS[name] };
      for (let i = 0; i < n; i++) {
        const color = new THREE.Color(name === 'taxi' ? '#f2b800' : PALETTE[(rng() * PALETTE.length) | 0]);
        body.setColorAt(i, color);
        const lane = lanes[(rng() * lanes.length) | 0];
        const v = 9 + rng() * 9;
        this.cars.push({
          T, i, color, lane, t: lane.a + rng() * (lane.b - lane.a), v, baseV: v, state: 'drive',
          pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0,
          spin: new THREE.Vector3(), hp: CAR_HP, wreckT: 0, still: 0, grounded: true,
        });
      }
      return T;
    });
    this.dummy = new THREE.Object3D();
    this.ctx = null;
    for (const c of this.cars) this.placeOnLane(c);
  }

  bind(ctx) {
    this.ctx = ctx;
  }

  placeOnLane(c) {
    const L = c.lane;
    if (L.axis === 'z') {
      c.pos.set(L.c, 0, c.t);
      c.yaw = L.dir > 0 ? Math.PI : 0;
    } else {
      c.pos.set(c.t, 0, L.c);
      c.yaw = L.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
  }

  // Put a car back into traffic on a random lane passing near the focus point.
  respawn(c, fx, fz) {
    for (let k = 0; k < 12; k++) {
      const L = this.lanes[(Math.random() * this.lanes.length) | 0];
      const cross = L.axis === 'z' ? fx : fz, along = L.axis === 'z' ? fz : fx;
      if (Math.abs(L.c - cross) > NEAR) continue;
      const a = Math.max(L.a, along - NEAR), b = Math.min(L.b, along + NEAR);
      if (b <= a) continue;
      // Don't pop a car into view right next to the player
      const t = a + Math.random() * (b - a);
      if (Math.abs(t - along) < 60 && Math.abs(L.c - cross) < 60) continue;
      c.lane = L;
      c.t = t;
      break;
    }
    if (c.state !== 'drive') {
      c.state = 'drive';
      c.hp = CAR_HP;
      c.vel.set(0, 0, 0);
      c.spin.set(0, 0, 0);
      c.pitch = c.roll = 0;
      c.T.body.setColorAt(c.i, c.color);
      c.T.body.instanceColor.needsUpdate = true;
    }
    c.v = c.baseV;
    this.placeOnLane(c);
  }

  // Is something (the player or a knocked-about car) in this car's lane just ahead?
  blocked(c) {
    const L = c.lane, ahead = (px, pz) => {
      const along = (L.axis === 'z' ? pz - c.t : px - c.t) * L.dir;
      const side = Math.abs((L.axis === 'z' ? px : pz) - L.c);
      return along > 0 && along < 9 && side < 2;
    };
    const p = this.ctx?.player;
    if (p && !p.dead && p.pos.y < 2.5 && ahead(p.pos.x, p.pos.z)) return true;
    for (const o of this.loose) if (o !== c && ahead(o.pos.x, o.pos.z)) return true;
    return false;
  }

  center(c, out) {
    return out.set(c.pos.x, c.pos.y + c.T.dims[1] * 0.5, c.pos.z);
  }

  knock(c, impulse, spinAmount) {
    if (c.state === 'drive') c.state = 'free';
    c.vel.add(impulse);
    c.spin.x += (Math.random() - 0.5) * spinAmount;
    c.spin.y += (Math.random() - 0.5) * spinAmount * 1.5;
    c.spin.z += (Math.random() - 0.5) * spinAmount;
    c.still = 0;
  }

  damage(c, amt) {
    if (c.state === 'wreck' || amt <= 0) return;
    c.hp -= amt;
    if (c.hp <= 0) this.explode(c);
  }

  // Area damage from powers and explosions; knock = launch speed at the centre.
  damageRadius(center, r, amt, knock) {
    let hits = 0;
    for (const c of this.cars) {
      const d = this.center(c, _v).distanceTo(center);
      if (d > r + 2) continue;
      const f = 1 - 0.5 * Math.min(1, d / r);
      _n.subVectors(_v, center).setY(0);
      if (_n.lengthSq() < 1e-4) _n.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _n.normalize().multiplyScalar(knock * f * 0.8);
      _n.y = knock * f * 0.45;
      if (knock > 0) this.knock(c, _n, knock * f * 0.4);
      this.damage(c, amt * f);
      hits++;
    }
    return hits;
  }

  // Nearest car hit by a moving sphere (projectiles). Cars are treated as spheres.
  sweep(o, d, len, rad) {
    let best = null, bt = len;
    for (const c of this.cars) {
      this.center(c, _v).sub(o);
      const tc = _v.dot(d), R = c.T.dims[2] * 0.42 + rad;
      if (tc < -R || tc > bt + R) continue;
      const d2 = _v.lengthSq() - tc * tc;
      if (d2 > R * R) continue;
      const t = Math.max(0, tc - Math.sqrt(R * R - d2));
      if (t < bt) {
        bt = t;
        best = c;
      }
    }
    return best ? { car: best, t: bt } : null;
  }

  explode(c) {
    const { fx, enemies, player } = this.ctx;
    c.state = 'wreck';
    c.hp = 0;
    c.wreckT = WRECK_TIME;
    c.vel.y += 9;
    c.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6);
    c.T.body.setColorAt(c.i, WRECK_COLOR);
    c.T.body.instanceColor.needsUpdate = true;
    const p = this.center(c, new THREE.Vector3());
    fx.burst(p, 140, { speed: 18, life: 0.9, size: 2.6, size1: 0.6, c0: [1, 0.8, 0.4], c1: [0.8, 0.15, 0], ay: 4, drag: 2.5 });
    fx.burst(p, 30, { speed: 26, life: 1.1, size: 0.35, c0: [1, 0.9, 0.6], c1: [1, 0.4, 0], ay: -20, drag: 0.4 });
    for (let i = 0; i < 40; i++) {
      fx.smoke(p.x, p.y, p.z, (Math.random() - 0.5) * 10, 2 + Math.random() * 6, (Math.random() - 0.5) * 10, 1.6 + Math.random(), 2, 6);
    }
    fx.ring(c.pos, 0xff8a30, 9, 0.45);
    this.ctx.impacts?.hit(c.pos.clone(), null, 5, 'fire', 9);
    fx.flash(p, 0xff8030, 2500, 60, 0.5);
    // The blast hurts nearby thugs and cars (enemies.damageRadius also hits cars: chain reactions)
    enemies.damageRadius(p, 8, 70, 16, 0, { type: 'power', noBoss: true }); // a car is nothing to the kaiju
    const d = player.pos.distanceTo(c.pos);
    if (d < 7) player.takeDamage(30 * (1 - d / 7));
    player.shake(Math.max(0.15, 0.9 - d / 60), 0.5);
  }

  // Player body-checks: running or flying into a car shoves it; hard hits launch and damage it.
  collidePlayer(c, dt) {
    const p = this.ctx.player;
    const [w, h, l] = c.T.dims;
    if (p.pos.y > c.pos.y + h + 0.3 || p.pos.y + p.height < c.pos.y) return;
    const dx = p.pos.x - c.pos.x, dz = p.pos.z - c.pos.z;
    const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // player in the car's local frame
    const hx = w / 2 + p.radius, hz = l / 2 + p.radius;
    if (Math.abs(lx) > hx || Math.abs(lz) > hz) return;
    _n.set(-dx, 0, -dz).normalize(); // from player toward car
    const closing = (p.vel.x - c.vel.x) * _n.x + (p.vel.z - c.vel.z) * _n.z;
    // Separate along the shallower local axis
    const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
    const sx = Math.sign(lx) || 1, sz = Math.sign(lz) || 1;
    const out = px < pz ? [sx * px * cs, -sx * px * sn] : [sz * pz * sn, sz * pz * cs];
    if (closing > 1) {
      const fast = closing > 20;
      _v.copy(_n).multiplyScalar(closing * (fast ? 1.1 : 0.9));
      _v.y = fast ? closing * 0.28 : 1.5;
      this.knock(c, _v, fast ? closing * 0.12 : closing * 0.05);
      if (closing > 12) {
        this.damage(c, closing * 1.4);
        const at = _v.copy(p.pos).setY(p.pos.y + 1);
        this.ctx.fx.burst(at, Math.min(40, closing), { speed: 10, life: 0.4, size: 0.4, c0: [1, 0.9, 0.6], c1: [1, 0.5, 0.1], ay: -15 });
        p.shake(Math.min(0.6, closing / 80), 0.25);
        if (this.ctx.combat) this.ctx.combat.hitstop(Math.min(0.08, closing / 1200));
      }
      p.vel.x -= _n.x * closing * 0.35;
      p.vel.z -= _n.z * closing * 0.35;
    }
    p.pos.x += out[0] * 0.5;
    p.pos.z += out[1] * 0.5;
  }

  // Loose cars bumping into others pass on their momentum.
  collideCars(c) {
    const speed = Math.hypot(c.vel.x, c.vel.z);
    if (speed < 3) return;
    for (const o of this.cars) {
      if (o === c || Math.abs(o.pos.x - c.pos.x) > 4 || Math.abs(o.pos.z - c.pos.z) > 4) continue;
      _n.subVectors(o.pos, c.pos).setY(0);
      const d = _n.length();
      if (d > 3.6 || d < 1e-3 || Math.abs(o.pos.y - c.pos.y) > 2) continue;
      _n.divideScalar(d);
      const closing = (c.vel.x - o.vel.x) * _n.x + (c.vel.z - o.vel.z) * _n.z;
      if (closing <= 0) continue;
      _v.copy(_n).multiplyScalar(closing * 0.7);
      _v.y = closing * 0.1;
      this.knock(o, _v, closing * 0.05);
      c.vel.addScaledVector(_n, -closing * 0.6);
      if (closing > 8) {
        this.damage(o, closing * 1.2);
        this.damage(c, closing * 0.8);
      }
    }
  }

  physics(c, dt) {
    const world = this.ctx.world;
    c.vel.y -= 25 * dt;
    const steps = Math.max(1, Math.ceil((c.vel.length() * dt) / 0.8));
    let ground = false;
    for (let s = 0; s < steps; s++) {
      c.pos.addScaledVector(c.vel, dt / steps);
      const r = world.resolve(c.pos, 1.3, c.T.dims[1], c.vel, dt / steps, 0.4);
      if (r.ground) ground = true;
      if (r.wall) {
        const hit = Math.hypot(c.vel.x, c.vel.z);
        if (hit > 15) this.damage(c, hit * 0.8);
        if (hit > 20) this.ctx.destruction?.damage(new THREE.Vector3(c.pos.x - r.nx * 2.5, c.pos.y + 1, c.pos.z - r.nz * 2.5), 2);
      }
    }
    c.grounded = ground;
    if (ground) {
      const f = Math.max(0, 1 - 2.5 * dt);
      c.vel.x *= f;
      c.vel.z *= f;
      c.spin.multiplyScalar(Math.max(0, 1 - 5 * dt));
      // Settle onto the wheels or the roof, whichever is closer
      const upright = Math.abs(Math.atan2(Math.sin(c.roll), Math.cos(c.roll))) < Math.PI / 2;
      const target = upright ? 0 : Math.PI;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      c.roll += wrap(target - c.roll) * Math.min(1, 6 * dt);
      c.pitch += wrap(-c.pitch) * Math.min(1, 6 * dt);
    }
    c.yaw += c.spin.y * dt;
    c.pitch += c.spin.x * dt;
    c.roll += c.spin.z * dt;
  }

  // Smoke when damaged, fire when critical, burning then smouldering wrecks.
  effects(c, dt) {
    const fx = this.ctx.fx;
    if (c.hp >= SMOKE_HP) return;
    const p = this.center(c, _v);
    const hood = c.T.dims[2] * 0.3;
    const hx = p.x - Math.sin(c.yaw) * hood, hz = p.z - Math.cos(c.yaw) * hood;
    const burning = c.state === 'wreck' ? c.wreckT > WRECK_TIME - 12 : c.hp < FIRE_HP;
    const heavy = c.hp < FIRE_HP || c.state === 'wreck';
    if (Math.random() < dt * (heavy ? 22 : 8)) {
      fx.smoke(hx + (Math.random() - 0.5), p.y + 0.6, hz + (Math.random() - 0.5), (Math.random() - 0.5) * 1.5, 2 + Math.random() * 2, (Math.random() - 0.5) * 1.5,
        2 + Math.random() * 1.5, heavy ? 1.2 : 0.7, heavy ? 5 : 3, heavy ? [0.16, 0.15, 0.14] : [0.45, 0.45, 0.45], [0.08, 0.08, 0.08]);
    }
    if (burning && Math.random() < dt * 30) {
      fx.spawn(hx + (Math.random() - 0.5) * 1.4, p.y + 0.4, hz + (Math.random() - 0.5) * 1.4, (Math.random() - 0.5), 2 + Math.random() * 2, (Math.random() - 0.5),
        0.5 + Math.random() * 0.3, 1.4, 0.4, [1, 0.75, 0.3], [0.9, 0.15, 0], 4, 1);
    }
  }

  // focus: point the traffic concentrates around (the player).
  update(dt, focus) {
    if (!this.ctx) return;
    this.loose = this.cars.filter((c) => c.state !== 'drive');
    const p = this.ctx.player;
    for (const c of this.cars) {
      if (c.state === 'drive') {
        const stop = this.blocked(c);
        c.v += ((stop ? 0 : c.baseV) - c.v) * Math.min(1, dt * (stop ? 6 : 1.5));
        const L = c.lane;
        c.t += L.dir * c.v * dt;
        if (c.t > L.b) c.t = L.a;
        if (c.t < L.a) c.t = L.b;
        this.placeOnLane(c);
        if (focus && Math.abs(c.pos.x - focus.x) + Math.abs(c.pos.z - focus.z) > FAR) this.respawn(c, focus.x, focus.z);
      } else {
        this.physics(c, dt);
        this.collideCars(c);
        this.ctx.props?.sweepBody(c.pos, 1.4, c.T.dims[1], c.vel, false); // flying cars mow down trees
        if (c.state === 'wreck') c.wreckT -= dt;
        const far = focus && Math.abs(c.pos.x - focus.x) + Math.abs(c.pos.z - focus.z);
        if (far > FAR || (c.state === 'wreck' && c.wreckT <= 0 && far > 80)) this.respawn(c, focus.x, focus.z);
      }
      if (!p.dead && Math.abs(p.pos.x - c.pos.x) < 4 && Math.abs(p.pos.z - c.pos.z) < 4) this.collidePlayer(c, dt);
      this.effects(c, dt);
    }
    const d = this.dummy;
    for (const c of this.cars) {
      d.position.copy(c.pos);
      _e.set(c.pitch, c.yaw, c.roll);
      d.quaternion.setFromEuler(_e);
      d.scale.setScalar(1);
      d.updateMatrix();
      c.T.body.setMatrixAt(c.i, d.matrix);
      if (c.state === 'wreck') d.scale.setScalar(0); // lights are out on a wreck
      d.updateMatrix();
      c.T.lights.setMatrixAt(c.i, d.matrix);
    }
    for (const T of this.types) {
      T.body.instanceMatrix.needsUpdate = true;
      T.lights.instanceMatrix.needsUpdate = true;
    }
  }
}
