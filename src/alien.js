import * as THREE from 'three';
import { clamp } from './util.js';

// Alien sphere: a strong enemy, a grey metal ball with a red eye that fires long-range lasers.
//   - Before each shot a thin red aiming laser tracks the hero, then locks on for a moment: that's
//     the moment to dodge (roll) or block. Then the real laser fires along the locked line: huge
//     damage, reaches 600 m and burns into whatever it hits.
//   - Sometimes it sees an attack coming (a projectile on its way, or the hero casting while aiming at
//     it) and darts sideways out of the way.
//   - They arrive in waves of 4, each breaking out of its own building near the hero (a wave every
//     3 minutes): the building rumbles, then the sphere smashes its way out, tearing chunks off it.
// Like the bosses it lives in enemies.list (so every attack hurts it) with its own update.

const HP = 900;
const BASE = 3; // the model is built at this radius and scaled up to RADIUS
const RADIUS = 6; // 12 m across
const SPEED = 14;
const KEEP = { min: 60, max: 140, height: [15, 35] };
const LASER = { aim: 1.0, lock: 0.12, fire: 0.4, range: 600, width: 1.6, dmg: 70, cooldown: [1.2, 2.2] };
const EMERGE = { rumble: 2.5, out: 20 }; // seconds of rumbling, exit speed (m/s)
const SPAWN_FIRST = 10, SPAWN_EVERY = 180;
const WAVE = 4; // spheres per wave, each from its own building
// Evasion: sometimes it sees an attack coming and darts sideways
const EVADE = { chance: 0.4, speed: 48, time: 0.3, cooldown: 1.2, warn: 0.6 }; // warn: seconds of projectile flight it reacts to
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// Shared look
const geo = {
  body: new THREE.SphereGeometry(BASE, 32, 22),
  band: new THREE.TorusGeometry(BASE * 1.005, 0.09, 6, 48),
  socket: new THREE.SphereGeometry(0.95, 18, 12),
  eye: new THREE.SphereGeometry(0.62, 18, 12),
  ring: new THREE.TorusGeometry(BASE * 1.25, 0.12, 6, 40),
  fin: new THREE.BoxGeometry(0.25, 0.9, 0.5),
  beam: new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0),
};
const mats = {
  socket: new THREE.MeshStandardMaterial({ color: '#111216', roughness: 0.3, metalness: 0.9 }),
  band: new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.35, metalness: 0.95 }),
  ring: new THREE.MeshStandardMaterial({ color: '#5a5e66', roughness: 0.25, metalness: 1 }),
  aim: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  core: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 2), toneMapped: false }),
  glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.15, 0.1), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
};

// The sphere's model, scaled to full size (also used for the wrecks in the Watcher's pocket dimension).
export function alienModel() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(geo.body, new THREE.MeshStandardMaterial({ color: '#8d9299', roughness: 0.28, metalness: 0.92, emissive: '#ffffff', emissiveIntensity: 0 }));
  body.castShadow = true;
  root.add(body);
  // Panel bands, the eye on the front (-Z), a spinning ring around the equator, little fins
  for (const [rx, ry] of [[Math.PI / 2, 0], [0, 0], [0, Math.PI / 2]]) {
    const b = new THREE.Mesh(geo.band, mats.band);
    b.rotation.set(rx, ry, 0);
    root.add(b);
  }
  const socket = new THREE.Mesh(geo.socket, mats.socket);
  socket.position.z = -BASE * 0.82;
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 0.08, 0.05), toneMapped: false });
  const eye = new THREE.Mesh(geo.eye, eyeMat);
  eye.position.z = -BASE * 0.93;
  root.add(socket, eye);
  const ring = new THREE.Mesh(geo.ring, mats.ring);
  ring.rotation.x = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(geo.fin, mats.ring);
    const a = (i / 6) * Math.PI * 2;
    f.position.set(Math.cos(a) * BASE * 1.25, Math.sin(a) * BASE * 1.25, 0);
    f.rotation.z = a;
    ring.add(f);
  }
  root.add(ring);
  root.scale.setScalar(RADIUS / BASE);
  return { root, body, eye, eyeMat, ring };
}

