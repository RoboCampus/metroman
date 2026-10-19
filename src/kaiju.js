import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';

// A building-sized, animalistic boss: a four-legged fire beast that stomps through the city.
//   - Walks toward the hero, smashing through any building in its way.
//   - Breathes big fireballs (single shots and spread volleys) that blow holes in buildings.
//   - Stomps when the hero is close to the ground below it.
//   - Leaps across the city at the hero and lands with a huge shock wave.
//   - Charges at the hero for a few seconds, head down, snapping its jaws to bite.
// It lives in enemies.list (type 'kaiju') so every attack the hero has can damage it; its body is
// a set of hit spheres (torso, neck, head, hips) instead of the single sphere smaller enemies use.

// The model is built at 1/SCALE size (about 36 m to the horn tips) and scaled up to skyscraper
// height; distances below are in world metres.
const SCALE = 4;
const HP = 6000;
const WALK = 34; // m/s
const TURN = 1.0; // rad/s
const KEEP = 150; // preferred distance to the hero
const STRIDE = 16 * SCALE; // metres per gait cycle
const FIREBALL = { speed: 115, radius: 4.5, dmg: 48, blast: 14 };
const LEAP = { min: 170, max: 650, crouch: 0.7 }; // jump-attack range and wind-up
const RUSH = { min: 90, max: 550, wind: 0.7, time: 5, speed: 68, turn: 1.7, dmg: 60, reach: 30 }; // charge & bite
const SPAWN_FIRST = 25, RESPAWN = 90;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

const skinMat = () => new THREE.MeshStandardMaterial({ color: '#34302b', roughness: 0.85, metalness: 0.05, flatShading: true, emissive: '#ffffff', emissiveIntensity: 0 });
const bellyMat = new THREE.MeshStandardMaterial({ color: '#5a4636', roughness: 0.9, flatShading: true });
const hornMat = new THREE.MeshStandardMaterial({ color: '#1a1714', roughness: 0.5, flatShading: true });
const toothMat = new THREE.MeshStandardMaterial({ color: '#d8cfb8', roughness: 0.6 });

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
// Lumpy ellipsoid: a low-poly sphere with jittered vertices reads as rough hide
function lump(rx, ry, rz, seg = 10, jitter = 0.08) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg - 3));
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * jitter;
    p.setXYZ(i, p.getX(i) * rx * k, p.getY(i) * ry * k, p.getZ(i) * rz * k);
  }
  g.computeVertexNormals();
  return g;
}
// Tapered limb segment hanging down from its pivot
function limb(r0, r1, len) {
  return new THREE.CylinderGeometry(r0, r1, len, 9, 2).translate(0, -len / 2, 0);
}

