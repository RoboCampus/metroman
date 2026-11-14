import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';
import { createRig } from './models.js';

// Raptor: a flying brawler. He circles the hero in the air and every few seconds goes for one of
// two attacks:
//   - Ram: he pulls back (red glow, "!"), then shoots at the hero. A hit launches the hero along his
//     flight path at 200 km/h.
//   - Grab: he pulls back with his arms thrown open (purple glow, "!"), then shoots at the hero the
//     same way. Caught, the hero is carried up a little and hurled straight down at the ground at
//     250 km/h.
//   Both home in on the hero (turning up to `turn` rad/s), so just running sideways won't do: a
//   dodge, a burst of speed or a building between you is what makes him miss. Once he's past the
//   hero he stops turning and flies on. Both can be dodged (he flies past) or blocked (he bounces
//   off, dazed). A blocked ram still launches the hero, but behind the shield (little damage), which
//   stays up while they hold block. Flying into a wall mid-attack dazes him too.
// Lives in enemies.list with its own update (like the charger), so all attacks hurt him.

const HP = 300;
const SCALE = 1.25;
const CY = 1.1 * SCALE; // chest height above his feet
const FLY = { speed: 26, range: [18, 30], height: [5, 12], orbit: 0.45 };
const RAM = { wind: 0.8, speed: 65, max: 1.4, turn: 2.2, reach: 2.6, dmg: 20, launch: 200 / 3.6, time: 2.2, lift: 0.15 };
const GRAB = {
  wind: 0.7, speed: 60, max: 1.4, turn: 2.5, reach: 2.6, dmg: 10, // arms open for `wind` s, then the launch
  hold: 0.8, rise: 14, // carried `rise` m up over `hold` s
  throw: 250 / 3.6, slamDmg: 35, down: 1.2, // thrown down at 250 km/h; knocked down on landing
};
const STUN = { blocked: 1.6, miss: 0.7, wall: 2 };
const COOLDOWN = [2.5, 4.5];
const MAX = 2, SPAWN_FIRST = 30, RESPAWN = 30;
// Everything a raptor-style flyer is tuned by (Bob reuses the class with his own numbers)
export const RAPTOR = { type: 'raptor', name: 'RAPTOR', SCALE, CY, FLY, RAM, GRAB, STUN, COOLDOWN };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

