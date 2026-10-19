import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';
import { stride } from './humanoid.js';
import { createRig } from './models.js';

// Color presets per power. A "look" holds 4 colors (like DCUO's color palette),
// plus body type, head style, emblem and cape.
export const PRESETS = {
  fire: { suit: '#7d1a12', trim: '#1b1a1f', cape: '#c43d0c', glow: '#ffae42' },
  electric: { suit: '#1a3a8a', trim: '#14151b', cape: '#13214a', glow: '#7fe3ff' },
};
export const DEFAULT_LOOK = {
  name: 'Guardian', body: 'average', head: 'cowl', emblem: 'flame', cape: true,
  pattern: 'panels', lines: true, skin: '#c98d6b', ...PRESETS.fire,
};
const BODY = { slim: [0.9, 0.98], average: [1, 1], muscular: [1.14, 1.02], large: [1.3, 1.05] };
const TRAILS = { fire: [[1, 0.75, 0.3], [0.8, 0.1, 0]], electric: [[0.75, 0.95, 1], [0.1, 0.3, 1]] };

const SENS = 0.0022;
const FLY_SPEED = 30, FLY_BOOST = 90;
const RUN_SPEED = 13, SUPER_SPEED = FLY_BOOST * 1.3; // super speed tops flight by 30%
const GRAVITY = 34;
const BLOCK_MOVE = 0.3; // movement speed multiplier while blocking
const BREAKOUT_CD = 6;
// Dodge: while blocking (hold Left Ctrl), tap a direction. Short burst with invulnerability, then a cooldown.
// A tap during the cooldown is buffered briefly so chained dodges don't get dropped.
const DODGE_TIME = 0.3, DODGE_CD = 0.7, DODGE_BUFFER = 0.25;
const DODGE_SPEED = { flight: 55, speed: 70 };
const WALL_BREAK_SPEED = 250 / 3.6; // m/s into a wall needed to smash through it (250 km/h)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export function drawEmblem(canvas, shape, fill, stroke) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.save();
  g.translate(64, 64);
  g.fillStyle = fill;
  g.strokeStyle = stroke;
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.beginPath();
  const poly = (pts) => pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (shape === 'flame') {
    g.moveTo(0, -56);
    g.bezierCurveTo(44, -8, 40, 44, 0, 54);
    g.bezierCurveTo(-40, 44, -44, -8, 0, -56);
  } else if (shape === 'bolt') {
    poly([[12, -58], [-32, 6], [-4, 6], [-14, 58], [32, -10], [4, -10], [20, -58]]);
  } else if (shape === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 24 : 56, a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    poly(pts);
  } else if (shape === 'diamond') {
    poly([[0, -58], [50, 0], [0, 58], [-50, 0]]);
  } else {
    g.arc(0, 0, 50, 0, Math.PI * 2);
  }
  g.closePath();
  g.fill();
  g.stroke();
  if (shape === 'diamond' || shape === 'atom') {
    g.fillStyle = stroke;
    g.beginPath();
    if (shape === 'diamond') poly([[0, -26], [22, 0], [0, 26], [-22, 0]]);
    else g.arc(0, 0, 18, 0, Math.PI * 2);
    g.closePath();
    g.fill();
  }
  g.restore();
}

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.spawn = ctx.city.spawn.clone();
    this.pos = this.spawn.clone();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.05;
    this.facing = 0;
    this.movement = 'flight';
    this.theme = 'fire';
    this.grounded = true;
    this.jumps = 0;
    this.wallRun = false;
    this.wallContact = 0;
    this.wallN = new THREE.Vector2();
    this.radius = 0.45;
    this.height = 2.0;
    this.maxHp = 300;
    this.hp = this.maxHp;
    this.maxPower = 100;
    this.power = this.maxPower;
    this.super = 0;
    this.dead = false;
    this.respawnT = 0;
    this.sinceHurt = 10;
    this.castT = 0;
    this.camDist = 7;
    this.curDist = 7;
    this.shakeT = 0;
    this.shakeDur = 1;
    this.shakeAmt = 0;
    this.anim = 0;
    this.speed = 0;
    this.dodgeT = 0;
    this.dodgeCd = 0;
    this.dodgeBuf = { f: 0, s: 0, t: 0 };
    this.dodgeDir = new THREE.Vector3();
    this.dodgeKind = 'roll';
    this.dodgeSign = 1;
    this.path = []; // recent positions while sprinting (lightning trail)
    this.pathT = 0;
    this.stepT = 0; // foot smoke cadence
    // Combat state
    this.blocking = false;
    this.downT = 0; // knocked down
    this.fall = 0; // 0..1 knockdown pose blend
    this.breakoutCd = 0;
    this.boHeld = 0;
    this.immuneT = 0; // brief immunity after a successful counter / breakout
    this.lungeT = 0;
    this.lungeVel = new THREE.Vector3();
    this.atk = null;
    this.shieldT = 0;
    this.build();
    this.applyLook(DEFAULT_LOOK);
    ctx.scene.add(this.root);
  }

  build() {
    const rig = (this.rig = createRig('hero'));
    this.root = rig.root;
    this.spin = rig.spin; // pivot at hip height for dodge rolls/flips and knockdowns
    this.body = rig.body;
    this.heads = rig.heads;

    this.emblemCanvas = document.createElement('canvas');
    this.emblemCanvas.width = this.emblemCanvas.height = 128;
    this.emblemTex = new THREE.CanvasTexture(this.emblemCanvas);
    this.emblemTex.colorSpace = THREE.SRGBColorSpace;
    const emblem = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17),
      new THREE.MeshBasicMaterial({ map: this.emblemTex, transparent: true, toneMapped: false }));
    emblem.position.set(0, rig.chest.y, rig.chest.z);
    emblem.rotation.y = Math.PI;
    this.body.add(emblem);

    // Cape flares from the shoulders toward the hem.
    const capeGeo = new THREE.PlaneGeometry(0.5, 1.15, 4, 10).translate(0, -0.575, 0);
    const cp = capeGeo.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setX(i, cp.getX(i) * (1 + (-cp.getY(i) / 1.15) * 0.35));
    this.capeRest = cp.array.slice();
    this.capeMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.65, metalness: 0.05 });
    this.cape = new THREE.Mesh(capeGeo, this.capeMat);
    this.cape.position.set(0, rig.capeAnchor.y, rig.capeAnchor.z);
    this.cape.castShadow = true;
    this.body.add(this.cape);

    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1.25, 24, 16), new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.shield.position.y = 1.0;
    this.shield.visible = false;
    this.root.add(this.shield);
  }

  applyLook(look) {
    this.look = { ...DEFAULT_LOOK, ...look };
    const L = this.look, rig = this.rig;
    rig.paint([L.suit, L.trim, L.skin, '#2b1d14', '#151518', L.cape], L);
    if (rig.glowMat) {
      rig.glowMat.color.set(L.glow);
      rig.glowMat.emissive.set(L.glow);
    }
    for (const m of rig.lines) m.visible = !!L.lines;
    this.capeMat.color.set(L.cape);
    this.shield.material.color.set(L.glow);
    drawEmblem(this.emblemCanvas, L.emblem, L.glow, L.trim);
    this.emblemTex.needsUpdate = true;
    for (const [k, g] of Object.entries(this.heads)) g.visible = k === L.head;
    this.cape.visible = !!L.cape;
    const [w, h] = BODY[L.body] || BODY.average;
    this.body.scale.set(w, h, w);
  }

  setTheme(name) {
    this.theme = name; // drives trail and impact colors; the costume colors come from the look
  }

  trailColors() {
    return TRAILS[this.theme];
  }

  glowColor() {
    return this.look.glow;
  }

  // Power interaction setup from melee finishers: fire burns, electricity charges.
  meleeStatus(move) {
    if (move !== 'finisher' && move !== 'uppercut') return {};
    return this.theme === 'fire' ? { burn: 3 } : { charge: 4 };
  }

  setMovement(m) {
    this.movement = m;
    this.wallRun = false;
  }

  cast() { this.castT = 0.6; }
  addSuper(a) { this.super = Math.min(100, this.super + a); }

  attack(kind, dur, facing, side = 1) {
    this.atk = { kind, dur, t: 0, facing, side };
  }

  lunge(dir, speed, t) {
    this.lungeVel.copy(dir).multiplyScalar(Math.min(speed, 80));
    this.lungeT = t;
    this.wallRun = false;
  }

  shake(amount, dur) {
    if (this.shakeAmt * Math.max(0, this.shakeT / this.shakeDur) > amount) return; // keep a stronger shake
    this.shakeAmt = amount;
    this.shakeT = this.shakeDur = dur;
  }

  getHandPos(out) {
    return this.rig.arms[1].hand.getWorldPosition(out);
  }

  get invulnerable() {
    return this.dodgeT > 0 || this.immuneT > 0;
  }

  // kind: 'normal' | 'interrupt' (lunging hit: blocked = countered) | 'bb' (block breaker)
  // Returns 'ignored' | 'blocked' | 'countered' | 'broken' | 'hit'.
  takeDamage(a, kind = 'normal') {
    if (this.dead || this.invulnerable) return 'ignored';
    if (this.blocking) {
      if (kind === 'bb') {
        this.hurt(a);
        this.knockdown(1.6, 'BLOCK BROKEN');
        return 'broken';
      }
      this.shieldT = 0.2;
      if (kind === 'interrupt') return 'countered';
      this.hurt(a * 0.2);
      return 'blocked';
    }
    this.hurt(a);
    if (kind === 'interrupt' && !this.dead) this.knockdown(1.3, 'KNOCKED DOWN');
    return 'hit';
  }

  hurt(a) {
    this.hp -= a;
    this.sinceHurt = 0;
    this.ctx.hud.hurt();
    if (this.hp <= 0) this.die();
  }

  knockdown(t, label) {
    if (this.downT > 0 || this.dead) return;
    this.downT = t;
    this.boHeld = 0;
    this.blocking = false;
    this.lungeT = 0;
    this.atk = null;
    this.vel.y = Math.max(this.vel.y, 6);
    this.ctx.hud.callout(this.breakoutCd <= 0 ? `${label} · HOLD CTRL TO BREAK OUT` : label, 'bad');
  }

  breakout() {
    this.downT = 0;
    this.boHeld = 0;
    this.breakoutCd = BREAKOUT_CD;
    this.immuneT = 0.8;
    const [c0, c1] = this.trailColors();
    _v.copy(this.pos);
    _v.y += 1;
    this.ctx.fx.burst(_v, 50, { speed: 12, life: 0.5, size: 0.8, c0, c1 });
    this.ctx.fx.ring(this.pos, this.look.glow, 6, 0.35);
    this.ctx.hud.callout('BREAKOUT', 'good');
  }

  die() {
    this.hp = 0;
    this.dead = true;
    this.downT = 0;
    this.respawnT = 4;
    this.root.visible = false;
    const c = _v.copy(this.pos);
    c.y += 1;
    const [c0, c1] = this.trailColors();
    this.ctx.fx.burst(c, 120, { speed: 14, life: 1, size: 1.2, c0, c1 });
    this.ctx.hud.message('DEFEATED', 3.5);
  }

  respawn() {
    this.dead = false;
    this.hp = this.maxHp;
    this.power = this.maxPower;
    this.pos.copy(this.spawn);
    this.vel.set(0, 0, 0);
    this.root.visible = true;
    this.ctx.hud.message('BACK IN ACTION', 1.5);
  }

  update(dt) {
    const inp = this.ctx.input;
    this.yaw -= inp.mouse.dx * SENS;
    this.pitch = clamp(this.pitch - inp.mouse.dy * SENS, -1.35, 1.35);
    if (inp.wheel) this.camDist = clamp(this.camDist + inp.wheel * 0.006, 3.5, 16);
    this.castT -= dt;
    this.sinceHurt += dt;
    this.wallContact -= dt;
    this.immuneT -= dt;
    this.breakoutCd -= dt;
    this.shieldT -= dt;

    if (this.dead) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.respawn();
      this.updateCamera(dt);
      return;
    }
    // Chaining hits raises power regen (DCUO's hit counter).
    this.power = Math.min(this.maxPower, this.power + (9 + Math.min(this.ctx.combat.hits, 25) * 0.6) * dt);
    if (this.sinceHurt > 4) this.hp = Math.min(this.maxHp, this.hp + 18 * dt);

    if (this.downT > 0) {
      this.updateDown(dt, inp);
      return;
    }
    this.blocking = inp.down('ControlLeft') && this.dodgeT <= 0;
    this.handleDodgeInput(dt, inp);
    let lungeEnded = false;
    if (this.lungeT > 0) {
      this.vel.copy(this.lungeVel);
      this.lungeT -= dt;
      lungeEnded = this.lungeT <= 0;
    } else if (this.dodgeT > 0) this.moveDodge(dt);
    else if (this.movement === 'flight') this.moveFlight(dt, inp);
    else this.moveSpeed(dt, inp);
    this.integrate(dt);
    if (lungeEnded) this.vel.multiplyScalar(0.1);
    this.animate(dt);
    // Pressing Shift in super speed kicks the lightning in straight away; in flight it's the
    // boost, which sets off a shock wave.
    const shift = inp.shift && this.movement === 'speed';
    if (shift && !this.wasShift) this.speedBurst();
    this.wasShift = shift;
    this.sprinting = shift; // lightning keeps going for as long as Shift is held
    const boost = inp.shift && this.movement === 'flight' && !this.blocking;
    if (boost && !this.wasBoost) this.boostWave();
    this.wasBoost = boost;
    this.trails(dt);
    this.updateCamera(dt);
  }

  updateDown(dt, inp) {
    this.downT -= dt;
    this.blocking = false;
    if (inp.down('ControlLeft') && this.breakoutCd <= 0) {
      this.boHeld += dt;
      if (this.boHeld >= 0.12) this.breakout();
    } else this.boHeld = 0;
    const f = 1 - Math.min(1, 3 * dt);
    this.vel.x *= f;
    this.vel.z *= f;
    if (this.movement === 'speed') this.vel.y -= GRAVITY * dt;
    else this.vel.y *= f;
    this.integrate(dt);
    this.animate(dt);
    this.updateCamera(dt);
  }

  axes(inp) {
    return [
      (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0),
      (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0),
    ];
  }

  // Rolling only comes out of the block: while Left Ctrl (block) is held, each direction
  // tap is a dodge. Holding a direction when raising the block doesn't roll.
  handleDodgeInput(dt, inp) {
    this.dodgeCd -= dt;
    const buf = this.dodgeBuf;
    buf.t -= dt;
    if (inp.down('ControlLeft')) {
      const f = (inp.hit('KeyW') ? 1 : 0) - (inp.hit('KeyS') ? 1 : 0);
      const s = (inp.hit('KeyD') ? 1 : 0) - (inp.hit('KeyA') ? 1 : 0);
      if (f || s) {
        buf.f = f;
        buf.s = s;
        buf.t = DODGE_BUFFER;
      }
    }
    if (buf.t > 0 && this.dodgeCd <= 0 && this.dodgeT <= 0) {
      buf.t = 0;
      this.startDodge(buf.f, buf.s);
    }
  }

  startDodge(f, s) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.dodgeDir.set(-sy * f + cy * s, 0, -cy * f - sy * s).normalize();
    this.dodgeKind = Math.abs(s) >= Math.abs(f) ? 'roll' : 'flip';
    this.dodgeSign = this.dodgeKind === 'roll' ? s : f;
    this.dodgeT = DODGE_TIME;
    this.dodgeCd = DODGE_CD;
    this.wallRun = false;
    this.blocking = false;
    this.lungeT = 0;
    this.facing = this.yaw;
    const [c0, c1] = this.trailColors();
    _v.copy(this.pos);
    _v.y += 1;
    this.ctx.fx.burst(_v, 30, { speed: 6, life: 0.4, size: 0.7, c0, c1, drag: 3 });
  }

  // Hold the burst speed along the dodge direction; keep sideways momentum.
  moveDodge(dt) {
    const v = DODGE_SPEED[this.movement];
    const along = this.vel.dot(this.dodgeDir);
    this.vel.addScaledVector(this.dodgeDir, v - along);
    if (this.movement === 'flight') this.vel.y *= 1 - Math.min(1, 6 * dt);
    else this.vel.y -= GRAVITY * dt;
    this.dodgeT -= dt;
    if (this.dodgeT <= 0) this.vel.addScaledVector(this.dodgeDir, -v * 0.6);
  }

  moveFlight(dt, inp) {
    const [f, s] = this.axes(inp);
    const u = (inp.down('Space') ? 1 : 0) - (inp.down('KeyC') ? 1 : 0);
    const cp = Math.cos(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // Forward follows the camera (including pitch), so you fly where you look.
    _v.set(-sy * cp * f + cy * s, Math.sin(this.pitch) * f + u, -cy * cp * f - sy * s);
    const moving = _v.lengthSq() > 0;
    if (moving) _v.normalize().multiplyScalar((inp.shift && !this.blocking ? FLY_BOOST : FLY_SPEED) * (this.blocking ? BLOCK_MOVE : 1));
    const k = moving ? (inp.shift ? 2.2 : 4) : 3;
    this.vel.lerp(_v, 1 - Math.exp(-k * dt));
    this.wallRun = false;
  }

  moveSpeed(dt, inp) {
    const [f, s] = this.axes(inp);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fast = inp.shift && !this.blocking;
    _v.set(-sy * f + cy * s, 0, -cy * f - sy * s);
    if (_v.lengthSq() > 0) _v.normalize().multiplyScalar((fast ? SUPER_SPEED : RUN_SPEED) * (this.blocking ? BLOCK_MOVE : 1));
    const k = this.grounded || this.wallRun ? (fast ? 3 : 12) : 1.6;
    const a = 1 - Math.exp(-k * dt);
    this.vel.x += (_v.x - this.vel.x) * a;
    this.vel.z += (_v.z - this.vel.z) * a;

    // Wall run: sprinting forward into a wall runs straight up it.
    if (fast && f > 0 && this.wallContact > 0) {
      this.wallRun = true;
      this.vel.y = Math.max(this.vel.y, 32);
    } else {
      if (this.wallRun) this.vel.y = Math.min(this.vel.y, 14);
      this.wallRun = false;
      this.vel.y -= GRAVITY * dt;
    }

    if (inp.hit('Space')) {
      if (this.grounded || this.wallRun) {
        this.vel.y = fast ? 22 : 16;
        if (this.wallRun) {
          this.vel.x += this.wallN.x * 25;
          this.vel.z += this.wallN.y * 25;
          this.wallRun = false;
          this.wallContact = 0;
        }
        this.jumps = 1;
      } else if (this.jumps < 2) {
        this.vel.y = 17;
        this.jumps = 2;
        const [c0, c1] = this.trailColors();
        this.ctx.fx.burst(this.pos, 25, { speed: 8, life: 0.4, size: 0.6, c0, c1 });
      }
    }
    if (this.grounded) this.jumps = 0;
  }

  integrate(dt) {
    const world = this.ctx.world;
    const vy0 = this.vel.y;
    const steps = Math.max(1, Math.ceil((this.vel.length() * dt) / 0.5));
    const sdt = dt / steps;
    let ground = false, slam = 0;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.vel, sdt);
      const vx = this.vel.x, vz = this.vel.z;
      const r = world.resolve(this.pos, this.radius, this.height, this.vel, sdt, 1.6);
      if (r.ground) ground = true;
      if (r.wall) {
        this.wallContact = 0.12;
        this.wallN.set(r.nx, r.nz);
        // Slamming into a wall at speed (flying, or airborne) smashes chunks out of it
        const into = -(vx * r.nx + vz * r.nz);
        if (into > WALL_BREAK_SPEED && (this.movement === 'flight' || !this.grounded) && !this.wallRun) slam = Math.max(slam, into);
      }
    }
    if (slam && this.ctx.destruction) {
      const n = this.wallN, at = _v2.set(this.pos.x - n.x * (this.radius + 0.6), this.pos.y + 1.2, this.pos.z - n.y * (this.radius + 0.6));
      if (this.ctx.destruction.damage(at.clone(), 1.5 + slam / 35, _v3.set(-n.x, 0, -n.y))) this.ctx.combat?.hitstop(0.06);
    }
    if (ground && !this.grounded && vy0 < -38) {
      // Hard landing shockwave
      this.ctx.fx.ring(this.pos, this.look.glow, 8, 0.4);
      this.ctx.fx.burst(_v.copy(this.pos).setY(this.pos.y + 0.3), 40, { speed: 12, life: 0.5, size: 1.2, c0: [0.7, 0.65, 0.6], c1: [0.2, 0.2, 0.2], drag: 3 });
      this.shake(0.35, 0.3);
    }
    this.grounded = ground;
    this.pos.x = clamp(this.pos.x, -2400, 2400);
    this.pos.z = clamp(this.pos.z, -2400, 2400);
    if (this.pos.y > 1200) {
      this.pos.y = 1200;
      if (this.vel.y > 0) this.vel.y = 0;
    }
  }

  animate(dt) {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed = this.vel.length();

    let target = this.facing;
    if (this.dodgeT > 0) target = this.yaw;
    else if (this.atk) target = this.atk.facing;
    else if (this.wallRun) target = Math.atan2(this.wallN.x, this.wallN.y);
    else if (this.castT > 0 || this.blocking) target = this.yaw;
    else if (hs > 1.5 && this.downT <= 0) target = Math.atan2(-this.vel.x, -this.vel.z);
    this.facing = lerpAngle(this.facing, target, 1 - Math.exp(-(this.atk ? 30 : 12) * dt));
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.facing;

    // Pose for this frame (see humanoid.js for rotation conventions).
    let p, capeLift = 0;
    if (this.wallRun) {
      this.anim += dt * 22;
      p = { ...stride(this.anim, 1.1, 1.2), tilt: 1.35 };
      capeLift = 0.3;
    } else if (this.movement === 'flight' && !this.grounded) {
      const fct = clamp((this.speed - 6) / 22, 0, 1);
      const vp = Math.atan2(this.vel.y, hs);
      this.anim += dt * 2;
      const sway = Math.sin(this.anim) * 0.15 * (1 - fct);
      p = {
        tilt: -(Math.PI / 2 - vp) * fct, // align body with velocity: superhero pose
        sR: Math.PI * 0.95 * fct + (1 - fct) * 0.25, eR: 0.1 * fct + 0.4 * (1 - fct),
        sL: 0.15 * (1 - fct), eL: 0.3,
        hL: 0.1 + sway, kL: -0.15 - 0.3 * (1 - fct),
        hR: 0.3 * (1 - fct) + 0.05, kR: -0.1 - 0.4 * (1 - fct),
        spread: 0.12 + 0.2 * (1 - fct),
      };
      capeLift = 0.15 * (1 - fct);
    } else if (!this.grounded) {
      p = { tilt: -0.2, hL: 0.6, kL: -1.0, hR: -0.3, kR: -0.4, sL: -0.5, sR: 0.5, eL: 0.8, eR: 0.8 };
      capeLift = clamp(hs / 40, 0, 1.1) + 0.2;
    } else if (hs > 0.8) {
      const fast = hs > 20;
      this.anim += dt * Math.min(28, 4 + hs * 0.9);
      p = { ...stride(this.anim, fast ? 1.25 : 0.4 + hs * 0.05, fast ? 1.6 : 0.5), tilt: fast ? -0.55 : -0.08 };
      capeLift = clamp(hs / 30, 0, 1.3);
    } else {
      this.anim += dt * 2;
      const b = Math.sin(this.anim) * 0.04;
      p = { sL: b, sR: b, spread: 0.16 };
    }
    if (this.castT > 0) {
      p.sR = Math.PI / 2 + this.pitch - (p.tilt ?? 0); // point at the crosshair
      p.eR = 0;
    }

    if (this.blocking) {
      // Forearms crossed in front of the face
      Object.assign(p, { tilt: Math.min(p.tilt ?? 0, 0) * 0.5 - 0.1, sL: 1.35, sR: 1.35, eL: 1.7, eR: 1.7, spread: -0.25, kL: -0.25, kR: -0.25 });
    }

    let fast = false;
    if (this.atk) {
      const a = this.atk;
      a.t += dt;
      const ph = Math.min(1, a.t / a.dur), s = Math.sin(Math.PI * ph);
      fast = true;
      if (a.kind === 'jab') {
        // Guard up, punching arm extends at the peak
        Object.assign(p, { sL: 1.1, eL: 1.6, sR: 1.1, eR: 1.6, tilt: -0.15 * s });
        if (a.side > 0) Object.assign(p, { sR: 0.4 + s * 1.2, eR: 1.6 * (1 - s) });
        else Object.assign(p, { sL: 0.4 + s * 1.2, eL: 1.6 * (1 - s) });
      } else if (a.kind === 'kick') {
        Object.assign(p, { hR: s * 1.7, kR: -(1 - s) * 1.2, hL: -0.2 * s, kL: -0.3, tilt: 0.35 * s, sL: 1.0, eL: 1.5, sR: 0.4, eR: 1.4 });
      } else if (a.kind === 'lunge') {
        Object.assign(p, { sR: 0.4 + s * 1.2, eR: 0, sL: -0.4 * s, eL: 1.2, tilt: -0.55 * s, hL: 0.7 * s, kL: -0.6 * s, hR: -0.5 * s, kR: -0.3 });
      } else if (a.kind === 'uppercut') {
        Object.assign(p, { sR: -0.4 + ph * 3.2, eR: 1.2 * (1 - ph) + 0.3, tilt: 0.3 * s, hL: 0.4 * s, kL: -0.5 * s, sL: 1.0, eL: 1.5 });
      } else if (a.kind === 'heavyCast') {
        const aimX = Math.PI / 2 + this.pitch - (p.tilt ?? 0);
        Object.assign(p, { sL: aimX, sR: aimX, eL: 0, eR: 0, spread: -0.1 });
      }
      if (a.t >= a.dur) this.atk = null;
    }

    // Knockdown: fall onto the back
    this.fall += ((this.downT > 0 ? 1 : 0) - this.fall) * (1 - Math.exp(-10 * dt));
    if (this.fall > 0.01) p = { sL: -0.3, sR: -0.3, eL: 0.3, eR: 0.3, spread: 0.5, hL: 0.3, kL: -0.3, hR: 0.1, kR: -0.1 };
    if (this.dodgeT > 0) {
      // Tucked for the roll/flip
      p = { sL: 0.9, sR: 0.9, eL: 1.4, eR: 1.4, hL: 1.3, hR: 1.3, kL: -1.8, kR: -1.8 };
      fast = true;
      capeLift = 0.6;
    }

    // On the ground with nothing else going on, a model rig plays its walk/run/idle clips
    // (the pose's stride is only used by the procedural rig). Casting still aims the right arm.
    const free = this.grounded && !this.wallRun && !this.atk && !this.blocking && this.dodgeT <= 0 && this.fall <= 0.01;
    const loco = free
      ? { clip: hs > 6 ? 'run' : hs > 0.8 ? 'walk' : 'idle', speed: hs, mask: this.castT > 0 ? 'armR' : null }
      : null;
    this.rig.pose(p, this.dodgeT > 0 ? 1 : 1 - Math.exp(-(fast ? 30 : 14) * dt), dt, loco);

    // Dodge: barrel roll (left/right) or somersault (front/back); knockdown: fall onto the back.
    this.spin.rotation.set(this.fall * 1.45, 0, 0);
    this.spin.position.y = this.rig.hipY * (1 - this.fall * 0.65);
    if (this.dodgeT > 0) {
      const a = (1 - this.dodgeT / DODGE_TIME) * Math.PI * 2 * this.dodgeSign;
      if (this.dodgeKind === 'roll') this.spin.rotation.z = -a;
      else this.spin.rotation.x = -a;
    }

    this.shield.visible = this.blocking;
    if (this.blocking) {
      this.shield.material.opacity = this.shieldT > 0 ? 0.5 : 0.18 + Math.sin(performance.now() / 120) * 0.04;
    }

    const pos = this.cape.geometry.attributes.position, rest = this.capeRest;
    const time = performance.now() / 1000;
    const flutter = 0.03 + (Math.min(this.speed, 60) / 60) * 0.12;
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1], s = -y / 1.25;
      pos.setZ(i, s * s * capeLift * 0.9 + Math.sin(time * 14 + s * 5 + x * 3) * flutter * s);
      pos.setY(i, y + s * s * capeLift * 0.35);
    }
    pos.needsUpdate = true;
    this.cape.geometry.computeVertexNormals();
    this.root.updateMatrixWorld(true);
  }

  trails(dt) {
    const fx = this.ctx.fx, [c0, c1] = this.trailColors();
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.dodgeT > 0 || this.lungeT > 0) {
      for (let i = 0; i < 4; i++) {
        fx.spawn(this.pos.x + (Math.random() - 0.5) * 0.6, this.pos.y + 0.3 + Math.random() * 1.4, this.pos.z + (Math.random() - 0.5) * 0.6,
          0, 0, 0, 0.3, 0.7, 0.1, c0, c1, 0, 0);
      }
    } else if (this.movement === 'speed' && (hs > 24 || this.wallRun || this.sprinting)) {
      const n = Math.ceil(dt * 90);
      for (let i = 0; i < n; i++) {
        fx.spawn(this.pos.x + (Math.random() - 0.5) * 0.8, this.pos.y + 0.2 + Math.random() * 1.7, this.pos.z + (Math.random() - 0.5) * 0.8,
          (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0.35, 0.5, 0.1, c0, c1, 0, 1);
      }
      this.speedLightning(dt, hs);
    } else if (this.movement === 'flight' && this.speed > 20) this.flightTrail(dt);
    const sprint = this.movement === 'speed' && (hs > 24 || this.wallRun || this.sprinting);
    if (!sprint && !(this.movement === 'flight' && this.speed > 20)) this.path.length = 0;
    this.footSmoke(dt, hs);
  }

  // Speedster lightning: arcs crackling over the body and bolts snaking along the path behind.
  speedLightning(dt, hs) {
    const fx = this.ctx.fx, color = this.look.glow, k = Math.max(this.sprinting ? 0.5 : 0, Math.min(1, hs / SUPER_SPEED));
    this.pathT -= dt;
    if (this.pathT <= 0) {
      this.pathT = 0.025;
      this.path.unshift(this.pos.clone().setY(this.pos.y + 0.4 + Math.random() * 1.2));
      if (this.path.length > 14) this.path.pop();
    }
    // Arcs jumping between points on the body
    if (Math.random() < dt * (10 + 30 * k)) {
      const a = _v.set(this.pos.x + (Math.random() - 0.5) * 1.2, this.pos.y + 0.2 + Math.random() * 1.7, this.pos.z + (Math.random() - 0.5) * 1.2);
      const b = _v2.set(a.x + (Math.random() - 0.5) * 1.8, a.y + (Math.random() - 0.5) * 1.8, a.z + (Math.random() - 0.5) * 1.8);
      fx.bolt(a, b, { color, width: 0.1, life: 0.05, jag: 0.3 });
    }
    // Bolts running along the trail
    if (this.path.length > 4 && Math.random() < dt * (6 + 22 * k)) {
      const i = (Math.random() * (this.path.length - 4)) | 0, j = Math.min(this.path.length - 1, i + 3 + ((Math.random() * 4) | 0));
      fx.bolt(this.path[i], this.path[j], { color, width: 0.14 + 0.1 * k, life: 0.08, jag: 0.25 });
    }
    // Bolts leaping ahead of the runner (about a third as many as behind)
    if (Math.random() < dt * (2 + 8 * k)) {
      _v3.set(this.vel.x, 0, this.vel.z);
      if (_v3.lengthSq() < 1) _v3.set(-Math.sin(this.facing), 0, -Math.cos(this.facing));
      _v3.normalize();
      const a = _v.copy(this.pos).setY(this.pos.y + 0.6 + Math.random() * 1.1);
      const reach = 2 + Math.random() * (3 + 6 * k);
      const b = _v2.copy(a).addScaledVector(_v3, reach);
      b.x += (Math.random() - 0.5) * reach * 0.6;
      b.y += (Math.random() - 0.5) * 1.5;
      b.z += (Math.random() - 0.5) * reach * 0.6;
      fx.bolt(a, b, { color, width: 0.1 + 0.08 * k, life: 0.06, jag: 0.3 });
    }
    // Now and then a big crack with a flash
    if (k > 0.8 && Math.random() < dt * 2.5) {
      _v.copy(this.pos).setY(this.pos.y + 1);
      fx.bolt(_v, _v2.copy(this.path[this.path.length - 1] ?? _v), { color, width: 0.35, life: 0.12, jag: 0.2 });
      fx.flash(_v, color, 6, 18, 0.12);
    }
  }

  // Flight trail in the power's style: a lightning streak for electricity, a flame jet for fire.
  flightTrail(dt) {
    const fx = this.ctx.fx, color = this.look.glow, [c0, c1] = this.trailColors();
    const k = Math.min(1, this.speed / FLY_BOOST);
    const at = _v.copy(this.pos).setY(this.pos.y + 1);
    this.pathT -= dt;
    if (this.pathT <= 0) {
      this.pathT = 0.03;
      this.path.unshift(at.clone());
      if (this.path.length > 16) this.path.pop();
    }
    if (this.theme === 'electric') {
      // Glowing core streak plus bolts zig-zagging along the flight path
      const n = Math.ceil(dt * 60);
      for (let i = 0; i < n; i++) {
        fx.spawn(at.x + (Math.random() - 0.5) * 0.4, at.y + (Math.random() - 0.5) * 0.4, at.z + (Math.random() - 0.5) * 0.4,
          0, 0, 0, 0.45, 0.45, 0.05, c0, c1, 0, 0);
      }
      if (this.path.length > 3 && Math.random() < dt * (8 + 26 * k)) {
        const i = (Math.random() * (this.path.length - 3)) | 0, j = Math.min(this.path.length - 1, i + 2 + ((Math.random() * 5) | 0));
        fx.bolt(this.path[i], this.path[j], { color, width: 0.14 + 0.14 * k, life: 0.09, jag: 0.25 });
      }
      if (Math.random() < dt * 12) {
        _v2.set(at.x + (Math.random() - 0.5) * 2, at.y + (Math.random() - 0.5) * 2, at.z + (Math.random() - 0.5) * 2);
        fx.bolt(at, _v2, { color, width: 0.08, life: 0.05, jag: 0.35 });
      }
    } else {
      // Flames pouring off the body and trailing back, with smoke behind them
      const n = Math.ceil(dt * (50 + 90 * k));
      for (let i = 0; i < n; i++) {
        const t = Math.random();
        fx.spawn(at.x + (Math.random() - 0.5) * 0.7, at.y + (Math.random() - 0.5) * 0.7, at.z + (Math.random() - 0.5) * 0.7,
          -this.vel.x * 0.15 * t + (Math.random() - 0.5) * 2, 1 + Math.random() * 2, -this.vel.z * 0.15 * t + (Math.random() - 0.5) * 2,
          0.35 + 0.35 * k, 0.7 + 0.5 * k, 0.15, [1, 0.85, 0.45], [0.9, 0.18, 0.02], 2, 1.5);
      }
      if (Math.random() < dt * (6 + 14 * k)) {
        const p = this.path[this.path.length - 1] ?? at;
        fx.smoke(p.x, p.y, p.z, (Math.random() - 0.5) * 1.5, 0.8, (Math.random() - 0.5) * 1.5, 1.4, 0.6, 2.2,
          [0.25, 0.22, 0.2], [0.12, 0.11, 0.1], 1.2, 0.8);
      }
    }
  }

  // Flight boost: a shock wave around the hero in the power's style.
  boostWave() {
    const fx = this.ctx.fx, color = this.look.glow;
    const c = _v.copy(this.pos).setY(this.pos.y + 1);
    // Wave plane faces the flight direction (or the camera's when hovering)
    _v3.set(this.vel.x, this.vel.y, this.vel.z);
    if (_v3.lengthSq() < 4) _v3.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    _v3.normalize();
    const u = new THREE.Vector3(0, 1, 0);
    if (Math.abs(_v3.y) > 0.9) u.set(1, 0, 0);
    u.cross(_v3).normalize();
    const w = new THREE.Vector3().crossVectors(_v3, u);
    const dir = new THREE.Vector3();
    const electric = this.theme === 'electric';
    // Ring of particles blasting outward in that plane
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      dir.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
      const sp = 22 + Math.random() * 8;
      if (electric) fx.spawn(c.x, c.y, c.z, dir.x * sp, dir.y * sp, dir.z * sp, 0.35, 0.7, 0.1, [1, 1, 1], TRAILS.electric[1], 0, 2.5);
      else fx.spawn(c.x, c.y, c.z, dir.x * sp, dir.y * sp, dir.z * sp, 0.5, 1.4, 0.3, [1, 0.8, 0.35], [0.85, 0.15, 0], 1, 2.5);
    }
    if (electric) {
      // Bolts lashing outward around the ring
      for (let i = 0; i < 8; i++) {
        const a = (i / 8 + Math.random() * 0.1) * Math.PI * 2;
        dir.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
        fx.bolt(c, _v2.copy(c).addScaledVector(dir, 5 + Math.random() * 3), { color, width: 0.25, life: 0.18, jag: 0.25 });
      }
    } else {
      // Fireball puff and smoke left hanging where the boost started
      fx.burst(c, 30, { speed: 8, life: 0.5, size: 1.6, size1: 0.4, c0: [1, 0.85, 0.4], c1: [0.9, 0.2, 0], ay: 2, drag: 2 });
      for (let i = 0; i < 10; i++) {
        fx.smoke(c.x, c.y, c.z, (Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6, 1.6, 1, 3,
          [0.28, 0.25, 0.22], [0.12, 0.11, 0.1], 1, 1.2);
      }
    }
    fx.flash(c, color, 12, 30, 0.25);
    fx.ring(this.pos, color, 9, 0.35);
    this.shake(0.15, 0.25);
  }

  // Shift pressed: a burst of bolts lashing out from the body, a flash and a shock ring.
  speedBurst() {
    const fx = this.ctx.fx, color = this.look.glow;
    const c = _v.copy(this.pos).setY(this.pos.y + 1);
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 3.5;
      _v2.set(c.x + Math.cos(a) * r, c.y + (Math.random() - 0.4) * 2.5, c.z + Math.sin(a) * r);
      fx.bolt(c, _v2, { color, width: 0.18, life: 0.16, jag: 0.3 });
    }
    fx.flash(c, color, 10, 22, 0.2);
    fx.ring(this.pos, color, 5, 0.3);
    fx.burst(c, 24, { speed: 9, life: 0.35, size: 0.35, c0: [1, 1, 1], c1: new THREE.Color(color).toArray(), drag: 3 });
  }

  // Little puffs of dust kicked up from the feet when running on the ground.
  footSmoke(dt, hs) {
    if (this.movement !== 'speed' || !this.grounded || this.wallRun || hs < 6 || this.downT > 0) return;
    this.stepT -= dt;
    if (this.stepT > 0) return;
    const fast = hs > 24;
    this.stepT = fast ? 0.02 : 0.11;
    const sy = Math.sin(this.facing), cy = Math.cos(this.facing);
    const back = Math.min(1, hs / SUPER_SPEED);
    for (const side of fast ? [-0.18, 0.18] : [Math.random() < 0.5 ? -0.18 : 0.18]) {
      const x = this.pos.x + cy * side + (Math.random() - 0.5) * 0.3, z = this.pos.z - sy * side + (Math.random() - 0.5) * 0.3;
      // drifts backwards, opposite to the run, and rises a little
      const vx = -this.vel.x * 0.08 + (Math.random() - 0.5) * 1.5, vz = -this.vel.z * 0.08 + (Math.random() - 0.5) * 1.5;
      this.ctx.fx.smoke(x, this.pos.y + 0.1, z, vx, 0.6 + Math.random() * 0.8, vz,
        0.6 + back * 0.8, 0.25, 0.9 + back * 1.4, [0.62, 0.6, 0.57], [0.42, 0.41, 0.4], 0.6, 1.6);
    }
  }

  updateCamera(dt) {
    const cam = this.ctx.camera, world = this.ctx.world;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd = _v.set(-sy * cp, sp, -cy * cp);
    const pivot = _v2.set(this.pos.x + cy * 0.7, this.pos.y + 1.75, this.pos.z - sy * 0.7);
    const sf = clamp(this.speed / 80, 0, 1);
    const want = this.camDist + sf * 3;
    const hit = world.raycast(pivot, _v3.copy(fwd).negate(), want + 0.5);
    const d = Math.max(1.0, Math.min(want, hit - 0.4));
    this.curDist = d < this.curDist ? d : this.curDist + (d - this.curDist) * (1 - Math.exp(-4 * dt));
    cam.position.copy(pivot).addScaledVector(fwd, -this.curDist);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const a = this.shakeAmt * Math.max(0, this.shakeT / this.shakeDur);
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
      cam.position.z += (Math.random() - 0.5) * a;
    }
    cam.lookAt(_v3.copy(pivot).add(fwd));
    const fov = 70 + sf * 22;
    cam.fov += (fov - cam.fov) * (1 - Math.exp(-4 * dt));
    cam.updateProjectionMatrix();
  }
}
