import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';
import { stride } from './humanoid.js';
import { createRig } from './models.js';
import { KAIJU_STATS } from './kaiju.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const JACKETS = ['#4a5a3a', '#7a2626', '#2f3d60', '#555555', '#6b4e2e', '#3a3a48', '#1f1f24'];
const PANTS = ['#23242a', '#2f3a4f', '#3b3428', '#1c1c1c'];
const SKINS = ['#e0ac85', '#c58f6a', '#8d5a3b', '#5e3b26', '#f1c8a4'];
const HATS = ['#b3202a', '#1d1d1d', '#2b4a7a', '#4b5320'];
const SHIRTS = ['#d8d8d8', '#9a1c1c', '#c9a227', '#3d3d3d'];
const MAX_THUGS = 16, MAX_DRONES = 5, MAX_BRUTES = 2, DESPAWN = 380;
const RED = 0xff2a2a, ORANGE = 0xff8a00, WHITE = 0xffffff;

// Telegraphed specials follow the counter triangle:
//   'hay' (red glow)    = lunging Interrupt-type attack  -> BLOCK it (L-Ctrl) to counter
//   'bb'  (orange glow) = Block Breaker attack           -> hit it with a melee HOLD (Interrupt)
//   blocking (blue shield)                              -> break it with a ranged HOLD (Block Breaker)
const STATS = {
  thug: {
    hp: 60, r: 0.85, cy: 1.1, colR: 0.4, colH: 1.9, speed: 5.5, keep: 16, shoots: true, blockRate: 0.8, cd: 4,
    hayRange: 5.5, hayWind: 0.7, hayLunge: 16, hayReach: 3.2, hayDmg: 28,
    bbRange: 35, bbWind: 1.0, bbDmg: 22, down: 2.4, mass: 1, scale: 1,
  },
  brute: {
    hp: 420, r: 1.35, cy: 1.75, colR: 0.65, colH: 3.0, speed: 4.2, keep: 2.5, shoots: false, blockRate: 1.6, cd: 2.5,
    hayRange: 16, hayWind: 0.8, hayLunge: 30, hayReach: 4.5, hayDmg: 40,
    bbRange: 9, bbWind: 1.1, bbDmg: 35, slam: 8, down: 1.8, mass: 0.35, scale: 1.6,
  },
  drone: { hp: 80, r: 0.9, cy: 0, mass: 0.8 },
  kaiju: KAIJU_STATS,
};

const geo = {
  droneBody: new THREE.SphereGeometry(0.55, 14, 10),
  droneRing: new THREE.TorusGeometry(0.85, 0.08, 6, 20).rotateX(Math.PI / 2),
  droneEye: new THREE.SphereGeometry(0.16, 8, 6).translate(0, 0, -0.5),
  bullet: new THREE.SphereGeometry(0.12, 6, 4),
  shield: new THREE.SphereGeometry(1.15, 18, 12),
};
const mats = {
  gun: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.4, metalness: 0.7 }),
  ring: new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.3, metalness: 0.8 }),
  eye: new THREE.MeshBasicMaterial({ color: '#ff2a3a', toneMapped: false }),
  bulletThug: new THREE.MeshBasicMaterial({ color: '#ffcc55', toneMapped: false }),
  bulletDrone: new THREE.MeshBasicMaterial({ color: '#ff3344', toneMapped: false }),
  bulletBB: new THREE.MeshBasicMaterial({ color: '#ff8a00', toneMapped: false }),
  shield: new THREE.MeshBasicMaterial({
    color: '#4fa8ff', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }),
};

function iconMaterial(color) {
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: tex, toneMapped: false });
}
const icons = { hay: iconMaterial('#e8202a'), bb: iconMaterial('#ff8a00') };

// Pistol parented to a model's right-hand bone (bones carry the model's scale, so undo it).
const gunGeo = new THREE.BoxGeometry(0.05, 0.24, 0.1).translate(0, 0.12, 0.03); // Mixamo hand bones point +Y along the fingers
function attachGun(rig) {
  const hand = rig.arms[1].hand;
  rig.root.updateMatrixWorld(true);
  const gun = new THREE.Mesh(gunGeo, mats.gun);
  gun.scale.setScalar(1 / hand.getWorldScale(new THREE.Vector3()).x);
  gun.castShadow = true;
  hand.add(gun);
}

