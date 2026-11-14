import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';
import { stride } from './humanoid.js';
import { createRig } from './models.js';

// Charger: a hulking bruiser who stalks the hero and every few seconds lowers his head and charges.
//   - Wind-up: he crouches and paws the ground, glowing red, with a "!" over his head.
//   - Charge: he runs straight at the hero at 42 m/s (steering a little), smashing cars and street
//     furniture out of the way.
//   - If he connects and the hero isn't dodging or blocking, the hero is launched at 200 mph for
//     3 seconds. Blocked, the hero is still launched but the shield stays up (little damage) for as
//     long as they hold block, and he is stunned; a dodge makes him miss and run past.
//   - Running into a wall stuns him; while stunned he's wide open.
// Lives in enemies.list with its own update (like the bosses), so all attacks hurt him.

const HP = 240;
const SCALE = 1.45;
const WALK = 5.5;
const CHARGE = { speed: 42, turn: 0.9, max: 1.5, wind: 0.85, range: [7, 45], reach: 1.9, dmg: 22, cooldown: [4, 7] };
const LAUNCH = { speed: 200 * 0.44704, time: 3, lift: 0.3 }; // 200 mph for 3 s
const STUN = { wall: 2.2, blocked: 1.6, miss: 0.9 };
const MAX = 2, SPAWN_FIRST = 15, RESPAWN = 25;
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

let iconMat = null;
function chargeIcon() {
  if (iconMat) return iconMat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ff2a2a';
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
  iconMat = new THREE.SpriteMaterial({ map: t, toneMapped: false });
  return iconMat;
}

export class Charger {
  constructor(ctx, x, z) {
    this.ctx = ctx;
    const rig = createRig('brute', { preferModel: ctx.useModels !== false });
    rig.paint(['#5a2416', '#1e1a18', '#c58f6a', '#000', '#141414', '#7a2a12']);
    rig.root.scale.setScalar(SCALE);
    this.rig = rig;
    this.icon = new THREE.Sprite(chargeIcon());
    this.icon.position.y = 2.4;
    this.icon.scale.setScalar(0.6);
    this.icon.visible = false;
    rig.root.add(this.icon);
    const e = ctx.enemies.base('charger', rig.root, new THREE.Vector3(x, ctx.world.groundY(x, z, 400), z), rig.material);
    e.boss = this;
    e.noBar = true;
    e.mapColor = '#ff7a2a';
    e.scoreValue = 5;
    this.e = e;
    this.vel = new THREE.Vector3();
    this.state = 'approach';
    this.stateT = 0;
    this.cd = 2 + Math.random() * 2;
    this.dir = new THREE.Vector3(0, 0, -1);
    this.step = Math.random() * 10;
    this.hitDone = false;
    this.dustT = 0;
  }

