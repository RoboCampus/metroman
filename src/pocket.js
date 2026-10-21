import * as THREE from 'three';
import { World } from './collision.js';
import { Kaiju } from './kaiju.js';
import { alienModel } from './alien.js';
import { towerTexture } from './watcher.js';
import { buildModel as carModel, PALETTE as CAR_COLORS } from './vehicles.js';
import { Squid } from './squid.js';
import { MANHATTAN } from './city.js';

// The pocket dimension: where the Watcher puts everything he erases (his recycle bin).
// Fly into the white sphere he makes during a lift (the point the building's top half is pulled
// into) and you're pulled in with it. Inside: a huge round floor sealed under a crackling electric
// dome, floating in a dark void among countless other domes like it, littered with what he threw
// away - a whole ruined city (a grid of streets with abandoned cars, every lot a broken building as tall as the real ones, or a pile of
// rubble), pieces of buildings hanging frozen in the air, wrecked spaceships, dead kaijus. Nothing in here moves. Every lift adds the erased blocks as a fresh heap of rubble (the
// last few are kept). A white sphere in the middle takes you back to where you came in.
// Five squids patrol the dome hunting anything alive (squid.js). The ruins can be smashed: punches,
// slams and the squids' beams knock blocks out of them (destruction.js hands its damage calls to
// this file while you're inside).
// Die in here and you come back at the way in. Die a third time and, a few seconds later, the
// blue man himself comes: he appears in front of you crackling with lightning and follows you,
// pours it into you (you can barely move) until you glow white, and after a long white-out fires
// you into New York at 1600 km/h, straight through the buildings.
//
// It's built (once, the first time you go in) far below the city, with its own collision world;
// while you're inside the city is hidden and its systems are paused (see main.js).

