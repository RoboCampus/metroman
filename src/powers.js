import * as THREE from 'three';
import { randomDir } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const FIRE_C0 = [1, 0.85, 0.45], FIRE_C1 = [0.9, 0.12, 0.0];
const ELEC_C0 = [0.85, 0.97, 1], ELEC_C1 = [0.15, 0.45, 1];

export function createPowerSet(ctx, type) {
  return type === 'fire' ? new FirePowers(ctx) : new ElectricPowers(ctx);
}

// Damage options passed to enemies.damage / damageRadius:
//   type: 'tap' | 'interrupt' | 'bb' (block breaker) | 'power' | 'dot'
//   burn / charge: seconds of status applied (power interaction setup)
//   exploit: 'burn' | 'charge' – bonus damage against targets with that status
//
// Shared cooldowns, power costs, projectiles and delayed effects. Subclasses define:
// abilities, ranged info, channelCost, ranged(), rangedHeavy(), channel(dt) and ability methods.
class PowerSet {
  constructor(ctx) {
    this.ctx = ctx;
    this.projectiles = [];
    this.timers = [];
    this.channeling = false;
  }

  init(abilities) {
    this.abilities = abilities.map((a) => ({ cd: 0, cost: 0, timer: 0, ...a }));
  }

  get(id) {
    return this.abilities.find((a) => a.id === id);
  }

  ready(a) {
    if (a.timer > 0) return false;
    return a.ult ? this.ctx.player.super >= 100 : this.ctx.player.power >= a.cost;
  }

  trigger(id) {
    const a = this.get(id), p = this.ctx.player;
    if (!this.ready(a)) {
      if (a.timer <= 0) this.ctx.hud.message(a.ult ? 'SUPERCHARGE NOT FULL' : 'NOT ENOUGH POWER', 0.8);
      return;
    }
    if (a.ult) p.super = 0;
    else p.power -= a.cost;
    a.timer = a.cd;
    p.cast();
    this.ctx.combat.sinceAttack = 0;
    this[a.fn]();
  }

  after(t, fn) {
    this.timers.push({ t, fn });
  }

  update(dt) {
    const { input, player } = this.ctx;
    for (const a of this.abilities) a.timer = Math.max(0, a.timer - dt);
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) {
        this.timers.splice(i, 1);
        tm.fn();
      }
    }
    this.updateProjectiles(dt);

    if (player.dead || player.downT > 0 || player.blocking) {
      if (this.channeling) this.stopChannel();
      this.channeling = false;
      return;
    }
    const ch = input.down('Digit3') && player.power > 2;
    if (ch) {
      player.power -= this.channelCost * dt;
      player.cast();
      this.ctx.combat.sinceAttack = 0;
      this.channel(dt);
    } else if (this.channeling) this.stopChannel();
    this.channeling = ch;

    if (input.hit('Digit1')) this.trigger('a1');
    if (input.hit('Digit2')) this.trigger('a2');
    if (input.hit('KeyR')) this.trigger('ult');
  }

  stopChannel() {
    this.ctx.fx.handLight.intensity = 0;
  }

  dispose() {
    this.stopChannel();
    for (const p of this.projectiles) if (p.mesh) this.ctx.scene.remove(p.mesh);
    this.projectiles.length = 0;
    this.timers.length = 0;
  }

  shoot(from, dir, speed, opt) {
    const p = {
      pos: from.clone(), vel: dir.clone().multiplyScalar(speed), life: opt.life ?? 2.5,
      radius: opt.radius ?? 0.4, mesh: opt.mesh, onHit: opt.onHit, trail: opt.trail,
    };
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      this.ctx.scene.add(p.mesh);
    }
    this.projectiles.push(p);
  }

  updateProjectiles(dt) {
    const { world, enemies, scene } = this.ctx;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const len = p.vel.length() * dt;
      _d.copy(p.vel).normalize();
      let t = world.raycastHit(p.pos, _d, len);
      let normal = t < len ? world.hitNormal : null; // surface hit, for craters / shattered glass
      const hitE = enemies.sweep(p.pos, _d, len, p.radius);
      if (hitE && hitE.t < t) {
        t = hitE.t;
        normal = null;
      }
      const hitC = this.ctx.traffic?.sweep(p.pos, _d, len, p.radius);
      if (hitC && hitC.t < t) {
        t = hitC.t;
        normal = null;
      }
      if (t < len || hitE || hitC || p.life <= 0) {
        p.pos.addScaledVector(_d, t);
        if (p.mesh) scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
        p.onHit(p.pos.clone(), normal);
        continue;
      }
      p.pos.addScaledVector(_d, len);
      if (p.mesh) p.mesh.position.copy(p.pos);
      if (p.trail) p.trail(p, dt);
    }
  }

  // Direction from the casting hand to the crosshair target.
  aimFromHand(range, assist) {
    const aim = this.ctx.getAim(range, assist);
    const from = this.ctx.player.getHandPos(V3());
    const dir = aim.point.clone().sub(from).normalize();
    return { aim, from, dir };
  }
}

