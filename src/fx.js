import * as THREE from 'three';
import { randomDir } from './util.js';

const MAXP = 9000;
const WHITE = [1, 1, 1];
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(0.3, -mv.z), 300.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  if (d > 1.0) discard;
  float a = 1.0 - d;
  gl_FragColor = vec4(vColor, a * a * vAlpha);
  #include <colorspace_fragment>
}`;

// CPU-simulated point sprites. Sizes are in meters. Additive (glowing fire, sparks) or
// normal blending (smoke, dust).
class Particles {
  constructor(scene, additive = true) {
    this.n = 0;
    this.p = new Float32Array(MAXP * 3);
    this.v = new Float32Array(MAXP * 3);
    this.c0 = new Float32Array(MAXP * 3);
    this.c1 = new Float32Array(MAXP * 3);
    this.life = new Float32Array(MAXP);
    this.max = new Float32Array(MAXP);
    this.s0 = new Float32Array(MAXP);
    this.s1 = new Float32Array(MAXP);
    this.ay = new Float32Array(MAXP);
    this.drag = new Float32Array(MAXP);
    this.gPos = new Float32Array(MAXP * 3);
    this.gCol = new Float32Array(MAXP * 3);
    this.gSize = new Float32Array(MAXP);
    this.gAlpha = new Float32Array(MAXP);

    const g = (this.geo = new THREE.BufferGeometry());
    const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr(this.gPos, 3));
    g.setAttribute('aColor', attr(this.gCol, 3));
    g.setAttribute('aSize', attr(this.gSize, 1));
    g.setAttribute('aAlpha', attr(this.gAlpha, 1));
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const pts = new THREE.Points(g, this.mat);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, ay, drag) {
    if (this.n >= MAXP) return;
    const i = this.n++, i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.c0[i3] = c0[0]; this.c0[i3 + 1] = c0[1]; this.c0[i3 + 2] = c0[2];
    this.c1[i3] = c1[0]; this.c1[i3 + 1] = c1[1]; this.c1[i3 + 2] = c1[2];
    this.life[i] = this.max[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.ay[i] = ay;
    this.drag[i] = drag;
  }

  copy(src, dst) {
    const s3 = src * 3, d3 = dst * 3;
    for (let k = 0; k < 3; k++) {
      this.p[d3 + k] = this.p[s3 + k];
      this.v[d3 + k] = this.v[s3 + k];
      this.c0[d3 + k] = this.c0[s3 + k];
      this.c1[d3 + k] = this.c1[s3 + k];
    }
    this.life[dst] = this.life[src];
    this.max[dst] = this.max[src];
    this.s0[dst] = this.s0[src];
    this.s1[dst] = this.s1[src];
    this.ay[dst] = this.ay[src];
    this.drag[dst] = this.drag[src];
  }

  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.copy(this.n - 1, i);
        this.n--;
        continue;
      }
      const i3 = i * 3;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i3] *= dr;
      this.v[i3 + 1] = this.v[i3 + 1] * dr + this.ay[i] * dt;
      this.v[i3 + 2] *= dr;
      this.p[i3] += this.v[i3] * dt;
      this.p[i3 + 1] += this.v[i3 + 1] * dt;
      this.p[i3 + 2] += this.v[i3 + 2] * dt;
      const t = 1 - this.life[i] / this.max[i];
      for (let k = 0; k < 3; k++) {
        this.gPos[i3 + k] = this.p[i3 + k];
        this.gCol[i3 + k] = this.c0[i3 + k] + (this.c1[i3 + k] - this.c0[i3 + k]) * t;
      }
      this.gSize[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.gAlpha[i] = (1 - t) * Math.min(1, t * 10 + 0.4);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) this.geo.attributes[name].needsUpdate = true;
  }
}

// Soft contact shadows under characters (a dark radial blob on the ground), rebuilt every frame
// with begin() / add() / end(). Cheap, and readable even where the sun shadow is lost.
export class BlobShadows {
  constructor(scene, max = 48) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    // White with an alpha falloff: the material colour sets the tint (black).
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.5, 'rgba(255,255,255,.65)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: tex, color: 0x000000, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      m.visible = false;
      m.renderOrder = 1;
      scene.add(m);
      this.pool.push(m);
    }
    this.n = 0;
  }

  begin() {
    this.n = 0;
  }

  // (x, z) on ground height gy; height = how far the caster is above the ground.
  add(x, gy, z, radius, height = 0, strength = 0.75) {
    if (this.n >= this.pool.length) return;
    const fade = Math.max(0, 1 - height / 35);
    if (fade <= 0.02) return;
    const m = this.pool[this.n++];
    m.visible = true;
    m.position.set(x, gy + 0.03, z);
    m.scale.setScalar(radius * 2 * (1 + height * 0.04));
    m.material.opacity = strength * fade;
  }

  end() {
    for (let i = this.n; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}

export class FX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.parts = new Particles(scene);
    this.smokeParts = new Particles(scene, false);
    this.bolts = [];
    this.rings = [];
    // Fixed light pool so the shader light count never changes.
    this.lights = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 40, 2);
      scene.add(l);
      this.lights.push({ l, t: 0, dur: 1, peak: 0 });
    }
    this.handLight = new THREE.PointLight(0xffffff, 0, 25, 2);
    scene.add(this.handLight);
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);
  }

  spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1 = c0, ay = 0, drag = 0) {
    this.parts.spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, ay, drag);
  }

  // Dark, non-glowing particle (smoke, dust). Positive ay makes it rise.
  smoke(x, y, z, vx, vy, vz, life, s0, s1, c0 = [0.22, 0.21, 0.2], c1 = [0.1, 0.1, 0.1], ay = 1.5, drag = 0.8) {
    this.smokeParts.spawn(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, ay, drag);
  }

  burst(pos, n, o = {}) {
    const { speed = 10, life = 0.6, size = 1, size1 = size * 0.2, c0 = WHITE, c1 = c0, ay = 0, drag = 1.5 } = o;
    for (let i = 0; i < n; i++) {
      randomDir(_v).multiplyScalar(speed * (0.25 + Math.random() * 0.75));
      this.parts.spawn(pos.x, pos.y, pos.z, _v.x, _v.y, _v.z, life * (0.5 + Math.random() * 0.7), size, size1, c0, c1, ay, drag);
    }
  }

  flash(pos, color, intensity, distance = 40, dur = 0.3) {
    let best = this.lights[0];
    for (const L of this.lights) if (L.l.intensity < best.l.intensity) best = L;
    best.l.position.copy(pos);
    best.l.color.set(color);
    best.l.distance = distance;
    best.l.intensity = best.peak = intensity;
    best.t = best.dur = dur;
  }

  ring(pos, color, radius, dur = 0.4) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    m.position.copy(pos);
    m.position.y += 0.3;
    m.scale.setScalar(0.5);
    this.scene.add(m);
    this.rings.push({ m, t: 0, dur, radius });
  }

  // Jagged camera-facing lightning ribbon (white core + colored glow), with random branches.
  bolt(from, to, o = {}) {
    const { color = 0x7fcfff, width = 0.4, life = 0.12, jag = 0.12 } = o;
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    const n = Math.max(3, Math.min(30, Math.round(len / 1.6)));
    _d.subVectors(to, from).normalize();
    _p.set(0, 1, 0);
    if (Math.abs(_d.y) > 0.9) _p.set(1, 0, 0);
    _p.cross(_d).normalize();
    _q.crossVectors(_d, _p);
    const amp = Math.min(len * jag, 4);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, env = Math.sin(Math.PI * t);
      const p = new THREE.Vector3().lerpVectors(from, to, t);
      if (i > 0 && i < n) {
        p.addScaledVector(_p, (Math.random() - 0.5) * 2 * amp * env);
        p.addScaledVector(_q, (Math.random() - 0.5) * 2 * amp * env);
      }
      pts.push(p);
    }
    const meshes = [this.ribbon(pts, width * 0.35, 0xffffff, 1), this.ribbon(pts, width * 1.8, color, 0.55)];
    this.bolts.push({ meshes, life, max: life });
    if (len > 8 && Math.random() < 0.7) {
      const bp = pts[1 + ((Math.random() * (n - 1)) | 0)];
      const end = randomDir(new THREE.Vector3()).multiplyScalar(len * 0.2).add(bp);
      this.bolt(bp, end, { color, width: width * 0.5, life, jag });
    }
  }

  ribbon(pts, w, color, opacity) {
    const n = pts.length, pos = new Float32Array(n * 6), cam = this.camera.position;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], p = pts[i];
      _d.subVectors(b, a);
      _v.subVectors(cam, p);
      _p.crossVectors(_d, _v).normalize().multiplyScalar(w / 2);
      pos[i * 6] = p.x - _p.x; pos[i * 6 + 1] = p.y - _p.y; pos[i * 6 + 2] = p.z - _p.z;
      pos[i * 6 + 3] = p.x + _p.x; pos[i * 6 + 4] = p.y + _p.y; pos[i * 6 + 5] = p.z + _p.z;
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, fog: false,
    }));
    m.frustumCulled = false;
    m.userData.base = opacity;
    this.scene.add(m);
    return m;
  }

  update(dt, viewHeight) {
    const scale = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    this.parts.mat.uniforms.uScale.value = this.smokeParts.mat.uniforms.uScale.value = scale;
    this.parts.update(dt);
    this.smokeParts.update(dt);

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      const k = Math.max(0, b.life / b.max);
      for (const m of b.meshes) m.material.opacity = m.userData.base * k;
      if (b.life <= 0) {
        for (const m of b.meshes) {
          this.scene.remove(m);
          m.geometry.dispose();
          m.material.dispose();
        }
        this.bolts.splice(i, 1);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      r.m.scale.setScalar(0.5 + k * r.radius);
      r.m.material.opacity = (1 - k) * 0.9;
      if (k >= 1) {
        this.scene.remove(r.m);
        r.m.material.dispose();
        this.rings.splice(i, 1);
      }
    }

    for (const L of this.lights) {
      L.t -= dt;
      L.l.intensity = L.t > 0 ? L.peak * (L.t / L.dur) ** 2 : 0;
    }
  }
}
