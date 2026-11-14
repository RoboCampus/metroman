import * as THREE from 'three';

// DCUO-style targeting.
//   Soft lock (automatic): whichever enemy is closest to the centre of the screen (in range, in
//     sight) is the target; it follows the camera. White brackets.
//   Hard lock (Caps Lock): keeps the current target no matter where the camera looks, until Caps
//     Lock again, the target dies or gets too far away. Red brackets.
// Powers (1 / 2 / 3 / R) aim at the target, and the held-LMB lunge flies at it. The RMB blast still
// goes where the crosshair points.

// range: soft lock reach (m); keep: a hard lock breaks past this; screen: how far from the centre
// (fraction of the screen height) the soft lock looks; sticky: a new target must be this much closer
// to the centre to take over; scan: seconds between soft lock re-picks
const LOCK = { range: 110, keep: 220, screen: 0.6, sticky: 0.08, scan: 0.1 };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _o = new THREE.Vector3();

export class LockOn {
  constructor(ctx) {
    this.ctx = ctx;
    this.target = null;
    this.hard = false;
    this.scanT = 0;
    this.toggles = 0;
    this.capsDownAt = -1e9;
    // Caps Lock: Windows sends keydown + keyup on every press; macOS sends keydown when it turns on
    // and only keyup when it turns off. A keyup with no keydown just before it is a press too.
    addEventListener('keydown', (e) => {
      if (e.code !== 'CapsLock' || e.repeat) return;
      this.capsDownAt = performance.now();
      this.toggles++;
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'CapsLock' && performance.now() - this.capsDownAt > 600) this.toggles++;
    });

    const el = (this.el = document.createElement('div'));
    el.id = 'lockon';
    el.innerHTML = '<i></i><i></i><i></i><i></i><div class="lockInfo"><span class="lockName"></span><div class="lockBar"><div></div></div></div>';
    document.getElementById('hud').appendChild(el);
    this.nameEl = el.querySelector('.lockName');
    this.barEl = el.querySelector('.lockBar div');
  }

  update(dt) {
    const { player, hud } = this.ctx;
    if (this.target && !this.valid(this.target, this.hard ? LOCK.keep : LOCK.range * 1.15)) {
      if (this.hard) hud.message(this.target.dead ? 'TARGET DOWN' : 'LOCK LOST', 0.8);
      this.target = null;
      this.hard = false;
    }
    while (this.toggles > 0) {
      this.toggles--;
      if (this.hard) {
        this.hard = false;
        hud.message('LOCK RELEASED', 0.6);
      } else {
        if (!this.target) this.target = this.pick(null);
        if (this.target) {
          this.hard = true;
          hud.message('TARGET LOCKED', 0.6);
        } else hud.message('NO TARGET', 0.6);
      }
    }
    if (!this.hard && !player.dead) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = LOCK.scan;
        this.target = this.pick(this.target);
      }
    } else if (player.dead) this.target = null;
    this.draw();
  }

  // Still a target: alive, on the scene and within `range` of the hero
  valid(e, range) {
    return !e.dead && this.ctx.enemies.list.includes(e) && this.ctx.enemies.center(e, _v).distanceTo(this.ctx.player.pos) < range;
  }

  // Screen-space distance of an enemy from the crosshair (in screen heights), or null if it's
  // behind the camera, off to the side, out of range or out of sight.
  score(e) {
    const { camera, enemies, player, world } = this.ctx;
    const c = enemies.center(e, _v);
    if (c.distanceTo(player.pos) > LOCK.range) return null;
    const s = _w.copy(c).project(camera);
    if (s.z > 1 || s.z < -1) return null;
    const d = Math.hypot(s.x * camera.aspect, s.y) / 2;
    if (d > LOCK.screen) return null;
    camera.getWorldPosition(_o);
    const dir = _w.subVectors(c, _o), dist = dir.length();
    if (dist > 1 && world.raycast(_o, dir.divideScalar(dist), dist) < dist - 1.5 - e.r) return null;
    return d;
  }

  // The enemy nearest the crosshair; the current one keeps it unless another is clearly closer.
  pick(cur) {
    let best = null, bd = Infinity;
    for (const e of this.ctx.enemies.list) {
      if (e.dead) continue;
      const d = this.score(e);
      if (d === null) continue;
      const k = e === cur ? d - LOCK.sticky : d;
      if (k < bd) {
        bd = k;
        best = e;
      }
    }
    return best;
  }

  // Brackets around the target on screen, with its name and health
  draw() {
    const e = this.target, el = this.el;
    if (!e) {
      el.style.display = 'none';
      return;
    }
    const { camera, enemies } = this.ctx;
    const c = enemies.center(e, _v);
    const dist = c.distanceTo(camera.getWorldPosition(_o));
    const s = _w.copy(c).project(camera);
    if (s.z > 1) {
      el.style.display = 'none';
      return;
    }
    const W = innerWidth, H = innerHeight;
    const r = e.spheres ? e.spheres.reduce((m, p) => Math.max(m, p.r), 0) : e.r;
    const px = THREE.MathUtils.clamp((r * 1.2 / Math.max(1, dist)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * H / 2, 18, H * 0.4);
    // (a hard-locked target off screen: brackets pinned to the edge)
    const x = THREE.MathUtils.clamp((s.x + 1) / 2 * W, 30, W - 30), y = THREE.MathUtils.clamp((1 - s.y) / 2 * H, 30, H - 30);
    el.style.display = '';
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.setProperty('--s', `${px * 2}px`);
    el.classList.toggle('hard', this.hard);
    const name = e.bossName || e.type.toUpperCase();
    if (this.nameEl.textContent !== name) this.nameEl.textContent = name;
    this.barEl.style.width = `${Math.max(0, e.hp / e.maxHp) * 100}%`;
  }
}