// ======================================================================== FIRE
const fireGeo = new THREE.SphereGeometry(0.45, 12, 8);
const fireMat = new THREE.MeshBasicMaterial({ color: 0xffc070, toneMapped: false });
const meteorGeo = new THREE.IcosahedronGeometry(2.2, 1);
const meteorMat = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff5a10, emissiveIntensity: 2.5, roughness: 0.8, flatShading: true });

class FirePowers extends PowerSet {
  constructor(ctx) {
    super(ctx);
    this.channelCost = 16;
    this.rangedInfo = { name: 'Fireball · hold Blazing Lance', icon: '🔥' };
    this.init([
      { id: 'a1', key: '1', name: 'Inferno Nova', icon: '💥', cd: 7, cost: 25, fn: 'inferno' },
      { id: 'a2', key: '2', name: 'Meteor', icon: '☄️', cd: 10, cost: 35, fn: 'meteor' },
      { id: 'channel', key: '3', name: 'Flamethrower (hold)', icon: '🌋', hold: true },
      { id: 'ult', key: 'R', name: 'Supernova', icon: '☀️', cd: 2, ult: true, fn: 'supernova' },
    ]);
  }

  flames(pos, n, speed, size, life, up = 6) {
    const fx = this.ctx.fx;
    for (let i = 0; i < n; i++) {
      randomDir(_c).multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      fx.spawn(pos.x, pos.y, pos.z, _c.x, _c.y, _c.z, life * (0.6 + Math.random() * 0.6), size, size * 0.3, FIRE_C0, FIRE_C1, up, 2.5);
    }
  }

  // normal: surface that was hit (null if it hit an enemy or a car)
  explode(pos, r, dmg, knock, big = 1, opts = {}, normal = null) {
    const { fx, enemies, player } = this.ctx;
    enemies.damageRadius(pos, r, dmg, knock, 0, opts);
    this.ctx.impacts.hit(pos, normal, r * 0.65, 'fire', big >= 1.5 ? r * 1.2 : 0);
    this.flames(pos, Math.round(40 * big), 14 * big, 2.2 * Math.sqrt(big), 0.7);
    fx.burst(pos, Math.round(15 * big), { speed: 25 * Math.sqrt(big), life: 0.8, size: 0.35, c0: [1, 0.9, 0.6], c1: [1, 0.3, 0], ay: -20, drag: 0.5 });
    fx.flash(pos, 0xff7a20, 600 * big, r * 4, 0.35);
    if (big >= 1.5) {
      fx.ring(pos, 0xff8a30, r * 1.2, 0.5);
      player.shake(0.2 * big, 0.4);
    }
  }