const O = new THREE.Vector3(0, -5000, 0); // the middle of the floor
const R = 1300; // radius of the floor and of the dome over it
const ENTRY = new THREE.Vector3(0, 80, 900); // where you arrive (relative to O), facing the middle
const EXIT = { at: new THREE.Vector3(0, 16, 0), r: 10 }; // the way back: low enough for a speedster to run into
const HEAPS = [[0, 720], [-200, 760], [200, 760], [-120, 600], [120, 600]]; // where the newest lifted blocks land
const MAX_HEAPS = 4;
const FOG = ['#140f26', 450, 3000];
// The ruined city: blocks of `block` m between `street` m streets (a street runs through the middle),
// each block split into 2 or 4 lots. A lot holds a broken building made of `ruin` blocks, or rubble.
const CITY = { block: 100, street: 30, gap: 4, plaza: 170, empty: 0.12, cars: [40, 160], ruin: [7.5, 6, 7.5] };
const FLOORS = [[0.35, 1, 5], [0.4, 6, 18], [0.25, 19, 42]]; // share of lots, floors from / to: stumps, mid-rise, towers (up to 250 m)
const SQUIDS = 5;
// The third death: `wait` s after it (the hero respawns as usual meanwhile) he fades in `dist` m in
// front of them and follows them; lightning pours from his hands into them (zap: they move at `slow`
// of their speed), then `white` s of white screen, and they're thrown back to the city
// at `speed` (m/s) for `time` s: from `out` m off one tip of Manhattan, `height` m up (rising by
// `lift` m/s), up the length of the island, smashing through everything in the way.
const PUNISH = { deaths: 3, wait: 5, appear: [0, 1.4], zap: [1.8, 4.8], launch: 5, dist: 32, rise: 11, slow: 0.12, white: 5, speed: 1600 / 3.6, time: 5, out: 500, height: 70, lift: 18, smash: 7, fall: 30, fallMax: 20 }; // fall: m/s² once the throw runs out
const GRACE = 5; // seconds the squids leave you alone after a respawn
const ramp = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const DEBRIS = 1200; // flying blocks knocked out of the ruins (the oldest are reused)
const TILE = 330; // blocks are drawn in tiles of this size so the ones off screen are skipped
// The other domes out in the void, as far as the eye can see (the camera sees further while inside)
const OTHERS = { n: 450, dist: [5000, 27000], size: [0.55, 1.4], spacing: 2.6, far: 32000 };
const FLOAT = { n: 70, loose: 800, height: [60, 700] }; // building parts hanging in the air
const WHITE = { in: [3, 2], out: [0, 1.6] }; // white screen when going in / out: seconds fully white, seconds fading
const BLOCK = [4, 3.6, 4]; // building chunks are made of the same blocks as the Watcher's tower
const FACADES = ['#d9cbb0', '#b5654a', '#9aa3ad', '#7f8fa6', '#cfc6b8', '#8a7a6a', '#6f8296'];
// A hidden block: tiny and far out of sight. (Not scale 0: that breaks the lighting maths and the
// broken pixels bloom into a bright square.)
const HIDDEN = new THREE.Matrix4().makeScale(1e-3, 1e-3, 1e-3).setPosition(0, -1e6, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const rand = (a, b) => a + Math.random() * (b - a);

// The dome: an electric field, faint except for the veins of energy crawling over it and where
// it's touched.
function domeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHit: { value: new THREE.Vector3() }, uHitK: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uHit; uniform float uHitK;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.5); // (clamped: pow of a negative is NaN, which bloom smears into black squares)
        vec3 q = vW * 0.006;
        float arcs = abs(sin(q.x * 3.1 + sin(q.y * 2.3 + uTime * 1.8) * 2.0) * sin(q.z * 2.7 + sin(q.x * 1.7 - uTime * 1.4) * 2.0));
        float flicker = 0.55 + 0.45 * sin(uTime * 23.0 + q.x * 7.0) * sin(uTime * 17.0 - q.z * 5.0);
        float veins = smoothstep(0.965, 1.0, 1.0 - arcs) * flicker;
        float fine = smoothstep(0.985, 1.0, 1.0 - abs(sin(q.y * 14.0 + sin(q.x * 5.0 + uTime) + uTime * 0.7)));
        float near = uHitK * exp(-distance(vW, uHit) / 40.0);
        float a = 0.02 + f * 0.22 + veins * 0.32 + fine * 0.05 + near * (0.25 + veins);
        gl_FragColor = vec4(vec3(0.45, 0.72, 2.3) * (0.8 + near), a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// The other domes: the same electric field seen from far away. Mostly a glowing rim, with the
// veins fading out with distance (they'd only shimmer).
function farDomeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vL; varying float vD;
      void main() {
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vec4 wp = modelMatrix * lp;
        vL = position;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vD = distance(cameraPosition, wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vL; varying float vD;
      void main() {
        float f = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.5); // (clamped: pow of a negative is NaN, which bloom smears into black squares)
        vec3 q = vL * 8.0;
        float arcs = abs(sin(q.x * 3.1 + sin(q.y * 2.3 + uTime * 1.8) * 2.0) * sin(q.z * 2.7 + sin(q.x * 1.7 - uTime * 1.4) * 2.0));
        float veins = smoothstep(0.95, 1.0, 1.0 - arcs) * (1.0 - smoothstep(5000.0, 12000.0, vD));
        float far = 1.0 - 0.75 * smoothstep(6000.0, 27000.0, vD);
        gl_FragColor = vec4(vec3(0.45, 0.72, 2.3), (0.008 + f * 0.22 + veins * 0.18) * far);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// Dark tiles with faintly glowing seams.
function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#26232f';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 10, 2 + Math.random() * 10);
  }
  g.fillStyle = '#7fb4ff';
  g.fillRect(0, 0, 128, 2);
  g.fillRect(0, 0, 2, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set((R * 2) / 20, (R * 2) / 20);
  t.anisotropy = 8;
  return t;
}

export class Pocket {
  constructor(ctx) {
    this.ctx = ctx;
    this.inside = false;
    this.built = false;
    this.O = O;
    this.R = R;
    this.squids = [];
    this.squidList = []; // enemies.list while you're inside (the squids)
    this.alarmT = -99;
    this.deaths = 0; // deaths in here since the last punishment
    this.graceT = 0;
    this.punish = null; // the third-death scene while it plays
    this.pendingThrow = null; // the white-out before that flight
    this.thrown = null; // the flight back across the city afterwards
    this.glowSaved = new Map(); // the hero's own emissive colours while they glow white
    this.heaps = []; // { pieces, mesh } - the blocks of the last few lifts, newest last
    this.heapN = 0;
    this.returnTo = new THREE.Vector3();
    this.veilT = 0; // seconds of white screen left
    this.veilFade = 1;
    this.veil = document.createElement('div');
    Object.assign(this.veil.style, { position: 'fixed', inset: '0', background: '#fff', opacity: '0', pointerEvents: 'none', zIndex: '40' });
    document.body.appendChild(this.veil);
  }

  // ---------------------------------------------------------------- going in and out
  // from: where the white sphere was (you come back out there)
  enter(from) {
    if (this.inside) return;
    const { ctx } = this, { player, scene } = ctx;
    // He finishes erasing on the spot: the blocks fall in with you
    if (ctx.watcher?.active) ctx.watcher.leave();
    if (!this.built) this.build();
    this.returnTo.copy(from);
    this.inside = true;
    this.cityWorld = ctx.world;
    ctx.world = this.world;
    // The enemies in here are the squids: they take the city's place in enemies.list
    this.cityEnemies = ctx.enemies.list;
    ctx.enemies.list = this.squidList;
    for (const o of ctx.cityObjects ?? []) {
      o.userData.pocketWasVisible = o.visible;
      o.visible = false;
    }
    this.saved = { fog: scene.fog, background: scene.background, sky: ctx.sky?.visible, sun: ctx.sun?.color.clone(), sunI: ctx.sun?.intensity, hemiI: ctx.hemi?.intensity };
    scene.fog = this.fog;
    scene.background = this.fog.color;
    if (ctx.sky) ctx.sky.visible = false;
    this.saved.far = ctx.camera.far;
    ctx.camera.far = OTHERS.far; // (the other domes are far away)
    ctx.camera.updateProjectionMatrix();
    ctx.sun?.color.set('#dbe4ff');
    if (ctx.sun) ctx.sun.intensity = 1.5;
    if (ctx.hemi) ctx.hemi.intensity = 0.7;
    this.group.visible = true;
    player.pos.copy(O).add(ENTRY);
    player.vel.set(0, 0, 0);
    player.launchT = 0;
    player.path.length = 0;
    player.yaw = 0; // facing the middle
    player.pitch = -0.08;
    this.t = 0;
    this.hinted = false;
    this.whiteout(WHITE.in);
    this.spawnSquids();
    player.shake(0.8, 0.8);
    ctx.hud.message('THE POCKET DIMENSION', 3.5);
    ctx.hud.callout('WHERE HE KEEPS EVERYTHING HE ERASES', 'bad');
  }

  exit() {
    if (!this.inside) return;
    const { ctx } = this, { player, scene } = ctx;
    this.inside = false;
    ctx.world = this.cityWorld;
    ctx.enemies.list = this.cityEnemies;
    for (const o of ctx.cityObjects ?? []) o.visible = o.userData.pocketWasVisible ?? true;
    const s = this.saved;
    scene.fog = s.fog;
    scene.background = s.background;
    if (ctx.sky) ctx.sky.visible = s.sky;
    ctx.camera.far = s.far;
    ctx.camera.updateProjectionMatrix();
    if (ctx.sun) {
      ctx.sun.color.copy(s.sun);
      ctx.sun.intensity = s.sunI;
    }
    if (ctx.hemi) ctx.hemi.intensity = s.hemiI;
    this.group.visible = false;
    player.pos.copy(this.returnTo);
    player.vel.set(0, 0, 0);
    player.path.length = 0;
    this.whiteout(WHITE.out);
    player.shake(0.8, 0.8);
    ctx.hud.callout('BACK IN NEW YORK', 'good');
  }

  whiteout([hold, fade]) {
    this.veilT = hold + fade;
    this.veilFade = fade;
  }

  update(dt) {
    this.veilT = Math.max(0, this.veilT - dt);
    const k = Math.min(1, this.veilT / this.veilFade);
    this.veil.style.opacity = String(k * k);
    if (this.pendingThrow) this.updatePendingThrow(dt);
    if (this.thrown) this.updateThrown(dt);
    if (!this.inside) return;
    const { player, fx, hud } = this.ctx;
    this.t += dt;
    this.graceT -= dt;
    if (player.dead && !this.wasDead) this.onDeath();
    this.wasDead = player.dead;
    if (this.punish) {
      this.updatePunish(dt);
      if (!this.inside) return;
    }
    if (!this.hinted && this.t > 5) {
      this.hinted = true;
      hud.callout('THE WHITE SPHERE IN THE MIDDLE LEADS BACK', 'good');
    }
    // The way out: a pulsing white sphere, light streaming into it
    const ex = _v.copy(O).add(EXIT.at);
    this.exitOrb.scale.setScalar(EXIT.r * (1 + Math.sin(this.t * 6) * 0.06));
    if (Math.random() < dt * 30) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(30 + Math.random() * 30);
      fx.spawn(ex.x + d.x, ex.y + d.y, ex.z + d.z, -d.x / 0.8, -d.y / 0.8, -d.z / 0.8, 0.8, 1.2, 0.2, [0.6, 0.8, 1], [1, 1, 1], 0, 0);
    }
    this.updateDome(dt);
    this.updateDebris(dt);
    if (!this.punish && _c2.copy(player.pos).setY(player.pos.y + 1).distanceTo(ex) < EXIT.r + 2) this.exit(); // (no escaping him)
    // Fell out somehow (e.g. a respawn put the hero back in the city): just restore the city
    else if (Math.abs(player.pos.y - O.y) > 1500) {
      const back = player.pos.clone();
      this.exit();
      player.pos.copy(back);
    }
  }

  // The dome: arcs crawling over it, and it throws the hero back if they touch it.
  updateDome(dt) {
    const { player, fx, hud } = this.ctx, u = this.domeMat.uniforms;
    u.uTime.value = this.t;
    this.othersMat.uniforms.uTime.value = this.t;
    u.uHitK.value = Math.max(0, u.uHitK.value - dt * 2);
    if (Math.random() < dt * 5) {
      const a = Math.random() * Math.PI * 2, e = rand(0.05, 1.3), a2 = a + rand(-0.25, 0.25), e2 = Math.min(1.5, Math.max(0.02, e + rand(-0.25, 0.25)));
      const from = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).multiplyScalar(R).add(O);
      const to = new THREE.Vector3(Math.cos(a2) * Math.cos(e2), Math.sin(e2), Math.sin(a2) * Math.cos(e2)).multiplyScalar(R).add(O);
      fx.bolt(from, to, { color: 0x8fc0ff, width: 2 + Math.random() * 3, life: 0.2 + Math.random() * 0.2, jag: 0.12, segs: 40, maxAmp: 30, branches: 2 });
    }
    const n = _c2.copy(player.pos).setY(player.pos.y + 1).sub(O), d = n.length(), lim = R - 4;
    if (d < lim || player.dead) return;
    n.multiplyScalar(1 / d);
    player.pos.addScaledVector(n, lim - d);
    const out = player.vel.dot(n);
    if (out > 0) player.vel.addScaledVector(n, -out * 1.8);
    player.launchT = 0;
    const hit = n.clone().multiplyScalar(R).add(O);
    u.uHit.value.copy(hit);
    u.uHitK.value = 1;
    player.shake(0.9, 0.5);
    if (Math.random() < dt * 20) {
      fx.bolt(hit.clone(), new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(60).add(hit), { color: 0x7fb8ff, width: 0.9, life: 0.12, jag: 0.2 });
      fx.burst(hit, 6, { speed: 10, life: 0.3, size: 0.6, c0: [0.8, 0.95, 1], c1: [0.2, 0.45, 1] });
    }
    if (!this.domeMsg) {
      this.domeMsg = true;
      hud.callout('THE DOME HOLDS YOU IN', 'bad');
    }
  }

  // ---------------------------------------------------------------- dying in here
  calm() {
    return this.t < 7 || this.graceT > 0 || !!this.punish;
  }

  respawnPoint() {
    this.graceT = GRACE;
    return _c2.copy(O).add(ENTRY);
  }

  onDeath() {
    this.deaths++;
    const { player, hud } = this.ctx;
    if (this.deaths < PUNISH.deaths) {
      hud.callout(`YOU DIED IN HIS POCKET (${this.deaths}/${PUNISH.deaths})`, 'bad');
      return;
    }
    // The third time he comes himself, a few seconds later
    hud.callout(`YOU DIED IN HIS POCKET (${this.deaths}/${PUNISH.deaths})`, 'bad');
    this.punish = { t: -PUNISH.wait };
  }

  // The hero's whole body glowing white (k: 0..1; 0 puts their own colours back).
  heroGlow(k) {
    this.ctx.player.root.traverse((o) => {
      const m = o.material;
      if (!o.isMesh || !m?.emissive) return;
      if (!this.glowSaved.has(m)) this.glowSaved.set(m, { c: m.emissive.clone(), i: m.emissiveIntensity });
      const s = this.glowSaved.get(m);
      m.emissive.copy(s.c).lerp(_c.setRGB(1, 1, 1), k);
      m.emissiveIntensity = s.i + (3.5 - s.i) * k;
    });
    if (k <= 0) this.glowSaved.clear();
  }

  updatePunish(dt) {
    const P = this.punish, { player, fx, hud, watcher } = this.ctx;
    if (player.dead) P.t = Math.min(P.t, -0.5); // (waits until the hero is back on their feet)
    P.t += dt;
    if (P.t < 0) return;
    P.eye = (P.eye ?? new THREE.Vector3()).copy(player.pos).setY(player.pos.y + 1);
    if (!P.man) {
      // He appears in front of them (where the camera looks)
      _v.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      P.man = P.eye.clone().addScaledVector(_v, PUNISH.dist);
      P.man.y += PUNISH.rise; // towering over them
      P.prev = player.pos.clone();
      fx.flash(P.man, 0xbfe6ff, 40000, 400, 0.6);
      player.shake(1, 1);
      hud.message('HE HAS COME FOR YOU', 3.5);
    }
    // ...and stays there, following them wherever they go
    _v.subVectors(P.man, P.eye).setY(0);
    if (_v.lengthSq() < 1) _v.set(0, 0, -1);
    _w.copy(P.eye).addScaledVector(_v.normalize(), PUNISH.dist);
    _w.y += PUNISH.rise;
    P.man.lerp(_w, 1 - Math.exp(-1.5 * dt));
    player.immuneT = 0.5;
    // Once the lightning hits them they can barely move
    if (P.t >= PUNISH.zap[0]) {
      player.pos.lerpVectors(P.prev, player.pos, PUNISH.slow); // (only how far they get: their speed is untouched, so it doesn't decay to nothing)
    }
    P.prev.copy(player.pos);
    // Him: fading in, lightning bursting out of him more and more, then both arms on the hero
    const fade = ramp(P.t, PUNISH.appear[0], PUNISH.appear[1]);
    watcher.showMan(P.man, P.eye, fade);
    watcher.posePointing(dt, P.t > PUNISH.zap[0] - 0.5 ? P.eye : null, true);
    const fury = 0.3 + 0.7 * ramp(P.t, 0, PUNISH.zap[0]);
    for (let i = 0, n = Math.round(dt * 70 * fury) + (Math.random() < 0.5 ? 1 : 0); i < n; i++) {
      const from = _v.set(rand(-3, 3), rand(-6, 6), rand(-3, 3)).add(P.man).clone();
      const to = _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(rand(20, 70)).add(from).clone();
      fx.bolt(from, to, { color: 0xa8d8ff, width: rand(0.4, 1.4), life: rand(0.08, 0.2), jag: 0.18, branches: 2 });
    }
    if (Math.random() < dt * 8 * fury) fx.flash(P.man, 0xbfe6ff, 5000 * fury, 300, 0.15);
    // Pouring it into the hero: bolts from both hands, the hero turning white
    const zap = ramp(P.t, PUNISH.zap[0], PUNISH.zap[1]);
    if (P.t >= PUNISH.zap[0]) {
      for (let h = 0; h < 2; h++) {
        for (let i = 0; i < 3; i++) {
          const hand = watcher.handPos(h, _v).clone();
          const hit = _w.copy(P.eye).add(_c2.set(rand(-0.6, 0.6), rand(-0.9, 0.9), rand(-0.6, 0.6))).clone();
          fx.bolt(hand, hit, { color: 0xd8f0ff, width: rand(0.25, 0.7), life: 0.07, jag: 0.12, branches: 1 });
        }
      }
      if (Math.random() < dt * 20) fx.burst(P.eye, 8, { speed: 10, life: 0.3, size: 0.6, c0: [1, 1, 1], c1: [0.5, 0.75, 1] });
      if (Math.random() < dt * 10) fx.flash(P.eye, 0xffffff, 4000 * zap, 120, 0.12);
      player.shake(0.5 + 0.6 * zap, 0.2);
      this.heroGlow(zap);
    }
    if (P.t >= PUNISH.launch) this.eject();
  }

  // Out of the pocket and into New York at 1600 km/h: from out over the water off the tip of
  // Manhattan nearest to where he took the hero in, up the length of the island.
  eject() {
    const { player, fx, hud, watcher } = this.ctx;
    fx.flash(this.punish.eye, 0xffffff, 60000, 800, 0.5);
    this.punish = null;
    this.deaths = 0;
    watcher.showMan(_v.set(0, 0, 0), _w.set(0, 0, 1), 0);
    this.exit();
    const M = MANHATTAN, south = this.returnTo.z > (M.minZ + M.maxZ) / 2;
    const x = Math.max(M.minX + 80, Math.min(M.maxX - 80, this.returnTo.x));
    const start = _v.set(x, PUNISH.height, south ? M.maxZ + PUNISH.out : M.minZ - PUNISH.out);
    const dir = new THREE.Vector3(0, 0, south ? -1 : 1);
    player.pos.copy(start);
    player.yaw = Math.atan2(-dir.x, -dir.z); // (the camera looks ahead: the city coming at them)
    player.pitch = -0.05;
    // A long white-out first; the throw starts as it clears
    this.pendingThrow = { t: PUNISH.white, start: start.clone(), dir };
    this.whiteout([PUNISH.white, 1.2]);
    this.heroGlow(1);
  }

  updatePendingThrow(dt) {
    const T = this.pendingThrow, { player, hud } = this.ctx;
    T.t -= dt;
    player.pos.copy(T.start);
    player.vel.set(0, 0, 0);
    player.immuneT = 0.5;
    if (T.t > 0) return;
    this.pendingThrow = null;
    player.launch(T.dir.clone().multiplyScalar(PUNISH.speed).setY(PUNISH.lift), PUNISH.time);
    this.thrown = { t: PUNISH.time, dir: T.dir };
    hud.message('LAUNCHED BACK TO NEW YORK', 3);
  }

  // The flight: it smashes a hole through everything in the way, a white streak behind it,
  // the glow wearing off.
  updateThrown(dt) {
    const T = this.thrown, { player, fx, destruction } = this.ctx;
    T.t -= dt;
    const k = Math.max(0, T.t / PUNISH.time);
    if (player.dead || (T.falling ?? 0) > PUNISH.fallMax) return this.endThrown();
    // Out of steam (or stopped dead by something that won't break): still helpless, it tumbles on
    // and drops until it hits the ground
    if (!T.falling && (T.t <= 0 || player.launchT <= 0)) {
      T.falling = 1e-6;
      player.launchVel.multiplyScalar(player.launchT <= 0 ? 0 : 0.5).setY(Math.min(player.launchVel.y, 0));
    }
    if (T.falling) {
      T.falling += dt;
      if (player.grounded) return this.endThrown(true);
      player.launchT = 1; // (keeps the controls off and the tumble going)
      player.launchStuck = 0;
      const drag = Math.exp(-1.2 * dt);
      player.launchVel.x *= drag;
      player.launchVel.z *= drag;
      player.launchVel.y -= (PUNISH.fall - 8) * dt; // (the launch already pulls 8 m/s² down)
      if (player.wallContact > 0) player.launchVel.x = player.launchVel.z = 0; // slides down the wall
      return;
    }
    this.heroGlow(k);
    const c = _v.copy(player.pos).setY(player.pos.y + 1);
    destruction?.damage(c.clone().addScaledVector(T.dir, 4), PUNISH.smash, T.dir);
    this.ctx.traffic?.damageRadius(c, PUNISH.smash, 200, 60);
    for (let i = 0; i < 4; i++) fx.spawn(c.x + rand(-1, 1), c.y + rand(-1, 1), c.z + rand(-1, 1), -T.dir.x * 20, rand(-2, 2), -T.dir.z * 20, 0.6, 2.5 * k + 0.5, 0.2, [1, 1, 1], [0.6, 0.8, 1], 0, 2);
    if (Math.random() < dt * 20) fx.bolt(c.clone(), c.clone().addScaledVector(T.dir, -rand(10, 30)).add(_w.set(rand(-4, 4), rand(-4, 4), rand(-4, 4))), { color: 0xd8f0ff, width: 0.5, life: 0.1, jag: 0.2 });
    player.shake(0.7, 0.2);
  }

  endThrown(landed = false) {
    const { player, fx, destruction } = this.ctx;
    this.heroGlow(0);
    this.thrown = null;
    player.launchT = 0;
    player.vel.set(0, 0, 0);
    if (!landed) return;
    // The landing: a crater-making thud
    const c = _v.copy(player.pos).setY(player.pos.y + 0.3);
    fx.ring(c, 0xd8f0ff, 14, 0.5);
    fx.burst(c, 60, { speed: 16, life: 0.7, size: 1.6, c0: [0.75, 0.7, 0.65], c1: [0.25, 0.24, 0.23], drag: 3 });
    destruction?.damage(c.clone(), 4, null);
    this.ctx.impacts?.hit(c.clone(), null, 6, 'elec', 9);
    player.shake(1.2, 0.6);
  }

  // ---------------------------------------------------------------- squids
  // Top them back up to five each time you come in (and calm the survivors down).
  spawnSquids() {
    this.squids = this.squids.filter((q) => !q.e.dead);
    for (const q of this.squids) q.begin('patrol');
    while (this.squids.length < SQUIDS) {
      const a = Math.random() * Math.PI * 2, d = rand(300, R - 300);
      this.squids.push(new Squid(this.ctx, this, new THREE.Vector3(O.x + Math.cos(a) * d, O.y + rand(350, 700), O.z + Math.sin(a) * d)));
    }
  }

  // A squid has seen the hero (one warning for a while, however many of them join in).
  squidAlarm() {
    if (this.t - this.alarmT < 6) return;
    this.alarmT = this.t;
    this.ctx.hud.callout('A SQUID HAS SPOTTED YOU! GET BEHIND A BUILDING!', 'bad');
  }

  // ---------------------------------------------------------------- breaking the ruins
  // Knock every block within `radius` of `point` out of the ruins (they fly off as debris).
  // Same signature as Destruction.damage; returns how many blocks came out.
  damage(point, radius, push = null) {
    if (!this.built) return 0;
    const vols = this.world.query(point.x - radius, point.z - radius, point.x + radius, point.z + radius).filter((v) => v.ruin);
    const touched = new Set(), hit = new Set(), c = new THREE.Vector3();
    let removed = 0;
    for (const v of vols) {
      if (point.y - radius > v.maxY || point.y + radius < v.minY) continue;
      const range = (p, min, size, n) => [Math.max(0, Math.floor((p - radius - min) / size)), Math.min(n - 1, Math.floor((p + radius - min) / size))];
      const [i0, i1] = range(point.x, v.minX, v.sx, v.nx), [j0, j1] = range(point.y, v.minY, v.sy, v.ny), [k0, k1] = range(point.z, v.minZ, v.sz, v.nz);
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          for (let i = i0; i <= i1; i++) {
            const ci = (j * v.nz + k) * v.nx + i;
            if (!v.occ[ci]) continue;
            c.set(v.minX + (i + 0.5) * v.sx, v.minY + (j + 0.5) * v.sy, v.minZ + (k + 0.5) * v.sz);
            // (any block the blast touches comes out)
            const dx = Math.max(0, Math.abs(point.x - c.x) - v.sx / 2), dy = Math.max(0, Math.abs(point.y - c.y) - v.sy / 2), dz = Math.max(0, Math.abs(point.z - c.z) - v.sz / 2);
            if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
            this.unblock(v, ci, touched);
            hit.add(v);
            if (removed++ < 14) this.spawnDebris(c, v, v.ruin.tint, push, point);
          }
        }
      }
    }
    for (const v of hit) removed += this.topple(v, touched);
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
    if (removed) {
      this.ctx.fx.burst(point, Math.min(80, 16 + removed * 3), { speed: 12, life: 0.9, size: 2.5, size1: 4, c0: [0.55, 0.52, 0.5], c1: [0.25, 0.24, 0.24], drag: 2 });
      if (removed > 6) this.ctx.player.shake(0.3, 0.3);
    }
    return removed;
  }

  unblock(v, ci, touched) {
    v.occ[ci] = 0;
    const mesh = v.ruin.mesh[ci];
    if (mesh) {
      mesh.setMatrixAt(v.ruin.idx[ci], HIDDEN);
      touched.add(mesh);
    }
  }

  // Whatever no longer connects down to the ground (through its neighbouring blocks) comes down:
  // cut a ruin through and the part above falls in pieces.
  topple(v, touched) {
    const { nx, ny, nz, occ } = v, n = nx * ny * nz, seen = new Uint8Array(n), stack = [];
    for (let ci = 0; ci < nx * nz; ci++) if (occ[ci]) { seen[ci] = 1; stack.push(ci); }
    while (stack.length) {
      const ci = stack.pop(), i = ci % nx, k = ((ci / nx) | 0) % nz, j = (ci / (nx * nz)) | 0;
      const visit = (cj) => { if (occ[cj] && !seen[cj]) { seen[cj] = 1; stack.push(cj); } };
      if (i > 0) visit(ci - 1);
      if (i < nx - 1) visit(ci + 1);
      if (k > 0) visit(ci - nx);
      if (k < nz - 1) visit(ci + nx);
      if (j > 0) visit(ci - nx * nz);
      if (j < ny - 1) visit(ci + nx * nz);
    }
    const c = new THREE.Vector3();
    let fell = 0;
    for (let ci = 0; ci < n; ci++) {
      if (!occ[ci] || seen[ci]) continue;
      this.unblock(v, ci, touched);
      const i = ci % nx, k = ((ci / nx) | 0) % nz, j = (ci / (nx * nz)) | 0;
      c.set(v.minX + (i + 0.5) * v.sx, v.minY + (j + 0.5) * v.sy, v.minZ + (k + 0.5) * v.sz);
      // Every block falls (nearly whole), so the building comes down rather than vanishing
      const d = this.spawnDebris(c, v, v.ruin.tint, null, c);
      d.vel.set(rand(-2, 2), rand(-3, 0), rand(-2, 2));
      d.size.set(v.sx, v.sy, v.sz).multiplyScalar(rand(0.85, 1));
      d.spin = rand(-1, 1);
      d.life = 9;
      fell++;
      if (fell % 12 === 1) this.ctx.fx.burst(c, 10, { speed: 6, life: 1.4, size: 4, size1: 7, c0: [0.55, 0.52, 0.5], c1: [0.25, 0.24, 0.24], drag: 2 });
    }
    if (fell > 20) {
      this.ctx.player.shake(0.6, 0.8);
    }
    return fell;
  }

  spawnDebris(at, v, tint, push, from) {
    const D = this.debris, i = D.next++ % DEBRIS;
    const out = _v.subVectors(at, from).normalize();
    D.items[i] = {
      pos: at.clone(),
      vel: out.clone().multiplyScalar(rand(6, 18)).addScaledVector(push ?? _c2.set(0, 0, 0), rand(8, 18)).add(_c2.set(0, rand(2, 10), 0)),
      size: new THREE.Vector3(v.sx, v.sy, v.sz).multiplyScalar(rand(0.45, 0.85)),
      rot: new THREE.Quaternion(), axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spin: rand(-6, 6), life: 6,
    };
    D.mesh.setColorAt(i, tint);
    D.mesh.instanceColor.needsUpdate = true;
    return D.items[i];
  }

  // Debris tumbles, falls, bounces on the floor and shrinks away.
  updateDebris(dt) {
    const D = this.debris;
    let any = false;
    D.items.forEach((d, i) => {
      if (!d) return;
      any = true;
      d.life -= dt;
      if (d.life <= 0) {
        D.items[i] = null;
        D.mesh.setMatrixAt(i, HIDDEN);
        return;
      }
      d.vel.y -= 30 * dt;
      d.pos.addScaledVector(d.vel, dt);
      const floor = O.y + d.size.y * 0.4;
      if (d.pos.y < floor) {
        d.pos.y = floor;
        d.vel.set(d.vel.x * 0.55, Math.abs(d.vel.y) * 0.3, d.vel.z * 0.55);
        d.spin *= 0.6;
      }
      d.rot.multiply(_q.setFromAxisAngle(d.axis, d.spin * dt));
      D.mesh.setMatrixAt(i, _m.compose(d.pos, d.rot, _s.copy(d.size).multiplyScalar(Math.min(1, d.life))));
    });
    if (any) D.mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- the trash
  // Every lift ends here: its blocks (from destruction.extract) become a heap of rubble.
  dump(pieces) {
    if (!pieces?.length) return;
    const [hx, hz] = HEAPS[this.heapN++ % HEAPS.length];
    const heap = { pieces: pieces.map((p) => ({ size: p.size.clone(), color: p.color })), x: hx, z: hz };
    this.heaps.push(heap);
    if (this.heaps.length > MAX_HEAPS) this.removeHeap(this.heaps.shift());
    if (this.built) this.makeHeap(heap);
  }

  makeHeap(heap) {
    // Dropped one by one onto a height map, most of them near the middle: a pile
    const n = heap.pieces.length, R = 8 + Math.sqrt(n) * 1.3, cell = 3, tops = new Map();
    let peak = 0;
    const mesh = new THREE.InstancedMesh(this.boxGeo, this.blockMat, n);
    heap.pieces.forEach((p, i) => {
      const r = R * Math.pow(Math.random(), 0.8), a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r, key = Math.round(x / cell) * 1000 + Math.round(z / cell);
      const t = Math.min(p.size.x, p.size.y, p.size.z), h = tops.get(key) ?? 0;
      tops.set(key, h + Math.max(0.6, t) * 0.8);
      peak = Math.max(peak, h);
      _q.setFromEuler(new THREE.Euler(rand(-0.6, 0.6), Math.random() * Math.PI * 2, rand(-0.6, 0.6)));
      mesh.setMatrixAt(i, _m.compose(_v.set(O.x + heap.x + x, O.y + h + t * 0.3, O.z + heap.z + z), _q, p.size));
      mesh.setColorAt(i, _c.set(p.color).lerp(new THREE.Color(1, 1, 1), 0.2));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    this.group.add(mesh);
    heap.mesh = mesh;
    // You can stand on the middle of the pile
    heap.box = this.world.addBox(O.x + heap.x - R * 0.3, O.y, O.z + heap.z - R * 0.3, O.x + heap.x + R * 0.3, O.y + peak * 0.7, O.z + heap.z + R * 0.3);
  }

  removeHeap(heap) {
    if (!heap.mesh) return;
    this.group.remove(heap.mesh);
    heap.mesh.dispose();
    heap.box.disabled = true;
  }

  // ---------------------------------------------------------------- building it
  build() {
    this.built = true;
    this.world = new World(32);
    this.world.floorAt = () => O.y;
    this.fog = new THREE.Fog(...FOG);
    this.group = new THREE.Group();
    this.group.visible = false;
    this.ctx.scene.add(this.group);
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.blockMat = new THREE.MeshStandardMaterial({ map: towerTexture(), roughness: 0.75, metalness: 0.1 });
    this.spots = [{ x: 0, z: 0, r: 90 }, { x: ENTRY.x, z: ENTRY.z, r: 130 }]; // keep the exit and the way in clear
    for (const [x, z] of HEAPS) this.spots.push({ x, z, r: 50 });
    this.blocks = []; // every block of every ruin / chunk / floating part: one instanced mesh at the end
    this.buildDome();
    this.buildVoid();
    this.buildOtherDomes();
    this.buildKaijus();
    this.buildShips();
    this.buildCity();
    this.buildLoose();
    this.buildFloating();
    this.finishBlocks();
    const debris = new THREE.InstancedMesh(this.boxGeo, this.blockMat, DEBRIS);
    for (let i = 0; i < DEBRIS; i++) {
      debris.setMatrixAt(i, HIDDEN);
      debris.setColorAt(i, _c.set('#ffffff'));
    }
    debris.frustumCulled = false;
    debris.castShadow = true;
    this.group.add(debris);
    this.debris = { mesh: debris, items: [], next: 0 };
    for (const h of this.heaps) this.makeHeap(h);
    // The way out
    this.exitOrb = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), new THREE.MeshBasicMaterial({
      color: new THREE.Color(6, 6, 6.5), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false,
    }));
    this.exitOrb.position.copy(O).add(EXIT.at);
    this.group.add(this.exitOrb);
  }

  // A free spot of radius r on the floor (things may overlap a little, like a real junk pile).
  place(r) {
    const lim = R - r - 30;
    let best = null, bestGap = -Infinity;
    for (let i = 0; i < 60; i++) {
      const d = lim * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2, x = Math.cos(a) * d, z = Math.sin(a) * d;
      let gap = Infinity;
      for (const s of this.spots) gap = Math.min(gap, Math.hypot(s.x - x, s.z - z) - s.r - r * 0.7);
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, z, r };
      }
      if (gap > 0) break;
    }
    this.spots.push(best);
    return best;
  }

  // Sit `obj` (already rotated) at x, z on the floor, sunk `sink` metres in.
  settle(obj, x, z, sink = 0) {
    obj.position.set(0, 0, 0);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(O.x + x - (box.min.x + box.max.x) / 2, O.y - sink - box.min.y, O.z + z - (box.min.z + box.max.z) / 2);
    obj.updateMatrixWorld(true);
    return box.translate(obj.position);
  }

  // Collision for a (roughly box-shaped) object: its bounds shrunk by k, sitting on the floor.
  solid(box, k = 0.8) {
    const c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).multiplyScalar(k / 2);
    this.world.addBox(c.x - h.x, Math.max(O.y, c.y - h.y), c.z - h.z, c.x + h.x, c.y + h.y, c.z + h.z);
  }

  buildDome() {
    const g = this.group;
    // The round floor
    const floorTex = floorTexture();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 160), new THREE.MeshStandardMaterial({
      map: floorTex, emissive: '#5d8fff', emissiveMap: floorTex, emissiveIntensity: 0.35, roughness: 0.55, metalness: 0.3,
    }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(O);
    floor.receiveShadow = true;
    g.add(floor);
    this.world.addBox(O.x - R, O.y - 10, O.z - R, O.x + R, O.y, O.z + R); // (for rays; the dome keeps you over the floor)
    // Its rim, and the electric dome over it (solid: see updateDome)
    this.domeMat = domeMaterial();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 48, 0, Math.PI * 2, 0, Math.PI / 2), this.domeMat);
    dome.position.copy(O);
    dome.renderOrder = 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 4, 8, 256), new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.9, 1.6, 4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false,
    }));
    rim.rotation.x = Math.PI / 2;
    rim.position.copy(O);
    g.add(dome, rim);
  }

  // Outside the dome: nothing but a dark void and far-off specks of light.
  buildVoid() {
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(29000 + Math.random() * 2000).add(O);
      pos.set([_v.x, _v.y, _v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#9fb6ff', size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
    stars.frustumCulled = false;
    this.group.add(stars);
  }

  // Countless other domes all around: other pockets like this one, scattered through the void at
  // every distance, on every side, above and below. Each is a dome over a dark floor with a glowing
  // rim - what's inside them is too far away to make out.
  buildOtherDomes() {
    const list = [];
    for (let tries = 0; list.length < OTHERS.n && tries < OTHERS.n * 20; tries++) {
      // more of them further out (like stars), none too close to each other
      // in every direction: around, above and below
      const d = OTHERS.dist[0] + (OTHERS.dist[1] - OTHERS.dist[0]) * Math.pow(Math.random(), 0.7), r = R * rand(...OTHERS.size);
      const p = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      if (p.lengthSq() > 0.25 || p.lengthSq() < 1e-4) continue; // (uniform directions: only points inside the ball)
      p.setLength(d);
      if (list.some((o) => o.p.distanceTo(p) < (o.r + r) * OTHERS.spacing * 0.5)) continue;
      list.push({ p, r });
    }
    this.othersMat = farDomeMaterial();
    const domes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), this.othersMat, list.length);
    const floors = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#0b0d20', side: THREE.DoubleSide, fog: false }), list.length);
    const rims = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.004, 4, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.9, 1.6, 4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false,
    }), list.length);
    list.forEach(({ p, r }, i) => {
      _m.compose(_v.copy(p).add(O), _q.setFromAxisAngle(_s.set(0, 1, 0), Math.random() * 6.3), _s.setScalar(r));
      domes.setMatrixAt(i, _m);
      floors.setMatrixAt(i, _m);
      rims.setMatrixAt(i, _m);
    });
    for (const m of [domes, floors, rims]) {
      m.computeBoundingSphere();
      this.group.add(m);
    }
  }

  // Dead kaijus: the real kaiju's model, posed and frozen. pose: side | back | stand | curl
  buildKaijus() {
    const SCALE = 4;
    const skins = ['#34302b', '#2d3a2c', '#4a3328', '#30343d'];
    const poses = [['side', -640, -420], ['back', 620, -520], ['stand', -580, 380], ['curl', 660, 360]];
    poses.forEach(([pose, x, z], i) => {
      const parts = { glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.17, 0.03) }) }; // embers, not fire: it's dead
      const root = new THREE.Group();
      Kaiju.prototype.build.call(parts, root, new THREE.MeshStandardMaterial({ color: skins[i], roughness: 0.85, metalness: 0.05, flatShading: true }));
      root.scale.setScalar(SCALE);
      const legs = parts.legs;
      if (pose === 'stand') {
        // frozen mid-roar, as if he stopped time
        parts.jawG.rotation.x = 0.6;
        parts.neck.rotation.x = -0.35;
        legs.forEach((L, j) => (L.hip.rotation.x = j % 2 ? 0.35 : -0.3));
        parts.tail.forEach((s) => (s.rotation.y = 0.08));
      } else {
        // limbs gone stiff, tail limp or curled around
        legs.forEach((L) => {
          L.hip.rotation.x = (L.front ? -0.5 : 0.5) * rand(0.6, 1.2);
          L.knee.rotation.x = rand(-0.4, 0.4);
        });
        parts.jawG.rotation.x = rand(0.1, 0.5);
        parts.tail.forEach((s) => (s.rotation.y = pose === 'curl' ? 0.32 : rand(-0.12, 0.12)));
        if (pose === 'curl') parts.neck.rotation.y = 0.6;
        root.rotation.z = pose === 'back' ? Math.PI : Math.PI / 2;
      }
      const holder = new THREE.Group();
      holder.add(root);
      holder.rotation.y = Math.random() * Math.PI * 2;
      this.group.add(holder);
      this.settle(holder, x, z, pose === 'stand' ? 0 : 4);
      this.spots.push({ x, z, r: 170 });
      // The big lumps of the body are solid
      for (const m of parts.body.children.slice(0, 4)) this.solid(new THREE.Box3().setFromObject(m), 0.85);
    });
  }

  buildShips() {
    // Alien sphere wrecks, half sunk into the floor, eyes gone dim
    for (let i = 0; i < 16; i++) {
      const { root, eyeMat } = alienModel();
      eyeMat.color.setRGB(0.25, 0.02, 0.01);
      root.rotation.set(rand(-1, 1), Math.random() * 6.3, rand(-1, 1));
      this.group.add(root);
      const s = this.place(12);
      this.solid(this.settle(root, s.x, s.z, rand(1, 5)), 0.75);
    }
    // Flying saucers, crashed at an angle with one edge dug in
    const hull = new THREE.MeshStandardMaterial({ color: '#a4abb6', roughness: 0.3, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: '#3a3f48', roughness: 0.4, metalness: 0.8 });
    const dome = new THREE.MeshStandardMaterial({ color: '#4d7ea8', roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.75 });
    const deadLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.6, 0.5) });
    const profile = [[0, -4], [16, -4], [28, -1.5], [36, 0], [36, 1], [26, 3.5], [13, 5], [0, 5]].map(([r, y]) => new THREE.Vector2(r, y));
    const saucerGeo = new THREE.LatheGeometry(profile, 40);
    for (let i = 0; i < 6; i++) {
      const ship = new THREE.Group();
      const body = new THREE.Mesh(saucerGeo, hull);
      body.castShadow = true;
      const top = new THREE.Mesh(new THREE.SphereGeometry(11, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), dome);
      top.position.y = 4.5;
      const belly = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 4, 24), dark);
      belly.position.y = -5;
      ship.add(body, top, belly);
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2, l = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), deadLight);
        l.position.set(Math.cos(a) * 34, 0.5, Math.sin(a) * 34);
        ship.add(l);
      }
      ship.scale.setScalar(rand(1, 1.4));
      ship.rotation.set(rand(0.25, 0.6) * (Math.random() < 0.5 ? -1 : 1), Math.random() * 6.3, rand(-0.3, 0.3));
      this.group.add(ship);
      const s = this.place(48);
      this.solid(this.settle(ship, s.x, s.z, 8), 0.6);
    }
    // Two cruisers: long arrow-shaped hulls, engines cold. One rests flat, one on its side.
    const shape = new THREE.Shape();
    [[0, -90], [34, 40], [20, 62], [-20, 62], [-34, 40]].forEach(([x, y], k) => (k ? shape.lineTo(x, y) : shape.moveTo(x, y)));
    const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 14, bevelEnabled: true, bevelSize: 2, bevelThickness: 2, bevelSegments: 1 }).rotateX(-Math.PI / 2);
    const engineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.12, 0.35) });
    for (let i = 0; i < 2; i++) {
      const ship = new THREE.Group();
      const body = new THREE.Mesh(hullGeo, dark);
      body.castShadow = true;
      const bridge = new THREE.Mesh(this.boxGeo, hull);
      bridge.scale.set(16, 12, 30);
      bridge.position.set(0, 20, -30); // the nose points +Z, the bridge and engines are at the back
      ship.add(body, bridge);
      for (const x of [-12, 0, 12]) {
        const e = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 10, 16).rotateX(Math.PI / 2), dark);
        e.position.set(x, 7, -66);
        const glow = new THREE.Mesh(new THREE.CircleGeometry(4, 16), engineMat);
        glow.position.set(x, 7, -71.1);
        glow.rotation.y = Math.PI;
        ship.add(e, glow);
      }
      ship.rotation.set(0, Math.random() * 6.3, i ? Math.PI / 2 - 0.1 : 0.06);
      this.group.add(ship);
      const s = this.place(85);
      this.solid(this.settle(ship, s.x, s.z, i ? 3 : 0), i ? 0.5 : 0.6);
    }
  }

  // ---------------------------------------------------------------- blocks
  // Matrix for a structure of nx * ny * nz blocks (origin at the middle of its base) turned by
  // `euler` and sat on the floor at x, z (sunk `sink` m), or hung in the air with its middle at `y`.
  frame(euler, [nx, ny, nz], [bx, by, bz], x, z, sink = 0, y = null) {
    const m = new THREE.Matrix4().makeRotationFromEuler(euler);
    const box = new THREE.Box3(new THREE.Vector3((-nx * bx) / 2, 0, (-nz * bz) / 2), new THREE.Vector3((nx * bx) / 2, ny * by, (nz * bz) / 2)).applyMatrix4(m);
    const c = box.getCenter(new THREE.Vector3());
    const ty = y === null ? O.y - sink - box.min.y : O.y + y - c.y;
    return m.premultiply(new THREE.Matrix4().makeTranslation(O.x + x - c.x, ty, O.z + z - c.z));
  }

  // Blocks [i, j, k] of a structure -> instances. With `solid` (only for axis-aligned structures)
  // every vertical run of blocks also becomes a collision box.
  // With `owner` (a breakable ruin) each block remembers its cell so it can be knocked out later.
  emit(cells, [nx, , nz], [bx, by, bz], matrix, tint, solid, owner = null) {
    for (const [i, j, k] of cells) {
      _m.compose(_v.set((i - nx / 2 + 0.5) * bx, (j + 0.5) * by, (k - nz / 2 + 0.5) * bz), _q.identity(), _s.set(bx * 0.99, by * 0.99, bz * 0.99));
      this.blocks.push({ m: _m.clone().premultiply(matrix), c: tint, owner, ci: (j * nz + k) * nx + i });
    }
    if (!solid) return;
    const cols = new Map();
    for (const [i, j, k] of cells) {
      const key = i * 1000 + k;
      if (!cols.has(key)) cols.set(key, []);
      cols.get(key).push(j);
    }
    const box = new THREE.Box3();
    for (const [key, js] of cols) {
      const i = Math.floor(key / 1000), k = key % 1000;
      js.sort((a, b) => a - b);
      let start = js[0];
      for (let n = 1; n <= js.length; n++) {
        if (n < js.length && js[n] === js[n - 1] + 1) continue;
        box.min.set((i - nx / 2) * bx, start * by, (k - nz / 2) * bz);
        box.max.set((i - nx / 2 + 1) * bx, (js[n - 1] + 1) * by, (k - nz / 2 + 1) * bz);
        box.applyMatrix4(matrix);
        this.world.addBox(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
        start = js[n];
      }
    }
  }

  finishBlocks() {
    const tiles = new Map();
    for (const b of this.blocks) {
      const key = Math.floor((b.m.elements[12] - O.x) / TILE) * 1000 + Math.floor((b.m.elements[14] - O.z) / TILE);
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(b);
    }
    for (const list of tiles.values()) {
      const mesh = new THREE.InstancedMesh(this.boxGeo, this.blockMat, list.length);
      list.forEach(({ m, c, owner, ci }, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, _c.copy(c).offsetHSL(0, 0, rand(-0.06, 0.06)));
        if (owner) {
          owner.mesh[ci] = mesh;
          owner.idx[ci] = i;
        }
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.blocks = null;
  }

  tint() {
    return new THREE.Color(FACADES[(Math.random() * FACADES.length) | 0]);
  }

  // ---------------------------------------------------------------- the ruined city
  buildCity() {
    const { block, street, gap } = CITY, P = block + street;
    const n = Math.ceil(R / P);
    this.buildCars(P, n);
    for (let gx = -n; gx < n; gx++) {
      for (let gz = -n; gz < n; gz++) {
        const bx = gx * P + P / 2, bz = gz * P + P / 2; // middle of the block (streets run along multiples of P)
        if (Math.hypot(bx, bz) < CITY.plaza) continue; // an open square around the way out
        // 2 or 4 lots
        const quad = Math.random() < 0.3, alongX = (gx + gz) % 2 === 0;
        const lots = quad
          ? [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [bx + (sx * block) / 4, bz + (sz * block) / 4, block / 2 - gap, block / 2 - gap])
          : [-1, 1].map((sd) => (alongX ? [bx, bz + (sd * block) / 4, block, block / 2 - gap] : [bx + (sd * block) / 4, bz, block / 2 - gap, block]));
        for (const lot of lots) if (this.lotFree(lot)) Math.random() < CITY.empty ? this.rubbleLot(lot) : this.ruin(lot);
      }
    }
  }

  // Inside the dome and clear of everything already placed (kaijus, ships, the way in and out).
  lotFree([x, z, w, d]) {
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) if (Math.hypot(x + (cx * w) / 2, z + (cz * d) / 2) > R - 40) return false;
    for (const sp of this.spots) {
      const dx = Math.max(Math.abs(sp.x - x) - w / 2, 0), dz = Math.max(Math.abs(sp.z - z) - d / 2, 0);
      if (Math.hypot(dx, dz) < sp.r) return false;
    }
    return true;
  }

  // A broken building filling (most of) the lot: just the outer walls, the top broken off along a
  // slanted, jagged line, big bites torn out of the sides, a few floors left hanging inside the
  // tall ones.
  ruin([x, z, w, d]) {
    const b = CITY.ruin;
    const nx = Math.max(3, Math.floor(w / b[0]) - ((Math.random() * 2) | 0)), nz = Math.max(3, Math.floor(d / b[2]) - ((Math.random() * 2) | 0));
    let roll = Math.random(), kind = 0;
    while (kind < FLOORS.length - 1 && roll > FLOORS[kind][0]) roll -= FLOORS[kind++][0];
    const ny = FLOORS[kind][1] + ((Math.random() * (FLOORS[kind][2] - FLOORS[kind][1] + 1)) | 0);
    const dir = Math.random() * Math.PI * 2, shear = kind ? rand(0.15, 0.7) : rand(0, 0.5);
    const bites = kind ? Array.from({ length: 1 + ((Math.random() * 3) | 0) }, () => {
      const side = Math.random() < 0.5;
      return [side ? (Math.random() < 0.5 ? 0 : nx - 1) : Math.random() * nx, rand(0.1, 0.85) * ny, side ? Math.random() * nz : (Math.random() < 0.5 ? 0 : nz - 1), rand(1, 3) + ny * 0.04];
    }) : [];
    const bitten = (i, j, k) => bites.some(([bx, by, bz, r]) => (i - bx) ** 2 + (j - by) ** 2 + (k - bz) ** 2 < r * r);
    const walls = [], floors = [];
    let lowest = ny;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        if (i > 0 && i < nx - 1 && k > 0 && k < nz - 1) continue;
        const u = Math.min(1, Math.max(0, ((i / (nx - 1) - 0.5) * Math.cos(dir) + (k / (nz - 1) - 0.5) * Math.sin(dir)) * 1.2 + 0.5));
        const top = Math.max(1, Math.round(ny * (1 - shear * u) - Math.random() * Math.min(4, ny * 0.4)));
        lowest = Math.min(lowest, top);
        for (let j = 0; j < top; j++) if (!bitten(i, j, k) && (j < 2 || Math.random() > 0.03)) walls.push([i, j, k]);
      }
    }
    if (kind === 2) {
      for (let j = 5; j < lowest - 2; j += 5) {
        for (let i = 1; i < nx - 1; i++) for (let k = 1; k < nz - 1; k++) if (Math.random() < 0.7 && !bitten(i, j, k)) floors.push([i, j, k]);
      }
    }
    const size = [nx, ny, nz], m = this.frame(new THREE.Euler(), size, b, x, z);
    const tint = this.tint();
    // Breakable: its walls and floors are one block grid in the collision world (see damage)
    const occ = new Uint8Array(nx * ny * nz), ruin = { tint, mesh: [], idx: new Int32Array(nx * ny * nz) };
    for (const [i, j, k] of walls.concat(floors)) occ[(j * nz + k) * nx + i] = 1;
    this.world.addVolume({
      minX: O.x + x - (nx * b[0]) / 2, minY: O.y, minZ: O.z + z - (nz * b[2]) / 2,
      maxX: O.x + x + (nx * b[0]) / 2, maxY: O.y + ny * b[1], maxZ: O.z + z + (nz * b[2]) / 2, nx, ny, nz, occ, ruin,
    });
    this.emit(walls, size, b, m, tint, false, ruin);
    this.emit(floors, size, b, m, tint, false, ruin);
  }

  // An empty lot: the broken-off top of a building lying (or leaning) in it, and rubble around.
  rubbleLot([x, z, w, d]) {
    const b = BLOCK, long = Math.max(w, d) - 6;
    const nx = 3 + ((Math.random() * 4) | 0), nz = 3 + ((Math.random() * 4) | 0), ny = Math.max(4, Math.min(16, Math.floor(long / b[1]) - ((Math.random() * 4) | 0)));
    const lean = Math.random() < 0.3;
    // Lying along the lot's long side (axis-aligned so its collision boxes fit exactly)
    const euler = lean ? new THREE.Euler(rand(0.25, 0.5), d > w ? 0 : Math.PI / 2, rand(-0.2, 0.2))
      : w >= d ? new THREE.Euler(0, Math.random() < 0.5 ? 0 : Math.PI, Math.PI / 2) : new THREE.Euler(Math.PI / 2, Math.random() < 0.5 ? 0 : Math.PI, 0);
    const cells = [];
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) for (let j = 0, h = Math.max(1, ny - ((Math.random() * 4) | 0)); j < h; j++) cells.push([i, j, k]);
    this.emit(cells, [nx, ny, nz], b, this.frame(euler, [nx, ny, nz], b, x, z, lean ? 3 : 0), this.tint(), !lean);
    for (let i = 0; i < 40; i++) {
      const sz = new THREE.Vector3(...b).multiplyScalar(rand(0.4, 1.1));
      _q.setFromEuler(new THREE.Euler(rand(-1, 1), Math.random() * 6.3, rand(-1, 1)));
      this.blocks.push({ m: new THREE.Matrix4().compose(_v.set(O.x + x + rand(-w, w) / 2, O.y + sz.y * 0.3, O.z + z + rand(-d, d) / 2), _q, sz), c: this.tint() });
    }
  }

  // Cars abandoned along the streets, some flipped over or on their side.
  buildCars(P, n) {
    const cars = [];
    for (let k = -n; k <= n; k++) {
      const c = k * P, half = Math.sqrt(Math.max(0, (R - 2) ** 2 - c * c));
      if (half < 20) continue;
      for (const axis of ['x', 'z']) {
        for (let t = -half + 20; t < half - 20; t += rand(...CITY.cars)) {
          const lane = (Math.random() < 0.5 ? -1 : 1) * rand(3, 11);
          const px = axis === 'z' ? c + lane : t, pz = axis === 'z' ? t : c + lane;
          if (Math.hypot(px - ENTRY.x, pz - ENTRY.z) < 60 || Math.hypot(px, pz) < 60) continue;
          cars.push([px, pz, (axis === 'z' ? 0 : Math.PI / 2) + (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5)]);
        }
      }
    }
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 });
    const types = ['taxi', 'sedan', 'suv'].map((name) => ({ name, geo: carModel(name).body, list: [] }));
    for (const car of cars) types[(Math.random() * 3) | 0].list.push(car);
    for (const T of types) {
      const mesh = new THREE.InstancedMesh(T.geo, bodyMat, Math.max(1, T.list.length));
      mesh.count = T.list.length;
      T.list.forEach(([x, z, yaw], i) => {
        const pose = Math.random(); // most on their wheels, some flipped over, some on their side
        const e = new THREE.Euler(pose < 0.75 ? 0 : pose < 0.9 ? Math.PI : 0, yaw, pose >= 0.9 ? Math.PI / 2 : 0, 'YXZ');
        const lift = pose < 0.75 ? 0 : pose < 0.9 ? 1.5 : 1;
        mesh.setMatrixAt(i, _m.compose(_v.set(O.x + x, O.y + lift, O.z + z), _q.setFromEuler(e), _s.set(1, 1, 1)));
        mesh.setColorAt(i, _c.set(T.name === 'taxi' ? '#f2b800' : CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0]).multiplyScalar(rand(0.45, 0.8))); // dusty
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true; // (no shadows cast: too many of them to draw into the shadow map)
      this.group.add(mesh);
    }
  }

  // Loose blocks everywhere.
  buildLoose() {
    const b = BLOCK;
    for (let i = 0; i < 1500; i++) {
      const sz = new THREE.Vector3(...b).multiplyScalar(rand(0.4, 1.1)), d = (R - 20) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (Math.hypot(x, z) < 50 || Math.hypot(x - ENTRY.x, z - ENTRY.z) < 30) continue;
      _q.setFromEuler(new THREE.Euler(rand(-1, 1), Math.random() * 6.3, rand(-1, 1)));
      this.blocks.push({ m: new THREE.Matrix4().compose(_v.set(O.x + x, O.y + sz.y * 0.3, O.z + z), _q, sz), c: this.tint() });
    }
  }

  // Pieces of buildings hanging frozen in the air: broken corners, torn-off walls, tumbling blocks.
  // The level ones you can land on.
  buildFloating() {
    const b = BLOCK, [y0, y1] = FLOAT.height;
    const spotIn = () => {
      const d = (R - 120) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      return [Math.cos(a) * d, Math.min(rand(y0, y1), Math.sqrt((R - 100) ** 2 - d * d) - 40), Math.sin(a) * d];
    };
    for (let n = 0; n < FLOAT.n; n++) {
      const wall = n % 3 === 0; // a facade torn off in one piece
      const nx = wall ? 6 + ((Math.random() * 8) | 0) : 3 + ((Math.random() * 7) | 0), nz = wall ? 1 : 3 + ((Math.random() * 7) | 0), ny = wall ? 5 + ((Math.random() * 10) | 0) : 3 + ((Math.random() * 10) | 0);
      const cells = [];
      for (let i = 0; i < nx; i++) {
        for (let k = 0; k < nz; k++) {
          const h = Math.max(1, ny - ((Math.random() * 4) | 0)), lo = (Math.random() * 2) | 0; // broken at both ends
          for (let j = lo; j < h; j++) if (Math.random() > 0.12) cells.push([i, j, k]);
        }
      }
      const level = !wall && n % 2 === 0;
      const euler = level ? new THREE.Euler(0, ((Math.random() * 4) | 0) * (Math.PI / 2), 0) : new THREE.Euler(rand(-1.2, 1.2), Math.random() * 6.3, rand(-1.2, 1.2));
      const [x, y, z] = spotIn();
      this.emit(cells, [nx, ny, nz], b, this.frame(euler, [nx, ny, nz], b, x, z, 0, y), this.tint(), level);
    }
    for (let i = 0; i < FLOAT.loose; i++) {
      const [x, y, z] = spotIn(), sz = new THREE.Vector3(...b).multiplyScalar(rand(0.4, 1.2));
      _q.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
      this.blocks.push({ m: new THREE.Matrix4().compose(_v.set(O.x + x, O.y + y, O.z + z), _q, sz), c: this.tint() });
    }
  }
}