export class Enemies {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
    this.bullets = [];
    this.spawnT = 0;
    this.score = 0;
  }

  base(type, group, pos, mat) {
    const S = STATS[type];
    const e = {
      type, group, pos, mat, stats: S, hp: S.hp, maxHp: S.hp, r: S.r, cy: S.cy,
      vel: new THREE.Vector3(), dead: false, deathT: 0, stun: 0, knockT: 0, flash: 0,
      shootT: 1 + Math.random() * 2, pending: 0, numT: 0, facing: 0, spin: 0, grounded: false,
      wander: Math.random() * Math.PI * 2, wanderT: 0, idle: false, step: Math.random() * 10,
      orbit: Math.random() * Math.PI * 2, orbitDir: Math.random() < 0.5 ? -1 : 1, bob: Math.random() * 10,
      // combat
      blockT: 0, windup: null, strikeT: 0, downT: 0, cdT: 3 + Math.random() * 5,
      burnT: 0, chargeT: 0, labelT: 0,
    };
    group.position.copy(pos);
    this.ctx.scene.add(group);
    this.list.push(e);
    return e;
  }

  makeThug(x, z, brute = false) {
    const type = brute ? 'brute' : 'thug';
    const rig = createRig(type, { preferModel: this.ctx.useModels !== false });
    if (!rig.procedural && !brute) attachGun(rig);
    const pick = (a) => a[(Math.random() * a.length) | 0];
    // Palette: jacket, pants, skin, hat, dark, shirt
    rig.paint(brute
      ? ['#4a1f5c', '#2a2630', pick(SKINS), '#000', '#141414', '#3a1748']
      : [pick(JACKETS), pick(PANTS), pick(SKINS), pick(HATS), '#151515', pick(SHIRTS)]);
    const g = rig.root;
    g.scale.setScalar(STATS[type].scale);
    const e = this.base(type, g, new THREE.Vector3(x, 0, z), rig.material);
    e.rig = rig;
    e.shield = new THREE.Mesh(geo.shield, mats.shield);
    e.shield.position.y = 1.1;
    e.shield.visible = false;
    e.icon = new THREE.Sprite(icons.hay);
    e.icon.position.y = 2.5;
    e.icon.scale.setScalar(0.7);
    e.icon.visible = false;
    g.add(e.shield, e.icon);
    return e;
  }

  makeDrone(x, y, z) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: '#8a9099', roughness: 0.3, metalness: 0.7, emissive: WHITE, emissiveIntensity: 0 });
    const body = new THREE.Mesh(geo.droneBody, mat);
    const ring = new THREE.Mesh(geo.droneRing, mats.ring);
    const eye = new THREE.Mesh(geo.droneEye, mats.eye);
    body.castShadow = ring.castShadow = true;
    g.add(body, ring, eye);
    const e = this.base('drone', g, new THREE.Vector3(x, y, z), mat);
    e.ring = ring;
    return e;
  }

  center(e, out) {
    out.copy(e.pos);
    out.y += e.cy;
    return out;
  }

  // Distance from p to an enemy: to its centre, or for the kaiju to the surface of its nearest
  // body part (it's far too big for a single point).
  reach(e, p) {
    if (!e.spheres) return this.center(e, _t).distanceTo(p);
    let best = Infinity;
    for (const s of e.spheres) best = Math.min(best, s.c.distanceTo(p) - s.r);
    return Math.max(0, best);
  }

  remove(i) {
    const e = this.list[i];
    this.ctx.scene.remove(e.group);
    e.mat.dispose();
    this.list.splice(i, 1);
  }

  manageSpawns() {
    const p = this.ctx.player.pos;
    let thugs = 0, drones = 0, brutes = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.boss) continue; // the kaiju has its own spawner
      if (Math.hypot(e.pos.x - p.x, e.pos.z - p.z) > DESPAWN) {
        this.remove(i);
        continue;
      }
      if (e.dead) continue;
      if (e.type === 'thug') thugs++;
      else if (e.type === 'brute') brutes++;
      else drones++;
    }
    if (thugs < MAX_THUGS) {
      const pt = this.ctx.city.randomStreetPoint(p.x, p.z, 60, 200);
      if (pt) {
        const n = 2 + ((Math.random() * 3) | 0);
        for (let k = 0; k < n; k++) this.makeThug(pt.x + (Math.random() - 0.5) * 6, pt.z + (Math.random() - 0.5) * 6);
        if (brutes < MAX_BRUTES && Math.random() < 0.3) this.makeThug(pt.x, pt.z, true);
      }
    }
    if (drones < MAX_DRONES && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, d = 120 + Math.random() * 80;
      this.makeDrone(p.x + Math.cos(a) * d, Math.max(25, p.y + 15), p.z + Math.sin(a) * d);
    }
  }

  update(dt) {
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 1;
      this.manageSpawns();
    }
    const fx = this.ctx.fx;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.boss) {
        if (e.dead) {
          if (e.boss.updateDead(dt)) this.remove(i);
          continue;
        }
        e.boss.update(dt);
      } else if (e.dead) {
        if (this.updateDead(e, dt)) this.remove(i);
        continue;
      } else if (e.type === 'drone') this.updateDrone(e, dt);
      else this.updateThug(e, dt);
      if (e.dead) continue;

      if (!e.boss) e.flash = Math.max(0, e.flash - dt * 6);
      let col = WHITE, inten = e.flash * 0.9;
      if (e.windup) {
        col = e.windup.kind === 'hay' ? RED : ORANGE;
        inten = Math.max(inten, 0.6 + 0.4 * Math.sin(e.windup.t * 25));
      }
      if (!e.boss) {
        e.mat.emissive.setHex(col);
        e.mat.emissiveIntensity = inten;
      }

      this.center(e, _v);
      if (e.stun > 0) {
        e.stun -= dt;
        if (Math.random() < dt * 15) fx.burst(_v, 4, { speed: 5, life: 0.3, size: 0.4, size1: 0.05, c0: [0.8, 0.95, 1], c1: [0.1, 0.4, 1] });
      }
      // Status effects (power interaction setup)
      if (e.burnT > 0) {
        e.burnT -= dt;
        if (Math.random() < dt * 25) {
          fx.spawn(_v.x + (Math.random() - 0.5) * 0.6, _v.y + (Math.random() - 0.5) * 1.2, _v.z + (Math.random() - 0.5) * 0.6,
            0, 2, 0, 0.5, 0.7, 0.2, [1, 0.8, 0.3], [0.8, 0.1, 0], 3, 0);
        }
        this.damage(e, 8 * dt, { type: 'dot' });
      }
      if (e.chargeT > 0) {
        e.chargeT -= dt;
        if (Math.random() < dt * 10) fx.burst(_v, 2, { speed: 6, life: 0.2, size: 0.35, c0: [0.8, 0.95, 1], c1: [0.2, 0.5, 1] });
      }
      e.labelT -= dt;
      e.numT -= dt;
      if (e.pending >= 1 && e.numT <= 0) this.flushDamage(e);
    }
    this.updateBullets(dt);
  }

  flushDamage(e) {
    if (e.pending >= 1) this.ctx.hud.damageNumber(this.center(e, _t), Math.round(e.pending));
    e.pending = 0;
    e.numT = 0.25;
  }

  label(e, text, cls) {
    if (e.labelT > 0) return;
    e.labelT = 0.5;
    this.ctx.hud.damageNumber(this.center(e, _t).setY(_t.y + 0.8), text, cls);
  }

  updateThug(e, dt) {
    const { player, world, combat } = this.ctx;
    const S = e.stats;
    _v.subVectors(player.pos, e.pos);
    const dist = _v.length(), hd = Math.hypot(_v.x, _v.z) || 1;
    const aggro = !player.dead && dist < 75;
    let tx = 0, tz = 0, spd = 0;
    e.cdT -= dt;
    e.knockT -= dt;
    if (e.downT > 0) e.downT -= dt;
    if (e.strikeT > 0) {
      e.strikeT -= dt;
      if (e.strikeT <= 0) this.resolveLunge(e);
    }
    const control = e.stun <= 0 && e.knockT <= 0 && e.downT <= 0;
    if (!control && e.windup) this.cancelWindup(e);
    if (control) {
      if (aggro) {
        e.facing = Math.atan2(-_v.x, -_v.z);
        if (e.windup) this.updateWindup(e, dt, hd);
        else if (e.blockT > 0) e.blockT -= dt;
        else if (hd < 18 && combat.sinceAttack < 0.4 && Math.random() < dt * S.blockRate) e.blockT = 1.2 + Math.random() * 1.6;
        else if (e.cdT <= 0) this.chooseSpecial(e, hd);
        if (!e.windup && e.blockT <= 0) {
          if (hd > S.keep) { tx = _v.x / hd; tz = _v.z / hd; spd = S.speed; }
          else if (S.shoots && hd < 8) { tx = -_v.x / hd; tz = -_v.z / hd; spd = 3; }
          if (S.shoots) {
            e.shootT -= dt;
            if (e.shootT <= 0 && dist < 65) {
              e.shootT = 1.1 + Math.random() * 1.4;
              this.fire(e, 55, 7, mats.bulletThug);
            }
          }
        }
      } else {
        e.blockT = 0;
        e.wanderT -= dt;
        if (e.wanderT <= 0) {
          e.wanderT = 2 + Math.random() * 4;
          e.wander = Math.random() * Math.PI * 2;
          e.idle = Math.random() < 0.4;
        }
        if (!e.idle) {
          tx = -Math.sin(e.wander);
          tz = -Math.cos(e.wander);
          spd = 1.6;
          e.facing = e.wander;
        }
      }
    }
    if (control) {
      const a = 1 - Math.exp(-(e.grounded ? 8 : 0.5) * dt);
      e.vel.x += (tx * spd - e.vel.x) * a;
      e.vel.z += (tz * spd - e.vel.z) * a;
    } else if (e.grounded && e.strikeT <= 0) {
      const f = 1 - Math.min(1, 3 * dt);
      e.vel.x *= f;
      e.vel.z *= f;
    }
    e.vel.y -= 30 * dt;
    const steps = Math.max(1, Math.ceil((e.vel.length() * dt) / 0.5));
    e.grounded = false;
    for (let s = 0; s < steps; s++) {
      e.pos.addScaledVector(e.vel, dt / steps);
      const r = world.resolve(e.pos, S.colR, S.colH, e.vel, dt / steps, 1.6);
      if (r.ground) e.grounded = true;
      if (r.wall && !aggro) e.wanderT = 0;
    }
    const hsp = Math.hypot(e.vel.x, e.vel.z);
    e.step += (hsp * dt * 1.6) / S.scale;
    e.group.position.copy(e.pos);
    e.group.rotation.y = lerpAngle(e.group.rotation.y, e.facing, 1 - Math.exp(-10 * dt));
    const lean = e.downT > 0 ? -1.45 : e.knockT > 0 && !e.grounded && e.strikeT <= 0 ? -1.2 : 0;
    e.group.rotation.x += (lean - e.group.rotation.x) * (1 - Math.exp(-10 * dt));
    e.shield.visible = e.blockT > 0;
    e.icon.visible = !!e.windup;
    this.poseThug(e, hsp, aggro, Math.atan2(player.pos.y - e.pos.y, hd), dt);
  }

  poseThug(e, hsp, aggro, aimPitch, dt) {
    const brute = e.type === 'brute';
    let p = hsp > 0.5 ? stride(e.step, Math.min(1, 0.35 + hsp * 0.1), 0.4) : { spread: 0.1 };
    // Model rigs walk with clips; specials/blocks/knockdowns take over the whole body,
    // and aiming takes over just the gun arm.
    let loco = { clip: hsp > 4 ? 'run' : hsp > 0.5 ? 'walk' : 'idle', speed: hsp / e.stats.scale, mask: null };
    if (e.downT > 0 || e.stun > 0 || e.blockT > 0 || e.windup || e.strikeT > 0 || !e.grounded) loco = null;
    else if (aggro) loco.mask = brute ? 'arms' : 'armR';
    if (e.downT > 0 || e.stun > 0) p = { sL: 0.2, sR: 0.2, eL: 0.4, eR: 0.4, spread: 0.4 };
    else if (e.blockT > 0) Object.assign(p, { sL: 1.4, sR: 1.4, eL: 1.8, eR: 1.8, spread: -0.2 });
    else if (e.windup?.kind === 'hay') Object.assign(p, { sR: -0.9, eR: 1.7, sL: 1.0, eL: 1.3, tilt: 0.15, hL: 0.4, kL: -0.4 });
    else if (e.windup?.kind === 'bb') {
      Object.assign(p, brute
        ? { sL: 2.9, sR: 2.9, eL: 0.4, eR: 0.4, tilt: 0.2, kL: -0.5, kR: -0.5 } // overhead slam
        : { sR: 1.5 + aimPitch, eR: 0, sL: 1.4 + aimPitch, eL: 0.3, tilt: -0.1, kL: -0.4, kR: -0.4 }); // braced charge shot
    } else if (e.strikeT > 0) Object.assign(p, { sR: 1.6, eR: 0, tilt: -0.3 });
    else if (aggro && brute) Object.assign(p, { sL: 0.9, eL: 1.6, sR: 0.9, eR: 1.6 }); // fists up
    else if (aggro) Object.assign(p, { sR: 1.5 + clamp(aimPitch, -0.8, 1.4), eR: 0.05, sL: 0.4, eL: 0.9 }); // aim the pistol
    e.rig.pose(p, 1 - Math.exp(-12 * dt), dt, loco);
  }

  chooseSpecial(e, hd) {
    const S = e.stats;
    if (hd < S.hayRange && (hd > S.bbRange || Math.random() < 0.55)) this.startWindup(e, 'hay');
    else if (hd < S.bbRange) this.startWindup(e, 'bb');
    e.cdT = S.cd + Math.random() * S.cd;
  }

  startWindup(e, kind) {
    e.windup = { kind, t: 0, dur: kind === 'hay' ? e.stats.hayWind : e.stats.bbWind };
    e.icon.material = icons[kind];
  }

  cancelWindup(e) {
    e.windup = null;
    e.icon.visible = false;
  }

  updateWindup(e, dt, hd) {
    const w = e.windup;
    w.t += dt;
    if (w.t < w.dur) return;
    this.cancelWindup(e);
    const S = e.stats, { player, fx } = this.ctx;
    if (w.kind === 'hay') {
      // Lunge at the player; the hit lands when the lunge arrives.
      _w.subVectors(player.pos, e.pos).setY(0).normalize();
      e.vel.x = _w.x * S.hayLunge;
      e.vel.z = _w.z * S.hayLunge;
      e.strikeT = clamp((hd - 1.5) / S.hayLunge, 0.12, 0.6);
      e.knockT = e.strikeT;
    } else if (e.type === 'brute') {
      // Ground slam: area block breaker
      fx.ring(e.pos, ORANGE, S.slam, 0.35);
      fx.burst(_w.copy(e.pos).setY(e.pos.y + 0.4), 50, { speed: 14, life: 0.5, size: 1.4, c0: [0.8, 0.7, 0.55], c1: [0.3, 0.25, 0.2], drag: 3 });
      fx.flash(e.pos, 0xff8a30, 900, 30, 0.25);
      if (Math.hypot(player.pos.x - e.pos.x, player.pos.z - e.pos.z) < S.slam && Math.abs(player.pos.y - e.pos.y) < 4) {
        player.takeDamage(S.bbDmg, 'bb');
        player.shake(0.5, 0.3);
      } else player.shake(0.15, 0.2);
    } else {
      this.fire(e, 40, S.bbDmg, mats.bulletBB, 'bb', 2.5);
    }
  }

  resolveLunge(e) {
    const { player, fx } = this.ctx;
    const S = e.stats;
    e.vel.x *= 0.2;
    e.vel.z *= 0.2;
    if (e.dead || e.downT > 0) return;
    const d = Math.hypot(player.pos.x - e.pos.x, player.pos.z - e.pos.z);
    if (d > S.hayReach || Math.abs(player.pos.y - e.pos.y) > 3) return;
    const r = player.takeDamage(S.hayDmg, 'interrupt');
    if (r === 'countered') this.counter(e, 'COUNTER!');
    else if (r === 'hit') {
      _w.copy(player.pos);
      _w.y += 1.2;
      fx.burst(_w, 20, { speed: 9, life: 0.35, size: 0.7, c0: [1, 0.5, 0.4], c1: [0.6, 0, 0] });
      player.shake(0.4, 0.25);
    }
  }

  // The enemy lost the counter exchange: knocked down, player gets brief immunity.
  counter(e, text) {
    const { player, hud, fx, combat } = this.ctx;
    this.cancelWindup(e);
    e.blockT = 0;
    e.strikeT = 0;
    e.downT = e.stats.down;
    _w.subVectors(e.pos, player.pos).setY(0).normalize().multiplyScalar(8 * e.stats.mass + 2);
    e.vel.add(_w);
    e.vel.y += 6 * e.stats.mass + 2;
    player.immuneT = Math.max(player.immuneT, 1.0);
    hud.callout(text, 'good');
    combat.hitstop(0.1);
    this.center(e, _w);
    fx.burst(_w, 40, { speed: 12, life: 0.45, size: 0.8, c0: [1, 0.95, 0.6], c1: [1, 0.6, 0.1] });
    fx.ring(e.pos, 0xffe080, 4, 0.3);
    fx.flash(_w, 0xffe0a0, 600, 20, 0.2);
    player.shake(0.3, 0.2);
  }

  updateDrone(e, dt) {
    const { player, world } = this.ctx;
    _v.subVectors(player.pos, e.pos);
    const dist = _v.length();
    const aggro = !player.dead && dist < 130;
    e.bob += dt;
    if (e.stun > 0 || e.knockT > 0) {
      e.vel.multiplyScalar(1 - Math.min(1, 2 * dt));
      if (e.stun > 0) e.vel.y -= 6 * dt;
    } else {
      if (aggro) {
        e.orbit += dt * 0.35 * e.orbitDir;
        _w.set(player.pos.x + Math.cos(e.orbit) * 26, player.pos.y + 9 + Math.sin(e.bob * 1.3) * 2, player.pos.z + Math.sin(e.orbit) * 26);
        e.shootT -= dt;
        if (e.shootT <= 0 && dist < 75) {
          e.shootT = 1.4 + Math.random();
          this.fire(e, 70, 10, mats.bulletDrone);
        }
      } else {
        _w.copy(e.pos);
        _w.y += Math.sin(e.bob) * 0.5;
      }
      _u.subVectors(_w, e.pos).multiplyScalar(1.2);
      if (_u.length() > 22) _u.setLength(22);
      e.vel.lerp(_u, 1 - Math.exp(-2 * dt));
    }
    e.knockT -= dt;
    e.pos.addScaledVector(e.vel, dt);
    _w.copy(e.pos);
    _w.y -= 0.6;
    world.resolve(_w, 0.8, 1.2, e.vel, dt, 0);
    _w.y += 0.6;
    e.pos.copy(_w);
    e.group.position.copy(e.pos);
    if (aggro) e.group.rotation.y = Math.atan2(-_v.x, -_v.z);
    e.ring.rotation.z = Math.sin(e.bob * 2) * 0.2;
  }

  updateDead(e, dt) {
    e.deathT -= dt;
    e.vel.y -= 25 * dt;
    e.pos.addScaledVector(e.vel, dt);
    const r = this.ctx.world.resolve(e.pos, 0.3, 1, e.vel, dt, 0.5);
    if (r.ground) {
      e.vel.x *= 0.9;
      e.vel.z *= 0.9;
      e.spin *= 0.9;
      if (e.type === 'drone' && !e.boom) {
        e.boom = true;
        e.deathT = Math.min(e.deathT, 0.3);
        this.ctx.fx.burst(e.pos, 50, { speed: 14, life: 0.6, size: 1.6, c0: [1, 0.8, 0.4], c1: [0.6, 0.1, 0] });
        this.ctx.fx.flash(e.pos, 0xff8040, 500, 30, 0.3);
      }
    }
    e.group.position.copy(e.pos);
    e.group.rotation.x += e.spin * dt;
    const s = e.type === 'drone' ? 1 : e.stats.scale;
    if (e.deathT < 0.5) e.group.scale.setScalar(s * Math.max(0.01, e.deathT / 0.5));
    return e.deathT <= 0;
  }

  muzzle(e, out) {
    if (e.rig) {
      e.group.updateMatrixWorld(true);
      return e.rig.arms[1].hand.getWorldPosition(out);
    }
    return out.set(0, 0, -0.7).applyAxisAngle(UP, e.group.rotation.y).add(e.pos);
  }

  fire(e, speed, dmg, mat, kind = 'normal', scale = 1) {
    const { player, scene, fx } = this.ctx;
    const from = this.muzzle(e, new THREE.Vector3());
    const to = _w.copy(player.pos);
    to.y += 1.2;
    const d = from.distanceTo(to);
    to.x += (Math.random() - 0.5) * d * 0.06;
    to.y += (Math.random() - 0.5) * d * 0.06;
    to.z += (Math.random() - 0.5) * d * 0.06;
    const dir = to.sub(from).normalize();
    const mesh = new THREE.Mesh(geo.bullet, mat);
    mesh.position.copy(from);
    mesh.scale.set(scale, scale, 5 * scale);
    mesh.lookAt(_u.copy(from).add(dir));
    scene.add(mesh);
    this.bullets.push({ pos: from, vel: dir.clone().multiplyScalar(speed), life: 2.5, dmg, mesh, kind });
    const c = mat === mats.bulletDrone ? [1, 0.3, 0.3] : [1, 0.85, 0.4];
    fx.spawn(from.x, from.y, from.z, 0, 0, 0, 0.08, 0.8 * scale, 0.3, c, c);
  }

  updateBullets(dt) {
    const { player, world, scene, fx } = this.ctx;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      const len = b.vel.length() * dt;
      _u.copy(b.vel).normalize();
      const t = world.raycast(b.pos, _u, len);
      _v.copy(player.pos);
      _v.y += 1.1;
      const proj = clamp(_w.subVectors(_v, b.pos).dot(_u), 0, t);
      const miss = _w.copy(b.pos).addScaledVector(_u, proj).distanceTo(_v);
      let done = false;
      if (!player.dead && miss < (b.kind === 'bb' ? 1.3 : 0.9)) {
        const r = player.takeDamage(b.dmg, b.kind);
        if (r !== 'ignored') {
          const c = r === 'blocked' ? [0.5, 0.8, 1] : [1, 0.6, 0.3];
          fx.burst(_v, 8, { speed: 6, life: 0.25, size: 0.4, c0: c });
          done = true;
        }
      }
      if (!done && (t < len || b.life <= 0)) {
        b.pos.addScaledVector(_u, t);
        fx.burst(b.pos, 5, { speed: 5, life: 0.2, size: 0.3, c0: [1, 0.85, 0.5] });
        done = true;
      }
      if (done) {
        scene.remove(b.mesh);
        this.bullets.splice(i, 1);
        continue;
      }
      b.pos.addScaledVector(_u, len);
      b.mesh.position.copy(b.pos);
    }
  }

  // ------------------------------------------------------------ damage API used by powers & combat
  damage(e, amt, opts = {}) {
    if (e.dead) return 0;
    const type = opts.type || 'tap';
    // Counter triangle
    if (type === 'interrupt' && e.windup?.kind === 'bb') {
      this.counter(e, 'INTERRUPT!');
      amt *= 1.5;
    } else if (e.blockT > 0 && type !== 'dot') {
      if (type === 'bb') {
        this.counter(e, 'BLOCK BROKEN!');
        amt *= 1.5;
      } else {
        amt *= type === 'power' ? 0.5 : 0.15;
        this.label(e, 'BLOCKED', 'blocked');
      }
    }
    // Power interactions: exploit a status set up by an earlier attack
    if (opts.exploit === 'burn' && e.burnT > 0) {
      amt *= 1.6;
      this.label(e, 'BURNING +60%', 'pi-fire');
    }
    if (opts.exploit === 'charge' && e.chargeT > 0) {
      amt *= 1.6;
      e.chargeT = 0;
      this.label(e, 'OVERLOAD +60%', 'pi-elec');
      this.ctx.fx.burst(this.center(e, _t), 25, { speed: 12, life: 0.35, size: 0.6, c0: [0.85, 0.97, 1], c1: [0.15, 0.45, 1] });
    }
    if (opts.burn) e.burnT = Math.max(e.burnT, opts.burn);
    if (opts.charge) e.chargeT = Math.max(e.chargeT, opts.charge);

    e.hp -= amt;
    e.pending += amt;
    if (type !== 'dot') e.flash = 1;
    this.ctx.player.addSuper(amt * 0.1);
    this.ctx.combat.onHit(type);
    if (opts.stun) e.stun = Math.max(e.stun, opts.stun);
    if (opts.knock) {
      e.vel.addScaledVector(opts.knock, e.stats.mass);
      if (opts.knock.lengthSq() * e.stats.mass > 9) e.knockT = Math.max(e.knockT, 0.5);
    }
    if (e.hp <= 0) this.kill(e);
    return amt;
  }

  kill(e) {
    e.dead = true;
    e.deathT = 2;
    if (e.boss) {
      this.flushDamage(e);
      e.mat.emissiveIntensity = 0;
    }
    e.spin = (Math.random() - 0.5) * 14;
    e.vel.y += 6;
    e.mat.emissiveIntensity = 0;
    if (e.shield) e.shield.visible = e.icon.visible = false;
    this.flushDamage(e);
    this.score += e.boss ? 25 : e.type === 'brute' ? 5 : 1;
    this.ctx.hud.setScore(this.score);
    this.ctx.player.addSuper(e.type === 'brute' ? 20 : 4);
    if (e.boss) return;
  }

  damageRadius(c, r, amt, knock, stun, opts = {}) {
    for (const e of this.list) {
      if (e.dead || e === opts.skip || (e.boss && opts.noBoss)) continue;
      this.center(e, _v);
      const d = e.spheres ? this.reach(e, c) : _v.distanceTo(c);
      if (d > r + (e.spheres ? 0 : e.r)) continue;
      const f = 1 - 0.5 * Math.min(1, d / r);
      _w.subVectors(_v, c);
      _w.y = Math.max(_w.y, 0);
      if (_w.lengthSq() < 1e-6) _w.set(0, 1, 0);
      _w.normalize();
      _w.y += 0.6;
      _w.normalize().multiplyScalar(knock * f);
      this.damage(e, amt * f, { ...opts, skip: undefined, noBoss: undefined, knock: _w.clone(), stun }); // clone: counter() reuses _w
    }
    this.ctx.traffic?.damageRadius(c, r, amt, knock); // area attacks also wreck cars
    if (knock > 3) this.ctx.props?.damageRadius(c, r, knock); // ...and smash trees, benches, hydrants
  }

  // Nearest enemy hit by a moving sphere from o along unit d within len.
  sweep(o, d, len, rad) {
    let best = null, bt = len;
    for (const e of this.list) {
      if (e.dead) continue;
      const parts = e.spheres || [{ c: this.center(e, _u), r: e.r }];
      for (const s of parts) {
        _w.subVectors(s.c, o);
        const tc = _w.dot(d), R = s.r + rad;
        const d2 = _w.lengthSq() - tc * tc;
        if (d2 > R * R) continue;
        const th = Math.sqrt(R * R - d2);
        let t = tc - th;
        if (t < 0) t = tc + th < 0 ? -1 : 0;
        if (t < 0 || t > bt) continue;
        bt = t;
        best = e;
      }
    }
    return best ? { enemy: best, t: bt } : null;
  }

  // Enemy closest to the aim ray within a cone, with line of sight.
  findTarget(o, d, maxDist, cosCone) {
    let best = null, bestCos = cosCone;
    for (const e of this.list) {
      if (e.dead) continue;
      this.center(e, _v);
      _w.subVectors(_v, o);
      const dist = _w.length();
      if (dist > maxDist || dist < 0.5) continue;
      const c = _w.dot(d) / dist;
      if (c <= bestCos) continue;
      _w.divideScalar(dist);
      if (this.ctx.world.raycast(o, _w, dist) < dist - 1.2) continue;
      bestCos = c;
      best = e;
    }
    return best;
  }

  // Closest enemy within range inside a cone around dir (melee lock-on).
  meleeTarget(o, d, range, cosA) {
    let best = null, bd = range;
    for (const e of this.list) {
      if (e.dead) continue;
      _w.subVectors(this.center(e, _v), o);
      const dist = e.spheres ? this.reach(e, o) : _w.length();
      if (dist > bd || (!e.spheres && dist < 0.01)) continue;
      if (!e.spheres && _w.dot(d) / dist < cosA && dist > 2) continue;
      bd = dist;
      best = e;
    }
    return best;
  }

  nearest(p, r, exclude = []) {
    let best = null, bd = r;
    for (const e of this.list) {
      if (e.dead || exclude.includes(e)) continue;
      const d = this.reach(e, p);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  inRadius(p, r) {
    return this.list.filter((e) => !e.dead && this.reach(e, p) < r + (e.spheres ? 0 : e.r));
  }

  cone(o, d, range, cosA, fn) {
    for (const e of this.list) {
      if (e.dead) continue;
      _u.subVectors(this.center(e, _v), o);
      const dist = _u.length();
      if (dist > range || dist < 0.01) continue;
      if (_u.dot(d) / dist > cosA) fn(e);
    }
  }
}