  fireball(from, dir, speed, scale, onHit) {
    const fx = this.ctx.fx;
    const mesh = new THREE.Mesh(fireGeo, fireMat);
    mesh.scale.setScalar(scale);
    this.shoot(from, dir, speed, {
      mesh,
      radius: 0.5 * scale,
      life: 200 / speed,
      // Spread the trail along this frame's path so it stays continuous at high speed.
      trail: (p, dt) => {
        for (let i = 0; i < 6 * scale; i++) {
          const back = Math.random() * dt;
          fx.spawn(p.pos.x - p.vel.x * back, p.pos.y - p.vel.y * back, p.pos.z - p.vel.z * back,
            (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3,
            0.35, 1.1 * scale, 0.2, FIRE_C0, FIRE_C1, 4, 1);
        }
      },
      onHit,
    });
  }

  ranged() {
    const { from, dir } = this.aimFromHand();
    this.fireball(from, dir, 360, 1, (pos, n) => this.explode(pos, 4.5, 24, 9, 1, { type: 'tap', burn: 3 }, n));
  }

  // Block Breaker: a big, fast lance of fire.
  rangedHeavy(combo) {
    const { player } = this.ctx;
    const { from, dir } = this.aimFromHand();
    player.attack('heavyCast', 0.4, player.yaw);
    player.cast();
    const k = combo ? 1.5 : 1;
    this.flames(from, 20, 6, 1, 0.3);
    this.fireball(from, dir, 300, 2 * k, (pos, n) => this.explode(pos, 6 * k, 42 * k, 16, 1.6 * k, { type: 'bb', burn: 4 }, n));
  }

  channel(dt) {
    const { player, fx, enemies } = this.ctx;
    const aim = this.ctx.getAim(40);
    const from = player.getHandPos(_a);
    const dir = _b.copy(aim.point).sub(from).normalize();
    const n = Math.ceil(220 * dt);
    for (let i = 0; i < n; i++) {
      _c.copy(dir).multiplyScalar(38 + Math.random() * 14);
      _c.x += (Math.random() - 0.5) * 9 + player.vel.x;
      _c.y += (Math.random() - 0.5) * 9 + player.vel.y;
      _c.z += (Math.random() - 0.5) * 9 + player.vel.z;
      fx.spawn(from.x, from.y, from.z, _c.x, _c.y, _c.z, 0.38 + Math.random() * 0.2, 0.4, 3.2, FIRE_C0, FIRE_C1, 5, 1.2);
    }
    enemies.cone(from, dir, 20, Math.cos(0.38), (e) =>
      enemies.damage(e, 70 * dt, { type: 'power', burn: 2, knock: _d.copy(dir).multiplyScalar(14 * dt) }));
    this.ctx.traffic?.damageRadius(_c.copy(from).addScaledVector(dir, 9), 7, 70 * dt, 0); // sets cars on fire
    const L = fx.handLight;
    L.position.copy(from).addScaledVector(dir, 3);
    L.color.set(0xff7a20);
    L.intensity = 250 + Math.random() * 200;
  }

  inferno() {
    const { player, fx, enemies } = this.ctx;
    const c = V3().copy(player.pos);
    c.y += 1;
    enemies.damageRadius(c, 16, 75, 24, 0, { type: 'power', burn: 4 });
    this.ctx.impacts.hit(c, null, 9, 'fire', 15);
    for (let i = 0; i < 220; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 22 + Math.random() * 16;
      fx.spawn(c.x, c.y + Math.random() * 1.5, c.z, Math.cos(ang) * sp, Math.random() * 5, Math.sin(ang) * sp,
        0.55 + Math.random() * 0.3, 1.8, 3.5, FIRE_C0, FIRE_C1, 4, 2.5);
    }
    this.flames(c, 60, 8, 2.5, 0.8);
    fx.ring(c, 0xff7020, 17, 0.45);
    fx.ring(c, 0xffc060, 11, 0.35);
    fx.flash(c, 0xff6a10, 1500, 60, 0.5);
    player.shake(0.5, 0.4);
  }

  meteor() {
    const aim = this.ctx.getAim(140);
    const target = aim.point.clone();
    const start = target.clone().add(V3(30, 110, 20));
    const dir = target.clone().sub(start);
    const dist = dir.length();
    dir.normalize();
    this.ctx.fx.ring(target, 0xff4010, 11, 0.9);
    this.shoot(start, dir, dist / 0.85, {
      mesh: new THREE.Mesh(meteorGeo, meteorMat),
      radius: 1.5,
      life: 2,
      trail: (p) => {
        this.flames(p.pos, 6, 4, 3.2, 0.6);
        p.mesh.rotation.x += 0.2;
        p.mesh.rotation.y += 0.13;
      },
      onHit: (pos, n) => {
        this.explode(pos, 12, 150, 34, 3, { type: 'power', exploit: 'burn' }, n);
        this.flames(pos, 120, 26, 3, 1.0);
      },
    });
  }

  supernova() {
    const { player, fx } = this.ctx;
    this.ctx.hud.message('SUPERNOVA!', 1.2);
    const c = V3().copy(player.pos);
    c.y += 1;
    for (let i = 0; i < 140; i++) {
      randomDir(_c);
      fx.spawn(c.x + _c.x * 12, c.y + _c.y * 12, c.z + _c.z * 12, -_c.x * 20, -_c.y * 20, -_c.z * 20, 0.6, 1.2, 0.3, FIRE_C0, FIRE_C1, 0, 0);
    }
    fx.flash(c, 0xffa040, 800, 30, 0.6);
    this.after(0.6, () => {
      const c2 = V3().copy(player.pos);
      c2.y += 1;
      this.ctx.enemies.damageRadius(c2, 38, 340, 50, 0, { type: 'power', exploit: 'burn' });
      this.ctx.impacts.hit(c2, null, 18, 'fire', 35);
      for (let i = 0; i < 500; i++) {
        randomDir(_c).multiplyScalar(40 + Math.random() * 30);
        fx.spawn(c2.x, c2.y, c2.z, _c.x, _c.y, _c.z, 0.7 + Math.random() * 0.5, 3, 6, FIRE_C0, FIRE_C1, 3, 2.2);
      }
      fx.ring(c2, 0xff6010, 40, 0.8);
      fx.ring(c2, 0xffd080, 28, 0.6);
      fx.ring(c2, 0xffffff, 16, 0.4);
      fx.flash(c2, 0xffb050, 5000, 150, 1.0);
      player.shake(1.2, 0.8);
    });
  }
}

// ======================================================================== ELECTRICITY
class ElectricPowers extends PowerSet {
  constructor(ctx) {
    super(ctx);
    this.channelCost = 15;
    this.arcT = 0;
    this.rangedInfo = { name: 'Bolt · hold Overload', icon: '⚡' };
    this.init([
      { id: 'a1', key: '1', name: 'Thunderclap', icon: '💫', cd: 7, cost: 25, fn: 'thunderclap' },
      { id: 'a2', key: '2', name: 'Lightning Storm', icon: '⛈️', cd: 12, cost: 35, fn: 'storm' },
      { id: 'channel', key: '3', name: 'Chain Arc (hold)', icon: '🌩️', hold: true },
      { id: 'ult', key: 'R', name: 'Wrath of the Storm', icon: '🌀', cd: 2, ult: true, fn: 'wrath' },
    ]);
  }

