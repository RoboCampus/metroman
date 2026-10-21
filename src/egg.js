import * as THREE from 'three';
import { clamp } from './util.js';

// Warden egg: an alien egg-shaped drone split by a glowing blue seam.
//   - Arrives through a rift in the sky: a spinning portal with flashes and lightning, and the egg
//     slides out of it.
//   - Flies to the hero and, once close, throws a blue holographic sphere cage around everything
//     near it. A hero inside can't leave the cage and can't boost (Shift: super speed sprint /
//     flight boost). Everything else (alien spheres, lasers, the hero's attacks) passes through it.
//   - Inside, the hero is frozen down to a crawl (they have to dodge-roll to get out of a laser's way)
//     and an icy blue fog fills the view.
//   - The cage holds for a while, drops to recharge, and comes back if the hero is still close.
//     Destroying the egg breaks the cage.
// Lives in enemies.list with its own update, like the alien spheres.

const HP = 650;
const SIZE = 2.6; // egg radius at its widest (height is about 2.6x this)
const SPEED = 32;
const CAGE = { trigger: 26, radius: 36, hold: 20, recharge: 6, grow: 0.7 };
const PORTAL = { time: 2.8, radius: 14 };
const SPAWN_FIRST = 18, SPAWN_EVERY = 180;
const BLUE = new THREE.Color(0.35, 0.75, 3);
const ICE = new THREE.Color('#bfe3ff');
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

// Egg profile for a lathe: narrow top, wide lower body
function eggGeometry() {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, a = t * Math.PI;
    const y = -Math.cos(a), r = Math.sin(a) * (1 - 0.18 * y);
    pts.push(new THREE.Vector2(Math.max(1e-3, r * SIZE), y * SIZE * 1.3));
  }
  return new THREE.LatheGeometry(pts, 40);
}
const geo = {
  egg: eggGeometry(),
  seam: new THREE.TorusGeometry(SIZE * 1.06, 0.12, 8, 64),
  halo: new THREE.SphereGeometry(SIZE * 1.9, 20, 14),
  cage: new THREE.IcosahedronGeometry(1, 3),
  portal: new THREE.TorusGeometry(1, 0.06, 8, 64),
  disc: new THREE.CircleGeometry(1, 48),
};
geo.cageLines = new THREE.WireframeGeometry(geo.cage);
const mats = {
  seam: new THREE.MeshBasicMaterial({ color: BLUE, toneMapped: false }),
  halo: new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  portal: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 2.2, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  disc: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.4, 1.4), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
};