  update(dt) {
    const e = this.e, { player, world, fx } = this.ctx;
    e.stun = 0;
    this.stateT -= dt;
    this.cd -= dt;
    const to = _v.subVectors(player.pos, e.pos);
    const dist = Math.hypot(to.x, to.z);
    const want = Math.atan2(-to.x, -to.z);
    let speed = 0;

    switch (this.state) {
      case 'approach': {
        e.facing = lerpAngle(e.facing, want, 1 - Math.exp(-5 * dt));
        if (dist > CHARGE.range[0] * 1.5) speed = WALK;
        const reachable = Math.abs(player.pos.y - e.pos.y) < 4 && !player.dead;
        if (this.cd <= 0 && reachable && dist > CHARGE.range[0] && dist < CHARGE.range[1] && this.clearPath()) {
          this.state = 'windup';
          this.stateT = CHARGE.wind;
          this.icon.visible = true;
        }
        break;
      }
      case 'windup':
        // Lock onto the hero, paw the ground
        e.facing = lerpAngle(e.facing, want, 1 - Math.exp(-10 * dt));
        this.dustT -= dt;
        if (this.dustT <= 0) {
          this.dustT = 0.12;
          fx.smoke(e.pos.x + (Math.random() - 0.5) * 1.5, e.pos.y + 0.2, e.pos.z + (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.8, 0.6, 1.6, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 1);
        }
        if (this.stateT <= 0) {
          this.state = 'charge';
          this.stateT = CHARGE.max;
          this.hitDone = false;
          this.dir.set(-Math.sin(e.facing), 0, -Math.cos(e.facing));
          this.icon.visible = false;
          fx.ring(e.pos, 0xff4020, 4, 0.3);
          player.shake(0.15 * Math.max(0.2, 1 - dist / 60), 0.2);
        }
        break;
      case 'charge': {
        // Straight at the hero, steering only a little
        if (!this.hitDone && !player.dead) {
          const turn = Math.atan2(-to.x, -to.z), cur = Math.atan2(-this.dir.x, -this.dir.z);
          const nf = lerpAngle(cur, turn, Math.min(1, (CHARGE.turn * dt) / Math.max(0.01, Math.abs(((turn - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI))));
          this.dir.set(-Math.sin(nf), 0, -Math.cos(nf));
        }
        e.facing = Math.atan2(-this.dir.x, -this.dir.z);
        speed = CHARGE.speed;
        // Dust and debris kicked up, cars and benches bowled over
        if (Math.random() < 0.7) fx.smoke(e.pos.x, e.pos.y + 0.3, e.pos.z, -this.dir.x * 6, 1.5, -this.dir.z * 6, 0.9, 0.8, 2.2, [0.5, 0.47, 0.43], [0.3, 0.28, 0.26], 0.3, 1);
        _w.copy(e.pos).addScaledVector(this.dir, 1.5);
        _w.y += 1;
        this.ctx.traffic?.damageRadius(_w, 2.5, 60, 25);
        this.ctx.props?.damageRadius(_w, 2, 20);
        // Contact with the hero
        if (!this.hitDone && !player.dead) {
          _w.copy(player.pos).sub(e.pos);
          if (Math.hypot(_w.x, _w.z) < CHARGE.reach * SCALE * 0.75 && Math.abs(_w.y) < 2.5) this.impact();
        }
        if (this.stateT <= 0) this.recover(STUN.miss);
        break;
      }
      case 'stunned':
        if (Math.random() < dt * 6) {
          _w.set(e.pos.x + (Math.random() - 0.5), e.pos.y + 2.7 * SCALE * 0.75, e.pos.z + (Math.random() - 0.5));
          fx.spawn(_w.x, _w.y, _w.z, 0, 0.5, 0, 0.5, 0.35, 0.1, [1, 0.95, 0.5], [1, 0.7, 0.2], 0, 0);
        }
        if (this.stateT <= 0) {
          this.state = 'approach';
          this.cd = CHARGE.cooldown[0] + Math.random() * (CHARGE.cooldown[1] - CHARGE.cooldown[0]);
        }
        break;
    }

    // Move on the ground
    const fx2 = -Math.sin(e.facing), fz = -Math.cos(e.facing);
    const dirX = this.state === 'charge' ? this.dir.x : fx2, dirZ = this.state === 'charge' ? this.dir.z : fz;
    this.vel.x = dirX * speed;
    this.vel.z = dirZ * speed;
    this.vel.y -= 25 * dt;
    e.pos.addScaledVector(this.vel, dt);
    const r = world.resolve(e.pos, 0.6 * SCALE, 1.9 * SCALE, this.vel, dt, 0.6);
    if (r.ground) this.vel.y = Math.min(0, this.vel.y);
    if (this.state === 'charge' && r.wall) this.crash();
    e.vel.set(0, 0, 0);

    // Glow: red pulse while winding up and charging, white flash when hit
    e.flash = Math.max(0, e.flash - dt * 6);
    const hot = this.state === 'windup' || this.state === 'charge';
    e.mat.emissive.setHex(hot ? 0xff2020 : 0xffffff);
    e.mat.emissiveIntensity = hot ? 0.5 + 0.4 * Math.sin(performance.now() * 0.025) : e.flash * 0.9;

    this.animate(dt, speed);
  }

  // Nothing solid between him and the hero at chest height?
  clearPath() {
    const e = this.e, p = this.ctx.player.pos;
    _w.set(p.x - e.pos.x, 0, p.z - e.pos.z);
    const d = _w.length();
    _w.divideScalar(d || 1);
    return this.ctx.world.raycast({ x: e.pos.x, y: e.pos.y + 1, z: e.pos.z }, _w, d) >= d - 1;
  }

  impact() {
    const { player, fx, hud } = this.ctx;
    this.hitDone = true;
    const r = player.takeDamage(CHARGE.dmg, 'normal');
    _w.copy(player.pos);
    _w.y += 1;
    if (r === 'ignored') {
      hud.callout('DODGED!', 'good'); // he thunders past
      return;
    }
    const dir = this.dir.clone().setY(LAUNCH.lift).normalize();
    if (r === 'blocked') {
      // The shield takes the hit (little damage) but they're still sent flying, shield up
      player.launch(dir.multiplyScalar(LAUNCH.speed), LAUNCH.time, true);
      fx.burst(_w, 40, { speed: 12, life: 0.4, size: 0.9, c0: [0.7, 0.9, 1], c1: [0.2, 0.5, 1] });
      fx.ring(_w, 0x6ab8ff, 7, 0.35, this.dir);
      player.shake(0.6, 0.35);
      hud.callout('CHARGE BLOCKED · LAUNCHED!', 'good');
      this.recover(STUN.blocked);
      return;
    }
    // Full hit: launched at 200 mph
    if (!player.dead) player.launch(dir.multiplyScalar(LAUNCH.speed), LAUNCH.time);
    fx.burst(_w, 50, { speed: 18, life: 0.5, size: 1.2, c0: [1, 0.8, 0.5], c1: [0.8, 0.2, 0.1], drag: 2 });
    fx.flash(_w, 0xff6040, 1500, 30, 0.2);
    fx.ring(player.pos, 0xff6040, 8, 0.35);
    player.shake(1, 0.5);
    this.ctx.combat?.hitstop(0.08);
    hud.callout('RAMMED!', 'bad');
    this.recover(STUN.miss);
  }

  crash() {
    const { fx, player, destruction } = this.ctx, e = this.e;
    _w.copy(e.pos).addScaledVector(this.dir, 1.2);
    _w.y += 1.2;
    destruction?.damage(_w, 2.5, this.dir);
    fx.burst(_w, 30, { speed: 9, life: 0.4, size: 1, c0: [0.7, 0.65, 0.6], c1: [0.3, 0.3, 0.3], drag: 3 });
    player.shake(0.5 * Math.max(0.1, 1 - player.pos.distanceTo(e.pos) / 60), 0.3);
    this.recover(STUN.wall);
  }

  // Dazed for a moment after a charge (longer after a wall or a block): free hits for the hero.
  recover(stun) {
    this.state = 'stunned';
    this.stateT = stun;
    this.icon.visible = false;
  }

  animate(dt, speed) {
    const e = this.e;
    this.rig.root.position.copy(e.pos);
    this.rig.root.rotation.y = e.facing;
    this.step += dt * (4 + speed * 0.6);
    let p, loco;
    if (this.state === 'charge') {
      // Head down, shoulder first, legs pumping
      p = { ...stride(this.step, 1.2, 1.4), tilt: -0.6, sL: 0.5, eL: 1.7, sR: 0.9, eR: 1.5, spread: 0.3 };
      loco = { clip: 'run', speed: speed / SCALE, mask: 'arms' };
    } else if (this.state === 'windup') {
      // Crouched, pawing the ground, arms back
      const paw = Math.sin(performance.now() * 0.02) * 0.4;
      p = { tilt: -0.4, hL: 0.5 + paw, kL: -1.1, hR: -0.2, kR: -0.6, sL: -0.4, sR: -0.4, eL: 0.9, eR: 0.9, spread: 0.35 };
      loco = null;
    } else if (this.state === 'stunned') {
      const wob = Math.sin(performance.now() * 0.008) * 0.15;
      p = { tilt: 0.1 + wob, sL: 0.2, sR: 0.2, eL: 0.4, eR: 0.4, spread: 0.5, kL: -0.3, kR: -0.3 };
      loco = null;
    } else {
      p = speed > 0.5 ? { ...stride(this.step, 0.5, 0.4), sL: 0.9, eL: 1.6, sR: 0.9, eR: 1.6 } : { sL: 0.9, eL: 1.6, sR: 0.9, eR: 1.6 };
      loco = { clip: speed > 0.5 ? 'walk' : 'idle', speed: speed / SCALE, mask: 'arms' };
    }
    this.rig.pose(p, 1 - Math.exp(-12 * dt), dt, loco);
  }

  // Falls flat on his back and fades out. True when gone.
  updateDead(dt) {
    if (this.state !== 'dead') {
      this.state = 'dead';
      this.deathT = 0;
      this.icon.visible = false;
      this.ctx.hud.callout('CHARGER DOWN', 'good');
    }
    this.deathT += dt;
    const k = Math.min(1, this.deathT / 0.5);
    this.rig.spin.rotation.x = 1.45 * k * k;
    this.rig.spin.position.y = this.rig.hipY * (1 - 0.65 * k);
    this.rig.pose({ sL: -0.3, sR: -0.3, eL: 0.3, eR: 0.3, spread: 0.5, hL: 0.3, kL: -0.3, hR: 0.1, kR: -0.1 }, 0.3, dt, null);
    if (this.deathT > 2) this.rig.root.scale.setScalar(SCALE * Math.max(0.01, 1 - (this.deathT - 2) * 2));
    return this.deathT > 2.5;
  }

  dispose() {}
}

// Keeps a couple of chargers around the hero. J summons one now.
export class ChargerSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.list = [];
  }

  spawn() {
    const p = this.ctx.player.pos;
    const pt = this.ctx.city?.randomStreetPoint?.(p.x, p.z, 45, 90);
    const a = Math.random() * Math.PI * 2;
    this.list.push(new Charger(this.ctx, pt ? pt.x : p.x + Math.cos(a) * 50, pt ? pt.z : p.z + Math.sin(a) * 50));
  }

  update(dt, input) {
    const enemies = this.ctx.enemies, p = this.ctx.player.pos;
    this.list = this.list.filter((c) => {
      if (!enemies.list.includes(c.e)) return false;
      // wandered off far away: quietly replace later
      if (!c.e.dead && c.e.pos.distanceTo(p) > 400) {
        enemies.remove(enemies.list.indexOf(c.e));
        return false;
      }
      return true;
    });
    if (input?.hit('KeyJ')) this.spawn();
    if (this.enabled === false) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = RESPAWN;
      if (this.list.length < MAX) this.spawn();
    }
  }
}

export const CHARGER_STATS = { hp: HP, r: 0.9 * SCALE, cy: 1.2 * SCALE * 0.75, mass: 0.15, scale: SCALE };