export class AlienSphere {
  // i: its place in the wave (staggers the break-outs and first shots so they don't all go at once)
  constructor(ctx, group, at, i = 0) {
    this.ctx = ctx;
    const { root, body, eye, eyeMat, ring } = alienModel();
    this.eyeMat = eyeMat;
    this.eye = eye;
    this.ring = ring;
    // Aiming laser and the real laser
    this.aimLine = new THREE.Mesh(geo.beam, mats.aim);
    this.beam = new THREE.Group();
    this.beam.add(new THREE.Mesh(geo.beam, mats.core));
    const glow = new THREE.Mesh(geo.beam, mats.glow);
    glow.scale.set(2.6, 1, 2.6);
    this.beam.add(glow);
    this.aimLine.visible = this.beam.visible = false;
    ctx.scene.add(this.aimLine, this.beam);

    const e = ctx.enemies.base('alien', root, at.clone(), body.material);
    e.boss = this;
    e.noBar = true; // strong enemy, not a boss: no health bar at the top
    e.mapColor = '#ff4040';
    e.scoreValue = 10;
    this.e = e;
    this.root = root;
    this.vel = new THREE.Vector3();
    this.heroC = new THREE.Vector3();
    this.toP = new THREE.Vector3();
    this.home = group; // the building it's coming out of
    this.state = 'rumble';
    this.stateT = EMERGE.rumble + i * 0.6;
    this.cd = 2 + i * 0.7;
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.orbit = Math.random() * Math.PI * 2;
    this.bob = Math.random() * 10;
    this.carveT = 0;
    this.evadeT = 0; // > 0 while darting aside
    this.evadeCd = 0;
    this.evadeVel = new THREE.Vector3();
    this.seen = new WeakSet(); // projectiles it has already reacted to (one roll of the dice each)
    this.lastCast = 0;
    // Way out: horizontally toward the hero, until clear of the building
    _v.subVectors(ctx.player.pos, at).setY(0);
    if (_v.lengthSq() < 1) _v.set(1, 0, 0);
    this.exitDir = _v.normalize().clone();
    root.visible = false; // hidden inside the building while it rumbles
    if (i === 0) ctx.hud.callout('SOMETHING IS INSIDE THOSE BUILDINGS!', 'bad');
  }

  eyePos(out) {
    return this.eye.getWorldPosition(out);
  }

