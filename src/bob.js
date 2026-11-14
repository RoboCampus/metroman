import * as THREE from 'three';
import { createRig } from './models.js';
import { Raptor, RAPTOR } from './raptor.js';

// Bob: a metal man with red eyes, and a real fight. He patrols the sky over the city looking for
// the hero; once he spots them (or gets hit) he goes after them until they get away.
// He fights like a raptor (ram / grab), only harder, and his throw is 350 km/h. Then the finisher:
// a red circle marks where the hero hit the ground and he charges up over it, then dives into it
// at full speed and blows it apart. Down on the ground, the hero has to break out (Ctrl) and get out
// of the circle, or dodge as he lands; a breakout alone isn't enough.

const HP = 2500;
const SCALE = 1.3;
const BOB = {
  type: 'bob', name: 'BOB', SCALE, CY: 1.1 * SCALE,
  FLY: { speed: 34, range: [14, 24], height: [4, 9], orbit: 0.6 },
  RAM: { ...RAPTOR.RAM, wind: 0.6, speed: 80, turn: 2.8, dmg: 35, time: 2.4 },
  GRAB: { ...RAPTOR.GRAB, wind: 0.55, speed: 75, turn: 3, dmg: 15, throw: 350 / 3.6, slamDmg: 60, down: 1.6 },
  STUN: { blocked: 1.3, miss: 0.5, wall: 1.6 },
  COOLDOWN: [1.2, 2.4],
};
// spot: sees the hero this far (with a clear line; `near` always), loses them past `lose`.
// search: patrol waypoints land this far from the hero (he has a rough idea where they are), the
// circle shrinking by `narrow` each waypoint down to `closest`. Blocked by a wall: climbs over it.
const PATROL = {
  speed: 30, alt: 35, roof: 15, spot: 120, near: 50, lose: 260, look: 0.25,
  search: [40, 160], narrow: 0.6, closest: 0.2, leg: 15, stuck: 0.8, climb: 45,
};
// The finisher: blast radius R (m), `wind` s of charging, the dive at `speed` m/s, then the blast
// (launching the hero out of the crater) and `stun` s dazed in it
const FINISH = { R: 8, wind: 1.5, speed: 140, rise: 10, dmg: 55, launch: 250 / 3.6, lift: 0.6, time: 2.2, stun: 1.8 };
const SPAWN_FIRST = 60, RESPAWN = 120;
const METAL = '#b4b9c0', JOINT = '#6a6e75', EYE = '#ff1a1a';
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

const eyeGeo = new THREE.SphereGeometry(1, 10, 8);
const eyeMat = new THREE.MeshBasicMaterial({ color: EYE, toneMapped: false });
let glowMat = null;
function eyeGlow() {
  if (glowMat) return glowMat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,90,70,1)');
  grad.addColorStop(0.3, 'rgba(255,20,10,0.6)');
  grad.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (glowMat = new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
}

export class Bob extends Raptor {
  constructor(ctx, pos) {
    super(ctx, pos, BOB);
    const e = this.e;
    e.noBar = false;
    e.bossName = 'BOB';
    e.mapColor = '#ff2a2a';
    e.scoreValue = 40;
    this.icon.position.y = 2.2;
    this.addEyes();
    this.lastHp = e.hp;
    this.lookT = 0;
    this.search = 1;
    this.stuckT = 0;
    this.climb = 0;
    this.spot = new THREE.Vector3();
    this.marker = this.makeMarker();
    this.begin('patrol');
    this.pickWaypoint();
  }

  // The hero's own mannequin body, all brushed steel
  makeRig() {
    const rig = createRig('hero', { preferModel: this.ctx.useModels !== false });
    rig.paint([METAL, JOINT, METAL, METAL, JOINT, METAL]);
    const joints = new Set((rig.tinted ?? []).filter((t) => t.slot === 'trim').map((t) => t.mat));
    for (const m of rig.mats ?? [rig.material]) {
      if (rig.mats) m.color.set(joints.has(m) ? JOINT : METAL);
      m.map = null;
      m.metalness = 0.85;
      m.roughness = joints.has(m) ? 0.5 : 0.32;
      m.needsUpdate = true;
    }
    return rig;
  }