const icons = {};
function alertIcon(color) {
  if (icons[color]) return icons[color];
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#fff';
  g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 42px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('!', 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (icons[color] = new THREE.SpriteMaterial({ map: t, toneMapped: false }));
}

export class Raptor {
  constructor(ctx, pos, cfg = RAPTOR) {
    this.ctx = ctx;
    this.cfg = cfg;
    const rig = this.makeRig();
    rig.root.scale.setScalar(cfg.SCALE);
    this.rig = rig;
    this.icon = new THREE.Sprite(alertIcon('#ff2a2a'));
    this.icon.position.y = 2.4;
    this.icon.scale.setScalar(0.6);
    this.icon.visible = false;
    rig.root.add(this.icon);
    const e = ctx.enemies.base(cfg.type, rig.root, pos.clone(), rig.material);
    e.boss = this;
    e.noBar = true;
    e.mapColor = '#3ad0ff';
    e.scoreValue = 6;
    this.e = e;
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.state = 'hover';
    this.stateT = 0;
    this.cd = 2 + Math.random() * 2;
    this.orbit = Math.random() * Math.PI * 2;
    this.range = this.cfg.FLY.range[0] + Math.random() * (this.cfg.FLY.range[1] - this.cfg.FLY.range[0]);
    this.height = this.cfg.FLY.height[0] + Math.random() * (this.cfg.FLY.height[1] - this.cfg.FLY.height[0]);
    this.t = Math.random() * 10;
    this.hitDone = false;
  }

  makeRig() {
    const rig = createRig('thug', { preferModel: this.ctx.useModels !== false });
    rig.paint(['#16343a', '#c8a23a', '#8a6a52', '#000', '#101418', '#1f4a52']);
    return rig;
  }

  begin(state, t = 0) {
    this.state = state;
    this.stateT = t;
    this.icon.visible = state === 'windup' || state === 'grabwind' || state === 'finwind';
    if (this.icon.visible) this.icon.material = alertIcon(state === 'grabwind' ? '#b03aff' : '#ff2a2a');
  }

  update(dt) {
    const e = this.e;
    e.stun = 0;
    this.t += dt;
    this.stateT -= dt;
    this.cd -= dt;
    const face = this.think(dt);
    e.facing = lerpAngle(e.facing, face, 1 - Math.exp(-10 * dt));
    this.fly(dt);
  }

  // The fight: circle the hero and attack. Returns the heading he wants to face.
  think(dt) {
    const e = this.e, { player, fx } = this.ctx;
    const target = _t.copy(player.pos);
    target.y += 1;
    const c = this.center(_c); // (its own vector: _w is scratch below)
    const to = _v.subVectors(target, c), dist = to.length();
    const free = !player.dead && player.launchT <= 0 && player.downT <= 0;
    let face = Math.atan2(-to.x, -to.z);

    switch (this.state) {
      case 'hover': {
        // Circle the hero in the air, a little above them; ready to attack but no clear line
        // (buildings in the way), come in closer and higher
        this.orbit += this.cfg.FLY.orbit * dt;
        const ready = this.cd <= 0 && free && dist < 60, clear = ready && this.clearLine(c, target, dist);
        this.seekT = ready && !clear ? (this.seekT ?? 0) + dt : 0;
        const tight = this.seekT > 0.6 ? 1 : 0;
        const goal = _w.set(player.pos.x + Math.cos(this.orbit) * this.range * (1 - 0.5 * tight), player.pos.y + this.height + 10 * tight, player.pos.z + Math.sin(this.orbit) * this.range * (1 - 0.5 * tight));
        goal.y = Math.max(goal.y, this.ctx.world.floorAt?.(goal.x, goal.z) ?? 0) + 2;
        this.steer(goal.sub(e.pos), this.cfg.FLY.speed, 2.5, dt);
        if (clear) {
          if (Math.random() < 0.5) this.begin('windup', this.cfg.RAM.wind);
          else this.begin('grabwind', this.cfg.GRAB.wind);
        }
        break;
      }
      case 'windup':
        // Pull back, locked on, then go
        this.vel.lerp(_w.copy(to).normalize().multiplyScalar(-4), 1 - Math.exp(-6 * dt));
        if (Math.random() < dt * 30) fx.spawn(c.x, c.y, c.z, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 0.3, 0.6, 0.1, [1, 0.5, 0.3], [0.8, 0.1, 0.05], 0, 1);
        if (this.stateT <= 0) {
          this.begin('ram', this.cfg.RAM.max);
          this.dir.copy(to).normalize();
          this.hitDone = false;
          this.passed = false;
          fx.ring(c, 0xff4020, 5, 0.3, this.dir);
        }
        break;
      case 'ram': {
        // At the hero, homing in
        if (!this.hitDone && !player.dead) this.home(to, this.cfg.RAM.turn, dt);
        this.vel.copy(this.dir).multiplyScalar(this.cfg.RAM.speed);
        face = Math.atan2(-this.dir.x, -this.dir.z);
        this.trail(c, [1, 0.5, 0.3], [0.8, 0.1, 0.05]);
        this.ctx.traffic?.damageRadius(c, 2.5, 60, 25);
        if (!this.hitDone && !player.dead && dist < this.cfg.RAM.reach) this.ramHit();
        if (this.stateT <= 0) this.recover(this.cfg.STUN.miss);
        break;
      }
      case 'grabwind':
        // Arms thrown open, pulling back, locked on, then go
        this.vel.lerp(_w.copy(to).normalize().multiplyScalar(-4), 1 - Math.exp(-6 * dt));
        if (Math.random() < dt * 30) fx.spawn(c.x, c.y, c.z, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 0.3, 0.6, 0.1, [0.9, 0.6, 1], [0.4, 0.1, 0.8], 0, 1);
        if (this.stateT <= 0) {
          if (!free) {
            this.begin('hover');
            break;
          }
          this.begin('grab', this.cfg.GRAB.max);
          this.dir.copy(to).normalize();
          this.hitDone = false;
          this.passed = false;
          fx.ring(c, 0xa040ff, 5, 0.3, this.dir);
        }
        break;
      case 'grab':
        // Launched at the hero like the ram, homing in; touching them is the grab
        if (!player.dead) this.home(to, this.cfg.GRAB.turn, dt);
        this.vel.copy(this.dir).multiplyScalar(this.cfg.GRAB.speed);
        face = Math.atan2(-this.dir.x, -this.dir.z);
        this.trail(c, [0.8, 0.5, 1], [0.4, 0.1, 0.8]);
        this.ctx.traffic?.damageRadius(c, 2.5, 60, 25);
        if (!this.hitDone && !player.dead && dist < this.cfg.GRAB.reach) this.grabHit();
        if (this.state === 'grab' && this.stateT <= 0) this.recover(this.cfg.STUN.miss);
        break;
      case 'hold': {
        // Carrying them up, held out in front, then hurled at the ground
        this.vel.set(0, this.cfg.GRAB.rise / this.cfg.GRAB.hold, 0);
        face = e.facing;
        if (player.dead) {
          this.begin('hover');
          break;
        }
        this.pin();
        if (this.stateT <= 0) this.hurl();
        break;
      }
      case 'slam':
        // Watching them hit the ground
        this.vel.multiplyScalar(Math.exp(-4 * dt));
        face = e.facing;
        // Straight down at exactly the throw speed (no gravity on top; brushing a wall can end the
        // throw early: they still go down at full speed)
        if (!player.dead && player.launchT > 0) player.launchVel.y = -this.cfg.GRAB.throw;
        if (!player.dead && player.launchT <= 0 && !player.grounded) player.vel.y = Math.min(player.vel.y, -this.cfg.GRAB.throw);
        if (player.dead || player.grounded || this.stateT <= 0) this.slamDown();
        break;
      case 'stunned':
        this.vel.multiplyScalar(Math.exp(-3 * dt));
        this.vel.y -= 4 * dt;
        face = e.facing + Math.sin(this.t * 6) * 0.3;
        if (Math.random() < dt * 6) {
          _w.set(e.pos.x + (Math.random() - 0.5), e.pos.y + 2.4 * this.cfg.SCALE, e.pos.z + (Math.random() - 0.5));
          fx.spawn(_w.x, _w.y, _w.z, 0, 0.5, 0, 0.5, 0.35, 0.1, [1, 0.95, 0.5], [1, 0.7, 0.2], 0, 0);
        }
        if (this.stateT <= 0) {
          this.begin('hover');
          this.cd = this.cfg.COOLDOWN[0] + Math.random() * (this.cfg.COOLDOWN[1] - this.cfg.COOLDOWN[0]);
        }
        break;
    }
    return face;
  }

  fly(dt) {
    const e = this.e;
    // Knocked by a hit (the hero's lunge...): shoved that way (he's heavy, so not far)
    if (e.vel.lengthSq() > 1) this.vel.add(e.vel);
    // Fly (bumping into buildings; a ram into a wall dazes him)
    e.pos.addScaledVector(this.vel, dt);
    const r = this.ctx.world.resolve(e.pos, 0.6 * this.cfg.SCALE, 1.9 * this.cfg.SCALE, this.vel, dt, 0.6);
    if (r.wall && (this.state === 'ram' || this.state === 'grab')) this.crash();
    else this.bumped?.(r);
    e.pos.x = clamp(e.pos.x, -2400, 2400);
    e.pos.z = clamp(e.pos.z, -2400, 2400);
    e.vel.set(0, 0, 0);

    // Glow: red for the ram, purple for the grab, white flash when hit
    e.flash = Math.max(0, e.flash - dt * 6);
    const ram = this.state === 'windup' || this.state === 'ram' || this.state === 'finwind' || this.state === 'dive', grab = this.state === 'grabwind' || this.state === 'grab' || this.state === 'hold';
    e.mat.emissive.setHex(ram ? 0xff2020 : grab ? 0xa040ff : 0xffffff);
    e.mat.emissiveIntensity = ram || grab ? 0.5 + 0.4 * Math.sin(this.t * 25) : e.flash * 0.9;
    this.animate(dt);
  }

  center(out) {
    return out.copy(this.e.pos).setY(this.e.pos.y + this.cfg.CY);
  }

  // Accelerate toward `delta` (capped at `speed`)
  steer(delta, speed, k, dt) {
    const want = delta.lengthSq() > speed * speed * 0.25 ? delta.normalize().multiplyScalar(speed) : delta.multiplyScalar(2);
    this.vel.lerp(want, 1 - Math.exp(-k * dt));
  }

  // Turn the attack heading toward `to` at up to `turn` rad/s; once the hero is behind him (he
  // overshot), he stops turning and flies on past
  home(to, turn, dt) {
    if (this.passed) return;
    const d = to.length();
    if (d < 1e-3) return;
    _d.copy(to).divideScalar(d);
    const cos = clamp(this.dir.dot(_d), -1, 1);
    if (cos < 0 && d < 12) {
      this.passed = true;
      return;
    }
    const ang = Math.acos(cos), step = turn * dt;
    if (ang <= step) this.dir.copy(_d);
    else {
      _w.crossVectors(this.dir, _d);
      if (_w.lengthSq() < 1e-8) _w.set(0, 1, 0);
      this.dir.applyAxisAngle(_w.normalize(), step).normalize();
    }
  }

  clearLine(from, to, d) {
    _d.subVectors(to, from).divideScalar(d || 1);
    return this.ctx.world.raycast(from, _d, d) >= d - 1.5;
  }

  trail(c, c0, c1) {
    const fx = this.ctx.fx;
    for (let i = 0; i < 3; i++) {
      fx.spawn(c.x + (Math.random() - 0.5) * 0.8, c.y + (Math.random() - 0.5) * 1.6, c.z + (Math.random() - 0.5) * 0.8,
        -this.vel.x * 0.05, -this.vel.y * 0.05, -this.vel.z * 0.05, 0.35, 0.8, 0.1, c0, c1, 0, 1);
    }
  }

  // ---------------------------------------------------------------- the ram
  ramHit() {
    const { player, fx, hud } = this.ctx;
    this.hitDone = true;
    const r = player.takeDamage(this.cfg.RAM.dmg, 'normal');
    const at = _w.copy(player.pos).setY(player.pos.y + 1);
    if (r === 'ignored') {
      hud.callout('DODGED!', 'good'); // he shoots past
      return;
    }
    const dir = this.dir.clone();
    dir.y += this.cfg.RAM.lift;
    if (r === 'blocked') {
      // The shield takes the hit (little damage) but they're still sent flying, shield up
      player.launch(dir.normalize().multiplyScalar(this.cfg.RAM.launch), this.cfg.RAM.time, true);
      this.vel.copy(this.dir).multiplyScalar(-10);
      fx.burst(at, 40, { speed: 12, life: 0.4, size: 0.9, c0: [0.7, 0.9, 1], c1: [0.2, 0.5, 1] });
      fx.ring(at, 0x6ab8ff, 7, 0.35, this.dir);
      player.shake(0.6, 0.35);
      hud.callout('RAM BLOCKED · LAUNCHED!', 'good');
      this.recover(this.cfg.STUN.blocked);
      return;
    }
    // Full hit: launched along his flight path at 200 km/h
    if (!player.dead) player.launch(dir.normalize().multiplyScalar(this.cfg.RAM.launch), this.cfg.RAM.time);
    fx.burst(at, 50, { speed: 18, life: 0.5, size: 1.2, c0: [1, 0.8, 0.5], c1: [0.8, 0.2, 0.1], drag: 2 });
    fx.flash(at, 0xff6040, 1500, 30, 0.2);
    fx.ring(at, 0xff6040, 8, 0.35, this.dir);
    player.shake(1, 0.5);
    this.ctx.combat?.hitstop(0.08);
    hud.callout('RAMMED!', 'bad');
  }

  crash() {
    const { fx, player, destruction } = this.ctx;
    const at = this.center(_w).addScaledVector(this.dir, 1.2);
    destruction?.damage(at.clone(), 2.5, this.dir.clone());
    fx.burst(at, 30, { speed: 9, life: 0.4, size: 1, c0: [0.7, 0.65, 0.6], c1: [0.3, 0.3, 0.3], drag: 3 });
    player.shake(0.5 * Math.max(0.1, 1 - player.pos.distanceTo(this.e.pos) / 60), 0.3);
    this.vel.copy(this.dir).multiplyScalar(-6);
    this.recover(this.cfg.STUN.wall);
  }

  // ---------------------------------------------------------------- the grab
  grabHit() {
    const { player, fx, hud } = this.ctx;
    this.hitDone = true;
    const r = player.takeDamage(this.cfg.GRAB.dmg, 'normal');
    const at = _w.copy(player.pos).setY(player.pos.y + 1);
    if (r === 'ignored') {
      hud.callout('DODGED!', 'good'); // grabs thin air
      this.recover(this.cfg.STUN.miss);
      return;
    }
    if (r === 'blocked') {
      player.vel.addScaledVector(this.dir, 8);
      this.vel.copy(this.dir).multiplyScalar(-12);
      fx.burst(at, 30, { speed: 10, life: 0.35, size: 0.8, c0: [0.7, 0.9, 1], c1: [0.2, 0.5, 1] });
      player.shake(0.4, 0.3);
      hud.callout('GRAB BLOCKED!', 'good');
      this.recover(this.cfg.STUN.blocked);
      return;
    }
    // Caught: no control while he carries them up (launch with no speed; pinned every frame)
    player.launch(_v.set(0, 0, 0), this.cfg.GRAB.hold + 0.3);
    this.begin('hold', this.cfg.GRAB.hold);
    this.pin();
    fx.burst(at, 25, { speed: 8, life: 0.35, size: 0.8, c0: [0.9, 0.7, 1], c1: [0.4, 0.1, 0.8] });
    player.shake(0.5, 0.3);
    hud.callout('GRABBED!', 'bad');
  }

  // The hero held out in front of him
  pin() {
    const { player } = this.ctx, e = this.e;
    player.pos.set(e.pos.x - Math.sin(e.facing) * 1.4 * this.cfg.SCALE, e.pos.y - 0.2, e.pos.z - Math.cos(e.facing) * 1.4 * this.cfg.SCALE);
    player.vel.set(0, 0, 0);
    player.launchVel.set(0, 0, 0);
    player.launchT = Math.max(player.launchT, 0.2);
  }

  hurl() {
    const { player, fx } = this.ctx;
    player.launch(_v.set(0, -this.cfg.GRAB.throw, 0), 6);
    fx.ring(this.center(_w), 0xa040ff, 6, 0.3, _v.set(0, 1, 0));
    player.shake(0.6, 0.3);
    this.ctx.hud.callout('THROWN DOWN!', 'bad');
    this.begin('slam', 6);
  }

  // They hit the ground: crater, shock wave, knocked flat
  slamDown() {
    const { player, fx } = this.ctx;
    if (!player.dead && player.grounded) {
      player.launchT = 0;
      player.vel.set(0, 0, 0);
      player.hurt(this.cfg.GRAB.slamDmg);
      if (!player.dead) player.knockdown(this.cfg.GRAB.down, 'SLAMMED DOWN');
      const at = _w.copy(player.pos);
      fx.ring(at, 0xa040ff, 14, 0.45);
      fx.ring(at, 0xd8d0c0, 8, 0.3);
      fx.burst(at.setY(at.y + 0.3), 70, { speed: 18, life: 0.7, size: 1.6, c0: [0.7, 0.65, 0.6], c1: [0.2, 0.2, 0.2], drag: 3 });
      fx.flash(at, 0xa040ff, 80, 25, 0.2);
      this.ctx.impacts?.hit(player.pos.clone(), null, 4, 'elec', 6);
      this.ctx.traffic?.damageRadius(at, 6, 80, 20);
      player.shake(1, 0.5);
      this.ctx.combat?.hitstop(0.08);
    }
    this.begin('hover');
    this.cd = this.cfg.COOLDOWN[0] + Math.random() * (this.cfg.COOLDOWN[1] - this.cfg.COOLDOWN[0]);
  }

  // Dazed for a moment after an attack (longer after a wall or a block): free hits for the hero.
  recover(stun) {
    this.begin('stunned', stun);
  }

  // ---------------------------------------------------------------- looks
  animate(dt) {
    const e = this.e, s = this.state;
    this.rig.root.position.copy(e.pos);
    this.rig.root.rotation.y = e.facing;
    const bob = Math.sin(this.t * 2.2);
    const pitch = Math.atan2(this.dir.y, Math.hypot(this.dir.x, this.dir.z));
    let p;
    if (s === 'ram' || s === 'dive') {
      // Superman: flat out along the flight path, both fists first, legs locked
      p = { tilt: -(Math.PI / 2 - pitch), sL: Math.PI * 0.97, sR: Math.PI * 0.97, eL: 0.05, eR: 0.05, spread: -0.06, hL: 0, hR: 0, kL: -0.04, kR: -0.04 };
    } else if (s === 'windup' || s === 'finwind') {
      // Coiled up, fists back
      p = { tilt: 0.25, sL: -0.7, sR: -0.7, eL: 1.2, eR: 1.2, spread: 0.3, hL: 1.1, kL: -1.7, hR: 0.9, kR: -1.6 };
    } else if (s === 'grabwind') {
      // Arms thrown wide open
      p = { tilt: -0.25, sL: 1.45, sR: 1.45, eL: 0.25, eR: 0.25, spread: 1.0, hL: 0.4, kL: -0.9, hR: 0.6, kR: -1.1 };
    } else if (s === 'grab') {
      // Flat out along the flight path like the ram, but arms open wide to catch them
      p = { tilt: -(Math.PI / 2 - pitch), sL: Math.PI * 0.8, sR: Math.PI * 0.8, eL: 0.35, eR: 0.35, spread: 0.7, hL: 0, hR: 0, kL: -0.1, kR: -0.1 };
    } else if (s === 'hold') {
      p = { tilt: 0.1, sL: 1.45, sR: 1.45, eL: 0.35, eR: 0.35, spread: 0.1, hL: 0.3, kL: -0.7, hR: 0.5, kR: -0.9 };
    } else if (s === 'slam') {
      // Follow-through of the throw, arms flung down
      p = { tilt: -0.5, sL: 0.3, sR: 0.3, eL: 0.1, eR: 0.1, spread: 0.2, hL: 0.5, kL: -1.0, hR: 0.2, kR: -0.6 };
    } else if (s === 'stunned') {
      const wob = Math.sin(this.t * 7) * 0.2;
      p = { tilt: 0.2 + wob, sL: 0.3, sR: 0.2, eL: 0.5, eR: 0.5, spread: 0.6, hL: 0.2, kL: -0.4, hR: 0.1, kR: -0.3 };
    } else {
      // Hovering, fists up, legs dangling
      p = { tilt: -0.1 + bob * 0.03, sL: 0.7, eL: 1.5, sR: 0.8, eR: 1.6, spread: 0.3, hL: 0.15 + bob * 0.08, kL: -0.5, hR: 0.6, kR: -1.1 };
    }
    this.rig.pose(p, 1 - Math.exp(-(s === 'ram' || s === 'grab' || s === 'dive' ? 25 : 12) * dt), dt, null);
  }

  // Drops out of the sky and fades out. True when gone.
  updateDead(dt) {
    const { player } = this.ctx;
    if (this.state !== 'dead') {
      if (this.state === 'hold' && player.launchT > 0) player.launchT = 0; // lets go
      this.state = 'dead';
      this.deathT = 0;
      this.icon.visible = false;
      this.vel.set(0, Math.min(this.vel.y, 0), 0);
      this.ctx.hud.callout(`${this.cfg.name} DOWN`, 'good');
    }
    this.deathT += dt;
    const e = this.e;
    this.vel.y -= 30 * dt;
    e.pos.addScaledVector(this.vel, dt);
    const r = this.ctx.world.resolve(e.pos, 0.6 * this.cfg.SCALE, 1.9 * this.cfg.SCALE, this.vel, dt, 0.6);
    if (r.ground) this.vel.set(0, 0, 0);
    this.rig.root.position.copy(e.pos);
    const k = Math.min(1, this.deathT / 0.6);
    this.rig.spin.rotation.x = 1.45 * k * k;
    this.rig.spin.position.y = this.rig.hipY * (1 - 0.65 * k);
    this.rig.pose({ sL: -0.3, sR: -0.3, eL: 0.3, eR: 0.3, spread: 0.5, hL: 0.3, kL: -0.3, hR: 0.1, kR: -0.1 }, 0.3, dt, null);
    if (this.deathT > 3) this.rig.root.scale.setScalar(this.cfg.SCALE * Math.max(0.01, 1 - (this.deathT - 3) * 2));
    return this.deathT > 3.5;
  }

  dispose() {}
}

// Keeps a couple of raptors around the hero. H summons one now.
export class RaptorSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.list = [];
  }

  spawn() {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2;
    this.list.push(new Raptor(this.ctx, new THREE.Vector3(p.x + Math.cos(a) * 60, Math.max(p.y, 0) + 30, p.z + Math.sin(a) * 60)));
  }

  update(dt, input) {
    const enemies = this.ctx.enemies, p = this.ctx.player.pos;
    this.list = this.list.filter((r) => {
      if (!enemies.list.includes(r.e)) return false;
      if (!r.e.dead && r.e.pos.distanceTo(p) > 400) {
        enemies.remove(enemies.list.indexOf(r.e));
        return false;
      }
      return true;
    });
    if (input?.hit('KeyH')) this.spawn();
    if (this.enabled === false) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = RESPAWN;
      if (this.list.length < MAX) this.spawn();
    }
  }
}

export const RAPTOR_STATS = { hp: HP, r: 0.9 * SCALE, cy: CY, mass: 0.15, scale: SCALE };