  update(dt) {
    const e = this.e, { player, world, fx } = this.ctx;
    e.stun = 0;
    this.stateT -= dt;
    this.bob += dt;
    this.ring.rotation.z += dt * 1.5;
    // Own vectors: the helpers below use the scratch ones
    const heroC = this.heroC.copy(player.pos);
    heroC.y += 1;
    const toP = this.toP.subVectors(heroC, e.pos);
    const dist = toP.length();

    switch (this.state) {
      case 'rumble': {
        // The building shakes and sheds dust before it breaks out
        const d = player.pos.distanceTo(e.pos);
        if (Math.random() < dt * 12) player.shake(0.25 * Math.max(0.2, 1 - d / 300), 0.25);
        if (Math.random() < dt * 20) {
          const w = this.home.walls[(Math.random() * this.home.walls.length) | 0];
          fx.smoke(w.cx + (Math.random() - 0.5) * w.w, w.y0 + Math.random() * w.h, w.cz + (Math.random() - 0.5) * w.d,
            (Math.random() - 0.5) * 3, -1, (Math.random() - 0.5) * 3, 2, 3, 7, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 0.8);
        }
        if (this.stateT <= 0) this.breakOut();
        e.vel.set(0, 0, 0);
        return;
      }
      case 'exit':
        // Smash a tunnel out of the building
        e.pos.addScaledVector(this.exitDir, EMERGE.out * dt);
        this.carveT -= dt;
        if (this.carveT <= 0) {
          this.carveT = 0.08;
          this.ctx.destruction?.damage(e.pos, RADIUS + 1.5, this.exitDir);
        }
        if (!this.insideHome(e.pos, RADIUS + 4) || this.stateT <= 0) {
          this.state = 'hunt';
          this.vel.copy(this.exitDir).multiplyScalar(EMERGE.out);
        }
        this.face(this.exitDir, dt);
        break;
      case 'hunt': {
        this.evade(dt);
        this.cd -= dt;
        if (this.cd <= 0 && !player.dead && dist < LASER.range * 0.8 && this.clearShot(heroC)) {
          this.state = 'aim';
          this.stateT = LASER.aim;
          this.aimDir.copy(toP).normalize();
        }
        this.move(dt, toP, dist);
        this.face(toP, dt);
        break;
      }
      case 'aim': {
        this.evade(dt);
        // Thin red laser tracks the hero, then locks on just before firing
        const locked = this.stateT < LASER.lock;
        this.eyePos(_u);
        if (!locked) {
          _v.copy(player.pos);
          _v.y += 1;
          const want = _v.sub(_u).normalize();
          this.aimDir.lerp(want, 1 - Math.exp(-10 * dt)).normalize();
        }
        this.face(this.aimDir, dt * 3);
        const t = world.raycastHit(_u, this.aimDir, LASER.range);
        this.showBeam(this.aimLine, _u, this.aimDir, t, locked ? 0.12 : 0.06);
        this.aimLine.visible = !locked || Math.sin(performance.now() * 0.06) > -0.3; // flickers when locked
        const k = 1 - this.stateT / LASER.aim;
        this.eyeMat.color.setRGB(2.5 + k * 4, 0.08 + k * 0.6, 0.05 + k * 0.4);
        this.vel.multiplyScalar(Math.exp(-4 * dt));
        e.pos.addScaledVector(this.vel, dt);
        if (this.stateT <= 0) this.fire();
        break;
      }
      case 'fire': {
        // The beam stays a moment, fading
        const k = Math.max(0, this.stateT / LASER.fire);
        this.beam.children[0].scale.x = this.beam.children[0].scale.z = 0.5 * k + 0.05;
        this.beam.children[1].material.opacity = 0.45 * k;
        if (this.stateT <= 0) {
          this.beam.visible = false;
          this.beam.children[1].material.opacity = 0.45;
          this.state = 'hunt';
          this.cd = LASER.cooldown[0] + Math.random() * (LASER.cooldown[1] - LASER.cooldown[0]);
          this.eyeMat.color.setRGB(2.5, 0.08, 0.05);
        }
        break;
      }
    }
    // Hover bob
    this.root.position.copy(e.pos);
    this.root.position.y += Math.sin(this.bob * 2) * 0.3;
    e.vel.set(0, 0, 0);
    e.flash = Math.max(0, e.flash - dt * 6);
    e.mat.emissiveIntensity = e.flash * 0.6;
  }

  // Keep a good firing distance, circling and drifting up and down.
  move(dt, toP, dist) {
    const e = this.e, { world } = this.ctx;
    this.orbit += dt * 0.3;
    const hd = Math.hypot(toP.x, toP.z) || 1;
    const want = _u.set(0, 0, 0);
    if (dist > KEEP.max) want.set(toP.x / hd, 0, toP.z / hd);
    else if (dist < KEEP.min) want.set(-toP.x / hd, 0, -toP.z / hd);
    want.x += Math.cos(this.orbit) * 0.6;
    want.z += Math.sin(this.orbit) * 0.6;
    const p = this.ctx.player.pos;
    const ty = Math.max(p.y + KEEP.height[0] + (Math.sin(this.orbit * 0.7) * 0.5 + 0.5) * (KEEP.height[1] - KEEP.height[0]), world.groundY(e.pos.x, e.pos.z, 600) + 8);
    want.y = clamp((ty - e.pos.y) * 0.2, -1, 1);
    want.normalize().multiplyScalar(SPEED);
    this.vel.lerp(want, 1 - Math.exp(-1.5 * dt));
    e.pos.addScaledVector(this.vel, dt);
    // Bump off buildings
    const r = world.resolve(e.pos, RADIUS, RADIUS * 2, this.vel, dt, 0);
    if (r.wall) this.vel.y += 20 * dt;
  }

