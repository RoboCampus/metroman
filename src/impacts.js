import * as THREE from 'three';

// Impact marks: craters (with cooling embers) on the ground, scorch marks and shattered
// windows on walls, plus falling glass. Marks are pooled decals that fade after a while.

const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const EMBER = { fire: new THREE.Color(0xff6a1a), elec: new THREE.Color(0x5fc8ff) };
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _p = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3();
const _u = new THREE.Vector3(); // shatter() scratch: callers may pass _p as pos

function canvasTex(draw, size = 256, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Jagged lines from the centre outward
function radialCracks(g, S, n, from, to, style, width) {
  g.strokeStyle = style;
  g.lineWidth = width;
  for (let i = 0; i < n; i++) {
    let a = (i / n) * Math.PI * 2 + Math.random() * 0.4, r = from;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
    while (r < to) {
      r += 6 + Math.random() * 10;
      a += (Math.random() - 0.5) * 0.35;
      g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
    }
    g.stroke();
  }
}

function makeTextures() {
  const crater = canvasTex((g, S) => {
    const c = S / 2;
    // Irregular blast outline built from overlapping blotches
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * S * 0.28;
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r, rad = S * (0.12 + Math.random() * 0.12);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(22,18,15,.9)');
      gr.addColorStop(1, 'rgba(22,18,15,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const gr = g.createRadialGradient(c, c, 0, c, c, S * 0.5);
    gr.addColorStop(0, 'rgba(6,5,4,1)');
    gr.addColorStop(0.35, 'rgba(14,12,10,.95)');
    gr.addColorStop(0.55, 'rgba(60,55,50,.75)'); // rubble rim
    gr.addColorStop(0.75, 'rgba(30,26,22,.35)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 500; i++) {
      // rubble and debris specks around the rim
      const a = Math.random() * Math.PI * 2, r = S * (0.2 + Math.random() * 0.3);
      g.fillStyle = Math.random() < 0.5 ? 'rgba(90,85,78,.8)' : 'rgba(15,13,11,.8)';
      g.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    radialCracks(g, S, 9, S * 0.12, S * 0.48, 'rgba(5,4,3,.85)', 2);
  });
  const ember = canvasTex((g, S) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.22);
    gr.addColorStop(0, 'rgba(255,255,255,.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    radialCracks(g, S, 8, S * 0.05, S * 0.36, 'rgba(255,255,255,.9)', 2);
  });
  const scorch = canvasTex((g, S) => {
    for (let i = 0; i < 30; i++) {
      // soot, smeared upward
      const x = S / 2 + (Math.random() - 0.5) * S * 0.4, y = S / 2 - Math.random() * S * 0.25 + S * 0.05;
      const rad = S * (0.08 + Math.random() * 0.18);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(12,10,9,.75)');
      gr.addColorStop(1, 'rgba(12,10,9,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    radialCracks(g, S, 6, S * 0.06, S * 0.3, 'rgba(5,4,3,.7)', 2);
  });
  const glass = canvasTex((g, S) => {
    const c = S / 2;
    // Dark jagged hole where the pane was knocked out
    g.fillStyle = 'rgba(4,7,12,.92)';
    g.beginPath();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, r = S * (0.12 + Math.random() * 0.14);
      if (i) g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      else g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    // Spider-web cracks: radial lines plus jagged rings
    radialCracks(g, S, 14, S * 0.15, S * 0.48, 'rgba(235,245,255,.85)', 1.5);
    g.strokeStyle = 'rgba(235,245,255,.6)';
    g.lineWidth = 1;
    for (const ring of [0.24, 0.32, 0.4]) {
      g.beginPath();
      for (let i = 0; i <= 20; i++) {
        const a = (i / 20) * Math.PI * 2, r = S * ring * (0.9 + Math.random() * 0.2);
        if (i) g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
        else g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      }
      g.stroke();
    }
    // A few loose shards still hanging in the frame
    g.fillStyle = 'rgba(200,225,245,.35)';
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, r = S * 0.2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      g.lineTo(c + Math.cos(a + 0.25) * r * 1.6, c + Math.sin(a + 0.25) * r * 1.6);
      g.lineTo(c + Math.cos(a - 0.15) * r * 1.9, c + Math.sin(a - 0.15) * r * 1.9);
      g.fill();
    }
  });
  return { crater, ember, scorch, glass };
}

class Decals {
  constructor(scene, max = 90) {
    this.tex = makeTextures();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        transparent: true, depthWrite: false, roughness: 1, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      m.visible = false;
      m.renderOrder = 2;
      m.receiveShadow = true;
      scene.add(m);
      this.pool.push({ m, life: 0, max: 1, ember: 0 });
    }
    this.next = 0;
  }

  // kind: 'crater' | 'scorch' | 'glass'. normal: unit surface normal.
  add(kind, pos, normal, size, life, emberKind = null) {
    const d = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length; // oldest mark is recycled
    const { m } = d, mat = m.material;
    mat.map = this.tex[kind];
    mat.emissiveMap = emberKind ? this.tex.ember : null;
    mat.emissive.copy(emberKind ? EMBER[emberKind] : new THREE.Color(0));
    mat.emissiveIntensity = emberKind ? 2.5 : 0;
    mat.opacity = 1;
    mat.needsUpdate = true;
    _n.set(normal.x, normal.y, normal.z);
    m.position.set(pos.x, pos.y, pos.z).addScaledVector(_n, 0.04);
    m.quaternion.setFromUnitVectors(Z, _n);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.visible = true;
    Object.assign(d, { life, max: life, ember: emberKind ? 2 : 0 });
  }

  update(dt) {
    for (const d of this.pool) {
      if (!d.m.visible) continue;
      d.life -= dt;
      const mat = d.m.material;
      if (d.ember > 0) {
        d.ember -= dt;
        mat.emissiveIntensity = Math.max(0, d.ember) * 1.25; // embers cool down
      }
      mat.opacity = Math.min(1, d.life / 2); // fade over the last 2 seconds
      if (d.life <= 0) d.m.visible = false;
    }
  }
}

export class Impacts {
  constructor(ctx) {
    this.ctx = ctx;
    this.decals = new Decals(ctx.scene);
  }

  update(dt) {
    this.decals.update(dt);
  }

  // An attack landed at pos. normal: surface it hit (null = in the air / on an enemy).
  // size: crater diameter in metres. kind: 'fire' | 'elec'. blast: radius for shattering
  // windows on nearby walls (0 = only what was hit directly).
  hit(pos, normal, size, kind = 'fire', blast = 0) {
    const world = this.ctx.world;
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    _p.set(pos.x, pos.y, pos.z);
    let n = normal;
    if (!n) {
      // Mid-air hits still mark the ground if they're close to it
      const gy = world.groundY(_p.x, _p.z, _p.y + 0.5);
      if (_p.y - gy < Math.max(1.5, size * 0.5)) {
        n = UP;
        _p.y = gy;
      }
    }
    if (n) {
      if (n.y > 0.6) this.decals.add('crater', _p, n, size * (0.9 + Math.random() * 0.3), 7 + size * 0.4, kind);
      else if (Math.abs(n.y) < 0.5) this.wall(_p, n, size, kind);
    }
    if (blast >= 4) this.shatterAround(_p.clone(), blast);
    // Strong blasts and heavy direct wall hits knock chunks out of buildings
    const dest = this.ctx.destruction;
    if (blast >= 4) dest?.damage(at, blast * 0.45);
    // Any hit on a wall knocks out the blocks it touches (aim a little inside the wall)
    else if (normal && Math.abs(normal.y) < 0.5) dest?.damage(at.addScaledVector(normal, -1.5), Math.max(1.2, size * 0.5));
  }

  wall(pos, n, size, kind) {
    this.decals.add('scorch', pos, n, size * 1.3, 8 + size * 0.4, kind);
    this.shatter(pos, n, size);
  }

  // Shattered windows on a wall around pos, with glass raining down.
  shatter(pos, n, size) {
    const fx = this.ctx.fx;
    _t.set(-n.z, 0, n.x); // along the wall
    const count = Math.min(4, 1 + Math.floor(size / 3));
    for (let k = 0; k < count; k++) {
      const spread = k === 0 ? 0 : 1;
      _o.copy(pos)
        .addScaledVector(_t, (Math.random() - 0.5) * size * 1.6 * spread)
        .addScaledVector(UP, (Math.random() - 0.5) * size * spread);
      if (_o.y < 1) continue;
      this.decals.add('glass', _o, n, 2.4 + Math.random() * 1.4, 22);
      for (let i = 0; i < 26; i++) {
        _d.copy(n).multiplyScalar(2 + Math.random() * 6)
          .addScaledVector(_t, (Math.random() - 0.5) * 6)
          .add(_u.set(0, 1 + Math.random() * 3, 0));
        const sx = _o.x + (Math.random() - 0.5) * 1.5, sy = _o.y + (Math.random() - 0.5) * 1.5, sz = _o.z + (Math.random() - 0.5) * 1.5;
        if (i % 3) {
          // glittering shards catching the light
          fx.spawn(sx, sy, sz, _d.x, _d.y, _d.z, 1.4 + Math.random() * 0.8, 0.22, 0.08, [0.85, 0.95, 1], [0.35, 0.5, 0.65], -20, 0.2);
        } else {
          fx.smoke(sx, sy, sz, _d.x, _d.y, _d.z, 1.6 + Math.random() * 0.6, 0.18, 0.12, [0.55, 0.65, 0.72], [0.4, 0.48, 0.55], -20, 0.2);
        }
      }
    }
  }

  // Big blasts: find walls within radius in 8 directions and shatter them too.
  shatterAround(pos, r) {
    const world = this.ctx.world;
    let done = 0;
    for (let i = 0; i < 8 && done < 4; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.3;
      _d.set(Math.cos(a), 0, Math.sin(a));
      _o.set(pos.x, Math.max(pos.y, 0) + 1.5 + Math.random() * 3, pos.z);
      const t = world.raycastHit(_o, _d, r);
      const n = world.hitNormal;
      if (!n || t >= r || Math.abs(n.y) > 0.5) continue;
      const hitP = _o.clone().addScaledVector(_d, t);
      this.shatter(hitP, new THREE.Vector3(n.x, n.y, n.z), Math.max(2, 6 * (1 - t / r)));
      done++;
    }
  }
}