  sparks(pos, n, speed, size = 0.5, life = 0.35) {
    this.ctx.fx.burst(pos, n, { speed, life, size, size1: 0.05, c0: ELEC_C0, c1: ELEC_C1, ay: -12, drag: 2 });
  }

  zap(from, to, width = 0.35, life = 0.12) {
    this.ctx.fx.bolt(from, to, { color: 0x6fc8ff, width, life });
  }

  bolt(width, dmg, opts) {
    const { enemies, fx } = this.ctx;
    const { aim, from } = this.aimFromHand(150, 8);
    const target = aim.target || enemies.nearest(aim.point, 3);
    const to = target ? enemies.center(target, V3()) : aim.point.clone();
    this.zap(from, to, width, 0.12 + width * 0.1);
    this.sparks(to, 10 + width * 20, 10);
    fx.flash(to, 0x66bbff, 250 + width * 600, 18, 0.12);
    if (target) enemies.damage(target, dmg, { knock: _b.copy(to).sub(from).normalize().multiplyScalar(4 + width * 10), ...opts });
    else {
      this.ctx.traffic?.damageRadius(to, 2.5, dmg, 3 + width * 8);
      this.ctx.impacts.hit(to, aim.normal, 1.2 + width * 2.2, 'elec');
    }
    return { target, to };
  }

  ranged() {
    this.bolt(0.35, 17, { type: 'tap', charge: 4 });
  }

  // Block Breaker: a thick overload bolt that also arcs to one nearby enemy.
  rangedHeavy(combo) {
    const { player, enemies } = this.ctx;
    player.attack('heavyCast', 0.4, player.yaw);
    player.cast();
    const k = combo ? 1.5 : 1;
    const { target, to } = this.bolt(0.9 * k, 42 * k, { type: 'bb', charge: 5 });
    if (target) {
      const next = enemies.nearest(to, 12, [target]);
      if (next) {
        const p = enemies.center(next, V3());
        this.zap(to, p, 0.4, 0.15);
        enemies.damage(next, 20 * k, { type: 'tap', charge: 4 });
      }
    }
  }