  // Watch for incoming attacks; on some of them, dart sideways at high speed.
  evade(dt) {
    const e = this.e, { player } = this.ctx;
    this.evadeCd -= dt;
    if (this.evadeT > 0) {
      this.evadeT -= dt;
      e.pos.addScaledVector(this.evadeVel, dt);
      this.ctx.world.resolve(e.pos, RADIUS, RADIUS * 2, this.evadeVel, dt, 0);
      // afterimage streak
      this.ctx.fx.spawn(e.pos.x, e.pos.y, e.pos.z, 0, 0, 0, 0.25, RADIUS * 1.6, RADIUS, [0.6, 0.62, 0.68], [0.3, 0.3, 0.35], 0, 0);
      return;
    }
    let threat = null;
    // Projectiles on their way that would hit within the next moment
    for (const p of this.ctx.getPowers?.()?.projectiles ?? []) {
      if (this.seen.has(p)) continue;
      const speed = p.vel.length();
      _v.subVectors(e.pos, p.pos);
      const dir = _w.copy(p.vel).divideScalar(speed || 1);
      const along = _v.dot(dir);
      if (along <= 0 || along > speed * EVADE.warn) continue;
      if (_u.copy(p.pos).addScaledVector(dir, along).distanceTo(e.pos) > RADIUS + (p.radius ?? 0.4) + 1.5) continue;
      this.seen.add(p);
      threat = dir;
      break;
    }
    // The hero just cast something with the crosshair on it (instant-hit powers)
    if (!threat && player.castT > this.lastCast + 0.05) {
      const cam = this.ctx.camera.position, cp = Math.cos(player.pitch);
      const fwd = _w.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);
      _v.subVectors(e.pos, cam);
      const along = _v.dot(fwd);
      if (along > 0 && _u.copy(cam).addScaledVector(fwd, along).distanceTo(e.pos) < RADIUS + 3) threat = fwd;
    }
    this.lastCast = player.castT;
    if (!threat || this.evadeCd > 0 || Math.random() > EVADE.chance) return;
    // Dart sideways (perpendicular to the attack), a bit up or down too
    const side = _v.crossVectors(threat, Y);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().multiplyScalar(Math.random() < 0.5 ? -1 : 1);
    side.y += (Math.random() - 0.5) * 0.6;
    this.evadeVel.copy(side.normalize()).multiplyScalar(EVADE.speed);
    this.evadeT = EVADE.time;
    this.evadeCd = EVADE.cooldown;
    this.ctx.enemies.label(e, 'EVADED', 'blocked');
  }

  face(dir, dt) {
    const yaw = Math.atan2(-dir.x, -dir.z), pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    const k = 1 - Math.exp(-6 * dt);
    this.root.rotation.order = 'YXZ';
    let dy = yaw - this.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.root.rotation.y += dy * k;
    this.root.rotation.x += (pitch - this.root.rotation.x) * k;
    this.root.updateMatrixWorld(true);
  }

  // Nothing solid between the eye and the hero?
  clearShot(target) {
    this.eyePos(_u);
    const d = _u.distanceTo(target);
    const dir = _w.copy(target).sub(_u).normalize();
    return this.ctx.world.raycastHit(_u, dir, d) >= d - 1.5;
  }

  showBeam(mesh, from, dir, len, r) {
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(Y, dir);
    mesh.scale.set(r, len, r);
  }

  fire() {
    const { player, world, fx, impacts } = this.ctx;
    this.state = 'fire';
    this.stateT = LASER.fire;
    this.aimLine.visible = false;
    const from = this.eyePos(new THREE.Vector3());
    const dir = this.aimDir;
    const t = world.raycastHit(from, dir, LASER.range);
    const normal = t < LASER.range ? world.hitNormal : null;
    this.beam.visible = true;
    this.showBeam(this.beam, from, dir, t, 1);
    this.beam.children[0].scale.set(0.55, 1, 0.55);
    fx.flash(from, 0xff2020, 1200, 40, 0.2);
    // Hero on the line? (they had the lock time to get out of the way)
    _v.copy(player.pos);
    _v.y += 1;
    const proj = _w.subVectors(_v, from).dot(dir);
    if (!player.dead && proj > 0 && proj < t && _w.copy(from).addScaledVector(dir, proj).distanceTo(_v) < LASER.width) {
      const r = player.takeDamage(LASER.dmg, 'normal');
      if (r === 'hit') {
        player.vel.addScaledVector(dir, 25);
        if (!player.dead) player.knockdown(1.0, 'LASERED');
      } else if (r === 'blocked') this.ctx.hud.callout('BLOCKED THE LASER', 'good');
      else if (r === 'ignored') this.ctx.hud.callout('DODGED!', 'good');
      fx.burst(_v, 30, { speed: 12, life: 0.4, size: 0.8, c0: [1, 0.7, 0.6], c1: [1, 0.1, 0.05] });
    }
    // Burn into whatever it hits
    const end = from.clone().addScaledVector(dir, t);
    fx.burst(end, 40, { speed: 16, life: 0.5, size: 1.2, c0: [1, 0.8, 0.6], c1: [1, 0.15, 0.05], drag: 2 });
    fx.flash(end, 0xff3020, 1500, 50, 0.3);
    for (let i = 0; i < 8; i++) fx.smoke(end.x, end.y, end.z, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4, 2, 1.5, 5);
    if (normal) {
      impacts?.hit(end, normal, 5, 'fire', 0);
      this.ctx.destruction?.damage(end.clone().addScaledVector(normal, -1.5), 3.5, dir);
    }
    this.ctx.traffic?.damageRadius(end, 4, 200, 10);
    this.ctx.props?.damageRadius(end, 4, 10);
    player.shake(0.3 * Math.max(0.2, 1 - player.pos.distanceTo(end) / 200), 0.3);
  }

  // Bursts out of its building: a big hole where it comes out, then it tunnels clear.
  breakOut() {
    const e = this.e, fx = this.ctx.fx;
    this.root.visible = true;
    this.state = 'exit';
    this.stateT = 6;
    this.ctx.destruction?.damage(e.pos, RADIUS + 5, this.exitDir);
    fx.flash(e.pos, 0xff3030, 1500, 60, 0.4);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.smoke(e.pos.x, e.pos.y, e.pos.z, Math.cos(a) * 12 + this.exitDir.x * 10, (Math.random() - 0.3) * 8, Math.sin(a) * 12 + this.exitDir.z * 10,
        2.5, 3, 9, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 1);
    }
    this.ctx.player.shake(0.6, 0.5);
    this.ctx.hud.callout('ALIEN SPHERES!', 'bad');
  }

  insideHome(p, pad) {
    return this.home.walls.some((w) => Math.abs(p.x - w.cx) < w.w / 2 + pad && Math.abs(p.z - w.cz) < w.d / 2 + pad && p.y < w.y0 + w.h + pad);
  }

  die() {
    this.state = 'dead';
    this.aimLine.visible = this.beam.visible = false;
    this.fallV = new THREE.Vector3((Math.random() - 0.5) * 6, 4, (Math.random() - 0.5) * 6);
    this.ctx.hud.callout('ALIEN SPHERE DESTROYED!', 'good');
    this.eyeMat.color.setRGB(0.2, 0.02, 0.02);
  }

  // Sparks and smoke as it drops, then it blows up on the ground. True when gone.
  updateDead(dt) {
    if (this.state !== 'dead') this.die();
    const e = this.e, { world, fx } = this.ctx;
    this.fallV.y -= 25 * dt;
    e.pos.addScaledVector(this.fallV, dt);
    this.root.position.copy(e.pos);
    this.root.rotation.x += dt * 3;
    this.root.rotation.z += dt * 2;
    if (Math.random() < 0.7) fx.smoke(e.pos.x, e.pos.y, e.pos.z, 0, 2, 0, 1.5, 1.5, 4);
    if (Math.random() < 0.4) fx.burst(e.pos, 4, { speed: 8, life: 0.3, size: 0.4, c0: [1, 0.8, 0.5], c1: [1, 0.3, 0] });
    const gy = Math.max(world.groundY(e.pos.x, e.pos.z, e.pos.y + RADIUS), world.floorAt(e.pos.x, e.pos.z));
    if (e.pos.y - RADIUS <= gy) {
      _v.set(e.pos.x, gy + 0.5, e.pos.z);
      fx.burst(_v, 80, { speed: 20, life: 0.8, size: 2.6, size1: 0.5, c0: [1, 0.85, 0.5], c1: [0.9, 0.2, 0], ay: 3, drag: 2 });
      fx.flash(_v, 0xff6020, 2500, 70, 0.5);
      this.ctx.impacts?.hit(_v, null, 8, 'fire', 9);
      this.ctx.enemies.damageRadius(_v, 8, 60, 14, 0, { type: 'power', skip: e });
      this.ctx.player.shake(0.6, 0.5);
      return true;
    }
    return false;
  }

  dispose() {
    this.ctx.scene.remove(this.aimLine, this.beam);
    this.e.mat.dispose();
  }
}

