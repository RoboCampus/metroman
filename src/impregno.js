import * as THREE from 'three';
import { clamp, lerpAngle } from './util.js';
import { createRig } from './models.js';

// Impregno Man: a flying boss with a mayonnaise-powered jetpack.
//   - Flies around the hero at up to 250 km/h, dashing to new positions.
//   - His jetpack exhaust is mayonnaise: it drips and splats all over the city.
//   - Sprays streams of mayo blobs at the hero from his hand nozzle.
//   - Special: charges up a ka-me-ha-me-ha style mayo beam fired from his hips, straight at the
//     hero. The beam tears through buildings.
//   - Mayo flood: flies over a nearby city block, loads up for 10 seconds, then buries the whole
//     block in a heap of mayo balls that lasts 40 seconds (2 minute cooldown). The heap can be
//     waded through and blasted apart, and it sticks to the hero.
// Every mayo splat sticks to whatever it hit for 30 seconds. Mayo that hits the hero (or that they
// touch) also sticks to them for 5 seconds; that part is only cosmetic.
// Like the kaiju he lives in enemies.list, so all the hero's attacks can hurt him. When another boss
// is around (this.rival, see bossfight.js) he fights that boss instead of the hero.

const SCALE = 1.25;
const HP = 3000;
const MAX_SPEED = 250 / 3.6; // 250 km/h
const ACCEL = 70;
const ORBIT = { radius: 60, height: 18 };
const SPRAY = { time: 1.6, rate: 14, speed: 95, spread: 0.05, dmg: 3.5 };
const BEAM = { charge: 1.8, time: 2.8, turn: 0.55, range: 450, radius: 2.4, dps: 55, every: 11 };
const SPLAT_LIFE = 30; // seconds a mayo splat stays
const FLOOD = { first: 25, cooldown: 120, load: 10, pour: 6, life: 40, max: 2400, spacing: 4, street: 8, roof: 5 };
const COAT = { life: 5, max: 26 };
const SPAWN_FIRST = 15, RESPAWN = 90;
const MAYO = [1, 0.97, 0.84], MAYO2 = [0.9, 0.86, 0.7];
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), Y = UP, Z = new THREE.Vector3(0, 0, 1);

const mayoMat = new THREE.MeshStandardMaterial({ color: '#fff6d8', roughness: 0.18, metalness: 0, emissive: '#3a3420', emissiveIntensity: 0.3 });

function mayoTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d'), S = 256, m = S / 2;
  g.fillStyle = 'rgba(255,248,222,.97)';
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * S * 0.15;
    g.beginPath();
    g.arc(m + Math.cos(a) * r, m + Math.sin(a) * r, S * (0.1 + Math.random() * 0.12), 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2, r = S * (0.22 + Math.random() * 0.25);
    g.beginPath();
    g.arc(m + Math.cos(a) * r, m + Math.sin(a) * r, S * (0.008 + Math.random() * 0.03), 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(225,212,170,.6)'; // creamy swirls
  g.lineWidth = 3;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(m + (Math.random() - 0.5) * 40, m + (Math.random() - 0.5) * 40, 10 + Math.random() * 30, Math.random() * 6, Math.random() * 6 + 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Mayo splats stuck to the ground and walls: one instanced mesh, each splat lives 30 s.
export class MayoSplats {
  constructor(scene, max = 600) {
    const mat = new THREE.MeshStandardMaterial({
      map: mayoTexture(), transparent: true, depthWrite: false, roughness: 0.2, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.items = [];
    for (let i = 0; i < max; i++) {
      this.items.push({ pos: new THREE.Vector3(), q: new THREE.Quaternion(), size: 0, age: 0, life: 0 });
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.next = 0;
    this.active = 0;
    scene.add(this.mesh);
  }

  add(pos, normal, size) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length; // the oldest splat is recycled if it overflows
    if (it.life <= 0) this.active++;
    it.pos.copy(pos).addScaledVector(normal, 0.05);
    it.q.setFromUnitVectors(Z, normal).multiply(_q.setFromAxisAngle(Z, Math.random() * Math.PI * 2));
    it.size = size * (0.8 + Math.random() * 0.4);
    it.age = 0;
    it.life = SPLAT_LIFE;
  }

  update(dt) {
    if (!this.active) return;
    this.items.forEach((it, i) => {
      if (it.life <= 0) return;
      it.age += dt;
      if (it.age >= it.life) {
        it.life = 0;
        this.active--;
        this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        return;
      }
      // Splats in fast, shrinks away over the last 1.5 s
      const s = it.size * Math.min(1, it.age / 0.12) * Math.min(1, (it.life - it.age) / 1.5);
      this.mesh.setMatrixAt(i, _m.compose(it.pos, it.q, _s.set(s, s, s)));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// Mayo stuck on the hero: blobs on their body that slowly drip and fall off after 5 seconds.
// Purely cosmetic.
export class MayoCoat {
  constructor(ctx) {
    this.ctx = ctx;
    this.blobs = [];
    this.geo = new THREE.SphereGeometry(1, 10, 8);
    this.cooldown = 0;
  }

  // Stick n more blobs on the hero (or refresh the oldest ones once the coat is full).
  add(n = 3) {
    const body = this.ctx.player.rig?.body;
    if (!body) return;
    for (let i = 0; i < n; i++) {
      let b;
      if (this.blobs.length >= COAT.max) {
        b = this.blobs.reduce((a, c) => (c.t < a.t ? c : a));
      } else {
        b = { mesh: new THREE.Mesh(this.geo, mayoMat) };
        b.mesh.castShadow = true;
        body.add(b.mesh);
        this.blobs.push(b);
      }
      // Somewhere on the torso, head or legs (body space: y up from the hips, -z is the front)
      const r = Math.random(), a = Math.random() * Math.PI * 2;
      if (r < 0.55) b.mesh.position.set(Math.cos(a) * 0.19, -0.05 + Math.random() * 0.7, Math.sin(a) * 0.14);
      else if (r < 0.7) b.mesh.position.set(Math.cos(a) * 0.1, 0.78 + Math.random() * 0.12, Math.sin(a) * 0.1);
      else b.mesh.position.set((Math.random() < 0.5 ? -1 : 1) * 0.11 + Math.cos(a) * 0.07, -0.9 + Math.random() * 0.8, Math.sin(a) * 0.07);
      b.size = 0.05 + Math.random() * 0.08;
      b.mesh.scale.set(b.size, b.size * 0.7, b.size);
      b.mesh.visible = true;
      b.t = COAT.life;
    }
  }

  // Touching mayo: add a little at a time
  touch(dt) {
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    this.cooldown = 0.2;
    this.add(1);
  }

  update(dt) {
    const fx = this.ctx.fx;
    for (const b of this.blobs) {
      if (!b.mesh.visible) continue;
      b.t -= dt;
      if (b.t <= 0) {
        b.mesh.visible = false;
        continue;
      }
      const k = Math.min(1, b.t / 0.6); // shrinks away at the end
      b.mesh.scale.set(b.size * k, b.size * 0.7 * k, b.size * k);
      b.mesh.position.y -= dt * 0.02; // slowly sliding down
      if (Math.random() < dt * 0.6) {
        b.mesh.getWorldPosition(_w);
        fx.smoke(_w.x, _w.y, _w.z, 0, -1, 0, 0.8, 0.12, 0.05, MAYO, MAYO2, -20, 0.2);
      }
    }
  }
}

// A city block buried in mayo: lots of white balls of different sizes heaped over the streets,
// sidewalks and rooftops. Balls fly out of Impregno Man and settle into the heap. The hero can
// wade through it (it shoves the balls aside, slows them down and sticks to them) and blast it
// apart with attacks. Gone after 40 seconds.
export class MayoFlood {
  constructor(ctx, rect) {
    this.ctx = ctx;
    this.rect = rect;
    this.age = 0;
    this.balls = [];
    const world = ctx.world;
    // Target heap: a column of balls on every patch of ground or roof in the block
    let top = 0;
    for (let x = rect.x0 + FLOOD.spacing / 2; x < rect.x1; x += FLOOD.spacing) {
      for (let z = rect.z0 + FLOOD.spacing / 2; z < rect.z1; z += FLOOD.spacing) {
        const jx = x + (Math.random() - 0.5) * FLOOD.spacing * 0.7, jz = z + (Math.random() - 0.5) * FLOOD.spacing * 0.7;
        const base = Math.max(0, world.groundY(jx, jz, 600));
        const depth = (base < 1 ? FLOOD.street : FLOOD.roof) * (0.7 + Math.random() * 0.6);
        for (let y = base; y < base + depth && this.balls.length < FLOOD.max; ) {
          const r = 1.1 + Math.random() * 1.6;
          this.balls.push({
            home: new THREE.Vector3(jx + (Math.random() - 0.5) * 1.5, y + r * 0.8, jz + (Math.random() - 0.5) * 1.5),
            pos: new THREE.Vector3(), vel: new THREE.Vector3(), r, state: 'wait', t: 0,
          });
          y += r * 1.3;
          top = Math.max(top, y);
        }
      }
    }
    this.top = top;
    // Pour from the bottom of the heap up
    this.balls.sort((a, b) => a.home.y - b.home.y);
    this.balls.forEach((b, i) => (b.t = (i / this.balls.length) * FLOOD.pour));
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 7), mayoMat, this.balls.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    for (let i = 0; i < this.balls.length; i++) this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    ctx.scene.add(this.mesh);
    this.source = null; // where the balls come from (Impregno Man's hips) while pouring
    this.wadeT = 0;
  }

  // Throw a ball from the source on an arc that lands on its spot in the heap.
  launch(b) {
    const from = this.source;
    b.pos.copy(from).add(_w.set((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6));
    const T = 0.9 + Math.random() * 0.6, g = 30;
    b.vel.set((b.home.x - b.pos.x) / T, (b.home.y - b.pos.y) / T + 0.5 * g * T, (b.home.z - b.pos.z) / T);
    b.land = T;
    b.state = 'fly';
  }

  // Attacks blow the balls around
  blast(p, r) {
    if (p.x < this.rect.x0 - r || p.x > this.rect.x1 + r || p.z < this.rect.z0 - r || p.z > this.rect.z1 + r) return;
    for (const b of this.balls) {
      if (b.state !== 'rest') continue;
      _v.subVectors(b.pos, p);
      const d = _v.length();
      if (d > r + b.r) continue;
      if (d < 1e-3) _v.set(0, 1, 0);
      _v.normalize();
      const k = (1 - Math.min(1, d / (r + b.r))) * 25 + 6;
      b.vel.set(_v.x * k, Math.abs(_v.y) * k + 6 + Math.random() * 6, _v.z * k);
      b.state = 'loose';
    }
  }

  // Returns false once it has melted away.
  update(dt) {
    this.age += dt;
    const world = this.ctx.world, player = this.ctx.player, mesh = this.mesh;
    const fade = this.age > FLOOD.life - 2 ? Math.max(0, (FLOOD.life - this.age) / 2) : 1;
    // Is the hero in the heap? (cheap box test first)
    const pp = player.pos, R = this.rect;
    const near = pp.x > R.x0 - 4 && pp.x < R.x1 + 4 && pp.z > R.z0 - 4 && pp.z < R.z1 + 4 && pp.y < this.top + 3;
    let touching = false;
    _u.set(pp.x, pp.y + 1, pp.z);
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (b.state === 'wait') {
        b.t -= dt;
        if (b.t <= 0 && this.source) this.launch(b);
        else continue;
      }
      if (b.state === 'fly') {
        b.land -= dt;
        b.vel.y -= 30 * dt;
        b.pos.addScaledVector(b.vel, dt);
        if (b.land <= 0) {
          b.pos.copy(b.home);
          b.state = 'rest';
        }
      } else if (b.state === 'loose') {
        // Knocked loose: falls and settles wherever it lands
        b.vel.y -= 30 * dt;
        b.pos.addScaledVector(b.vel, dt);
        const floor = Math.max(world.floorAt(b.pos.x, b.pos.z), b.vel.y < 0 ? world.groundY(b.pos.x, b.pos.z, b.pos.y + 1) : -1e9) + b.r * 0.8;
        if (b.pos.y < floor) {
          b.pos.y = floor;
          b.state = 'rest';
          if (Math.random() < 0.3) this.ctx.mayo.add(_w.set(b.pos.x, floor - b.r * 0.8, b.pos.z), UP, b.r * 1.8);
        }
      }
      // Wading: the hero shoves balls aside and gets mayo on them
      if (near && b.state === 'rest') {
        _v.subVectors(b.pos, _u);
        const d = _v.length(), min = b.r + 0.7;
        if (d < min) {
          touching = true;
          _v.y *= 0.3;
          if (_v.lengthSq() < 1e-4) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          b.pos.addScaledVector(_v.normalize(), (min - d) * 0.5);
        }
      }
      const s = b.r * fade;
      mesh.setMatrixAt(i, _m.compose(b.pos, _q.identity(), _s.set(s, s * 0.9, s)));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (touching) {
      this.ctx.mayoCoat?.touch(dt);
      // Thick, sticky going: lose about half the movement this frame
      player.pos.addScaledVector(player.vel, -dt * 0.55);
      this.wadeT -= dt;
      if (this.wadeT <= 0) {
        this.wadeT = 0.15;
        this.ctx.fx.smoke(pp.x, pp.y + 0.5, pp.z, (Math.random() - 0.5) * 3, 2, (Math.random() - 0.5) * 3, 0.6, 0.5, 0.2, MAYO, MAYO2, -20, 0.5);
      }
    }
    if (this.age >= FLOOD.life) {
      this.ctx.scene.remove(mesh);
      mesh.dispose();
      return false;
    }
    return true;
  }
}

export class ImpregnoMan {
  constructor(ctx, x, y, z) {
    this.ctx = ctx;
    const rig = createRig('hero', { preferModel: ctx.useModels !== false });
    // Mayo-jar costume: cream suit, ketchup-red trim
    rig.paint(['#f3e7bd', '#c8102e', '#e0ac85', '#2a1a10', '#1a1a1a', '#c8102e'], { glow: '#fff1b0', lines: true });
    this.rig = rig;
    const root = rig.root;
    root.scale.setScalar(SCALE);
    this.buildJetpack();
    this.buildBeam();

    const e = ctx.enemies.base('impregno', root, new THREE.Vector3(x, y, z), rig.material);
    e.boss = this;
    e.bossName = 'IMPREGNO MAN';
    e.mapColor = '#fff3b0';
    this.e = e;
    this.vel = new THREE.Vector3();
    this.toP = new THREE.Vector3();
    this.state = 'arrive';
    this.stateT = 0;
    this.sprayCd = 2;
    this.beamCd = 7;
    this.floodCd = FLOOD.first;
    this.flood = null; // { rect, hover } while doing the mayo flood
    this.orbit = Math.atan2(x - ctx.player.pos.x, z - ctx.player.pos.z);
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.dashT = 3;
    this.dripT = 0;
    this.fireT = 0;
    this.blobs = [];
    this.beamDir = new THREE.Vector3(0, 0, -1);
    this.beamTick = 0;
    this.hitCalled = false;
    this.anim = 0;
    this.blobMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), mayoMat, 400);
    this.blobMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobMesh.frustumCulled = false;
    this.blobMesh.castShadow = true;
    this.blobMesh.count = 0;
    ctx.scene.add(this.blobMesh);
    ctx.hud.message('IMPREGNO MAN HAS ARRIVED!', 3);
  }

  // ---------------------------------------------------------------- model extras
  buildJetpack() {
    const rig = this.rig, pack = new THREE.Group();
    const tankMat = new THREE.MeshStandardMaterial({ color: '#f7f2e4', roughness: 0.25, metalness: 0.1 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#2d55c8', roughness: 0.4, metalness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: '#8a8f99', roughness: 0.35, metalness: 0.8 });
    const tank = new THREE.CylinderGeometry(0.15, 0.15, 0.55, 14);
    const cap = new THREE.CylinderGeometry(0.11, 0.13, 0.1, 14);
    const nozzle = new THREE.CylinderGeometry(0.07, 0.11, 0.16, 10);
    this.nozzles = [];
    for (const sx of [-0.16, 0.16]) {
      const t = new THREE.Mesh(tank, tankMat);
      t.position.set(sx, 0, 0);
      const c = new THREE.Mesh(cap, capMat);
      c.position.set(sx, 0.32, 0);
      const n = new THREE.Mesh(nozzle, metal);
      n.position.set(sx, -0.35, 0);
      t.castShadow = c.castShadow = n.castShadow = true;
      pack.add(t, c, n);
      const tip = new THREE.Object3D();
      tip.position.set(sx, -0.45, 0);
      pack.add(tip);
      this.nozzles.push(tip);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.06), metal);
    plate.position.z = -0.17;
    pack.add(plate);
    pack.position.set(0, rig.chest.y - 0.05, rig.capeAnchor.z + 0.18);
    rig.body.add(pack);
  }

  buildBeam() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 18, 1, true).translate(0, 0.5, 0), mayoMat);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 18, 1, true).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 1.5, 1.1), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }));
    glow.scale.set(1.6, 1, 1.6);
    g.add(core, glow);
    g.visible = false;
    this.beam = g;
    this.beamCore = core;
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mayoMat);
    this.ball.visible = false;
    this.ctx.scene.add(g, this.ball);
  }

  // Who he's attacking: his rival boss while one is alive, otherwise the hero.
  target() {
    const r = this.rival;
    if (r && !r.e.dead && this.ctx.enemies.list.includes(r.e)) return r.asTarget();
    return this.ctx.player;
  }

  // Impregno Man as another boss's target (looks like the hero to their attack code).
  asTarget() {
    const T = (this.asT ??= {
      pos: new THREE.Vector3(), vel: this.vel, hitR: 1.2, boss: this, knockdown() {},
      takeDamage: (a) => {
        this.ctx.enemies.damage(this.e, a, { type: 'power', noCredit: true });
        return 'hit';
      },
    });
    T.dead = this.e.dead;
    T.pos.copy(this.e.pos);
    return T;
  }

  hips(out) {
    this.rig.spin.getWorldPosition(out);
    return out.addScaledVector(_w.set(-Math.sin(this.e.facing), 0, -Math.cos(this.e.facing)), 0.35 * SCALE);
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    const e = this.e, { world } = this.ctx;
    const player = this.target(); // the hero, or the rival boss (same interface)
    e.stun = 0;
    const toP = this.toP.subVectors(player.pos, e.pos); // own vector: the attacks below use the scratch ones
    const dist = toP.length();
    const aware = !player.dead;
    const bigR = player.hitR ?? 0; // circle further out around something huge
    this.stateT -= dt;
    this.sprayCd -= dt;
    this.beamCd -= dt;
    this.floodCd -= dt;
    this.dashT -= dt;

    // Where he wants to be: circling the hero, a bit above them
    let hover = false;
    switch (this.state) {
      case 'arrive':
        if (dist < ORBIT.radius * 1.6) this.state = 'fly';
        break;
      case 'fly':
        if (aware && this.floodCd <= 0 && !bigR) {
          if (this.pickBlock()) {
            this.state = 'floodGo';
            this.stateT = 15; // give up if he can't get there
          } else this.floodCd = 10;
        } else if (aware && this.beamCd <= 0 && dist < 260 + bigR) {
          this.state = 'charge';
          this.stateT = BEAM.charge;
          this.ctx.hud.callout('MAYO-ME-HA-ME-HAAA!', 'bad');
          this.hitCalled = false;
        } else if (aware && this.sprayCd <= 0 && dist < 180 + bigR) {
          this.state = 'spray';
          this.stateT = SPRAY.time;
        }
        break;
      case 'spray':
        this.fireT -= dt;
        while (this.fireT <= 0) {
          this.fireT += 1 / SPRAY.rate;
          this.shoot();
        }
        if (this.stateT <= 0) {
          this.state = 'fly';
          this.sprayCd = 1.5 + Math.random();
        }
        break;
      case 'charge':
        hover = true;
        this.chargeFx(1 - this.stateT / BEAM.charge);
        if (this.stateT <= 0) {
          this.state = 'beam';
          this.stateT = BEAM.time;
          this.hips(_u);
          this.beamDir.copy(player.pos).setY(player.pos.y + 1).sub(_u).normalize();
          this.ctx.player.shake(0.6, 0.4);
        }
        break;
      case 'floodGo':
        // Fly to the spot above the block
        if (e.pos.distanceTo(this.flood.hover) < 10 || this.stateT <= 0) {
          this.state = 'floodLoad';
          this.stateT = FLOOD.load;
          this.ctx.hud.callout('IMPREGNO MAN IS LOADING UP...', 'bad');
          this.countdown = FLOOD.load + 1;
        }
        break;
      case 'floodLoad': {
        // 10 seconds of loading up: tanks shaking, mayo dribbling, the block marked out below
        this.chargeFx(1 - this.stateT / FLOOD.load);
        const n = Math.ceil(this.stateT);
        if (n < this.countdown) {
          this.countdown = n;
          this.ctx.hud.message(`MAYO FLOOD IN ${n}`, 0.9);
          const R = this.flood.rect;
          for (const [x, z] of [[R.x0, R.z0], [R.x1, R.z0], [R.x0, R.z1], [R.x1, R.z1], [(R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2]]) {
            this.ctx.fx.ring(_w.set(x, Math.max(0, this.ctx.world.groundY(x, z, 600)) + 0.3, z), 0xfff1c0, 16, 0.8);
          }
        }
        if (this.stateT <= 0) {
          this.state = 'floodPour';
          this.stateT = FLOOD.pour + 1;
          this.ball.visible = false;
          const f = new MayoFlood(this.ctx, this.flood.rect);
          this.ctx.mayoFloods.push(f);
          this.flood.heap = f;
          this.ctx.hud.message('MAYO FLOOD!', 1.5);
          this.ctx.player.shake(0.5, 0.6);
        }
        break;
      }
      case 'floodPour': {
        // Releasing the load from his hips onto the block
        const f = this.flood.heap;
        f.source = this.hips(f.sourceV ??= new THREE.Vector3());
        if (Math.random() < 0.6) this.ctx.player.shake(0.1, 0.15);
        if (this.stateT <= 0) {
          f.source = null;
          for (const b of f.balls) if (b.state === 'wait') this.launchLeft(f, b);
          this.flood = null;
          this.state = 'fly';
          this.floodCd = FLOOD.cooldown;
          this.sprayCd = 2;
          this.dashT = 0;
        }
        break;
      }
      case 'beam':
        hover = true;
        this.fireBeam(dt);
        if (this.stateT <= 0) {
          this.state = 'fly';
          this.beam.visible = this.ball.visible = false;
          this.beamCd = BEAM.every + Math.random() * 3;
          this.sprayCd = 1.5;
          this.dashT = 0; // reposition right after
        }
        break;
    }

    // Movement: steer toward the orbit point (or hold still while charging/firing)
    if (this.dashT <= 0) {
      this.dashT = 3 + Math.random() * 3;
      this.orbit += this.orbitDir * (1 + Math.random() * 1.5);
      if (Math.random() < 0.3) this.orbitDir *= -1;
    }
    this.orbit += this.orbitDir * dt * 0.25;
    const orbitR = ORBIT.radius + bigR * 1.3;
    let tx = player.pos.x + Math.sin(this.orbit) * orbitR, tz = player.pos.z + Math.cos(this.orbit) * orbitR;
    const ground = Math.max(world.groundY(tx, tz, 600), 0);
    let ty = clamp(Math.max(player.pos.y + ORBIT.height + bigR * 0.4, ground + 20), 20, 320);
    if (this.flood) ({ x: tx, y: ty, z: tz } = this.flood.hover); // over the block he's flooding
    const want = _u.set(tx - e.pos.x, ty - e.pos.y, tz - e.pos.z);
    const d = want.length();
    if (hover) want.set(0, 0, 0);
    else want.multiplyScalar(Math.min(MAX_SPEED, d * 1.4) / Math.max(d, 1e-3));
    const dv = want.sub(this.vel), dvl = dv.length();
    if (dvl > ACCEL * dt) dv.multiplyScalar((ACCEL * dt) / dvl);
    this.vel.add(dv);
    if (this.vel.length() > MAX_SPEED) this.vel.setLength(MAX_SPEED);
    e.pos.addScaledVector(this.vel, dt);
    // Don't fly through buildings: slide along them (and pop up over them)
    const r = world.resolve(e.pos, 0.7, 2.4, this.vel, dt, 0.6);
    if (r.wall) this.vel.y = Math.max(this.vel.y, 15);
    e.pos.y = Math.max(e.pos.y, world.floorAt(e.pos.x, e.pos.z) + 0.5);
    e.vel.set(0, 0, 0);

    // Face the hero when attacking, otherwise the direction of travel
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const attacking = this.state !== 'fly' && this.state !== 'arrive';
    const yaw = attacking || hs < 8 ? Math.atan2(-toP.x, -toP.z) : Math.atan2(-this.vel.x, -this.vel.z);
    e.facing = lerpAngle(e.facing, yaw, 1 - Math.exp(-8 * dt));
    this.rig.root.position.copy(e.pos);
    this.rig.root.rotation.y = e.facing;
    this.animate(dt, hs, toP, dist);
    this.exhaust(dt);

    e.flash = Math.max(0, e.flash - dt * 6);
    e.mat.emissive.setHex(0xffffff);
    e.mat.emissiveIntensity = e.flash * 0.6;
    this.updateBlobs(dt);
  }

  animate(dt, hs, toP, dist) {
    const still = this.state === 'charge' || this.state === 'beam' || this.state === 'floodLoad' || this.state === 'floodPour';
    const fct = still ? 0 : clamp((hs - 8) / 30, 0, 1);
    const vp = Math.atan2(this.vel.y, Math.max(hs, 1e-3));
    this.anim += dt * 2;
    const sway = Math.sin(this.anim) * 0.12;
    let p = {
      tilt: -(Math.PI / 2 - vp) * fct * 0.85,
      sL: 0.2 + 0.2 * (1 - fct), sR: 0.2 + 0.2 * (1 - fct), eL: 0.5, eR: 0.5, spread: 0.25,
      hL: 0.15 + sway, kL: -0.5 + sway, hR: 0.05 - sway, kR: -0.35, // dangling legs while hovering
    };
    if (this.state === 'spray') {
      const pitch = Math.atan2(toP.y + 1, Math.hypot(toP.x, toP.z));
      Object.assign(p, { tilt: 0, sR: Math.PI / 2 + pitch, eR: 0 });
    } else if (this.state === 'floodLoad' || this.state === 'floodPour') {
      // Squatting over the block, hips pointed down at it, shaking while he loads up
      const shake = this.state === 'floodLoad' ? Math.sin(performance.now() * 0.05) * 0.05 : 0;
      Object.assign(p, { tilt: 0.55 + shake, sL: -0.5, sR: -0.5, eL: 1.6, eR: 1.6, spread: 0.6, hL: 0.9, kL: -1.2, hR: 0.9, kR: -1.2 });
    } else if (this.state === 'charge' || this.state === 'beam') {
      // Hands on hips, legs braced wide, hips thrust toward the hero
      Object.assign(p, { tilt: this.state === 'beam' ? 0.3 : 0.15, sL: -0.5, sR: -0.5, eL: 1.6, eR: 1.6, spread: 0.6, hL: -0.35, kL: -0.4, hR: -0.35, kR: -0.4 });
    }
    this.rig.pose(p, 1 - Math.exp(-10 * dt), dt, null);
  }

  // Mayo exhaust: a creamy plume out of the nozzles and blobs dripping down onto the city.
  exhaust(dt) {
    const fx = this.ctx.fx;
    const thrust = 0.4 + Math.min(1, this.vel.length() / MAX_SPEED);
    for (const n of this.nozzles) {
      n.getWorldPosition(_w);
      for (let k = 0; k < 2; k++) {
        fx.smoke(_w.x + (Math.random() - 0.5) * 0.2, _w.y, _w.z + (Math.random() - 0.5) * 0.2,
          -this.vel.x * 0.2 + (Math.random() - 0.5) * 2, -6 - Math.random() * 6 * thrust, -this.vel.z * 0.2 + (Math.random() - 0.5) * 2,
          0.5 + Math.random() * 0.3, 0.35, 0.9 * thrust, MAYO, MAYO2, -8, 1.5);
      }
    }
    this.dripT -= dt;
    if (this.dripT <= 0) {
      this.dripT = 0.18 + Math.random() * 0.2;
      const n = this.nozzles[(Math.random() * 2) | 0];
      n.getWorldPosition(_w);
      this.blobs.push({ pos: _w.clone(), vel: new THREE.Vector3(this.vel.x * 0.4, -8, this.vel.z * 0.4), g: 30, r: 0.5 + Math.random() * 0.4, life: 8, drip: true });
    }
  }

  shoot() {
    const player = this.target();
    this.rig.root.updateMatrixWorld(true);
    const from = this.rig.arms[1].hand.getWorldPosition(new THREE.Vector3());
    const d = from.distanceTo(player.pos);
    const to = _w.copy(player.pos).addScaledVector(player.vel, (d / SPRAY.speed) * 0.7);
    to.y += 1;
    const dir = to.sub(from).normalize();
    dir.x += (Math.random() - 0.5) * SPRAY.spread * 2;
    dir.y += (Math.random() - 0.5) * SPRAY.spread * 2 + 0.02;
    dir.z += (Math.random() - 0.5) * SPRAY.spread * 2;
    dir.normalize();
    this.blobs.push({ pos: from, vel: dir.clone().multiplyScalar(SPRAY.speed), g: 10, r: 0.45 + Math.random() * 0.25, life: 3, drip: false });
    this.ctx.fx.smoke(from.x, from.y, from.z, dir.x * 8, dir.y * 8, dir.z * 8, 0.25, 0.4, 0.9, MAYO, MAYO2, 0, 2);
  }

  updateBlobs(dt) {
    const { world, player } = this.ctx, tgt = this.target();
    const mesh = this.blobMesh;
    for (let i = this.blobs.length - 1; i >= 0; i--) {
      const b = this.blobs[i];
      b.life -= dt;
      b.vel.y -= b.g * dt;
      const len = b.vel.length() * dt;
      _u.copy(b.vel).normalize();
      const reach = len + b.r;
      let t = world.raycastHit(b.pos, _u, reach);
      let hit = t < reach;
      let normal = hit ? world.hitNormal : null;
      if (!b.drip && !player.dead) {
        _v.copy(player.pos);
        _v.y += 1;
        const proj = clamp(_w.subVectors(_v, b.pos).dot(_u), 0, len);
        if (_w.copy(b.pos).addScaledVector(_u, proj).distanceTo(_v) < b.r + 0.8 && proj < t) {
          t = proj;
          hit = true;
          normal = null;
          const r = player.takeDamage(SPRAY.dmg, 'normal');
          if (r === 'hit' || r === 'blocked') this.ctx.mayoCoat?.add(2);
          if (r === 'hit' && !this.hitCalled) {
            this.hitCalled = true;
            this.ctx.hud.callout("MAYO'D!", 'bad');
          }
        }
        if (!hit && tgt !== player && !tgt.dead) {
          _v.copy(tgt.pos);
          _v.y += 1;
          const proj = clamp(_w.subVectors(_v, b.pos).dot(_u), 0, len);
          if (_w.copy(b.pos).addScaledVector(_u, proj).distanceTo(_v) < b.r + tgt.hitR && proj < t) {
            t = proj;
            hit = true;
            normal = null;
            tgt.takeDamage(SPRAY.dmg);
          }
        }
      }
      if (hit || b.life <= 0 || b.pos.y < world.floorAt(b.pos.x, b.pos.z)) {
        b.pos.addScaledVector(_u, Math.min(t, len));
        this.splat(b.pos, normal, b.r * (b.drip ? 5 : 4.5));
        this.blobs.splice(i, 1);
        continue;
      }
      b.pos.addScaledVector(_u, len);
    }
    // Draw: blobs stretch along their velocity
    this.blobs.forEach((b, i) => {
      if (i >= 400) return;
      _q.setFromUnitVectors(Y, _u.copy(b.vel).normalize());
      const stretch = 1 + Math.min(2, b.vel.length() / 60);
      mesh.setMatrixAt(i, _m.compose(b.pos, _q, _s.set(b.r, b.r * stretch, b.r)));
    });
    mesh.count = Math.min(400, this.blobs.length);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // Mayo hits something: a splash, and a splat that stays stuck there for 30 seconds.
  splat(p, normal, size) {
    const { fx, world, mayo } = this.ctx;
    for (let i = 0; i < 8; i++) {
      fx.smoke(p.x, p.y + 0.3, p.z, (Math.random() - 0.5) * 8, 2 + Math.random() * 5, (Math.random() - 0.5) * 8, 0.6 + Math.random() * 0.4, 0.4, 0.2, MAYO, MAYO2, -22, 0.4);
    }
    if (normal) mayo.add(p, normal, size);
    else {
      const gy = world.groundY(p.x, p.z, p.y + 0.5);
      if (p.y - gy < 3) mayo.add(_w.set(p.x, gy, p.z), UP, size);
    }
  }

  // ---------------------------------------------------------------- mayo flood
  // A city block near the hero (not the one they're in), with a hover point above it.
  pickBlock() {
    const { player, city, world } = this.ctx;
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
      const x = player.pos.x + Math.cos(a) * d, z = player.pos.z + Math.sin(a) * d;
      if (!city.isLand(x, z)) continue;
      const rect = city.blockAt(x, z);
      if (!rect) continue;
      let roof = 0;
      for (let i = 0; i < 9; i++) {
        roof = Math.max(roof, world.groundY(rect.x0 + ((i % 3) + 0.5) * (rect.x1 - rect.x0) / 3, rect.z0 + (((i / 3) | 0) + 0.5) * (rect.z1 - rect.z0) / 3, 600));
      }
      const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
      this.flood = { rect, hover: new THREE.Vector3(cx, Math.min(320, roof + 30), cz) };
      return true;
    }
    return false;
  }

  // Pouring ended early (e.g. he was beaten): drop the rest of the balls straight down.
  launchLeft(f, b) {
    b.pos.copy(b.home).setY(b.home.y + 20 + Math.random() * 20);
    b.vel.set(0, 0, 0);
    b.state = 'loose';
  }

  // ---------------------------------------------------------------- the special
  chargeFx(k) {
    const fx = this.ctx.fx;
    this.hips(_u);
    this.ball.visible = true;
    this.ball.position.copy(_u);
    this.ball.scale.setScalar(0.3 + k * 1.4 + Math.sin(performance.now() * 0.03) * 0.08);
    for (let i = 0; i < 3; i++) {
      _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(5 + Math.random() * 4);
      fx.spawn(_u.x + _w.x, _u.y + _w.y, _u.z + _w.z, -_w.x * 2.5, -_w.y * 2.5, -_w.z * 2.5, 0.4, 0.5, 0.15, [1, 1, 0.9], [1, 0.95, 0.75], 0, 0);
    }
    if (Math.random() < 0.3) this.ctx.player.shake(0.12 * k, 0.2);
  }

  fireBeam(dt) {
    const { player, world, fx, enemies } = this.ctx, tgt = this.target();
    const from = this.hips(new THREE.Vector3());
    // Track the hero, but only so fast: fly or run sideways to get out of it
    _w.copy(tgt.pos).setY(tgt.pos.y + 1).sub(from).normalize();
    const ang = this.beamDir.angleTo(_w);
    if (ang > 1e-4) {
      _q.setFromUnitVectors(this.beamDir, _w);
      const k = Math.min(1, (BEAM.turn * dt) / ang);
      this.beamDir.applyQuaternion(_q.slerp(new THREE.Quaternion(), 1 - k)).normalize();
    }
    const dir = this.beamDir;
    let t = world.raycastHit(from, dir, BEAM.range);
    let normal = t < BEAM.range ? world.hitNormal : null;
    // A rival boss in the way soaks up the beam
    if (tgt !== player && !tgt.dead) {
      _v.copy(tgt.pos);
      _v.y += 1;
      const proj = _w.subVectors(_v, from).dot(dir);
      if (proj > 0 && proj < t && _w.copy(from).addScaledVector(dir, proj).distanceTo(_v) < tgt.hitR + BEAM.radius) {
        t = Math.max(1, proj - tgt.hitR * 0.6);
        normal = null;
        tgt.takeDamage(BEAM.dps * dt);
      }
    }
    const end = _u.copy(from).addScaledVector(dir, t);
    // Beam mesh from the hips to whatever it hits
    const wob = 1 + Math.sin(performance.now() * 0.04) * 0.08;
    this.beam.visible = this.ball.visible = true;
    this.beam.position.copy(from);
    this.beam.quaternion.setFromUnitVectors(Y, dir);
    this.beam.scale.set(BEAM.radius * wob, t, BEAM.radius * wob);
    this.ball.position.copy(from);
    this.ball.scale.setScalar(1.8 * wob);
    player.shake(tgt === player ? 0.12 : 0.05, 0.2);
    for (let i = 0; i < 4; i++) {
      const s = Math.random() * t;
      fx.smoke(from.x + dir.x * s, from.y + dir.y * s, from.z + dir.z * s, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6,
        0.5, 1.2, 0.4, MAYO, MAYO2, -10, 1);
    }
    // Hero caught in the beam
    _v.copy(player.pos);
    _v.y += 1;
    const proj = clamp(_w.subVectors(_v, from).dot(dir), 0, t);
    if (!player.dead && _w.copy(from).addScaledVector(dir, proj).distanceTo(_v) < BEAM.radius + 1) {
      const r = player.takeDamage(BEAM.dps * dt, 'normal');
      if (r === 'hit' || r === 'blocked') {
        player.vel.addScaledVector(dir, 40 * dt);
        this.ctx.mayoCoat?.touch(dt);
      }
      if (r === 'hit' && !this.hitCalled) {
        this.hitCalled = true;
        this.ctx.hud.callout("MAYO'D!", 'bad');
      }
    }
    // Where it lands: mayo everywhere, and buildings get torn apart
    this.beamTick -= dt;
    if (this.beamTick <= 0) {
      this.beamTick = 0.1;
      for (let i = 0; i < 25; i++) {
        fx.smoke(end.x, end.y, end.z, (Math.random() - 0.5) * 22 - dir.x * 6, Math.random() * 14, (Math.random() - 0.5) * 22 - dir.z * 6,
          0.9 + Math.random() * 0.6, 1.2, 0.5, MAYO, MAYO2, -20, 0.5);
      }
      const n = normal || UP;
      _w.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
      _w.addScaledVector(n, -_w.dot(n)); // spread across the surface
      if (normal) this.ctx.mayo.add(_w.add(end), n, 6 + Math.random() * 5);
      if (normal && Math.abs(normal.y) < 0.5) {
        this.ctx.destruction?.damage(_v.copy(end).addScaledVector(normal, -1.5), 7.5, dir);
        if (Math.random() < 0.3) this.ctx.impacts?.shatter(end, normal, 5);
      }
      enemies.damageRadius(end, 6, 15, 10, 0, { type: 'power', skip: this.e, noCredit: true });
    }
  }

  // ---------------------------------------------------------------- death
  die() {
    if (this.flood?.heap) {
      const f = this.flood.heap;
      f.source = null;
      for (const b of f.balls) if (b.state === 'wait') this.launchLeft(f, b);
    }
    this.flood = null;
    this.state = 'dead';
    this.deathT = 0;
    this.beam.visible = this.ball.visible = false;
    if (!this.e.lastNoCredit) {
      // (beaten by the other boss: bossfight.js announces the winner instead)
      this.ctx.hud.message('IMPREGNO MAN DEFEATED!', 3);
      this.ctx.player.addSuper(100);
    }
    this.vel.y = Math.max(this.vel.y, 6);
  }

  // Jetpack sputters, he spins down and lands in a giant mayo splash. True once he's gone.
  updateDead(dt) {
    if (this.state !== 'dead') this.die();
    const e = this.e, { world, fx } = this.ctx;
    this.deathT += dt;
    if (!this.landed) {
      this.vel.y -= 25 * dt;
      e.pos.addScaledVector(this.vel, dt);
      this.rig.spin.rotation.z += dt * 9;
      const gy = Math.max(world.groundY(e.pos.x, e.pos.z, e.pos.y + 1), world.floorAt(e.pos.x, e.pos.z));
      if (Math.random() < 0.5) this.exhaust(dt);
      if (e.pos.y <= gy || this.deathT > 8) {
        e.pos.y = gy;
        this.landed = true;
        this.deathT = 0;
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          this.ctx.mayo.add(_w.set(e.pos.x + Math.cos(a) * 6, gy, e.pos.z + Math.sin(a) * 6), UP, 7);
        }
        this.ctx.mayo.add(_w.set(e.pos.x, gy, e.pos.z), UP, 14);
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 14;
          fx.smoke(e.pos.x, gy + 1, e.pos.z, Math.cos(a) * s, 3 + Math.random() * 10, Math.sin(a) * s, 1 + Math.random(), 1.4, 0.6, MAYO, MAYO2, -20, 0.5);
        }
        this.ctx.player.shake(0.4, 0.4);
      }
    } else this.rig.spin.rotation.x = Math.min(1.45, this.rig.spin.rotation.x + dt * 4);
    this.rig.root.position.copy(e.pos);
    this.rig.pose({ sL: -0.3, sR: -0.3, eL: 0.3, eR: 0.3, spread: 0.6, hL: 0.3, kL: -0.3, hR: 0.1, kR: -0.1 }, 0.2, dt, null);
    this.updateBlobs(dt);
    if (this.landed && this.deathT > 3) this.rig.root.scale.setScalar(SCALE * Math.max(0.01, 1 - (this.deathT - 3)));
    return this.landed && this.deathT > 4;
  }

  dispose() {
    this.ctx.scene.remove(this.beam, this.ball, this.blobMesh);
    this.blobMesh.dispose();
  }
}

// Brings Impregno Man in some time into the game, and again a while after each defeat.
// Press I to summon him right away.
export class ImpregnoSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.current = null;
    ctx.mayo = new MayoSplats(ctx.scene);
    ctx.mayoCoat = new MayoCoat(ctx);
    ctx.mayoFloods = [];
  }

  summon(at = null) {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2;
    if (at) this.current = new ImpregnoMan(this.ctx, at.x, at.y, at.z);
    else this.current = new ImpregnoMan(this.ctx, p.x + Math.cos(a) * 260, Math.max(60, p.y + 40), p.z + Math.sin(a) * 260);
  }

  update(dt, input) {
    this.ctx.mayo.update(dt);
    this.ctx.mayoCoat.update(dt);
    this.ctx.mayoFloods = this.ctx.mayoFloods.filter((f) => f.update(dt));
    if (this.current && !this.ctx.enemies.list.includes(this.current.e)) {
      this.current.dispose();
      this.current = null;
      this.timer = RESPAWN;
    }
    if (this.current) return;
    this.timer -= dt;
    if (input?.hit('KeyI') || this.timer <= 0) this.summon();
  }
}

export const IMPREGNO_STATS = { hp: HP, r: 1.8, cy: 1.3, mass: 0, scale: SCALE };
