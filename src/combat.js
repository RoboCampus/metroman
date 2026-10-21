import * as THREE from 'three';

// DCUO-style weapon combat:
//   LMB tap = quick melee, LMB hold = lunging melee (Interrupt)
//   RMB tap = quick ranged, RMB hold = heavy ranged (Block Breaker)
//   Hold L-Ctrl = Block (tap a direction while blocking to dodge). Counter triangle: Block Breaker > Block > Interrupt > Block Breaker.
// Inputs chain into combos when entered in sequence.

const HOLD = 0.28; // seconds a button must be held to count as "hold"
// Flying lunge (hold melee, with its animation): homes in on a target this far away, or flies this
// far ahead without one, then the right hook explodes on impact.
// range/free: metres to a target / with none; clip: the lunge animation's playback speed (shorter flight)
const LUNGE = { range: 80, free: 50, maxSpeed: 280, clip: 1.4, dmg: 45, knock: 22, blast: 7, blastDmg: 25 };
const COMBO_WINDOW = 0.9; // max gap between inputs in a combo
const HIT_WINDOW = 2.5; // hit counter resets after this long without a hit
const BUSY = { mt: 0.22, mh: 0.45, rt: 0.2, rh: 0.42 };

// Matched against the most recent inputs (longest first).
const COMBOS = [
  { seq: ['mt', 'mt', 'mt'], name: 'Flurry Finisher' },
  { seq: ['mt', 'mt', 'mh'], name: 'Rising Uppercut' },
  { seq: ['rt', 'rt', 'rh'], name: 'Barrage' },
  { seq: ['mt', 'mt', 'rh'], name: 'Breaker Combo' },
];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class Combat {
  constructor(ctx) {
    this.ctx = ctx;
    this.hist = [];
    this.histT = 0;
    this.left = { active: false, held: 0 };
    this.right = { active: false, held: 0 };
    this.queued = null;
    this.busyT = 0;
    this.timers = [];
    this.hits = 0;
    this.hitT = 0;
    this.hitstopT = 0;
    this.sinceAttack = 99; // enemies read this to decide when to block
    this.jab = 1;
    this.slots = [
      { id: 'melee', key: 'LMB', name: 'Strike · hold Lunge', icon: '👊' },
      { id: 'ranged', key: 'RMB', name: 'Blast · hold Breaker', icon: '🎯' },
      { id: 'block', key: 'Ctrl', name: 'Block · Breakout', icon: '🛡️', cd: 6, timer: 0 },
    ];
  }

  hitstop(t) {
    this.hitstopT = Math.max(this.hitstopT, t);
  }

  onHit(type) {
    if (type === 'dot') return;
    this.hits++;
    this.hitT = HIT_WINDOW;
  }

  after(t, fn) {
    this.timers.push({ t, fn });
  }

  // Tap fires on release; hold fires as soon as the threshold passes.
  readButton(b, held, down, dt, tapKind, holdKind) {
    if (down) {
      b.active = true;
      b.held = 0;
    }
    if (!b.active) return null;
    if (held) {
      b.held += dt;
      if (b.held >= HOLD) {
        b.active = false;
        return holdKind;
      }
      return null;
    }
    b.active = false;
    return tapKind;
  }

  update(dt) {
    const { input, player } = this.ctx;
    this.sinceAttack += dt;
    this.busyT -= dt;
    this.histT -= dt;
    if (this.histT <= 0) this.hist.length = 0;
    this.hitT -= dt;
    if (this.hitT <= 0) this.hits = 0;
    this.slots[2].timer = Math.max(0, player.breakoutCd);
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) {
        this.timers.splice(i, 1);
        tm.fn();
      }
    }

    const m = input.mouse;
    if (player.dead || player.downT > 0 || player.blocking) {
      this.left.active = this.right.active = false;
      this.queued = null;
      return;
    }
    const l = this.readButton(this.left, m.left, m.leftDown, dt, 'mt', 'mh');
    const r = this.readButton(this.right, m.right, m.rightDown, dt, 'rt', 'rh');
    const next = l || r;
    if (next) this.queued = next;
    if (this.queued && this.busyT <= 0 && player.dodgeT <= 0) {
      const kind = this.queued;
      this.queued = null;
      this.execute(kind);
    }
  }

  execute(kind) {
    this.busyT = BUSY[kind];
    this.sinceAttack = 0;
    this.hist.push(kind);
    if (this.hist.length > 4) this.hist.shift();
    this.histT = COMBO_WINDOW;
    // Taps in a row so far (picks the 1st / 2nd punch animation of the combo)
    let taps = 0;
    for (let i = this.hist.length - 1; i >= 0 && this.hist[i] === 'mt'; i--) taps++;
    let combo = null;
    for (const c of COMBOS) {
      const tail = this.hist.slice(-c.seq.length);
      if (tail.length === c.seq.length && tail.every((k, i) => k === c.seq[i])) {
        combo = c;
        break;
      }
    }
    if (combo) {
      this.hist.length = 0;
      this.ctx.hud.combo(combo.name);
    }
    const powers = this.ctx.getPowers();
    if (kind === 'mt') this.melee(combo?.name === 'Flurry Finisher' ? 'finisher' : 'jab', taps);
    else if (kind === 'mh') this.melee(combo?.name === 'Rising Uppercut' ? 'uppercut' : 'lunge', taps);
    else if (kind === 'rt') powers.ranged();
    else powers.rangedHeavy(!!combo);
  }

  // Ground combo animations (assets/anims/hero_combat.glb): left hook, right hook, then the uppercut
  // finisher. The hold lunge has its own flying animation (flyingLunge). Moves without an animation
  // (anything else in the air) use the procedural poses.
  static clipFor(move, taps) {
    if (move === 'finisher' || move === 'uppercut') return 'g_jab3';
    if (move === 'jab') return taps % 2 === 1 ? 'g_jab1' : 'g_jab2';
    return null;
  }

  melee(move, taps = 1) {
    if (move === 'lunge' && this.flyingLunge()) return;
    const { player, enemies, fx } = this.ctx;
    const heavy = move === 'lunge' || move === 'uppercut';
    const aim = this.ctx.getAim(heavy ? 16 : 6, heavy ? 30 : 55);
    const chest = _a.copy(player.pos);
    chest.y += 1.2;
    // Melee magnetism: lunge to the nearest enemy in front of the camera.
    const target = enemies.meleeTarget(chest, aim.dir, heavy ? 16 : 6, Math.cos(heavy ? 0.6 : 1.0));
    const dir = new THREE.Vector3();
    let lungeT = 0.06;
    if (target) {
      dir.subVectors(enemies.center(target, _b), chest);
      const dist = dir.length();
      dir.normalize();
      if (dist > 2.0) {
        lungeT = Math.min(heavy ? 0.22 : 0.12, (dist - 1.5) / 40);
        player.lunge(dir, (dist - 1.5) / lungeT, lungeT);
      }
    } else {
      dir.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      if (heavy) player.lunge(dir, 30, 0.15);
    }
    const anim = { jab: 'jab', finisher: 'kick', lunge: 'lunge', uppercut: 'uppercut' }[move];
    this.jab = -this.jab;
    const clip = player.attack(anim, heavy ? 0.42 : 0.24, Math.atan2(-dir.x, -dir.z), this.jab, Combat.clipFor(move, taps));
    // With an animation, the blow lands on its contact frame and the next attack can start from
    // its cancel frame
    if (clip) this.busyT = clip.cancel;
    const hitAt = clip ? Math.max(lungeT, clip.hit[0] ?? 0) : Math.max(0.05, lungeT);

    this.after(hitAt, () => {
      const T = player.trailColors();
      const hitPoint = _c.copy(player.pos);
      hitPoint.y += 1.2;
      hitPoint.addScaledVector(dir, 1.3);
      const reach = heavy || move === 'finisher' ? 2.4 : 1.7;
      const stats = {
        jab: { dmg: 14, knock: 3, type: 'tap' },
        finisher: { dmg: 32, knock: 18, type: 'tap' },
        lunge: { dmg: 30, knock: 10, type: 'interrupt' },
        uppercut: { dmg: 42, knock: 6, up: 16, type: 'interrupt' },
      }[move];
      let hit = false;
      for (const e of enemies.inRadius(hitPoint, reach)) {
        const k = dir.clone().setY(0).normalize().multiplyScalar(stats.knock);
        k.y = stats.up ?? (stats.knock > 8 ? 5 : 0);
        enemies.damage(e, stats.dmg, { type: stats.type, knock: k, ...player.meleeStatus(move) });
        hit = true;
      }
      if (this.ctx.traffic?.damageRadius(hitPoint, reach + 1.2, stats.dmg, stats.knock * 1.5 + (heavy ? 12 : 5))) hit = true;
      if (this.ctx.props?.damageRadius(hitPoint, reach + 0.6, stats.knock + 8)) hit = true;
      // Punches and kicks break blocks out of buildings
      if (this.ctx.destruction?.damage(hitPoint.clone().addScaledVector(dir, 1), heavy ? 2.2 : 1.4, dir)) hit = true;
      if (hit) {
        fx.burst(hitPoint, heavy ? 30 : 14, { speed: heavy ? 14 : 8, life: 0.35, size: heavy ? 0.9 : 0.6, c0: T[0], c1: T[1], drag: 3 });
        fx.flash(hitPoint, player.glowColor(), heavy ? 500 : 300, 15, 0.12);
        this.impact(hitPoint, dir, heavy || move === 'finisher' ? 1.6 : 1, T);
        this.hitstop(heavy || move === 'finisher' ? 0.07 : 0.05);
        player.shake(heavy ? 0.25 : 0.16, 0.15);
      } else {
        fx.burst(hitPoint, 5, { speed: 4, life: 0.2, size: 0.4, c0: T[0], c1: T[1] });
        fx.ring(hitPoint, player.glowColor(), 0.9, 0.15, dir); // (a puff of air off the fist)
      }
    });
  }

  // A punch landing: a white-hot pop at the fist, shock wave rings bursting out along the punch,
  // sparks sprayed forward in a cone and a puff of dust. k scales it (1 for a hook).
  impact(at, dir, k, [c0, c1]) {
    const fx = this.ctx.fx, color = this.ctx.player.glowColor();
    fx.spawn(at.x, at.y, at.z, 0, 0, 0, 0.1, 2.2 * k, 0.4, [1, 1, 1], c0, 0, 0);
    fx.ring(_b.copy(at).addScaledVector(dir, 0.2), 0xffffff, 1.8 * k, 0.16, dir);
    fx.ring(_b.copy(at).addScaledVector(dir, 0.6), color, 3 * k, 0.28, dir);
    for (let i = 0, n = Math.round(18 * k); i < n; i++) {
      // sparks: mostly forward, spread sideways
      _b.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4).add(dir).normalize().multiplyScalar(14 + Math.random() * 18);
      fx.spawn(at.x, at.y, at.z, _b.x, _b.y + 2, _b.z, 0.15 + Math.random() * 0.15, 0.35, 0.05, [1, 1, 0.9], c1, -20, 4);
    }
    for (let i = 0; i < 4 * k; i++) {
      fx.smoke(at.x, at.y, at.z, dir.x * 4 + (Math.random() - 0.5) * 3, (Math.random() - 0.3) * 2, dir.z * 4 + (Math.random() - 0.5) * 3, 0.5, 0.5, 1.6, [0.5, 0.48, 0.46], [0.3, 0.3, 0.3], 0.5, 3);
    }
  }

  // Hold melee with its animation: crouch, take off on the clip's launch frame, fly in flat (up to
  // LUNGE.range metres, homing on the target) and arrive exactly as the right hook lands, which
  // explodes. Returns false if there's no animation (the procedural lunge is used instead).
  flyingLunge() {
    const { player, enemies, fx } = this.ctx;
    const aim = this.ctx.getAim(LUNGE.range, 25);
    const chest = _a.copy(player.pos);
    chest.y += 1.2;
    const target = enemies.meleeTarget(chest, aim.dir, LUNGE.range, Math.cos(0.5));
    const dir = new THREE.Vector3();
    if (target) dir.subVectors(enemies.center(target, _b), chest).normalize();
    else {
      dir.copy(aim.dir);
      if (player.grounded && dir.y < 0) dir.y = 0; // don't dive into the street
      dir.normalize();
    }
    const clip = player.attack('lunge', 0.42, Math.atan2(-dir.x, -dir.z), 1, 'g_lunge', true, LUNGE.clip);
    if (!clip) return false;
    this.busyT = clip.cancel;
    const travel = Math.max(0.1, clip.hit[0] - clip.launch);
    this.after(clip.launch, () => {
      // Take off: re-aim at where the target is now, and cover the distance by the time the hook lands
      const from = _a.copy(player.pos);
      from.y += 1.2;
      let dist = LUNGE.free;
      if (target && !target.dead) {
        dir.subVectors(enemies.center(target, _b), from);
        dist = Math.max(0, dir.length() - 1.6);
        dir.normalize();
      }
      if (dist > 0.5) player.lunge(dir, Math.min(LUNGE.maxSpeed, dist / travel), travel);
      const T = player.trailColors();
      fx.burst(player.pos, 30, { speed: 10, life: 0.4, size: 1, c0: T[0], c1: T[1], drag: 3 });
      fx.ring(player.pos, player.glowColor(), 6, 0.3);
      player.shake(0.2, 0.2);
    });
    this.after(clip.hit[0], () => this.lungeImpact(dir, target));
    return true;
  }

  // The flying hook connects: a big explosion in the hero's energy colours.
  lungeImpact(dir, target) {
    const { player, enemies, fx } = this.ctx;
    const T = player.trailColors();
    const p = _c.copy(player.pos);
    p.y += 1.2;
    p.addScaledVector(dir, 1.4);
    const k = dir.clone().setY(0).normalize().multiplyScalar(LUNGE.knock);
    k.y = 7;
    if (target && !target.dead && enemies.reach(target, p) < 5) {
      enemies.damage(target, LUNGE.dmg, { type: 'interrupt', knock: k, ...player.meleeStatus('uppercut') });
    }
    enemies.damageRadius(p, LUNGE.blast, LUNGE.blastDmg, LUNGE.knock, 0, { type: 'power', skip: target });
    this.ctx.traffic?.damageRadius(p, LUNGE.blast + 1, 120, 30);
    this.ctx.props?.damageRadius(p, LUNGE.blast, 30);
    this.ctx.destruction?.damage(p.clone().addScaledVector(dir, 1.5), 3.5, dir);
    this.ctx.impacts?.hit(p.clone(), null, 6, player.theme === 'fire' ? 'fire' : 'elec', 9);
    // the explosion
    fx.burst(p, 70, { speed: 22, life: 0.6, size: 2.2, size1: 0.4, c0: T[0], c1: T[1], ay: 2, drag: 2.5 });
    fx.burst(p, 30, { speed: 30, life: 0.35, size: 0.5, c0: [1, 1, 1], c1: T[0], drag: 1.5 });
    for (let i = 0; i < 14; i++) {
      fx.smoke(p.x + (Math.random() - 0.5) * 3, p.y + (Math.random() - 0.5) * 2, p.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 8, 1 + Math.random() * 4, (Math.random() - 0.5) * 8, 1.5 + Math.random(), 2, 5);
    }
    fx.flash(p, player.glowColor(), 3000, 40, 0.3);
    fx.ring(p, player.glowColor(), 12, 0.4);
    this.hitstop(0.1);
    player.shake(0.6, 0.4);
  }
}
