import * as THREE from 'three';
import { createRig } from './models.js';
import { Kaiju } from './kaiju.js';

// The Watcher: every so often a black hole tears open in the sky, a storm of enormous lightning
// rakes the whole city for 5 seconds, and a giant glowing blue man drifts out of the hole. He isn't
// an enemy. Two kinds of visit:
//   Watch (most visits, 20 s): he hangs in the sky (100 m above the city's highest point) watching the hero.
//     - Get within 50 m and he throws the hero half the map away at 400 mph.
//     - If he erased a building before, he puts it back: motes of light pour in, it glows white
//       and reappears.
//     - He picks another building somewhere in the city and erases it: it glows white, five huge
//       lightning bolts hit it, and it dissolves into a cloud of atoms. It stays gone until he
//       puts it back on a later visit.
//   Kaiju show (sometimes, 23 s): far away and 500 m above the city's highest point he creates a kaiju out of thin air,
//     frozen in the sky. He circles it, spinning it faster and faster, then erases it and leaves.
//     The whole scene is sealed in an electric sphere the hero can't get through.
//   Building show (sometimes, 28 s): same place and barrier, but he creates a building. He circles
//     it while it turns, takes it apart block by block, sets the blocks orbiting in a great ring,
//     then erases them all and leaves.
//   Lift (sometimes, 23 s): like a watch visit, but he points at a building and the whole top half
//     of it comes apart block by block. The blocks rise until they float 300 m above the building,
//     then get pulled together into a single point, as if something were swallowing them, and
//     the point is erased. (The building rebuilds itself a minute later.)
// M summons a watch visit right away, N a kaiju show, B a building show, L a lift.

const STORM = 5; // seconds of city-wide lightning
const SCALE = 6; // he's about 12 m tall
const HOLE = { core: 16, disc: 52 };
// Timelines (seconds): hole opens, he emerges, hole closes behind him, reopens, he goes back in, end
const WATCH = { open: 1.5, emerge: [1.5, 4], close: [6, 8], reopen: [16.5, 17.5], back: [17.5, 19.5], end: 20, above: [100, 120] }; // above: metres over the city's highest point
const SHOW = {
  kind: 'kaiju', revealText: 'A KAIJU?!',
  open: 1.5, emerge: [1.5, 4], close: [6, 8], reopen: [19, 20], back: [20.5, 22.5], end: 23,
  create: [4, 8], orbit: [8, 15], erase: [15, 18.5], home: [18.5, 20.5],
  // creation, as fractions of `create` (the erase run backwards): white light, atoms gather, it
  // appears glowing white while 5 bolts strike it, the glow fades to its own colours
  light: [0, 0.15], gather: [0.12, 0.6], reveal: 0.6,
  chance: 0.25, dist: [750, 900], above: [500, 540], ahead: 150, orbitR: 230, barrier: 330, // above: metres over the city's highest point
};
// Building show: like the kaiju show (same creation, place and barrier), longer, with its own middle
const TOWER = {
  ...SHOW, kind: 'tower', revealText: 'A BUILDING?!', chance: 0.2,
  create: [4, 8], orbit: [8, 20], spin: [8, 11], apart: [11, 15], erase: [20, 23.5], home: [23.5, 25],
  reopen: [24, 25], back: [25.5, 27.5], end: 28,
  blocks: [6, 25, 6], block: [4, 3.6, 4], ring: [60, 135], // blocks across x / up / z, block size, ring radius range
};
// Lift: a watch visit with its own middle
const LIFT = {
  ...WATCH, kind: 'lift', chance: 0.15,
  pick: 5, glow: [5, 6.5], rise: [6.5, 14.5], pull: [14.5, 17.5], erase: [17.5, 19], reopen: [19.5, 20.5], back: [20.5, 22.5], end: 23,
  up: 300, // metres above the building's roof the blocks rise to
};
const INTERVAL = [70, 160]; // seconds between appearances
const FIRST = 25;
const REPEL = { radius: 50, speed: 400 * 0.44704, time: 7, cooldown: 2 }; // 400 mph, ~1.25 km
const ERASE = { start: 8, glow: 3.2, bolts: 5, fade: 0.8, range: [150, 650] };
const RETURN = { start: 4, time: 3 };
const KAIJU_SCALE = 4; // same size as the real kaiju (kaiju.js)
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3();
const shellGeo = new THREE.BoxGeometry(1, 1, 1);
const ramp = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

// Swirling accretion disc around the hole
function discMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uK: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uTime; uniform float uK; varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0, a = atan(p.y, p.x);
        float swirl = 0.5 + 0.5 * sin(a * 5.0 + r * 26.0 - uTime * 5.0);
        float streak = 0.5 + 0.5 * sin(a * 13.0 - r * 9.0 + uTime * 3.0);
        float inner = smoothstep(0.3, 0.42, r), outer = 1.0 - smoothstep(0.75, 1.0, r);
        vec3 hot = vec3(1.6, 1.8, 2.6), cool = vec3(0.25, 0.35, 1.6);
        vec3 col = mix(hot, cool, smoothstep(0.35, 0.95, r)) * (0.45 + 0.75 * swirl * streak);
        gl_FragColor = vec4(col, inner * outer * uK);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// Electric barrier: crawling energy pattern, brightest at the edges, near the point being pushed on.
function barrierMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uHit: { value: new THREE.Vector3() }, uHitK: { value: 0 } },
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
      uniform float uTime; uniform float uK; uniform vec3 uHit; uniform float uHitK;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
        vec3 q = vW * 0.05;
        float arcs = abs(sin(q.x * 3.1 + sin(q.y * 2.3 + uTime * 3.0) * 2.0) * sin(q.z * 2.7 + sin(q.x * 1.7 - uTime * 2.0) * 2.0));
        float veins = smoothstep(0.9, 1.0, 1.0 - arcs);
        float near = uHitK * exp(-distance(vW, uHit) / 45.0);
        float a = (f * 0.4 + veins * 0.8) * uK + near * (0.5 + veins);
        gl_FragColor = vec4(vec3(0.55, 0.8, 2.4) * (0.7 + near), a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// One facade cell: stone wall with a tall window (every block of the created building wears it).
function towerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c2b4';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(${90 + Math.random() * 60},${85 + Math.random() * 50},${70 + Math.random() * 40},0.08)`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  const gr = g.createLinearGradient(0, 22, 0, 106);
  gr.addColorStop(0, '#2b3d55');
  gr.addColorStop(0.5, '#4f6f92');
  gr.addColorStop(1, '#1d2a3b');
  g.fillStyle = '#6f6a60';
  g.fillRect(26, 18, 76, 92); // frame
  g.fillStyle = gr;
  g.fillRect(30, 22, 68, 84); // glass
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(30, 62, 68, 3); // transom
  g.fillRect(62, 22, 3, 84); // mullion
  g.fillStyle = '#9d968a';
  g.fillRect(22, 108, 84, 6); // sill
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Watcher {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = FIRST;
    this.active = false;
    this.groups = (ctx.city?.destructible?.groups ?? []).filter((g) => !g.round && g.walls.some((w) => w.h > 25 && w.style !== 'store'));
    this.erasedList = []; // buildings he has erased and not yet put back (oldest first)
    // Highest point in the city (the top of the tallest thing you can collide with)
    this.skyline = 0;
    for (const list of ctx.world?.grid?.values() ?? []) for (const b of list) this.skyline = Math.max(this.skyline, b.maxY ?? 0);
    this.repelCd = 0;
    this.erasing = null;
    this.returning = null;
    this.buildHole();
    this.buildMan();
    this.barrier = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), barrierMaterial());
    this.barrier.visible = false;
    ctx.scene.add(this.barrier);
  }

  buildHole() {
    const g = new THREE.Group();
    this.core = new THREE.Mesh(new THREE.SphereGeometry(HOLE.core, 32, 20), new THREE.MeshBasicMaterial({ color: '#000000', fog: false }));
    this.disc = new THREE.Mesh(new THREE.RingGeometry(HOLE.core * 0.8, HOLE.disc, 96, 1), discMaterial());
    this.lens = new THREE.Mesh(new THREE.TorusGeometry(HOLE.core * 1.12, 0.9, 10, 96), new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 2.6, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    }));
    g.add(this.core, this.disc, this.lens);
    g.visible = false;
    this.hole = g;
    this.ctx.scene.add(g);
  }

  buildMan() {
    const rig = createRig('hero', { preferModel: this.ctx.useModels !== false });
    rig.paint(['#3f9dff', '#62b8ff', '#3f9dff', '#2f7fe0', '#2a6fd0', '#3f9dff'], { glow: '#bfe6ff', lines: true });
    // Glowing skin: every material lights itself up in pale blue
    this.mats = [];
    rig.root.traverse((o) => {
      if (!o.isMesh || !o.material?.emissive) return;
      o.material.emissive.set('#58b4ff');
      o.material.emissiveIntensity = 1.4;
      o.material.color.set('#7cc4ff');
      o.material.transparent = true;
      o.material.fog = false; // stays bright even far up in the sky
      this.mats.push(o.material);
    });
    // Soft halo around him
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1.4, 20, 14), new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.25, 0.55, 1.6), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.halo.position.y = 1;
    this.halo.scale.set(1, 1.5, 1);
    rig.root.add(this.halo);
    this.light = new THREE.PointLight('#6ab8ff', 0, 260, 1.5);
    this.light.position.y = 1.2;
    rig.root.add(this.light);
    rig.root.scale.setScalar(SCALE);
    rig.root.visible = false;
    this.rig = rig;
    this.ctx.scene.add(rig.root);
  }

  // Open the hole: near the hero for a watch visit, far away and very high for a show.
  // kind: 'watch' | 'kaiju' | 'tower'
  appear(kind) {
    const p = this.ctx.player.pos, a = Math.random() * Math.PI * 2;
    const show = kind === 'kaiju' || kind === 'tower'; // the far-away shows behind the barrier
    const S = kind === 'kaiju' ? SHOW : kind === 'tower' ? TOWER : kind === 'lift' ? LIFT : WATCH;
    const d = show ? S.dist[0] + Math.random() * (S.dist[1] - S.dist[0]) : 150 + Math.random() * 100;
    const above = S.above;
    const h = this.skyline + above[0] + Math.random() * (above[1] - above[0]);
    this.at = new THREE.Vector3(p.x + Math.cos(a) * d, h, p.z + Math.sin(a) * d);
    this.toHero = new THREE.Vector3().subVectors(p, this.at).setY(0).normalize();
    this.hover = this.at.clone().addScaledVector(this.toHero, 30); // where he stays, a little out of the hole
    this.show = show;
    this.S = S;
    this.t = 0;
    this.active = true;
    this.boltT = 0;
    this.repelCd = 0;
    this.erased = this.returned = false;
    this.lift = null;
    this.liftTried = false;
    this.manPos = this.at.clone();
    this.hole.visible = true;
    this.hole.position.copy(this.at);
    this.rig.root.visible = false;
    if (show) {
      this.kc = this.at.clone().addScaledVector(this.toHero, S.ahead); // where the kaiju / building will be
      this.orbitA = Math.atan2(this.hover.z - this.kc.z, this.hover.x - this.kc.x);
      this.statue = null;
      this.barrier.position.copy(this.kc);
      this.barrier.scale.setScalar(S.barrier);
      this.blockedMsg = false;
    }
    this.ctx.hud.callout(show ? 'SOMETHING IS HAPPENING IN THE SKY...' : 'SOMETHING IS WATCHING...', 'bad');
    this.ctx.player.shake(0.8, 1.2);
  }

  update(dt, input) {
    if (!this.active) {
      this.updateReturn(dt);
      this.updateErase(dt);
      if (this.enabled === false) return;
      this.timer -= dt;
      if (input?.hit('KeyN')) this.appear('kaiju');
      else if (input?.hit('KeyB')) this.appear('tower');
      else if (input?.hit('KeyL')) this.appear('lift');
      else if (input?.hit('KeyM')) this.appear('watch');
      else if (this.timer <= 0) {
        const r = Math.random();
        this.appear(r < SHOW.chance ? 'kaiju' : r < SHOW.chance + TOWER.chance ? 'tower' : r < SHOW.chance + TOWER.chance + LIFT.chance ? 'lift' : 'watch');
      }
      return;
    }
    this.t += dt;
    const t = this.t, fx = this.ctx.fx, S = this.S;

    // The hole: opens, closes once he's out, reopens to take him back
    const open = t < S.close[0] ? ramp(t, 0, S.open) : t < S.reopen[0] ? 1 - ramp(t, S.close[0], S.close[1])
      : t < S.back[1] ? ramp(t, S.reopen[0], S.reopen[1]) : 1 - ramp(t, S.back[1], S.end);
    this.hole.visible = open > 0.002;
    this.hole.scale.setScalar(Math.max(0.01, open));
    this.hole.lookAt(this.ctx.camera.position);
    this.disc.rotation.z += dt * 0.6;
    this.disc.material.uniforms.uTime.value = t;
    this.disc.material.uniforms.uK.value = open;
    this.lens.material.opacity = open * (0.7 + 0.3 * Math.sin(t * 9));
    if (open > 0.1 && Math.random() < dt * 30) {
      // matter spiralling in
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(HOLE.disc * open * (0.8 + Math.random() * 0.6));
      fx.spawn(this.at.x + _v.x, this.at.y + _v.y, this.at.z + _v.z, -_v.x * 0.9, -_v.y * 0.9, -_v.z * 0.9, 1, 1.4, 0.2, [0.8, 0.9, 1], [0.3, 0.4, 1], 0, 0);
    }

    // City-wide lightning storm for the first 5 seconds
    if (t < STORM) {
      this.boltT -= dt;
      while (this.boltT <= 0) {
        this.boltT += 0.12 + Math.random() * 0.1;
        this.cityBolt();
      }
    }

    // The man
    const man = this.rig.root;
    const out = ramp(t, S.emerge[0], S.emerge[1]), back = ramp(t, S.back[0], S.back[1]);
    man.visible = out > 0 && back < 1;
    if (man.visible) {
      const fade = Math.min(out * 2, 1) * (1 - back);
      for (const m of this.mats) m.opacity = fade;
      this.halo.material.opacity = 0.18 * fade;
      this.light.intensity = 900 * fade;
      const look = this.show ? this.updateShowMan(dt, t, out, back) : this.updateWatchMan(dt, t, out, back);
      man.position.copy(this.manPos);
      man.position.y += Math.sin(t * 0.9) * 1.2 - SCALE; // centre him (rig origin is at the feet)
      man.rotation.y = Math.atan2(-(look.x - this.manPos.x), -(look.z - this.manPos.z));
      if (Math.random() < dt * 6) {
        _v.set(Math.random() - 0.5, Math.random() * 2.2, Math.random() - 0.5).multiplyScalar(SCALE).add(man.position);
        fx.spawn(_v.x, _v.y, _v.z, 0, 1.5, 0, 1.2, 0.8, 0.1, [0.7, 0.88, 1], [0.25, 0.5, 1], 0, 0.5);
      }
    }
    if (this.show) {
      if (S.kind === 'kaiju') this.updateStatue(dt, t);
      else this.updateTower(dt, t);
      this.updateBarrier(dt, t);
    } else if (S.kind === 'lift') {
      if (!this.lift && !this.liftTried && t >= S.pick) {
        this.liftTried = true;
        this.startLift();
      }
      this.updateLift(dt, t);
    } else {
      // Put back the oldest building he erased, then erase a new one
      if (!this.returned && t >= RETURN.start) {
        this.returned = true;
        if (this.erasedList.length) this.startReturn(this.erasedList.shift());
      }
      if (!this.erased && t >= ERASE.start) {
        this.erased = true;
        this.startErase();
      }
    }
    this.updateReturn(dt);
    this.updateErase(dt);
    if (t >= S.end) this.leave();
  }

  leave() {
    this.active = false;
    // (he's leaving: anything half-done finishes right now)
    if (this.erasing && !this.erasing.done) this.erasing.t = ERASE.glow;
    if (this.returning && !this.returning.done) this.returning.t = RETURN.time;
    this.updateReturn(0);
    this.updateErase(0);
    if (this.statue) this.removeStatue();
    if (this.lift) this.endLift();
    this.hole.visible = this.rig.root.visible = this.barrier.visible = false;
    this.light.intensity = 0;
    this.timer = INTERVAL[0] + Math.random() * (INTERVAL[1] - INTERVAL[0]);
  }

  // Watch visit: out of the hole to his hover point, facing the hero (or pointing at a building).
  updateWatchMan(dt, t, out, back) {
    this.manPos.lerpVectors(this.at, this.hover, out * (1 - back));
    const target = this.erasing && !this.erasing.done ? this.erasing.center : this.returning && !this.returning.done ? this.returning.center
      : this.lift ? (this.t < LIFT.pull[0] ? this.lift.center : this.lift.point) : null;
    this.posePointing(dt, target);
    if (out * (1 - back) > 0.9) this.repel(dt);
    return target ?? this.ctx.player.pos;
  }

  // Shows: emerges, points while creating, circles it, points while erasing it, home.
  updateShowMan(dt, t, out, back) {
    const S = this.S;
    if (t < S.orbit[0]) {
      this.manPos.lerpVectors(this.at, this.hover, out);
    } else if (t < S.home[0]) {
      // Circle the kaiju, speeding up as it spins faster
      const k = ramp(t, S.orbit[0], S.orbit[1]);
      this.orbitA += dt * (S.kind === 'kaiju' ? 0.25 + 0.9 * k : 0.35) * (t < S.erase[0] ? 1 : 0.4);
      _v.set(this.kc.x + Math.cos(this.orbitA) * S.orbitR, this.kc.y + Math.sin(t * 0.8) * 25, this.kc.z + Math.sin(this.orbitA) * S.orbitR);
      this.manPos.lerp(_v, 1 - Math.exp(-3 * dt));
    } else {
      // Back to the hole
      _v.copy(this.hover);
      this.manPos.lerp(_v, 1 - Math.exp(-2.5 * dt));
      if (back > 0) this.manPos.lerpVectors(this.manPos, this.at, back);
    }
    const creating = t >= S.create[0] && t < S.create[1], erasing = t >= S.erase[0] && t < S.erase[1];
    if (creating || erasing) this.posePointing(dt, this.kc, true);
    else if (t >= S.orbit[0] && t < S.erase[0]) {
      // Arms spread, conducting the spin
      this.rig.pose({ sL: 1.4, sR: 1.4, eL: 0.1, eR: 0.1, spread: 1.1, hL: 0.05, hR: 0.05, kL: -0.1, kR: -0.1 }, 1 - Math.exp(-4 * dt), dt, null);
    } else this.posePointing(dt, null);
    return t >= S.create[0] ? this.kc : this.ctx.player.pos;
  }

  // Calm hovering pose; with a target, the right arm points at it (both arms if `both`).
  posePointing(dt, target, both = false) {
    const pose = { sL: 0.12, sR: 0.12, eL: 0.25, eR: 0.25, spread: 0.32, hL: 0.04, hR: 0.04, kL: -0.08, kR: -0.08 };
    if (target) {
      const aim = Math.PI / 2 + Math.atan2(target.y - this.manPos.y, Math.hypot(target.x - this.manPos.x, target.z - this.manPos.z));
      Object.assign(pose, { sR: aim, eR: 0 });
      if (both) Object.assign(pose, { sL: aim, eL: 0, spread: 0.15 });
    }
    this.rig.pose(pose, 1 - Math.exp(-4 * dt), dt, null);
  }

  // Too close: a blast of force throws the hero away from him, half the map, at 400 mph.
  repel(dt) {
    this.repelCd -= dt;
    const { player, fx } = this.ctx;
    _v.copy(this.manPos); // his centre
    _w.copy(player.pos);
    _w.y += 1;
    if (this.repelCd > 0 || player.dead || _w.distanceTo(_v) > REPEL.radius) return;
    this.repelCd = REPEL.cooldown;
    const dir = _w.sub(_v).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
    dir.normalize().setY(0.25).normalize();
    player.launch(dir.clone().multiplyScalar(REPEL.speed), REPEL.time);
    fx.flash(_v, 0x9cd0ff, 8000, 200, 0.3);
    fx.ring(player.pos, 0x9cd0ff, 30, 0.5);
    fx.bolt(_v.clone(), player.pos.clone().setY(player.pos.y + 1), { color: 0x9cc8ff, width: 2, life: 0.25, jag: 0.15 });
    fx.burst(player.pos, 60, { speed: 30, life: 0.5, size: 1.4, c0: [0.85, 0.95, 1], c1: [0.3, 0.5, 1], drag: 2 });
    player.shake(1.2, 0.6);
    this.ctx.hud.callout('YOU GOT TOO CLOSE', 'bad');
  }

  // ---------------------------------------------------------------- erasing / returning buildings
  // White glow shells over a building's walls, plus its bounds.
  shellsFor(g) {
    const box = new THREE.Box3();
    const shells = g.walls.map((w) => {
      box.expandByPoint(_v.set(w.cx - w.w / 2, w.y0, w.cz - w.d / 2));
      box.expandByPoint(_v.set(w.cx + w.w / 2, w.y0 + w.h, w.cz + w.d / 2));
      const m = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(4, 4, 4.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      m.position.set(w.cx, w.y0 + w.h / 2, w.cz);
      m.scale.set(w.w + 0.8, w.h + 0.8, w.d + 0.8);
      this.ctx.scene.add(m);
      return m;
    });
    return { g, box, shells, t: 0, bolts: 0, center: box.getCenter(new THREE.Vector3()), done: false };
  }

  dropShells(job) {
    for (const m of job.shells) {
      this.ctx.scene.remove(m);
      m.material.dispose();
    }
  }

  // Pick a standing building in the city (far enough to watch it go) and start erasing it.
  startErase() {
    const p = this.ctx.player.pos;
    const options = this.groups.filter((g) => {
      if (g.erased || g.vols || g === this.returning?.g) return false;
      const w = g.walls[0], d = Math.hypot(w.cx - p.x, w.cz - p.z);
      return d > ERASE.range[0] && d < ERASE.range[1];
    });
    if (!options.length) return;
    this.erasing = this.shellsFor(options[(Math.random() * options.length) | 0]);
    this.ctx.hud.callout('HE IS LOOKING AT A BUILDING...', 'bad');
  }

  updateErase(dt) {
    const er = this.erasing;
    if (!er) return;
    const { fx, player } = this.ctx;
    er.t += dt;
    if (!er.done) {
      // Glows whiter and whiter...
      const k = Math.min(1, er.t / ERASE.glow);
      for (const m of er.shells) m.material.opacity = 0.15 + 0.75 * k * k + Math.random() * 0.08 * k;
      if (Math.random() < dt * 8 * k) fx.flash(er.center, 0xffffff, 6000 * k, 250, 0.12);
      // ...five huge bolts strike it...
      if (er.bolts < ERASE.bolts && er.t > 0.4 + er.bolts * ((ERASE.glow - 0.6) / ERASE.bolts)) {
        er.bolts++;
        this.strike(er.box, 450);
      }
      // ...and it's gone: reduced to atoms. It stays gone until he puts it back.
      if (er.t >= ERASE.glow) {
        er.done = true;
        er.t = 0;
        this.ctx.destruction?.erase(er.g, Infinity);
        this.erasedList.push(er.g);
        this.atomize(er.box);
        fx.flash(er.center, 0xffffff, 20000, 900, 0.5);
        player.shake(0.8, 0.8);
        this.ctx.hud.callout('ERASED', 'bad');
      }
      return;
    }
    // The white ghost of the building fades out after it's gone
    const k = Math.max(0, 1 - er.t / ERASE.fade);
    for (const m of er.shells) m.material.opacity = 0.9 * k;
    if (k <= 0) {
      this.dropShells(er);
      this.erasing = null;
    }
  }

  // Putting a building back: motes of light pour in and gather into its shape, it glows white, and
  // there it is again.
  startReturn(g) {
    this.returning = this.shellsFor(g);
    this.ctx.hud.callout('HE IS PUTTING IT BACK...', 'good');
  }

  updateReturn(dt) {
    const job = this.returning;
    if (!job) return;
    const { fx } = this.ctx, { box } = job;
    job.t += dt;
    if (!job.done) {
      const k = Math.min(1, job.t / RETURN.time);
      for (const m of job.shells) m.material.opacity = 0.9 * k * k;
      // Motes streaming in from all around and settling inside its outline
      const size = box.getSize(_u);
      for (let i = 0; i < 40 * dt * 60 * 0.5; i++) {
        _v.set(box.min.x + Math.random() * size.x, box.min.y + Math.random() * size.y, box.min.z + Math.random() * size.z);
        _w.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize().multiplyScalar(40 + Math.random() * 40);
        fx.spawn(_v.x + _w.x, _v.y + _w.y, _v.z + _w.z, -_w.x / 0.9, -_w.y / 0.9, -_w.z / 0.9, 0.9, 0.5, 0.9, [0.6, 0.8, 1], [1, 1, 1], 0, 0);
      }
      if (Math.random() < dt * 6 * k) fx.flash(job.center, 0xffffff, 5000 * k, 250, 0.12);
      if (job.t >= RETURN.time) {
        job.done = true;
        job.t = 0;
        this.ctx.destruction?.unerase(job.g);
        fx.flash(job.center, 0xffffff, 16000, 700, 0.4);
        this.ctx.player.shake(0.4, 0.5);
        this.ctx.hud.callout('RESTORED', 'good');
      }
      return;
    }
    const k = Math.max(0, 1 - job.t / ERASE.fade);
    for (const m of job.shells) m.material.opacity = 0.9 * k;
    if (k <= 0) {
      this.dropShells(job);
      this.returning = null;
    }
  }

  // A huge bolt from high in the sky onto a random point in the upper part of a box.
  strike(box, height, at = null) {
    const { fx, player } = this.ctx;
    const hit = at ? at.clone() : new THREE.Vector3(
      box.min.x + Math.random() * (box.max.x - box.min.x), box.min.y + (0.5 + Math.random() * 0.5) * (box.max.y - box.min.y),
      box.min.z + Math.random() * (box.max.z - box.min.z));
    const from = hit.clone().add(_v.set((Math.random() - 0.5) * 300, height + Math.random() * 200, (Math.random() - 0.5) * 300));
    fx.bolt(from, hit, { color: 0xdfeeff, width: 12 + Math.random() * 6, life: 0.35, jag: 0.06, segs: 140, maxAmp: 60, branches: 6 });
    fx.flash(hit, 0xffffff, 12000, 600, 0.25);
    fx.burst(hit, 50, { speed: 30, life: 0.6, size: 2.5, c0: [1, 1, 1], c1: [0.6, 0.75, 1], drag: 2 });
    player.shake(0.5 * Math.max(0.3, 1 - player.pos.distanceTo(hit) / 900), 0.4);
  }

  // A cloud of glittering motes where something was, drifting up and out.
  atomize(box) {
    const fx = this.ctx.fx, size = box.getSize(_w);
    const n = Math.min(2500, 400 + (size.x * size.y * size.z) / 400);
    for (let i = 0; i < n; i++) {
      const x = box.min.x + Math.random() * size.x, y = box.min.y + Math.random() * size.y, z = box.min.z + Math.random() * size.z;
      fx.spawn(x, y, z, (Math.random() - 0.5) * 6, 2 + Math.random() * 6, (Math.random() - 0.5) * 6,
        1.5 + Math.random() * 2.5, 0.5 + Math.random() * 0.6, 0.05, [1, 1, 1], [0.55, 0.75, 1], 1.5, 0.4);
    }
  }

  // ---------------------------------------------------------------- the kaiju show
  // A kaiju made out of nothing: the real kaiju's model, frozen (no AI, not an enemy), with its own
  // materials so it can glow white when he erases it.
  makeStatue() {
    const root = new THREE.Group();
    const parts = { glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.9, 0.15), toneMapped: false }) };
    Kaiju.prototype.build.call(parts, root, new THREE.MeshStandardMaterial({ color: '#34302b', roughness: 0.85, metalness: 0.05, flatShading: true }));
    parts.jawG.rotation.x = 0.5; // mid-roar
    const mats = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.fog = false; // it's far away and high up: don't let the city haze wash it out
      if (o.material.emissive) mats.push(o.material);
    });
    const pivot = new THREE.Group(); // spins around the body's centre
    root.position.y = -22 * KAIJU_SCALE;
    root.scale.setScalar(KAIJU_SCALE);
    pivot.add(root);
    pivot.position.copy(this.kc);
    this.ctx.scene.add(pivot);
    pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(pivot); // its full-size bounds, for the gathering atoms
    pivot.visible = false;
    // The light it's born from: a blinding white orb
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({
      color: new THREE.Color(6, 6, 6.5), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    }));
    orb.position.copy(this.kc);
    orb.scale.setScalar(0.01);
    this.ctx.scene.add(orb);
    this.statue = { pivot, mats, spin: 0, box, orb, born: 0 };
  }

  removeStatue() {
    const { pivot, orb } = this.statue;
    this.ctx.scene.remove(pivot, orb);
    orb.geometry.dispose();
    orb.material.dispose();
    pivot.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.statue = null;
  }

  // Creation, the erase run backwards. c: 0 -> 1 over SHOW.create.
  createStatue(dt, c) {
    const S = this.S, st = this.statue, { fx, player } = this.ctx;
    if (st.created) return;
    // 1. A blinding white light bursts open where it will be...
    const light = ramp(c, S.light[0], S.light[1]), fadeLight = ramp(c, S.reveal, S.reveal + 0.15);
    st.orb.visible = fadeLight < 1;
    st.orb.scale.setScalar(Math.max(0.01, 70 * light * (1 - 0.6 * fadeLight)));
    st.orb.material.opacity = (0.75 + 0.25 * Math.sin(c * 90)) * (1 - fadeLight);
    if (c > 0 && !st.lit) {
      st.lit = true;
      fx.flash(this.kc, 0xffffff, 30000, 1500, 0.6);
      player.shake(0.6, 0.6);
    }
    if (light > 0 && fadeLight < 1 && Math.random() < dt * 6) fx.flash(this.kc, 0xffffff, 15000, 1000, 0.15);
    // 2. ...atoms stream in from all around and gather into its shape...
    const g = ramp(c, S.gather[0], S.gather[1]);
    if (g > 0 && g < 1) {
      const left = (1 - g) * (S.gather[1] - S.gather[0]) * (S.create[1] - S.create[0]); // seconds until it appears
      const size = st.box.getSize(_u);
      for (let i = 0; i < 70; i++) {
        _v.set(st.box.min.x + Math.random() * size.x, st.box.min.y + Math.random() * size.y, st.box.min.z + Math.random() * size.z);
        const life = Math.max(0.25, Math.min(left, 0.6 + Math.random() * 0.8));
        _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(80 + Math.random() * 120);
        fx.spawn(_v.x + _w.x, _v.y + _w.y, _v.z + _w.z, -_w.x / life, -_w.y / life, -_w.z / life, life, 2.2, 0.8, [0.6, 0.78, 1], [1, 1, 1], 0, 0);
      }
    }
    // 3. ...it appears, all at once and glowing white, as five bolts strike it...
    if (c >= S.reveal && !st.pivot.visible) {
      st.pivot.visible = true;
      fx.flash(this.kc, 0xffffff, 30000, 1500, 0.5);
      player.shake(0.8, 0.6);
      this.ctx.hud.callout(S.revealText, 'bad');
    }
    if (st.pivot.visible) {
      // 4. ...and the white glow fades into its own colours.
      const r = ramp(c, S.reveal, 1);
      for (const m of st.mats) {
        m.emissive.setRGB(1, 1, 1);
        m.emissiveIntensity = 4 * (1 - r) * (1 - r);
      }
      while (st.born < Math.min(5, Math.floor(r * 5.5) + 1)) {
        st.born++;
        this.strike(st.box, 500);
      }
      if (r >= 1) {
        st.created = true;
        st.orb.visible = false;
      }
    }
  }

  updateStatue(dt, t) {
    const S = SHOW, { fx } = this.ctx;
    if (!this.statue && t >= S.create[0] && t < S.erase[1]) {
      this.makeStatue();
      this.ctx.hud.callout('HE IS CREATING SOMETHING...', 'bad');
    }
    const st = this.statue;
    if (!st) return;
    this.createStatue(dt, ramp(t, S.create[0], S.create[1]));
    // Spin: faster and faster while he circles it
    const s = ramp(t, S.orbit[0], S.erase[1]);
    st.spin += dt * (s * s * 4.5);
    st.pivot.rotation.y = st.spin;
    st.pivot.rotation.z = Math.sin(t * 0.7) * 0.1 * s;
    if (s > 0.3 && Math.random() < dt * 10 * s) {
      // wind and energy whipped off it
      _w.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.4, Math.random() - 0.5).normalize().multiplyScalar(160);
      fx.spawn(this.kc.x + _w.x, this.kc.y + _w.y, this.kc.z + _w.z, -_w.z * 0.6, 0, _w.x * 0.6, 1.2, 4, 1, [0.6, 0.8, 1], [0.3, 0.45, 1], 0, 0.3);
    }
    // Erase: white, five bolts, atoms
    const e = ramp(t, S.erase[0], S.erase[1]);
    if (e > 0) {
      for (const m of st.mats) {
        m.emissive.setRGB(1, 1, 1);
        m.emissiveIntensity = 4 * e * e;
      }
      if (Math.random() < dt * 8 * e) fx.flash(this.kc, 0xffffff, 12000 * e, 500, 0.12);
      const due = Math.floor(e * 5.5);
      st.bolts ??= 0;
      while (st.bolts < Math.min(5, due)) {
        st.bolts++;
        this.strike(new THREE.Box3().setFromObject(st.pivot), 500);
      }
      if (e >= 1) {
        this.atomize(new THREE.Box3().setFromObject(st.pivot));
        fx.flash(this.kc, 0xffffff, 30000, 1500, 0.6);
        this.ctx.player.shake(1, 0.8);
        this.ctx.hud.callout('ERASED', 'bad');
        this.removeStatue();
      }
    }
  }

  // ---------------------------------------------------------------- the building show
  // A building out of thin air: a hollow tower of window blocks (one instanced mesh), each block
  // free to fly apart later.
  makeTower() {
    const S = TOWER, [nx, ny, nz] = S.blocks, [bx, by, bz] = S.block;
    const H = ny * by;
    const pieces = [];
    for (let iy = 0; iy <= ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          const edge = ix === 0 || iz === 0 || ix === nx - 1 || iz === nz - 1;
          if (!edge && iy < ny) continue; // hollow inside; the extra top layer is the roof
          const home = new THREE.Vector3((ix - (nx - 1) / 2) * bx, iy * by - H / 2 + (iy === ny ? -by / 2 + 0.3 : 0), (iz - (nz - 1) / 2) * bz);
          const a = Math.random() * Math.PI * 2;
          pieces.push({
            home, roof: iy === ny, ringR: S.ring[0] + Math.random() * (S.ring[1] - S.ring[0]), ringA: a,
            ringH: (Math.random() - 0.5) * 40, axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
            tumble: (Math.random() - 0.5) * 4, bulge: 10 + Math.random() * 30, pos: new THREE.Vector3(),
          });
        }
      }
    }
    const mat = new THREE.MeshStandardMaterial({ map: towerTexture(), roughness: 0.6, metalness: 0.15, emissive: '#ffffff', emissiveIntensity: 0, fog: false });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(bx * 0.97, by * 0.97, bz * 0.97), mat, pieces.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    pieces.forEach((pc, i) => mesh.setColorAt(i, new THREE.Color().setScalar(pc.roof ? 0.6 : 0.85 + Math.random() * 0.15)));
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.position.copy(this.kc);
    this.ctx.scene.add(pivot);
    this.statue = { pivot, mats: [mat], spin: 0, box: null, orb: null, born: 0, mesh, pieces };
    this.placePieces(0, 0);
    pivot.updateMatrixWorld(true);
    this.statue.box = new THREE.Box3().setFromCenterAndSize(this.kc, new THREE.Vector3(nx * bx, H, nz * bz));
    pivot.visible = false;
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({
      color: new THREE.Color(6, 6, 6.5), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    }));
    orb.position.copy(this.kc);
    orb.scale.setScalar(0.01);
    this.ctx.scene.add(orb);
    this.statue.orb = orb;
  }

  // a: 0 = standing building, 1 = blocks in the ring. ringT: seconds the ring has been turning.
  placePieces(a, ringT) {
    const { mesh, pieces } = this.statue;
    const e = a * a * (3 - 2 * a);
    const q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), m = new THREE.Matrix4();
    pieces.forEach((pc, i) => {
      const ang = pc.ringA + ringT * (24 / pc.ringR); // ~24 m/s around the ring
      _v.set(Math.cos(ang) * pc.ringR, pc.ringH, Math.sin(ang) * pc.ringR);
      pc.pos.lerpVectors(pc.home, _v, e);
      pc.pos.y += Math.sin(Math.PI * a) * pc.bulge; // drift up and out as it comes apart
      q.setFromAxisAngle(pc.axis, pc.tumble * ringT * a);
      mesh.setMatrixAt(i, m.compose(pc.pos, q, s));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  updateTower(dt, t) {
    const S = TOWER, { fx } = this.ctx;
    if (!this.statue && t >= S.create[0] && t < S.erase[1]) {
      this.makeTower();
      this.ctx.hud.callout('HE IS CREATING SOMETHING...', 'bad');
    }
    const st = this.statue;
    if (!st) return;
    this.createStatue(dt, ramp(t, S.create[0], S.create[1]));
    // Turns slowly while he circles it...
    if (t >= S.spin[0] && t < S.apart[1]) st.spin += dt * 0.35 * (1 - ramp(t, S.apart[0], S.apart[1]));
    st.pivot.rotation.y = st.spin;
    // ...comes apart block by block, and the blocks swing out into a great turning ring
    const a = ramp(t, S.apart[0], S.apart[1]);
    if (a > 0) {
      const ringT = t - S.apart[0];
      this.placePieces(a, ringT);
      if (a < 1 && Math.random() < dt * 4) {
        // cracks of light as it separates
        const pc = st.pieces[(Math.random() * st.pieces.length) | 0];
        _v.copy(pc.pos).applyQuaternion(st.pivot.quaternion).add(this.kc);
        fx.burst(_v, 12, { speed: 10, life: 0.4, size: 1.5, c0: [1, 1, 1], c1: [0.5, 0.7, 1] });
      }
    }
    // Erase: every block glows white, five bolts, and they all go to atoms
    const e = ramp(t, S.erase[0], S.erase[1]);
    if (e > 0) {
      st.mats[0].emissiveIntensity = 4 * e * e;
      if (Math.random() < dt * 8 * e) fx.flash(this.kc, 0xffffff, 12000 * e, 600, 0.12);
      st.bolts ??= 0;
      while (st.bolts < Math.min(5, Math.floor(e * 5.5))) {
        st.bolts++;
        const pc = st.pieces[(Math.random() * st.pieces.length) | 0];
        this.strike(null, 500, _v.copy(pc.pos).applyQuaternion(st.pivot.quaternion).add(this.kc));
      }
      if (e >= 1) {
        for (const pc of st.pieces) {
          _v.copy(pc.pos).applyQuaternion(st.pivot.quaternion).add(this.kc);
          for (let k = 0; k < 3; k++) {
            fx.spawn(_v.x + (Math.random() - 0.5) * 4, _v.y + (Math.random() - 0.5) * 4, _v.z + (Math.random() - 0.5) * 4,
              (Math.random() - 0.5) * 6, 2 + Math.random() * 6, (Math.random() - 0.5) * 6, 1.5 + Math.random() * 2.5, 0.6 + Math.random() * 0.6, 0.05,
              [1, 1, 1], [0.55, 0.75, 1], 1.5, 0.4);
          }
        }
        fx.flash(this.kc, 0xffffff, 30000, 1500, 0.6);
        this.ctx.player.shake(1, 0.8);
        this.ctx.hud.callout('ERASED', 'bad');
        this.removeStatue();
      }
    }
  }

  // ---------------------------------------------------------------- the lift
  // Pick a building like for an erase; its top half glows first.
  startLift() {
    const p = this.ctx.player.pos;
    const options = this.groups.filter((g) => {
      if (g.erased || g.vols || g === this.returning?.g || g === this.erasing?.g) return false;
      const w = g.walls[0], d = Math.hypot(w.cx - p.x, w.cz - p.z);
      return d > ERASE.range[0] && d < ERASE.range[1];
    });
    if (!options.length) return;
    const g = options[(Math.random() * options.length) | 0];
    const box = new THREE.Box3();
    for (const w of g.walls) {
      box.expandByPoint(_v.set(w.cx - w.w / 2, w.y0, w.cz - w.d / 2));
      box.expandByPoint(_v.set(w.cx + w.w / 2, w.y0 + w.h, w.cz + w.d / 2));
    }
    const mid = (box.min.y + box.max.y) / 2;
    // Glow shells over the top half only
    const shells = [];
    for (const w of g.walls) {
      const top = w.y0 + w.h, bottom = Math.max(w.y0, mid);
      if (top <= bottom) continue;
      const m = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(4, 4, 4.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      m.position.set(w.cx, (top + bottom) / 2, w.cz);
      m.scale.set(w.w + 0.8, top - bottom + 0.8, w.d + 0.8);
      this.ctx.scene.add(m);
      shells.push(m);
    }
    const center = box.getCenter(new THREE.Vector3()).setY((mid + box.max.y) / 2);
    this.lift = { g, box, mid, shells, center, point: new THREE.Vector3(center.x, box.max.y + LIFT.up, center.z), pieces: null };
    this.ctx.hud.callout('HE IS LOOKING AT A BUILDING...', 'bad');
  }

  // The top half comes apart into flying blocks.
  liftOff() {
    const L = this.lift, top = L.box.max.y;
    const blocks = this.ctx.destruction?.extract(L.g, (c) => c.y >= L.mid) ?? [];
    L.pieces = blocks.map((b) => {
      const h = (b.pos.y - L.mid) / Math.max(1, top - L.mid); // 0 at the cut, 1 at the roof
      const out = _v.set(b.pos.x - L.center.x, 0, b.pos.z - L.center.z).multiplyScalar(1.3 + Math.random() * 0.6);
      return {
        start: b.pos, size: b.size, color: b.color,
        up: new THREE.Vector3(L.center.x + out.x, top + LIFT.up + (h - 0.5) * 30 + (Math.random() - 0.5) * 25, L.center.z + out.z),
        delay: (1 - h) * 1.2 + Math.random() * 0.8, // the roof goes first
        axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        tumble: (Math.random() - 0.5) * 3, swirl: 0.6 + Math.random() * 0.8, pos: new THREE.Vector3(),
      };
    });
    const mat = new THREE.MeshStandardMaterial({ map: towerTexture(), roughness: 0.7, metalness: 0.1, emissive: '#ffffff', emissiveIntensity: 0 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, L.pieces.length));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = L.pieces.length;
    L.pieces.forEach((pc, i) => mesh.setColorAt(i, new THREE.Color(pc.color).lerp(new THREE.Color(1, 1, 1), 0.35)));
    this.ctx.scene.add(mesh);
    // The point they get pulled into
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({
      color: new THREE.Color(6, 6, 6.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    orb.position.copy(L.point);
    orb.scale.setScalar(0.01);
    this.ctx.scene.add(orb);
    Object.assign(L, { mesh, mat, orb, bolts: 0 });
    this.ctx.fx.flash(L.center, 0xffffff, 12000, 500, 0.3);
    this.ctx.player.shake(0.5, 0.5);
  }

  updateLift(dt, t) {
    const L = this.lift;
    if (!L) return;
    const S = LIFT, { fx, player } = this.ctx;
    // Glow on the top half, then it comes apart
    const glow = ramp(t, S.glow[0], S.glow[1]);
    const fadeShell = ramp(t, S.glow[1], S.glow[1] + 0.6);
    for (const m of L.shells) m.material.opacity = (0.15 + 0.75 * glow * glow) * (1 - fadeShell);
    // Lightning hammers the top half while it glows, and one last bolt as it breaks loose
    const topHalf = L.topBox ??= new THREE.Box3(new THREE.Vector3(L.box.min.x, L.mid, L.box.min.z), L.box.max.clone());
    L.struck ??= 0;
    while (L.struck < Math.min(3, Math.floor(glow * 3.4))) {
      L.struck++;
      this.strike(topHalf, 450);
    }
    if (!L.pieces && t >= S.glow[1]) {
      this.strike(topHalf, 500, L.center);
      this.liftOff();
    }
    if (!L.pieces) return;
    const q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), s = new THREE.Vector3();
    const pull = ramp(t, S.pull[0], S.pull[1]), pullE = pull * pull * pull; // slow, then sucked in fast
    const riseT = t - S.rise[0], riseLen = S.rise[1] - S.rise[0] - 2;
    L.pieces.forEach((pc, i) => {
      // Rise: each block floats up to its place above the building
      const u = Math.min(1, Math.max(0, (riseT - pc.delay) / riseLen)), e = u * u * (3 - 2 * u);
      pc.pos.lerpVectors(pc.start, pc.up, e);
      pc.pos.y += Math.sin(t * 1.3 + i) * 1.5 * e; // gentle bob while floating
      // Pull: everything spirals in to one point
      if (pull > 0) {
        _v.subVectors(pc.pos, L.point);
        const ang = pullE * Math.PI * 2 * pc.swirl;
        const c = Math.cos(ang), sn = Math.sin(ang);
        _v.set(_v.x * c - _v.z * sn, _v.y, _v.x * sn + _v.z * c).multiplyScalar(1 - pullE);
        pc.pos.copy(L.point).add(_v);
      }
      q.setFromAxisAngle(pc.axis, pc.tumble * Math.max(0, riseT) * e);
      const k = 1 - 0.85 * pullE;
      L.mesh.setMatrixAt(i, m4.compose(pc.pos, q, s.copy(pc.size).multiplyScalar(k)));
    });
    L.mesh.instanceMatrix.needsUpdate = true;
    // Arcs crackling between rising blocks
    if (t < S.pull[1] && L.pieces.length > 1 && Math.random() < dt * 8) {
      const a = L.pieces[(Math.random() * L.pieces.length) | 0], b = L.pieces[(Math.random() * L.pieces.length) | 0];
      if (a.pos.distanceTo(b.pos) < 60) fx.bolt(a.pos.clone(), b.pos.clone(), { color: 0xbfe0ff, width: 0.8, life: 0.12, jag: 0.2 });
    }
    // The point: grows as it swallows them, streams of light falling in
    L.orb.visible = pull > 0;
    L.orb.scale.setScalar(Math.max(0.01, 4 + 10 * pull + Math.sin(t * 40) * 0.8 * pull));
    if (pull > 0 && pull < 1) {
      for (let i = 0; i < 10; i++) {
        _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(40 + Math.random() * 60);
        fx.spawn(L.point.x + _w.x, L.point.y + _w.y, L.point.z + _w.z, -_w.x / 0.6, -_w.y / 0.6, -_w.z / 0.6, 0.6, 1.2, 0.2, [0.6, 0.8, 1], [1, 1, 1], 0, 0);
      }
      if (Math.random() < dt * 3) player.shake(0.15, 0.2);
    }
    // Erase: white, bolts into the point, then gone
    const e = ramp(t, S.erase[0], S.erase[1]);
    if (e > 0) {
      L.mat.emissiveIntensity = 4 * e;
      L.orb.scale.setScalar(14 + 8 * e);
      if (Math.random() < dt * 8 * e) fx.flash(L.point, 0xffffff, 12000 * e, 500, 0.12);
      while (L.bolts < Math.min(3, Math.floor(e * 3.5))) {
        L.bolts++;
        this.strike(null, 450, L.point);
      }
      if (e >= 1) {
        // Burst of atoms out of the point
        for (let i = 0; i < 1500; i++) {
          _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(10 + Math.random() * 50);
          fx.spawn(L.point.x, L.point.y, L.point.z, _w.x, _w.y, _w.z, 1.5 + Math.random() * 2, 0.7, 0.05, [1, 1, 1], [0.55, 0.75, 1], 0, 1.2);
        }
        fx.flash(L.point, 0xffffff, 30000, 1200, 0.6);
        player.shake(0.9, 0.7);
        this.ctx.hud.callout('ERASED', 'bad');
        this.endLift();
      }
    }
  }

  endLift() {
    const L = this.lift;
    for (const m of L.shells) {
      this.ctx.scene.remove(m);
      m.material.dispose();
    }
    if (L.mesh) {
      this.ctx.scene.remove(L.mesh, L.orb);
      L.mesh.geometry.dispose();
      L.mat.map.dispose();
      L.mat.dispose();
      L.orb.geometry.dispose();
      L.orb.material.dispose();
    }
    this.lift = null;
  }

  // The electric sphere around the show: invisible until the hero comes near, impassable.
  updateBarrier(dt, t) {
    const { player, fx } = this.ctx, B = this.barrier, mat = B.material;
    const up = t < this.S.back[1];
    B.visible = up;
    if (!up) return;
    mat.uniforms.uTime.value = t;
    _w.copy(player.pos);
    _w.y += 1;
    const toHero = _v.subVectors(_w, this.kc), d = toHero.length(), R = this.S.barrier;
    const near = Math.max(0, 1 - (d - R) / 120); // fades in from 120 m away
    mat.uniforms.uK.value = Math.min(1, near) * 0.6;
    mat.uniforms.uHitK.value = Math.max(0, mat.uniforms.uHitK.value - dt * 2);
    if (d >= R + 1.5 || player.dead) return;
    // Pushed back out, sparks crawling over the barrier where it's touched, the camera shaking
    toHero.multiplyScalar(1 / d);
    player.pos.addScaledVector(toHero, R + 1.5 - d);
    const into = player.vel.dot(toHero);
    if (into < 0) player.vel.addScaledVector(toHero, -into * 1.8);
    if (player.launchT > 0) player.launchT = 0;
    const hit = _u.copy(this.kc).addScaledVector(toHero, R);
    mat.uniforms.uHit.value.copy(hit);
    mat.uniforms.uHitK.value = 1;
    player.shake(0.9, 0.5);
    if (Math.random() < dt * 20) {
      _w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(40).add(hit);
      fx.bolt(hit.clone(), _w.clone(), { color: 0x7fb8ff, width: 0.8, life: 0.12, jag: 0.2 });
      fx.burst(hit, 6, { speed: 10, life: 0.3, size: 0.6, c0: [0.8, 0.95, 1], c1: [0.2, 0.45, 1] });
    }
    if (!this.blockedMsg) {
      this.blockedMsg = true;
      this.ctx.hud.callout('AN ENERGY BARRIER BLOCKS YOUR WAY', 'bad');
    }
  }

  // ---------------------------------------------------------------- storm
  // One enormous forked bolt somewhere over the city: from high in the sky down into the streets,
  // or a long crawler across the sky. Up to 2 km long.
  cityBolt() {
    const { fx, player } = this.ctx;
    const p = player.pos;
    const a = Math.random() * Math.PI * 2, r = Math.random() * 1200;
    const from = new THREE.Vector3(p.x + Math.cos(a) * r, 320 + Math.random() * 260, p.z + Math.sin(a) * r);
    let to;
    if (Math.random() < 0.55) {
      const b = Math.random() * Math.PI * 2, s = 200 + Math.random() * 700;
      to = new THREE.Vector3(from.x + Math.cos(b) * s, 0, from.z + Math.sin(b) * s); // strike
    } else {
      const b = Math.random() * Math.PI * 2, s = 900 + Math.random() * 1100;
      to = new THREE.Vector3(from.x + Math.cos(b) * s, from.y + (Math.random() - 0.5) * 160, from.z + Math.sin(b) * s); // sky crawler
    }
    const len = from.distanceTo(to);
    fx.bolt(from, to, {
      color: 0x9cc8ff, width: 7 + Math.random() * 7, life: 0.25 + Math.random() * 0.25, jag: 0.06,
      segs: 150, maxAmp: Math.min(140, len * 0.07), branches: 4 + ((Math.random() * 5) | 0),
    });
    fx.flash(from, 0xa8d0ff, 9000, 900, 0.2);
    if (to.y < 1) {
      fx.flash(to, 0xa8d0ff, 8000, 500, 0.2);
      fx.burst(to, 40, { speed: 26, life: 0.6, size: 3, c0: [0.9, 0.96, 1], c1: [0.3, 0.5, 1], drag: 2 });
    }
    const d = Math.min(p.distanceTo(from), p.distanceTo(to));
    player.shake(0.5 * Math.max(0.3, 1 - d / 1200), 0.4); // thunder
  }
}