// A wave of 4 alien spheres every 3 minutes, each breaking out of a different building near the
// hero. U summons a wave now.
export class AlienSpawner {
  constructor(ctx, groups) {
    this.ctx = ctx;
    this.groups = groups.filter((g) => !g.round && g.walls.some((w) => w.h > 20 && w.style !== 'store'));
    this.timer = SPAWN_FIRST;
    this.list = [];
  }

  // Up to n different buildings 70-250 m from the hero, spread out (at least 60 m apart when
  // possible), each with a point inside it about halfway up.
  pickBuildings(n) {
    const p = this.ctx.player.pos;
    const near = this.groups.filter((g) => {
      const w = g.walls[0];
      const d = Math.hypot(w.cx - p.x, w.cz - p.z);
      return d > 70 && d < 250 && !g.vols?.length; // not one that's already wrecked
    });
    for (let i = near.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [near[i], near[j]] = [near[j], near[i]];
    }
    const picks = [];
    for (const minGap of [60, 0]) {
      for (const g of near) {
        if (picks.length >= n) break;
        const w = g.walls.reduce((a, b) => (b.h > a.h ? b : a));
        if (picks.some((q) => q.g === g || Math.hypot(q.at.x - w.cx, q.at.z - w.cz) < minGap)) continue;
        picks.push({ g, at: new THREE.Vector3(w.cx, w.y0 + Math.min(w.h * 0.5, 60), w.cz) });
      }
    }
    return picks;
  }

  spawn() {
    const picks = this.pickBuildings(WAVE);
    picks.forEach((pick, i) => this.list.push(new AlienSphere(this.ctx, pick.g, pick.at, i)));
    return picks.length > 0;
  }

  update(dt, input) {
    const enemies = this.ctx.enemies;
    this.list = this.list.filter((a) => {
      if (enemies.list.includes(a.e)) return true;
      a.dispose();
      return false;
    });
    // Switched off (main.js): no waves on the timer, but the key still summons one
    const auto = this.enabled !== false;
    if (auto) this.timer -= dt;
    if (input?.hit('KeyU') || (auto && this.timer <= 0)) this.timer = this.spawn() ? SPAWN_EVERY : 5;
  }
}

export const ALIEN_STATS = { hp: HP, r: RADIUS + 0.3, cy: 0, mass: 0.05, scale: RADIUS / 0.7 };