export class Kaiju {
  constructor(ctx, x, z) {
    this.ctx = ctx;
    this.glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.9, 0.15), toneMapped: false });
    this.glowBase = this.glow.color.clone();
    const skin = skinMat();
    const root = new THREE.Group();
    this.root = root;
    this.build(root, skin);
    root.scale.setScalar(SCALE);

    const enemies = ctx.enemies;
    const e = enemies.base('kaiju', root, new THREE.Vector3(x, 0, z), skin);
    e.boss = this;
    e.facing = Math.atan2(-(ctx.player.pos.x - x), -(ctx.player.pos.z - z));
    root.rotation.y = e.facing;
    e.spheres = [
      { o: new THREE.Vector3(0, 22, -2), r: SCALE * 11, c: new THREE.Vector3() }, // chest/belly
      { o: new THREE.Vector3(0, 21, 12), r: SCALE * 9, c: new THREE.Vector3() }, // hips
      { o: new THREE.Vector3(0, 28, -17), r: SCALE * 5.5, c: new THREE.Vector3() }, // neck
      { o: new THREE.Vector3(0, 31, -27), r: SCALE * 6, c: new THREE.Vector3(), head: true }, // head
    ];
    this.e = e;
    this.state = 'roar';
    this.stateT = 2.5;
    this.attackCd = 4;
    this.phase = 0;
    this.lastStep = [0, 0, 0, 0];
    this.smashT = 0;
    this.jaw = 0;
    this.charge = 0;
    this.tilt = 0;
    this.shots = 0;
    this.fireballs = [];
    this.crouch = 0;
    this.airY = 0;
    this.leap = null;
    this.lunge = 0; // 0..1 head-down charging pose
    this.biteCd = 0;
    this.progress = { x: x, z: z, t: 0 }; // stuck detection
    this.updateSpheres();
    ctx.hud.message('KAIJU ATTACK!', 3);
    ctx.player.shake(0.6, 2.5);
  }

  // ---------------------------------------------------------------- model
  build(root, skin) {
    const body = new THREE.Group();
    body.position.y = 22;
    root.add(body);
    this.body = body;
    body.add(mesh(lump(11, 9.5, 17, 14), skin, 0, 0, 0));
    body.add(mesh(lump(9, 7, 13, 12), bellyMat, 0, -3.2, -1));
    body.add(mesh(lump(9.5, 8.5, 9, 12), skin, 0, -0.5, 11)); // haunches
    body.add(mesh(lump(10, 9, 8, 12), skin, 0, 2, -11)); // shoulders hump

    // Glowing back spikes along the spine
    const spike = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0);
    for (let i = 0; i < 9; i++) {
      const z = -14 + i * 3.4, h = 6 - Math.abs(i - 3) * 0.6;
      const s = mesh(spike, i % 2 ? this.glow : hornMat, 0, 8.8 - Math.abs(i - 4) * 0.35, z);
      s.scale.set(1.6, h, 1.6);
      s.rotation.x = 0.35;
      body.add(s);
    }

    // Neck and head
    const neck = new THREE.Group();
    neck.position.set(0, 3, -15);
    body.add(neck);
    neck.add(mesh(lump(5.2, 5.5, 8, 10), skin, 0, 2.5, -4).rotateX(-0.5));
    this.neck = neck;
    const head = new THREE.Group();
    head.position.set(0, 7, -11);
    neck.add(head);
    this.head = head;
    head.add(mesh(lump(5.2, 4.2, 6.5, 12), skin, 0, 0, 0)); // skull
    head.add(mesh(lump(3.8, 2.4, 6, 10), skin, 0, -0.6, -6.5)); // snout
    for (const sx of [-1, 1]) {
      const horn = mesh(new THREE.ConeGeometry(1, 7, 6).translate(0, 3.5, 0), hornMat, sx * 3.2, 2.5, 2.5);
      horn.rotation.set(-1.1, 0, sx * -0.35);
      head.add(horn);
      head.add(mesh(new THREE.SphereGeometry(0.85, 8, 6), this.glow, sx * 3.1, 1.4, -3.4)); // eyes
      head.add(mesh(lump(1.4, 1, 2.5, 8), skin, sx * 3.4, 2.1, -3)); // brow ridge
    }
    const jaw = new THREE.Group();
    jaw.position.set(0, -2.2, 1.5);
    head.add(jaw);
    this.jawG = jaw;
    jaw.add(mesh(lump(3.6, 1.4, 6.5, 10), skin, 0, -0.6, -6));
    const tooth = new THREE.ConeGeometry(0.35, 1.6, 4);
    for (let i = 0; i < 6; i++) {
      for (const sx of [-1, 1]) {
        const up = mesh(tooth, toothMat, sx * (2.6 - i * 0.25), -2.8, -3 - i * 1.6);
        up.rotation.x = Math.PI;
        head.add(up);
        jaw.add(mesh(tooth, toothMat, sx * (2.4 - i * 0.25), 0.9, -2 - i * 1.6));
      }
    }
    // Furnace in the throat, visible when the jaw opens
    this.mouthGlow = mesh(lump(2.4, 1.2, 4, 8), this.glow, 0, -1.6, -5);
    head.add(this.mouthGlow);

    // Legs: hip/shoulder pivot -> thigh -> knee -> shin -> foot with claws
    this.legs = [];
    const claw = new THREE.ConeGeometry(0.6, 2.4, 5).rotateX(-Math.PI / 2);
    const legDefs = [[-1, -10, 0], [1, -10, 0.5], [-1, 11, 0.5], [1, 11, 0]];
    for (const [sx, z, off] of legDefs) {
      const hip = new THREE.Group();
      hip.position.set(sx * 8.5, -3, z);
      body.add(hip);
      hip.add(mesh(limb(4.6, 3.4, 10), skin));
      const knee = new THREE.Group();
      knee.position.y = -10;
      hip.add(knee);
      knee.add(mesh(limb(3.2, 2.4, 9), skin));
      const foot = new THREE.Group();
      foot.position.y = -9;
      knee.add(foot);
      foot.add(mesh(lump(3.4, 1.3, 4.2, 8), skin, 0, 0.2, -1));
      for (const cx of [-1.8, 0, 1.8]) foot.add(mesh(claw, hornMat, cx, -0.2, -5.2));
      this.legs.push({ hip, knee, foot, off, front: z < 0 });
    }

    // Tail: chain of shrinking segments, each swinging a little behind the last
    this.tail = [];
    let parent = body, len = 6, r = 5.5;
    let tz = 17;
    for (let i = 0; i < 9; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? -1 : 0, i === 0 ? tz : len);
      parent.add(seg);
      seg.add(mesh(new THREE.CylinderGeometry(r * 0.8, r, len + 1, 8).rotateX(Math.PI / 2).translate(0, 0, len / 2), skin));
      if (i % 2 === 0) {
        const s = mesh(spike, this.glow, 0, r * 0.7, len / 2);
        s.scale.set(r * 0.25, r * 0.6, r * 0.25);
        s.rotation.x = 0.5;
        seg.add(s);
      }
      this.tail.push(seg);
      parent = seg;
      len *= 0.92;
      r *= 0.8;
    }
  }

  // ---------------------------------------------------------------- per frame
  updateSpheres() {
    this.root.updateMatrixWorld(true);
    for (const s of this.e.spheres) {
      if (s.head) this.head.getWorldPosition(s.c);
      else s.c.copy(s.o).applyMatrix4(this.root.matrixWorld);
    }
  }

  update(dt) {
    const e = this.e, { player, world } = this.ctx;
    _v.subVectors(player.pos, e.pos);
    const dist = Math.hypot(_v.x, _v.z);
    const want = Math.atan2(-_v.x, -_v.z);
    e.stun = 0; // too big to stun
    e.vel.set(0, 0, 0);

    let speed = 0;
    this.stateT -= dt;
    this.attackCd -= dt;
    const aware = !player.dead;
    switch (this.state) {
      case 'roar':
        this.jaw = Math.min(1, this.jaw + dt * 2);
        if (Math.random() < dt * 20) this.ctx.player.shake(0.25, 0.3);
        if (this.stateT <= 0) this.state = 'walk';
        break;
      case 'walk': {
        this.jaw = Math.max(0, this.jaw - dt * 2);
        const turn = Math.abs(((want - e.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        // Head for the hero; if the river is in the way, follow the shore in the closest
        // direction that stays on land. Its body may hang out over the water, only its centre can't.
        let heading = want;
        if (dist > KEEP) heading = this.landHeading(want);
        const hTurn = Math.abs((((heading ?? want) - e.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (aware) e.facing = lerpAngle(e.facing, heading ?? want, Math.min(1, (TURN * dt) / Math.max(0.01, hTurn)));
        if (dist > KEEP && heading !== null && hTurn < 1.2 && this.onLand(e.facing, 25)) speed = WALK * (dist > KEEP * 2.5 ? 1.3 : 1);
        // Not getting anywhere for a while: jump to the hero instead
        const pr = this.progress;
        pr.t += dt;
        if (Math.hypot(e.pos.x - pr.x, e.pos.z - pr.z) > 25 || dist <= KEEP) {
          pr.x = e.pos.x;
          pr.z = e.pos.z;
          pr.t = 0;
        } else if (pr.t > 5 && aware && turn < 0.8) {
          pr.t = 0;
          this.begin('crouch', LEAP.crouch);
          break;
        }
        if (aware && this.attackCd <= 0 && dist < 750) {
          if (dist < 34 * SCALE && player.pos.y < 14 * SCALE) this.begin('stomp', 1.0);
          else if (dist > RUSH.min && dist < RUSH.max && turn < 0.8 && Math.random() < 0.3) {
            this.begin('rushWind', RUSH.wind);
            this.ctx.hud.callout('IT\'S CHARGING!', 'bad');
          } else if (dist > LEAP.min && dist < LEAP.max && turn < 0.8 && Math.random() < 0.35) {
            this.begin('crouch', LEAP.crouch);
          } else if (turn < 0.6) this.begin('breath', 0.9);
        }
        break;
      }
      case 'breath':
        // Rear the head back and suck in fire, then spit
        if (aware) e.facing = lerpAngle(e.facing, want, Math.min(1, dt * 1.5));
        this.charge = Math.min(1, this.charge + dt / 0.9);
        this.jaw = Math.min(0.6, this.jaw + dt * 1.5);
        this.inhale();
        if (this.stateT <= 0) {
          const volley = Math.random() < 0.4;
          if (volley) for (const a of [-0.12, 0, 0.12]) this.spit(a);
          else this.spit(0);
          this.shots++;
          this.jaw = 1;
          // Two or three single shots in a row before resting
          if (!volley && this.shots < 2 + (Math.random() < 0.5 ? 1 : 0)) this.begin('breath', 0.55, true);
          else {
            this.shots = 0;
            this.charge = 0;
            this.state = 'recover';
            this.stateT = 1;
            this.attackCd = 3 + Math.random() * 2.5;
          }
        }
        break;
      case 'stomp':
        // Rear up on the hind legs, then slam the front feet down
        this.tilt = Math.min(0.35, this.tilt + dt * 0.5);
        if (this.stateT <= 0) {
          this.slam();
          this.state = 'recover';
          this.stateT = 1.2;
          this.attackCd = 3 + Math.random() * 2;
        }
        break;
      case 'crouch':
        // Squat down and coil, facing the hero, then jump
        if (aware) e.facing = lerpAngle(e.facing, want, Math.min(1, dt * 2));
        this.crouch = Math.min(1, this.crouch + dt / LEAP.crouch);
        if (Math.random() < dt * 10) player.shake(0.15, 0.2);
        if (this.stateT <= 0) this.startLeap();
        break;
      case 'leap': {
        const L = this.leap;
        L.t += dt;
        const u = Math.min(1, L.t / L.T);
        e.pos.x = L.from.x + (L.to.x - L.from.x) * u;
        e.pos.z = L.from.z + (L.to.z - L.from.z) * u;
        this.airY = 4 * L.H * u * (1 - u);
        this.crouch = Math.max(0, this.crouch - dt * 4);
        // Warning rings where it's going to land
        L.ringT -= dt;
        if (L.ringT <= 0) {
          L.ringT = 0.3;
          this.ctx.fx.ring(_u.set(L.to.x, 0.3, L.to.z), 0xff3a1a, L.R, 0.35);
        }
        if (u >= 1) {
          this.airY = 0;
          this.leap = null;
          this.slam(e.pos, L.R);
          this.state = 'recover';
          this.stateT = 1.8;
          this.attackCd = 3.5 + Math.random() * 2;
        }
        break;
      }
      case 'rushWind':
        // Lowers its head and roars, then goes
        if (aware) e.facing = lerpAngle(e.facing, want, Math.min(1, dt * 2.5));
        this.lunge = Math.min(1, this.lunge + dt / RUSH.wind);
        this.jaw = Math.min(1, this.jaw + dt * 3);
        if (Math.random() < dt * 12) player.shake(0.2, 0.2);
        if (this.stateT <= 0) this.begin('rush', RUSH.time);
        break;
      case 'rush': {
        // Run the hero down, steering after them, jaws snapping
        const turn = Math.abs(((want - e.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (aware) e.facing = lerpAngle(e.facing, want, Math.min(1, (RUSH.turn * dt) / Math.max(0.01, turn)));
        if (this.onLand(e.facing, 40)) speed = RUSH.speed * Math.min(1, (RUSH.time - this.stateT) * 2 + 0.3);
        else this.stateT = Math.min(this.stateT, 0.3); // reached the water's edge
        this.jaw = 0.55 + 0.45 * Math.sin(this.stateT * 14);
        this.biteCd -= dt;
        if (this.biteCd <= 0 && aware && this.tryBite()) {
          this.endRush(1.6);
          break;
        }
        if (this.stateT <= 0) this.endRush(1.2);
        break;
      }
      case 'recover':
        this.jaw = Math.max(0, this.jaw - dt * 1.5);
        this.charge = Math.max(0, this.charge - dt * 2);
        if (this.stateT <= 0) this.state = 'walk';
        break;
    }
    if (this.state !== 'stomp') this.tilt = Math.max(0, this.tilt - dt * 1.4);
    if (this.state !== 'rushWind' && this.state !== 'rush') this.lunge = Math.max(0, this.lunge - dt * 1.5);
    if (this.state !== 'crouch' && this.state !== 'leap') this.crouch = Math.max(0, this.crouch - dt * 2);

    // Move and animate
    e.pos.x -= Math.sin(e.facing) * speed * dt;
    e.pos.z -= Math.cos(e.facing) * speed * dt;
    e.pos.y = this.airY;
    this.root.position.copy(e.pos);
    this.root.rotation.y = e.facing;
    this.animate(dt, speed);
    this.updateSpheres();
    if (speed > 0 || this.state === 'stomp' || this.state === 'leap') this.smash(dt);
    this.pushPlayer();

    // Glow: spikes and eyes brighten while charging; white flash when hit
    e.flash = Math.max(0, e.flash - dt * 6);
    e.mat.emissiveIntensity = e.flash * 0.35;
    this.glow.color.copy(this.glowBase).multiplyScalar(1 + this.charge * 1.5 + Math.sin(performance.now() * 0.004) * 0.15);
    this.updateFireballs(dt);
  }

  // Is the ground `ahead` metres in direction `facing` (centre of the body) land?
  onLand(facing, ahead) {
    const e = this.e;
    return this.ctx.city.isLand(e.pos.x - Math.sin(facing) * ahead, e.pos.z - Math.cos(facing) * ahead);
  }

  // The walkable heading closest to `want` (null if it's boxed in by water).
  landHeading(want) {
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6]) {
      if (this.onLand(want + off, 25) && this.onLand(want + off, 60)) return want + off;
    }
    return null;
  }

  // Jump at the spot the hero is over, leading them a little. Over the river it lands on the
  // nearest bit of shore on the way to them.
  startLeap() {
    const { player, city } = this.ctx, e = this.e;
    const to = new THREE.Vector3(player.pos.x + player.vel.x * 0.8, 0, player.pos.z + player.vel.z * 0.8);
    if (!city.isLand(to.x, to.z)) to.set(player.pos.x, 0, player.pos.z);
    for (let i = 0; i < 40 && !city.isLand(to.x, to.z); i++) to.lerp(e.pos, 0.08);
    if (!city.isLand(to.x, to.z)) to.copy(e.pos).setY(0);
    const d = Math.hypot(to.x - e.pos.x, to.z - e.pos.z);
    this.leap = { from: e.pos.clone(), to, t: 0, T: clamp(d / 220, 1.5, 3), H: Math.max(80, d * 0.35), R: 28 * SCALE, ringT: 0 };
    e.facing = Math.atan2(-(to.x - e.pos.x), -(to.z - e.pos.z));
    this.state = 'leap';
    this.charge = 0;
    // Launch: dust and a crater where it pushed off
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = 8 + Math.random() * 14;
      this.ctx.fx.smoke(e.pos.x, 2, e.pos.z, Math.cos(a) * s, Math.random() * 5, Math.sin(a) * s, 3, 6, 16, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 1);
    }
    this.ctx.impacts?.decals.add('crater', e.pos.clone().setY(0.02), UP, 18 * SCALE, 25, 'fire');
    this.ctx.destruction?.damage(_u.copy(e.pos).setY(8), 16);
    this.ctx.hud.callout('INCOMING!', 'bad');
    player.shake(0.6, 0.6);
  }

  // Snap at the hero if they're in front of its jaws (the bite reaches down below the head).
  tryBite() {
    const p = this.ctx.player.pos;
    this.mouth(_u);
    const hd = Math.hypot(p.x - _u.x, p.z - _u.z), dy = p.y + 1 - _u.y;
    if (Math.hypot(hd, Math.max(0, dy)) > RUSH.reach + 6 || dy < -RUSH.reach * 2.5) return false;
    this.biteCd = 0.6;
    this.jaw = 0;
    const fx = this.ctx.fx;
    fx.burst(_u, 30, { speed: 16, life: 0.4, size: 2, c0: [1, 0.85, 0.5], c1: [0.8, 0.2, 0], drag: 2 });
    fx.ring(_u, 0xff5020, 18, 0.3);
    this.ctx.player.shake(0.8, 0.4);
    const r = this.hitPlayer(RUSH.dmg, _u.clone(), 30);
    if (r === 'ignored') {
      this.ctx.hud.callout('DODGED!', 'good');
      return false; // rolled clear: keep chasing
    }
    this.ctx.hud.callout(r === 'blocked' ? 'BITE BLOCKED' : 'CHOMP!', r === 'blocked' ? 'good' : 'bad');
    return true;
  }

  endRush(t) {
    this.state = 'recover';
    this.stateT = t;
    this.attackCd = 2.5 + Math.random() * 2;
  }

  begin(state, t, keepCharge = false) {
    this.state = state;
    this.stateT = t;
    if (!keepCharge) this.charge = 0;
  }

  animate(dt, speed) {
    this.phase += (speed * dt) / STRIDE;
    const moving = speed > 0.1;
    const amp = moving ? 0.38 + 0.22 * this.lunge : 0;
    for (let i = 0; i < 4; i++) {
      const L = this.legs[i];
      const a = (this.phase + L.off + (L.front ? 0 : 0.25)) * Math.PI * 2;
      const swing = Math.sin(a) * amp;
      const lift = moving ? Math.max(0, Math.cos(a)) * 0.7 : 0;
      L.hip.rotation.x = swing + (L.front ? -this.tilt * 0.8 : this.tilt * 0.6);
      L.knee.rotation.x = (L.front ? lift : -lift) * 0.9 + (this.tilt && L.front ? 0.5 * this.tilt : 0);
      // Crouch: knees fold; in the air the front legs reach forward and the hind legs trail
      L.hip.rotation.x += (L.front ? 0.5 : -0.5) * this.crouch;
      L.knee.rotation.x += (L.front ? -1 : 1) * this.crouch;
      if (this.state === 'leap') {
        L.hip.rotation.x = L.front ? -0.9 : 0.8;
        L.knee.rotation.x = L.front ? 0.6 : -0.3;
      }
      L.foot.rotation.x = -L.hip.rotation.x - L.knee.rotation.x; // keep the sole flat
      // Footfall: shake and crush things underfoot
      const down = Math.cos(a) < 0 ? 1 : 0;
      if (moving && down && !this.lastStep[i]) this.footfall(L);
      this.lastStep[i] = down;
    }
    this.body.position.y = 22 + (moving ? Math.abs(Math.sin(this.phase * Math.PI * 4)) * 0.6 : 0) + this.tilt * 6 - this.crouch * 6;
    const lp = this.leap;
    this.body.rotation.x = this.tilt + (lp ? 0.35 * (1 - 2 * Math.min(1, lp.t / lp.T)) : 0) - 0.18 * this.lunge; // nose up, then down
    this.neck.rotation.x = -0.75 * this.lunge; // head down to bite
    this.body.rotation.z = moving ? Math.sin(this.phase * Math.PI * 2) * 0.03 : 0;
    // Head looks at the hero; rears back while charging
    const p = this.ctx.player.pos;
    this.head.getWorldPosition(_v);
    const local = this.root.worldToLocal(_w.copy(p));
    const yaw = clamp(Math.atan2(-local.x, -(local.z + 27)), -0.7, 0.7); // local space is unscaled
    const pitch = clamp(Math.atan2(p.y + 1 - _v.y, Math.hypot(p.x - _v.x, p.z - _v.z)) + 0.75 * this.lunge, -0.6, 0.5);
    this.neck.rotation.y += (yaw * 0.5 - this.neck.rotation.y) * Math.min(1, dt * 3);
    this.head.rotation.y += (yaw * 0.5 - this.head.rotation.y) * Math.min(1, dt * 3);
    const rear = this.state === 'breath' ? this.charge * 0.3 : 0;
    this.head.rotation.x += (pitch + rear - this.tilt - this.head.rotation.x) * Math.min(1, dt * 3);
    this.jawG.rotation.x = this.jaw * 0.75;
    this.mouthGlow.visible = this.jaw > 0.1 || this.charge > 0;
    const t = performance.now() * 0.001;
    this.tail.forEach((s, i) => {
      s.rotation.y = Math.sin(t * 1.4 - i * 0.5) * (moving ? 0.12 : 0.06);
      s.rotation.x = i === 0 ? -0.15 : 0.04;
    });
  }

  footfall(L) {
    L.foot.getWorldPosition(_u);
    _u.y = 0.5;
    const { fx, player } = this.ctx;
    for (let k = 0; k < 14; k++) {
      fx.smoke(_u.x + (Math.random() - 0.5) * 6 * SCALE, 1, _u.z + (Math.random() - 0.5) * 6 * SCALE, (Math.random() - 0.5) * 20, Math.random() * 5,
        (Math.random() - 0.5) * 20, 2.5 + Math.random(), 5, 14, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.4, 1);
    }
    this.ctx.impacts?.decals.add('crater', _u.clone().setY(0.02), UP, 7 * SCALE, 20, 'fire');
    const d = player.pos.distanceTo(_u);
    player.shake(0.6 * Math.max(0, 1 - d / 400), 0.4);
    const R = 7 * SCALE;
    this.ctx.destruction?.damage(_u.clone().setY(4), 10);
    this.ctx.traffic?.damageRadius(_u, R, 400, 18);
    this.ctx.props?.damageRadius(_u, R, 20);
    this.ctx.enemies.damageRadius(_u, R, 300, 20, 0, { type: 'power', skip: this.e });
    if (d < R && player.pos.y < 4 * SCALE) this.hitPlayer(30, _u, 18);
  }

  // Wreck the buildings the body is walking through.
  smash(dt) {
    this.smashT -= dt;
    if (this.smashT > 0) return;
    this.smashT = 0.2;
    const dest = this.ctx.destruction;
    if (!dest) return;
    _w.set(-Math.sin(this.e.facing), 0, -Math.cos(this.e.facing));
    for (const s of this.e.spheres) {
      // leading edge of each body part, plus the legs below the torso
      _u.copy(s.c).addScaledVector(_w, s.r * 0.6);
      if (this.ctx.world.pointInside(_u.x, _u.y, _u.z) || this.nearWall(_u, s.r)) dest.damage(_u, Math.min(16, s.r * 0.9), _w);
    }
    for (const L of this.legs) {
      L.knee.getWorldPosition(_u);
      if (this.nearWall(_u, 5 * SCALE)) dest.damage(_u, 12, _w);
    }
  }

  nearWall(p, r) {
    for (const b of this.ctx.world.query(p.x - r, p.z - r, p.x + r, p.z + r)) {
      if (!b.group || b.disabled) continue;
      if (p.x > b.minX - r && p.x < b.maxX + r && p.z > b.minZ - r && p.z < b.maxZ + r && p.y > b.minY - r && p.y < b.maxY + r) return true;
    }
    return false;
  }

  // The hero can't fly through the beast.
  pushPlayer() {
    const p = this.ctx.player;
    for (const s of this.e.spheres) {
      _v.copy(p.pos);
      _v.y += 1;
      _v.sub(s.c);
      const d = _v.length(), R = s.r + 0.6;
      if (d >= R || d < 1e-3) continue;
      _v.multiplyScalar((R - d) / d);
      p.pos.add(_v);
      const into = p.vel.dot(_v.normalize());
      if (into < 0) p.vel.addScaledVector(_v, -into);
    }
  }

  // ---------------------------------------------------------------- attacks
  mouth(out) {
    return this.mouthGlow.getWorldPosition(out);
  }

  inhale() {
    const fx = this.ctx.fx;
    this.mouth(_u);
    for (let i = 0; i < 3; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar((8 + Math.random() * 6) * SCALE);
      fx.spawn(_u.x + _v.x, _u.y + _v.y, _u.z + _v.z, -_v.x * 2.5, -_v.y * 2.5, -_v.z * 2.5, 0.4, 1.2, 4, [1, 0.6, 0.15], [1, 0.9, 0.5], 0, 0);
    }
  }

  spit(angle) {
    const { player, scene, fx } = this.ctx;
    const from = this.mouth(new THREE.Vector3());
    // Aim with a little lead so standing still or flying straight gets punished
    const d = from.distanceTo(player.pos);
    const to = _w.copy(player.pos).addScaledVector(player.vel, (d / FIREBALL.speed) * 0.6);
    to.y += 1;
    const dir = to.sub(from).normalize().applyAxisAngle(UP, angle).clone(); // clone: _w is scratch
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(FIREBALL.radius * 0.6, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 1), toneMapped: false })));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(FIREBALL.radius, 14, 10), new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 0.6, 0.08), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })));
    g.position.copy(from);
    scene.add(g);
    this.fireballs.push({ pos: from, vel: dir.multiplyScalar(FIREBALL.speed), life: 6, mesh: g });
    fx.flash(from, 0xff7a20, 900, 60, 0.25);
    fx.burst(from, 30, { speed: 14, life: 0.5, size: 2, c0: [1, 0.85, 0.4], c1: [0.9, 0.2, 0], drag: 2 });
  }

  updateFireballs(dt) {
    const { world, player, fx, scene } = this.ctx;
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      const len = f.vel.length() * dt;
      _u.copy(f.vel).normalize();
      const reach = len + FIREBALL.radius * 0.5;
      let t = world.raycastHit(f.pos, _u, reach);
      let hit = t < reach;
      let normal = hit ? world.hitNormal : null;
      // Close pass by the hero detonates it
      _v.copy(player.pos);
      _v.y += 1;
      const proj = clamp(_w.subVectors(_v, f.pos).dot(_u), 0, len);
      const miss = _w.copy(f.pos).addScaledVector(_u, proj).distanceTo(_v);
      if (!player.dead && miss < FIREBALL.radius + 0.8 && proj < t) {
        t = proj;
        hit = true;
        normal = null;
      }
      if (hit || f.life <= 0 || f.pos.y < world.floorAt(f.pos.x, f.pos.z)) {
        f.pos.addScaledVector(_u, Math.min(t, len));
        this.explode(f.pos, normal);
        scene.remove(f.mesh);
        f.mesh.children.forEach((m) => {
          m.geometry.dispose();
          m.material.dispose();
        });
        this.fireballs.splice(i, 1);
        continue;
      }
      f.pos.addScaledVector(_u, len);
      f.mesh.position.copy(f.pos);
      f.mesh.rotation.x += dt * 5;
      // Flaming trail
      for (let k = 0; k < 6; k++) {
        fx.spawn(f.pos.x + (Math.random() - 0.5) * FIREBALL.radius, f.pos.y + (Math.random() - 0.5) * FIREBALL.radius, f.pos.z + (Math.random() - 0.5) * FIREBALL.radius,
          (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.5, FIREBALL.radius, 0.6, [1, 0.8, 0.35], [0.8, 0.12, 0], 2, 1);
      }
      if (Math.random() < 0.6) fx.smoke(f.pos.x, f.pos.y, f.pos.z, 0, 1, 0, 1.6, 1.5, 4, [0.2, 0.18, 0.16], [0.08, 0.08, 0.08], 1.5, 0.5);
    }
  }

  explode(p, normal) {
    const { fx, player, impacts, enemies } = this.ctx;
    const B = FIREBALL.blast;
    fx.burst(p, 70, { speed: 22, life: 0.8, size: 3.2, size1: 0.6, c0: [1, 0.85, 0.4], c1: [0.85, 0.15, 0], ay: 3, drag: 2 });
    for (let i = 0; i < 18; i++) {
      fx.smoke(p.x + (Math.random() - 0.5) * B, p.y + (Math.random() - 0.3) * B * 0.6, p.z + (Math.random() - 0.5) * B,
        (Math.random() - 0.5) * 8, 2 + Math.random() * 4, (Math.random() - 0.5) * 8, 2.5 + Math.random() * 1.5, 3, 8, [0.24, 0.21, 0.19], [0.1, 0.1, 0.1], 1.6, 0.8);
    }
    fx.flash(p, 0xff7020, 2500, 80, 0.4);
    fx.ring(p, 0xff8a30, B * 1.6, 0.45);
    // Craters, shattered windows and a hole knocked through any building it hits
    impacts?.hit(p, normal, 7, 'fire', 10);
    this.ctx.destruction?.damage(normal ? _v.copy(p).addScaledVector(normal, -2) : p, 5.5);
    enemies.damageRadius(p, B, 120, 16, 0, { type: 'power', skip: this.e });
    const d = player.pos.distanceTo(p);
    player.shake(Math.min(1, 0.9 * (1 - d / 150)), 0.5);
    if (d < B) this.hitPlayer(FIREBALL.dmg * (1 - 0.6 * (d / B)), p, 22 * (1 - d / B) + 6);
  }

  // Shock wave on the ground: from the front feet (stomp) or at a landing point (leap).
  slam(at = null, R = 25 * SCALE) {
    const { fx, player } = this.ctx;
    if (at) _u.set(at.x, 0.3, at.z);
    else {
      _u.set(0, 0, 0);
      for (const L of this.legs) if (L.front) _u.add(L.foot.getWorldPosition(_v));
      _u.multiplyScalar(0.5).setY(0.3);
    }
    for (let r = 0; r < 3; r++) fx.ring(_u, 0xffb070, R * (0.6 + r * 0.3), 0.5 + r * 0.15);
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2, s = 10 + Math.random() * 16;
      fx.smoke(_u.x, 1, _u.z, Math.cos(a) * s * 2.5, Math.random() * 6, Math.sin(a) * s * 2.5, 3, 6, 16, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 1.2);
    }
    this.ctx.impacts?.decals.add('crater', _u.clone().setY(0.02), UP, R * 0.6, 25, 'fire');
    this.ctx.impacts?.shatterAround(_u.clone(), Math.min(40, R * 0.5));
    this.ctx.destruction?.damage(_u.clone().setY(6), 22);
    this.ctx.traffic?.damageRadius(_u, R, 300, 25);
    this.ctx.props?.damageRadius(_u, R, 25);
    this.ctx.enemies.damageRadius(_u, R, 200, 25, 0, { type: 'power', skip: this.e });
    player.shake(1.2, 0.8);
    const d = Math.hypot(player.pos.x - _u.x, player.pos.z - _u.z);
    if (d < R && player.pos.y < 6 * SCALE) this.hitPlayer(45 * (1 - 0.5 * d / R), _u, 22);
  }

  hitPlayer(dmg, from, knock) {
    const player = this.ctx.player;
    const r = player.takeDamage(dmg, 'normal');
    if (r !== 'hit') return r;
    _w.subVectors(player.pos, from).setY(0);
    if (_w.lengthSq() < 1e-4) _w.set(1, 0, 0);
    _w.normalize().multiplyScalar(knock);
    _w.y = knock * 0.5;
    player.vel.add(_w);
    if (!player.dead && knock > 14) player.knockdown(1.1, 'BLASTED');
    return r;
  }

  // ---------------------------------------------------------------- death
  die() {
    this.state = 'dead';
    this.deathT = 0;
    this.fallDir = Math.random() < 0.5 ? -1 : 1;
    for (const f of this.fireballs) this.ctx.scene.remove(f.mesh);
    this.fireballs.length = 0;
    this.ctx.hud.message('KAIJU DEFEATED!', 3);
    this.ctx.player.addSuper(100);
  }

  // Returns true once the body is gone.
  updateDead(dt) {
    if (this.state !== 'dead') this.die();
    this.deathT += dt;
    const t = this.deathT, fx = this.ctx.fx;
    this.jaw = Math.min(1, this.jaw + dt);
    this.jawG.rotation.x = this.jaw * 0.75;
    this.glow.color.copy(this.glowBase).multiplyScalar(Math.max(0, 1 - t / 3));
    // Legs buckle, then it keels over onto its side
    const k = clamp((t - 0.8) / 1.6, 0, 1), fall = k * k;
    this.root.rotation.z = this.fallDir * fall * 1.35;
    this.body.position.y = 22 - fall * 11;
    for (const L of this.legs) L.knee.rotation.x = (L.front ? 1 : -1) * Math.min(1, t) * 0.8;
    if (k >= 1 && !this.landed) {
      this.landed = true;
      _u.copy(this.e.pos).add(_v.set(this.fallDir * -14 * SCALE, 0, 0).applyAxisAngle(UP, this.e.facing));
      for (let i = 0; i < 80; i++) {
        fx.smoke(_u.x + (Math.random() - 0.5) * 50 * SCALE, 2, _u.z + (Math.random() - 0.5) * 50 * SCALE, (Math.random() - 0.5) * 30, Math.random() * 8,
          (Math.random() - 0.5) * 30, 5, 8, 24, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 0.8);
      }
      this.ctx.destruction?.damage(_u.clone().setY(10), 26);
      this.ctx.traffic?.damageRadius(_u, 30 * SCALE, 400, 20);
      this.ctx.props?.damageRadius(_u, 30 * SCALE, 20);
      this.ctx.player.shake(1.5, 1);
    }
    if (t > 8) this.root.position.y = -(t - 8) * 5 * SCALE; // sinks away
    return t > 13;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    this.glow.dispose();
  }
}

// Spawns the kaiju some time into the game, and again a while after each one is beaten.
// Press K to summon one right away.
export class KaijuSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.current = null;
  }

  summon() {
    const { player, city } = this.ctx;
    for (let tries = 0; tries < 20; tries++) {
      const pt = city.randomStreetPoint(player.pos.x, player.pos.z, 350, 520);
      if (pt && city.isLand(pt.x, pt.z)) {
        this.current = new Kaiju(this.ctx, pt.x, pt.z);
        return true;
      }
    }
    return false;
  }

  update(dt, input) {
    if (this.current && !this.ctx.enemies.list.includes(this.current.e)) {
      this.current.dispose();
      this.current = null;
      this.timer = RESPAWN;
    }
    if (this.current) return;
    this.timer -= dt;
    if (input?.hit('KeyK') || this.timer <= 0) {
      if (!this.summon()) this.timer = 5;
    }
  }
}

export const KAIJU_STATS = { hp: HP, r: 11 * SCALE, cy: 22 * SCALE, mass: 0, scale: SCALE };