  // Two glowing red eyes on the head bone (or on the body for the procedural fallback)
  addEyes() {
    const root = this.rig.root;
    root.rotation.y = 0;
    root.updateMatrixWorld(true);
    let head = null;
    root.traverse((o) => {
      if (!head && o.isBone && o.name.endsWith('Head')) head = o;
    });
    const parent = head ?? this.rig.body;
    const s = (this.eyeK = 1 / parent.getWorldScale(_v).x); // local units per metre
    // Where the eyes go, in Bob's own space (he faces -Z): on the face, a little above the head bone
    const base = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.65 * SCALE, 0).add(root.position);
    const y = base.y + 0.075 * SCALE;
    this.eyes = [];
    for (const side of [-1, 1]) {
      const x = base.x + side * 0.042 * SCALE;
      const at = _v.set(x, y, this.faceZ(x, y) ?? base.z - 0.105 * SCALE);
      const local = parent.worldToLocal(at.clone());
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.copy(local);
      eye.scale.set(0.022, 0.011, 0.012).multiplyScalar(s * SCALE);
      parent.add(eye);
      const glow = new THREE.Sprite(eyeGlow());
      glow.position.copy(local);
      glow.scale.setScalar(0.09 * s * SCALE);
      parent.add(glow);
      this.eyes.push(glow);
    }
  }

  // Front of the face at height y (in the rest pose): the skin vertex furthest toward -Z
  faceZ(x, y) {
    let z = Infinity;
    this.rig.root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        o.applyBoneTransform(i, _w.fromBufferAttribute(pos, i)).applyMatrix4(o.matrixWorld);
        if (Math.abs(_w.y - y) < 0.03 * SCALE && Math.abs(_w.x - x) < 0.02 * SCALE) z = Math.min(z, _w.z);
      }
    });
    return isFinite(z) ? z - 0.004 : null;
  }

  // The red warning circle on the ground: a rim, a faint fill and a disc that grows as he charges
  makeMarker() {
    const mat = (opacity) => new THREE.MeshBasicMaterial({ color: '#ff1a10', transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 72).rotateX(-Math.PI / 2), mat(0.95)));
    g.add(new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), mat(0.14)));
    const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), mat(0.3));
    g.add(fill);
    g.fill = fill;
    for (const m of g.children) m.renderOrder = 5;
    g.visible = false;
    this.ctx.scene.add(g);
    return g;
  }

  think(dt) {
    const e = this.e, { player, fx, hud } = this.ctx;
    const d = e.pos.distanceTo(player.pos);
    const hurt = e.hp < this.lastHp;
    this.lastHp = e.hp;
    if (this.state === 'finwind' || this.state === 'dive') return this.finisher(dt);
    if (this.state === 'patrol') {
      // Looking around (a sight check a few times a second)
      this.lookT -= dt;
      let seen = hurt || d < PATROL.near;
      if (!seen && this.lookT <= 0 && d < PATROL.spot) {
        this.lookT = PATROL.look;
        const c = this.center(_w), t = _v.copy(player.pos).setY(player.pos.y + 1);
        seen = this.clearLine(c, t, c.distanceTo(t));
      }
      if (player.dead || !seen) return this.patrol(dt);
      // Found them
      this.begin('hover');
      this.cd = 1.2;
      const c = this.center(_w);
      fx.ring(c, 0xff2020, 10, 0.5);
      fx.flash(c, 0xff2020, 200, 40, 0.3);
      hud.callout('BOB HAS FOUND YOU!', 'bad');
    } else if (this.state === 'hover' && (player.dead || d > PATROL.lose)) {
      // Lost them: back to searching
      this.begin('patrol');
      this.search = 1;
      this.pickWaypoint();
      return this.patrol(dt);
    }
    return super.think(dt);
  }

  // Thrown down: if they landed, the finisher comes next
  slamDown() {
    const player = this.ctx.player, landed = !player.dead && player.grounded;
    super.slamDown();
    if (!landed) return;
    this.spot.copy(player.pos);
    this.begin('finwind', FINISH.wind);
    this.ctx.fx.ring(this.center(_w), 0xff2020, 6, 0.4);
    this.ctx.hud.callout('BOB IS CHARGING · GET OUT OF THE CIRCLE!', 'bad');
  }

  finisher(dt) {
    const e = this.e, { player, fx } = this.ctx;
    const c = this.center(_w);
    if (this.state === 'finwind') {
      // Rising a little over the circle, red energy pouring into him, then the dive
      _v.set(e.pos.x - this.spot.x, 0, e.pos.z - this.spot.z);
      if (_v.lengthSq() > 1) _v.normalize().multiplyScalar(4);
      this.vel.lerp(_v.setY(FINISH.rise), 1 - Math.exp(-4 * dt));
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI - Math.PI / 2, r = 3 + Math.random() * 2;
        const ox = Math.cos(a) * Math.cos(b) * r, oy = Math.sin(b) * r, oz = Math.sin(a) * Math.cos(b) * r;
        fx.spawn(c.x + ox, c.y + oy, c.z + oz, -ox * 3, -oy * 3, -oz * 3, 0.3, 0.5, 0.1, [1, 0.4, 0.3], [0.9, 0.05, 0.02], 0, 0);
      }
      if (this.stateT <= 0) {
        if (player.dead) {
          this.begin('hover');
          return e.facing;
        }
        this.begin('dive', 3);
        this.dir.subVectors(this.spot, e.pos).normalize();
        fx.ring(c, 0xff2020, 7, 0.3, this.dir);
        fx.flash(c, 0xff2020, 300, 40, 0.2);
      }
      return Math.atan2(this.spot.x - e.pos.x, this.spot.z - e.pos.z) + Math.PI;
    }
    // The dive: straight into the middle of the circle
    this.vel.copy(this.dir).multiplyScalar(FINISH.speed);
    this.trail(c, [1, 0.4, 0.3], [0.9, 0.05, 0.02]);
    if (e.pos.distanceTo(this.spot) <= FINISH.speed * dt + 1 || this.stateT <= 0) {
      e.pos.copy(this.spot);
      this.blast();
    }
    return Math.atan2(-this.dir.x, -this.dir.z);
  }

  // Hit the ground (or a roof, an awning...) on the way down: that's where it goes off
  bumped(r) {
    if (this.state === 'dive' && (r.ground || r.wall)) {
      this.spot.copy(this.e.pos);
      this.blast();
    }
  }

  blast() {
    const { player, fx, hud } = this.ctx, at = this.spot, R = FINISH.R;
    this.vel.set(0, 0, 0);
    fx.ring(at, 0xff2020, R * 1.3, 0.5);
    fx.ring(at, 0xffc0a0, R * 0.8, 0.35);
    fx.burst(_w.copy(at).setY(at.y + 0.5), 120, { speed: 26, life: 0.8, size: 1.8, c0: [1, 0.5, 0.35], c1: [0.6, 0.05, 0.02], drag: 2.5 });
    fx.burst(_w.copy(at).setY(at.y + 0.3), 70, { speed: 16, life: 0.9, size: 1.6, c0: [0.7, 0.65, 0.6], c1: [0.2, 0.2, 0.2], drag: 3 });
    fx.flash(at, 0xff3020, 2500, 50, 0.3);
    this.ctx.destruction?.damage(at.clone(), R * 0.5, null);
    this.ctx.traffic?.damageRadius(at, R, 150, 35);
    player.shake(Math.max(0.2, 1.2 * (1 - player.pos.distanceTo(at) / 80)), 0.6);
    const dx = player.pos.x - at.x, dz = player.pos.z - at.z, dy = player.pos.y - at.y;
    if (!player.dead && Math.hypot(dx, dz) < R + 0.4 && dy > -2 && dy < R) {
      // Caught in it. Only a dodge gets them through (not the moment of cover after a breakout).
      let res = 'ignored';
      if (player.dodgeT <= 0) {
        const immune = player.immuneT;
        player.immuneT = 0;
        res = player.takeDamage(FINISH.dmg, 'normal');
        player.immuneT = immune;
      }
      if (res === 'ignored') hud.callout('DODGED!', 'good');
      else {
        // Blown out of the crater (straight up from dead centre)
        const dir = _v.set(dx, 0, dz);
        if (dir.lengthSq() < 0.01) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize().setY(FINISH.lift).normalize().multiplyScalar(FINISH.launch);
        player.downT = 0;
        if (!player.dead) player.launch(dir, FINISH.time, res === 'blocked');
        this.ctx.combat?.hitstop(0.1);
        hud.callout(res === 'blocked' ? 'BLAST BLOCKED · LAUNCHED!' : 'OBLITERATED!', res === 'blocked' ? 'good' : 'bad');
      }
    } else if (!player.dead) hud.callout('ESCAPED THE BLAST!', 'good');
    this.recover(FINISH.stun);
  }

  pickWaypoint() {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2;
    const r = (PATROL.search[0] + Math.random() * (PATROL.search[1] - PATROL.search[0])) * this.search;
    this.search = Math.max(PATROL.closest, this.search * PATROL.narrow);
    this.way = new THREE.Vector3(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
    this.wayT = PATROL.leg;
  }

  // Cruise from waypoint to waypoint high over the streets, climbing over whatever is ahead
  patrol(dt) {
    const e = this.e, world = this.ctx.world;
    this.wayT -= dt;
    const flat = Math.hypot(this.way.x - e.pos.x, this.way.z - e.pos.z);
    if (flat < 15 || this.wayT <= 0) this.pickWaypoint();
    // Looking ahead along the way for rooftops; pressed against a wall, climb
    _v.set(this.way.x - e.pos.x, 0, this.way.z - e.pos.z).normalize().multiplyScalar(30).add(e.pos);
    const roof = Math.max(world.groundY(_v.x, _v.z, 600), world.groundY(e.pos.x, e.pos.z, 600));
    this.stuckT = Math.hypot(this.vel.x, this.vel.z) < 4 ? this.stuckT + dt : 0;
    if (this.stuckT > PATROL.stuck) this.climb = PATROL.climb;
    this.climb = Math.max(0, this.climb - 8 * dt);
    const goal = _w.set(this.way.x, Math.max(PATROL.alt, roof + PATROL.roof) + this.climb, this.way.z);
    if (this.climb > 0) goal.y = e.pos.y + this.climb;
    this.steer(goal.sub(e.pos), PATROL.speed, 1.5, dt);
    this.dir.copy(this.vel).normalize();
    // Head turning side to side, scanning the streets
    return Math.atan2(-this.vel.x, -this.vel.z) + Math.sin(this.t * 1.3) * 0.25;
  }

  animate(dt) {
    // Eyes: steady red, flaring when he winds up
    const tell = this.state === 'windup' || this.state === 'grabwind' || this.state === 'finwind';
    const glow = (tell ? 0.2 : 0.09) * (1 + 0.15 * Math.sin(this.t * (tell ? 30 : 3))) * SCALE;
    for (const g of this.eyes ?? []) g.scale.setScalar(glow * this.eyeK);
    // The warning circle: pulsing rim, the inside filling up as he charges
    const m = this.marker, on = this.state === 'finwind' || this.state === 'dive';
    m.visible = on;
    if (on) {
      m.position.set(this.spot.x, this.spot.y + 0.3, this.spot.z);
      m.scale.setScalar(FINISH.R);
      m.children[0].material.opacity = 0.65 + 0.35 * Math.sin(this.t * 18);
      m.fill.scale.setScalar(this.state === 'dive' ? 1 : Math.max(0.02, 1 - Math.max(0, this.stateT) / FINISH.wind));
    }
    if (this.state !== 'patrol') return super.animate(dt);
    const e = this.e;
    this.rig.root.position.copy(e.pos);
    this.rig.root.rotation.y = e.facing;
    // Cruising flight: flat out, arms back along his sides
    const bob = Math.sin(this.t * 2);
    this.rig.pose({ tilt: -1.25 + bob * 0.04, sL: 0.15, sR: 0.15, eL: 0.2, eR: 0.2, spread: 0.18, hL: 0.05, kL: -0.15, hR: 0.15, kR: -0.35 }, 1 - Math.exp(-6 * dt), dt, null);
  }

  updateDead(dt) {
    this.marker.visible = false;
    const done = super.updateDead(dt);
    for (const g of this.eyes) g.visible = this.deathT < 1.2 && Math.random() > this.deathT / 1.2; // flicker out
    return done;
  }

  dispose() {
    this.ctx.scene.remove(this.marker);
  }
}

// Bob turns up on his own a minute in (and again a while after he's beaten). V calls him now.
export class BobSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.bob = null;
  }

  spawn() {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2;
    this.bob = new Bob(this.ctx, new THREE.Vector3(p.x + Math.cos(a) * 140, Math.max(p.y, 0) + PATROL.alt, p.z + Math.sin(a) * 140));
    this.ctx.hud.callout('BOB IS SEARCHING FOR YOU', 'bad');
  }

  update(dt, input) {
    const enemies = this.ctx.enemies;
    if (this.bob && !enemies.list.includes(this.bob.e)) {
      this.bob.dispose();
      this.bob = null;
      this.timer = RESPAWN;
    }
    if (input?.hit('KeyV')) {
      if (!this.bob) this.spawn();
      else this.ctx.hud.callout('BOB IS ALREADY OUT THERE', 'bad');
    }
    if (this.enabled === false || this.bob) return;
    this.timer -= dt;
    if (this.timer <= 0) this.spawn();
  }
}

export const BOB_STATS = { hp: HP, r: 0.9 * SCALE, cy: BOB.CY, mass: 0.08, scale: SCALE };
