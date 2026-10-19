import * as THREE from 'three';

// DCUO-style weapon combat:
//   LMB tap = quick melee, LMB hold = lunging melee (Interrupt)
//   RMB tap = quick ranged, RMB hold = heavy ranged (Block Breaker)
//   Hold L-Ctrl = Block (tap a direction while blocking to dodge). Counter triangle: Block Breaker > Block > Interrupt > Block Breaker.
// Inputs chain into combos when entered in sequence.

const HOLD = 0.28; // seconds a button must be held to count as "hold"
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
    if (kind === 'mt') this.melee(combo?.name === 'Flurry Finisher' ? 'finisher' : 'jab');
    else if (kind === 'mh') this.melee(combo?.name === 'Rising Uppercut' ? 'uppercut' : 'lunge');
    else if (kind === 'rt') powers.ranged();
    else powers.rangedHeavy(!!combo);
  }

  melee(move) {
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
    player.attack(anim, heavy ? 0.42 : 0.24, Math.atan2(-dir.x, -dir.z), this.jab);

    this.after(Math.max(0.05, lungeT), () => {
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
        fx.flash(hitPoint, player.glowColor(), heavy ? 500 : 200, 15, 0.12);
        this.hitstop(heavy || move === 'finisher' ? 0.07 : 0.035);
        player.shake(heavy ? 0.25 : 0.1, 0.15);
      } else {
        fx.burst(hitPoint, 5, { speed: 4, life: 0.2, size: 0.4, c0: T[0], c1: T[1] });
      }
    });
  }
}