// Holographic cage: a fresnel-glow shell plus a slowly turning wire lattice.
function makeCage() {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(geo.cage, new THREE.ShaderMaterial({
    uniforms: { uColor: { value: BLUE }, uPulse: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vY = position.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uPulse; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.5); // (clamped: pow of a negative is NaN, which bloom smears into black squares)
        float scan = 0.5 + 0.5 * sin(vY * 40.0 - uTime * 4.0); // scrolling scan lines
        float a = f * 0.55 + scan * 0.05 + uPulse * 0.35;
        gl_FragColor = vec4(uColor * (0.6 + uPulse), a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  const lines = new THREE.LineSegments(geo.cageLines, new THREE.LineBasicMaterial({
    color: new THREE.Color(0.5, 1.1, 2.6), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  // Icy tint on the inside of the cage (also covers the sky, which ignores the scene fog)
  const inner = new THREE.Mesh(geo.cage, new THREE.MeshBasicMaterial({
    color: ICE, transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false, fog: false,
  }));
  inner.scale.setScalar(0.99);
  g.add(shell, lines, inner);
  g.visible = false;
  return { g, shell, lines, inner };
}

export class WardenEgg {
  constructor(ctx, at) {
    this.ctx = ctx;
    const root = new THREE.Group();
    const shellMat = new THREE.MeshStandardMaterial({ color: '#b9c0cc', roughness: 0.22, metalness: 0.85, emissive: '#ffffff', emissiveIntensity: 0 });
    const egg = new THREE.Mesh(geo.egg, shellMat);
    egg.castShadow = true;
    const seam = new THREE.Mesh(geo.seam, mats.seam);
    seam.rotation.x = Math.PI / 2;
    seam.position.y = -SIZE * 0.1;
    this.halo = new THREE.Mesh(geo.halo, mats.halo.clone());
    root.add(egg, seam, this.halo);
    this.seam = seam;
    this.root = root;
    root.scale.setScalar(0.01);

    // The rift it comes through: spinning rings and a glowing disc, facing the hero
    this.portal = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(geo.portal, mats.portal.clone());
      r.scale.setScalar(PORTAL.radius * (1 - i * 0.18));
      this.portal.add(r);
    }
    this.portalDisc = new THREE.Mesh(geo.disc, mats.disc.clone());
    this.portalDisc.scale.setScalar(PORTAL.radius * 0.95);
    this.portal.add(this.portalDisc);
    this.portal.position.copy(at);
    this.portal.lookAt(ctx.player.pos);
    this.portal.scale.setScalar(0.01);
    this.cage = makeCage();
    ctx.scene.add(this.portal, this.cage.g);

    const e = ctx.enemies.base('egg', root, at.clone(), shellMat);
    e.boss = this;
    e.noBar = true;
    e.mapColor = '#5fb4ff';
    e.scoreValue = 10;
    this.e = e;
    this.vel = new THREE.Vector3();
    this.state = 'rift';
    this.stateT = PORTAL.time;
    this.cageT = 0;
    this.cageK = 0;
    this.cageCenter = new THREE.Vector3();
    this.heroInside = false;
    this.pulse = 0;
    this.chill = 0; // 0..1: how frozen the hero is by this egg's cage
    this.t = 0;
    this.out = new THREE.Vector3(); // direction it comes out of the portal
    this.out.subVectors(ctx.player.pos, at).normalize();
    ctx.hud.callout('A RIFT IS OPENING!', 'bad');
  }

  update(dt) {
    const e = this.e, { player, fx } = this.ctx;
    e.stun = 0;
    this.t += dt;
    this.stateT -= dt;
    // Gentle spin and a pulsing glow
    this.root.rotation.y += dt * 0.8;
    this.halo.material.opacity = 0.1 + 0.05 * Math.sin(this.t * 4) + this.cageK * 0.08;
    mats.seam.color.copy(BLUE).multiplyScalar(1 + 0.4 * Math.sin(this.t * 6));

    switch (this.state) {
      case 'rift':
        this.updateRift(dt);
        break;
      case 'hunt': {
        // Get right up next to the hero
        _v.copy(player.pos);
        _v.y += 6;
        const to = _w.subVectors(_v, e.pos), d = to.length();
        const want = to.multiplyScalar(Math.min(SPEED, d * 1.2) / Math.max(d, 1e-3));
        this.vel.lerp(want, 1 - Math.exp(-2 * dt));
        e.pos.addScaledVector(this.vel, dt);
        this.ctx.world.resolve(e.pos, SIZE, SIZE * 2.6, this.vel, dt, 0);
        this.stateT = Math.max(this.stateT, 0);
        if (this.cageT <= 0 && !player.dead && player.pos.distanceTo(e.pos) < CAGE.trigger) this.raiseCage();
        this.cageT -= dt;
        break;
      }
      case 'caged':
        // Hold position at the centre of the cage
        this.vel.multiplyScalar(Math.exp(-4 * dt));
        e.pos.lerp(this.cageCenter, 1 - Math.exp(-3 * dt));
        if (this.stateT <= 0) this.dropCage(CAGE.recharge);
        break;
    }
    this.updateCage(dt);
    this.root.position.copy(e.pos);
    this.root.position.y += Math.sin(this.t * 1.7) * 0.4;
    e.vel.set(0, 0, 0);
    e.flash = Math.max(0, e.flash - dt * 6);
    e.mat.emissiveIntensity = e.flash * 0.6;
    if (Math.random() < dt * 3) {
      // little blue sparks crawling over the shell
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(SIZE * 1.1).add(e.pos);
      fx.spawn(_v.x, _v.y, _v.z, 0, 0, 0, 0.3, 0.6, 0.1, [0.7, 0.9, 1], [0.2, 0.4, 1], 0, 0);
    }
  }

  // Portal opens with flashes and lightning, the egg slides out, the portal collapses.
  updateRift(dt) {
    const e = this.e, { fx, player } = this.ctx;
    const k = 1 - this.stateT / PORTAL.time; // 0 -> 1
    const open = k < 0.75 ? Math.min(1, k / 0.25) : Math.max(0, 1 - (k - 0.75) / 0.25);
    this.portal.scale.setScalar(Math.max(0.01, open));
    this.portal.children.forEach((r, i) => (r.rotation.z += dt * (2 + i * 1.5) * (i % 2 ? -1 : 1)));
    this.portalDisc.material.opacity = 0.5 * open + 0.2 * Math.random() * open;
    const p = this.portal.position;
    // Lightning crackling around the rim, flashes
    if (Math.random() < dt * 14 * open) {
      const a = Math.random() * Math.PI * 2, b = a + (Math.random() - 0.5) * 2;
      const from = _v.set(Math.cos(a), Math.sin(a), 0).multiplyScalar(PORTAL.radius * open).applyQuaternion(this.portal.quaternion).add(p);
      const to = _w.set(Math.cos(b), Math.sin(b), 0).multiplyScalar(PORTAL.radius * open * (1.2 + Math.random() * 0.8)).applyQuaternion(this.portal.quaternion).add(p);
      fx.bolt(from.clone(), to.clone(), { color: 0x7fb8ff, width: 0.35, life: 0.12, jag: 0.25 });
    }
    if (Math.random() < dt * 5 * open) fx.flash(p, 0x6aa8ff, 2500, 120, 0.15);
    // Giant lightning ripping across the sky from the rift, up to half the map long
    if (!this.struck) {
      this.struck = true; // opening strike: a few at once
      for (let i = 0; i < 4; i++) this.megaBolt(p);
    }
    if (Math.random() < dt * 3.5 * Math.max(open, 0.3)) this.megaBolt(p);
    if (Math.random() < dt * 4) player.shake(0.08, 0.2);
    // Egg emerges during the middle of the opening
    const emerge = clamp((k - 0.3) / 0.45, 0, 1);
    this.root.scale.setScalar(Math.max(0.01, emerge));
    e.pos.copy(p).addScaledVector(this.out, emerge * SIZE * 3);
    if (this.stateT <= 0) {
      this.state = 'hunt';
      this.ctx.scene.remove(this.portal);
      fx.burst(p, 60, { speed: 20, life: 0.6, size: 1.4, c0: [0.8, 0.95, 1], c1: [0.2, 0.4, 1], drag: 2 });
      fx.ring(p, 0x7fb8ff, PORTAL.radius * 1.5, 0.5);
    }
  }

  // One huge forked bolt from the rift: 400-1300 m long, across the sky or down into the city.
  megaBolt(from) {
    const { fx, player } = this.ctx;
    const a = Math.random() * Math.PI * 2, len = 400 + Math.random() * 900;
    const down = Math.random() < 0.6; // most strike down into the city, some streak across the sky
    // Down: lands on the ground len metres away (a long slanting strike); across: stays up in the sky
    const to = down
      ? new THREE.Vector3(from.x + Math.cos(a) * len, 0, from.z + Math.sin(a) * len)
      : from.clone().addScaledVector(_v.set(Math.cos(a), (Math.random() - 0.3) * 0.3, Math.sin(a)).normalize(), len);
    to.y = Math.max(to.y, 0);
    fx.bolt(from.clone(), to, {
      color: 0x8ec4ff, width: 4 + Math.random() * 4, life: 0.3 + Math.random() * 0.2, jag: 0.06,
      segs: 120, maxAmp: Math.min(90, len * 0.07), branches: 3 + ((Math.random() * 4) | 0),
    });
    fx.flash(from, 0x9cc8ff, 6000, 400, 0.25);
    fx.flash(to, 0x9cc8ff, 5000, 300, 0.2);
    if (to.y < 1) fx.burst(to, 30, { speed: 20, life: 0.5, size: 2.5, c0: [0.85, 0.95, 1], c1: [0.3, 0.5, 1], drag: 2 });
    const d = Math.min(player.pos.distanceTo(from), player.pos.distanceTo(to));
    player.shake(0.45 * Math.max(0.25, 1 - d / 800), 0.35); // thunder
  }

  raiseCage() {
    this.state = 'caged';
    this.stateT = CAGE.hold;
    this.cageCenter.copy(this.e.pos);
    this.cageK = 0;
    this.cage.g.visible = true;
    this.cage.g.position.copy(this.cageCenter);
    _v.copy(this.ctx.player.pos);
    _v.y += 1;
    this.heroInside = _v.distanceTo(this.cageCenter) < CAGE.radius;
    this.ctx.fx.flash(this.cageCenter, 0x6aa8ff, 3000, 80, 0.4);
    this.ctx.fx.ring(this.cageCenter, 0x7fb8ff, CAGE.radius, 0.5);
    if (this.heroInside) this.ctx.hud.callout('CAGED! BOOST DISABLED', 'bad');
  }

  dropCage(recharge) {
    this.state = 'hunt';
    this.cageT = recharge;
    this.heroInside = false;
  }

  updateCage(dt) {
    const caged = this.state === 'caged';
    this.cageK = caged ? Math.min(1, this.cageK + dt / CAGE.grow) : Math.max(0, this.cageK - dt / 0.4);
    const g = this.cage.g;
    g.visible = this.cageK > 0.001;
    if (!g.visible) return;
    const R = CAGE.radius * (caged ? 1 - (1 - this.cageK) ** 3 : this.cageK);
    g.scale.setScalar(Math.max(0.01, R));
    this.cage.lines.rotation.y += dt * 0.15;
    this.cage.lines.material.opacity = 0.35 * this.cageK + this.pulse * 0.4;
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    this.cage.shell.material.uniforms.uPulse.value = this.pulse;
    this.cage.shell.material.uniforms.uTime.value = this.t;
    this.chill = caged && this.heroInside ? this.cageK : 0;
    this.cage.inner.material.opacity = 0.22 * this.chill;
    if (!caged || !this.heroInside) return;
    // Keep the hero inside and grounded to normal speed
    const player = this.ctx.player;
    player.caged = 0.15;
    _v.copy(player.pos);
    _v.y += 1;
    _w.subVectors(_v, this.cageCenter);
    const d = _w.length(), lim = CAGE.radius - 1; // full size even while the hologram grows in
    if (d > lim && d > 1e-3) {
      _w.multiplyScalar(1 / d);
      player.pos.addScaledVector(_w, lim - d);
      const out = player.vel.dot(_w);
      if (out > 0) player.vel.addScaledVector(_w, -out * 1.6); // bounce back off the wall
      if (this.pulse < 0.3) {
        this.pulse = 1;
        _v.copy(this.cageCenter).addScaledVector(_w, lim);
        this.ctx.fx.burst(_v, 16, { speed: 6, life: 0.35, size: 0.7, c0: [0.8, 0.95, 1], c1: [0.2, 0.45, 1] });
      }
    }
  }

  die() {
    this.state = 'dead';
    this.dropCage(0);
    this.ctx.hud.callout('CAGE BROKEN!', 'good');
    const p = this.e.pos, fx = this.ctx.fx;
    fx.burst(p, 90, { speed: 24, life: 0.8, size: 1.8, size1: 0.3, c0: [0.85, 0.95, 1], c1: [0.2, 0.4, 1], drag: 2 });
    fx.flash(p, 0x6aa8ff, 3000, 90, 0.5);
    for (let i = 0; i < 6; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(10 + Math.random() * 8).add(p);
      fx.bolt(p.clone(), _v.clone(), { color: 0x7fb8ff, width: 0.4, life: 0.2, jag: 0.3 });
    }
    this.ctx.scene.remove(this.portal);
  }

  // Shell cracks open along the seam and the egg shrinks away. True when gone.
  updateDead(dt) {
    if (this.state !== 'dead') this.die();
    this.t += dt;
    this.updateCage(dt);
    const s = Math.max(0.01, this.root.scale.x - dt * 1.6);
    this.root.scale.setScalar(s);
    this.root.rotation.y += dt * 8;
    return s <= 0.02 && this.cageK <= 0;
  }

  dispose() {
    this.ctx.scene.remove(this.portal, this.cage.g);
    this.e.mat.dispose();
  }
}

// Warden eggs come through a rift in the sky near the hero (first 18 s in, then every 3 minutes,
// just after each alien sphere wave). O summons one now.
export class EggSpawner {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = SPAWN_FIRST;
    this.list = [];
    this.frost = 0;
    const fog = ctx.scene.fog;
    this.fogBase = fog ? { color: fog.color.clone(), near: fog.near, far: fog.far } : null;
    this.overlay = typeof document !== 'undefined' ? document.getElementById('frost') : null;
    this.mistT = 0;
  }

  // Freezing fog while the hero is caged: the scene fog turns icy blue and closes in, frost creeps
  // over the screen edges, and cold mist and ice glitter drift around the hero.
  updateFrost(dt) {
    let want = 0;
    for (const g of this.list) want = Math.max(want, g.chill);
    this.frost += (want - this.frost) * (1 - Math.exp(-(want > this.frost ? 2.5 : 1.5) * dt));
    if (this.frost < 0.002) this.frost = 0;
    const k = this.frost, fog = this.ctx.scene.fog, base = this.fogBase;
    if (fog && base) {
      fog.color.copy(base.color).lerp(ICE, k);
      fog.near = base.near + (2 - base.near) * k;
      fog.far = base.far + (150 - base.far) * k;
    }
    if (this.overlay) this.overlay.style.opacity = (k * 0.85).toFixed(3);
    if (k < 0.2) return;
    const { fx, player } = this.ctx;
    this.mistT -= dt;
    if (this.mistT > 0) return;
    this.mistT = 0.05;
    const p = player.pos, a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 10;
    fx.smoke(p.x + Math.cos(a) * r, p.y + Math.random() * 4, p.z + Math.sin(a) * r, (Math.random() - 0.5) * 1.5, 0.3, (Math.random() - 0.5) * 1.5,
      3, 2.5, 6, [0.82, 0.92, 1], [0.7, 0.85, 1], 0.1, 0.5);
    fx.spawn(p.x + (Math.random() - 0.5) * 6, p.y + Math.random() * 3, p.z + (Math.random() - 0.5) * 6, 0, -0.4, 0, 1.2, 0.18, 0.05,
      [0.9, 0.97, 1], [0.5, 0.75, 1], -1, 0.5);
  }

  spawn() {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 60;
    const at = new THREE.Vector3(p.x + Math.cos(a) * d, Math.max(p.y, 0) + 70 + Math.random() * 30, p.z + Math.sin(a) * d);
    this.list.push(new WardenEgg(this.ctx, at));
  }

  update(dt, input) {
    const enemies = this.ctx.enemies;
    this.list = this.list.filter((g) => {
      if (enemies.list.includes(g.e)) return true;
      g.dispose();
      return false;
    });
    this.updateFrost(dt);
    if (this.enabled === false) return; // switched off (main.js)
    this.timer -= dt;
    if (input?.hit('KeyO') || this.timer <= 0) {
      this.spawn();
      if (this.timer <= 0) this.timer = SPAWN_EVERY;
    }
  }
}

export const EGG_STATS = { hp: HP, r: SIZE * 1.15, cy: 0, mass: 0.05, scale: SIZE / 0.6 };