  channel(dt) {
    const { player, enemies, fx } = this.ctx;
    this.arcT -= dt;
    const aim = this.ctx.getAim(45, 14);
    const from = player.getHandPos(_a);
    const chain = [];
    let cur = aim.target;
    if (cur) {
      chain.push(cur);
      for (let k = 0; k < 3; k++) {
        const nxt = enemies.nearest(enemies.center(cur, _c), 14, chain);
        if (!nxt) break;
        chain.push(nxt);
        cur = nxt;
      }
    }
    chain.forEach((e, i) => enemies.damage(e, (i === 0 ? 55 : 35) * dt, { type: 'power', stun: 0.25, charge: 2 }));
    if (this.arcT <= 0) {
      this.arcT = 0.05;
      if (chain.length) {
        let prev = from.clone();
        for (const e of chain) {
          const p = enemies.center(e, V3());
          this.zap(prev, p, 0.3, 0.07);
          this.sparks(p, 3, 6);
          prev = p;
        }
      } else {
        const d = Math.min(18, from.distanceTo(aim.point));
        const to = from.clone().addScaledVector(_b.copy(aim.point).sub(from).normalize(), d);
        this.zap(from, to, 0.22, 0.06);
        this.ctx.traffic?.damageRadius(to, 2.5, 50 * 0.05, 0);
      }
    }
    const L = fx.handLight;
    L.position.copy(from);
    L.color.set(0x66bbff);
    L.intensity = 200 + Math.random() * 300;
  }

  thunderclap() {
    const { player, fx, enemies } = this.ctx;
    const c = V3().copy(player.pos);
    c.y += 1;
    for (const e of enemies.inRadius(c, 16)) this.zap(c, enemies.center(e, V3()), 0.5, 0.25);
    enemies.damageRadius(c, 16, 55, 12, 3.0, { type: 'power', exploit: 'charge' });
    this.ctx.impacts.hit(c, null, 9, 'elec', 16);
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.3, r = 8 + Math.random() * 8;
      const to = V3(c.x + Math.cos(ang) * r, player.pos.y, c.z + Math.sin(ang) * r);
      this.zap(c, to, 0.5, 0.25);
      this.sparks(to, 6, 8);
    }
    fx.ring(c, 0x7fd8ff, 17, 0.4);
    fx.ring(c, 0xffffff, 10, 0.3);
    fx.flash(c, 0x88ccff, 1500, 60, 0.4);
    player.shake(0.45, 0.35);
  }

  storm() {
    const aim = this.ctx.getAim(140);
    const target = aim.point.clone();
    this.ctx.fx.ring(target, 0x6fc8ff, 10, 2.4);
    for (let i = 0; i < 10; i++) {
      this.after(0.15 + i * 0.22, () => {
        const { enemies, world } = this.ctx;
        const near = enemies.inRadius(target, 14);
        let p;
        if (near.length && Math.random() < 0.6) p = enemies.center(near[(Math.random() * near.length) | 0], V3());
        else {
          p = target.clone().add(V3((Math.random() - 0.5) * 16, 0, (Math.random() - 0.5) * 16));
          p.y = world.groundY(p.x, p.z, target.y + 40);
        }
        this.strike(p, 6, 45, { type: 'power', charge: 5 });
      });
    }
  }

  strike(p, r, dmg, opts) {
    const { fx, enemies, player } = this.ctx;
    const top = p.clone().add(V3((Math.random() - 0.5) * 10, 90, (Math.random() - 0.5) * 10));
    fx.bolt(top, p, { color: 0x8fd0ff, width: 1.3, life: 0.28, jag: 0.08 });
    enemies.damageRadius(p, r, dmg, 8, 1.2, opts);
    this.ctx.impacts.hit(p, null, r * 0.9, 'elec', r);
    this.sparks(p, 25, 16, 0.7, 0.5);
    fx.ring(p, 0x9fe0ff, r * 1.3, 0.3);
    fx.flash(p, 0x9fd0ff, 1800, 70, 0.2);
    player.shake(0.15, 0.2);
  }

  wrath() {
    const { player, enemies, world } = this.ctx;
    this.ctx.hud.message('WRATH OF THE STORM!', 1.2);
    const c = V3().copy(player.pos);
    c.y += 1;
    this.sparks(c, 80, 20, 0.8, 0.6);
    const opts = { type: 'power', exploit: 'charge' };
    const list = enemies.inRadius(c, 90).slice(0, 25);
    list.forEach((e, i) => this.after(0.1 + i * 0.07, () => {
      if (!e.dead) this.strike(enemies.center(e, V3()), 4, 260, opts);
    }));
    if (!list.length) {
      for (let i = 0; i < 6; i++) {
        this.after(i * 0.1, () => {
          const p = V3(c.x + (Math.random() - 0.5) * 60, 0, c.z + (Math.random() - 0.5) * 60);
          p.y = world.groundY(p.x, p.z, c.y + 60);
          this.strike(p, 4, 260, opts);
        });
      }
    }
  }
}
