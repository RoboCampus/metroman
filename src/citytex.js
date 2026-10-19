import * as THREE from 'three';

// Procedural textures for the city: weathered facades (+ normal maps), streets, Broadway, signs.

export const WIN_W = 4, WIN_H = 3.6, CELLS = 16, ROOF_UV = 2.5 / 512;

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(c, { srgb = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Height canvas (grey = height) -> tangent-space normal map. Canvas y runs down, texture v up.
function heightToNormal(src, strength) {
  const W = src.width, H = src.height;
  const h = src.getContext('2d').getImageData(0, 0, W, H).data;
  const out = canvas(W, H), og = out.getContext('2d'), img = og.createImageData(W, H), d = img.data;
  const at = (x, y) => h[(((y + H) % H) * W + ((x + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const du = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dv = (at(x, y - 1) - at(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(du, dv, 1);
      const i = (y * W + x) * 4;
      d[i] = (-du * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (-dv * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

// Facade atlas: CELLS x CELLS window cells (one cell = one window bay x one floor).
// Maps: colour (with grime), emissive (lit windows), ORM (G roughness, B metalness), normal.
// Canvas top of a cell is the top of the floor.
export function makeFacade(style, rng) {
  const S = 512, cs = S / CELLS;
  const a = canvas(S, S), e = canvas(S, S), o = canvas(S, S), hc = canvas(S, S);
  const ca = a.getContext('2d'), ce = e.getContext('2d'), co = o.getContext('2d'), ch = hc.getContext('2d');
  const grey = (v) => `rgb(${(v * 255) | 0},${(v * 255) | 0},${(v * 255) | 0})`;
  const paint = (x, y, w, h, col, rough, metal, height) => {
    ca.fillStyle = col;
    ca.fillRect(x, y, w, h);
    co.fillStyle = `rgb(0,${(rough * 255) | 0},${(metal * 255) | 0})`;
    co.fillRect(x, y, w, h);
    if (height !== undefined) {
      ch.fillStyle = grey(height);
      ch.fillRect(x, y, w, h);
    }
  };
  const sills = []; // window bottoms, for soot streaks
  const litRate = { glass: 0.25, deco: 0.35, office: 0.3, brick: 0.35, store: 0.8 }[style];
  const glass = (x, y, w, h, depth = 0.25) => {
    sills.push([x, y + h, w]);
    const r = rng();
    if (r < litRate) {
      const col = rng() < 0.8 ? `hsl(${35 + rng() * 15}, 90%, ${58 + rng() * 22}%)` : `hsl(${195 + rng() * 20}, 60%, ${72 + rng() * 15}%)`;
      paint(x, y, w, h, col, 0.5, 0, depth);
      ce.globalAlpha = 0.55 + rng() * 0.45;
      ce.fillStyle = col;
      ce.fillRect(x, y, w, h);
      ce.globalAlpha = 1;
      if (rng() < 0.3) {
        // lit window behind blinds
        ca.fillStyle = ce.fillStyle = 'rgba(0,0,0,.35)';
        for (let yy = y + 1; yy < y + h; yy += 2) {
          ca.fillRect(x, yy, w, 1);
          ce.fillRect(x, yy, w, 1);
        }
      }
    } else {
      const v = (16 + rng() * 16) | 0;
      paint(x, y, w, h, `rgb(${v},${v + 9},${v + 20})`, 0.08, 0.7, depth);
      const k = rng();
      if (k < 0.15) {
        // closed blinds
        paint(x, y, w, h * (0.4 + rng() * 0.6), `rgb(${150 + rng() * 40},${140 + rng() * 40},${120 + rng() * 30})`, 0.8, 0);
        ca.fillStyle = 'rgba(0,0,0,.18)';
        for (let yy = y + 1; yy < y + h; yy += 2) ca.fillRect(x, yy, w, 1);
      } else if (k < 0.25) {
        // curtains at the sides
        const cc = `hsl(${rng() * 360}, 30%, ${25 + rng() * 25}%)`;
        paint(x, y, w * 0.3, h, cc, 0.9, 0);
        paint(x + w * 0.7, y, w * 0.3, h, cc, 0.9, 0);
      }
    }
    // Window air conditioner
    if ((style === 'brick' || style === 'office') && rng() < 0.12) paint(x + w / 2 - 4, y + h - 6, 8, 6, '#b9b9b5', 0.6, 0.3, 0.95);
  };

  ce.fillStyle = '#000';
  ce.fillRect(0, 0, S, S);
  const base = { glass: '#b9c3cc', deco: '#d9d9d9', office: '#cdcdcd', brick: '#d0d0d0', store: '#3a3a3a' }[style];
  paint(0, 0, S, S, base, style === 'glass' ? 0.35 : 0.85, style === 'glass' ? 0.8 : 0, 0.6);
  if (style === 'brick') {
    // mortar courses and staggered joints
    ca.fillStyle = 'rgba(0,0,0,.14)';
    ch.fillStyle = grey(0.5);
    for (let y = 0; y < S; y += 4) {
      ca.fillRect(0, y, S, 1);
      ch.fillRect(0, y, S, 1);
      for (let x = (y / 4) % 2 ? 0 : 4; x < S; x += 8) {
        ca.fillRect(x, y, 1, 4);
        ch.fillRect(x, y, 1, 4);
      }
    }
    // individual brick colour variation
    for (let i = 0; i < 4000; i++) {
      ca.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.06)';
      ca.fillRect(((rng() * 64) | 0) * 8, ((rng() * 128) | 0) * 4 + 1, 7, 3);
    }
  }
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const px = cx * cs, py = cy * cs;
      if (style === 'glass') {
        // Curtain wall: full-height glass, thin mullions, dark spandrel band per floor
        glass(px + 1, py + 1, cs - 2, cs - 9, 0.5);
        paint(px + 1, py + cs - 8, cs - 2, 7, '#3c4954', 0.3, 0.7, 0.55);
      } else if (style === 'deco') {
        // Art deco: strong vertical piers, recessed windows, chevron spandrels
        const pier = cx % 4 === 0 ? 10 : 6;
        ch.fillStyle = grey(0.85);
        ch.fillRect(px, py, pier, cs);
        glass(px + pier, py + 5, cs - pier - 6, 18);
        paint(px + pier, py + 23, cs - pier - 6, 6, '#8e8e8e', 0.7, 0.1, 0.4);
        ca.strokeStyle = 'rgba(255,255,255,.35)';
        ca.beginPath();
        ca.moveTo(px + pier, py + 29);
        ca.lineTo(px + (pier + cs - 6) / 2, py + 24);
        ca.lineTo(px + cs - 6, py + 29);
        ca.stroke();
      } else if (style === 'office') {
        // Ribbon windows with a projecting sill band
        glass(px, py + 9, cs, 16);
        paint(px, py + 9, 1, 16, '#9a9a9a', 0.5, 0.5, 0.7);
        paint(px, py + 25, cs, 2, '#e0e0e0', 0.7, 0, 0.8);
      } else if (style === 'brick') {
        // Punched windows with light stone frames, lintels and sills
        paint(px + 8, py + 4, 16, 3, '#ececec', 0.7, 0, 0.85);
        paint(px + 8, py + 5, 16, 20, '#f2f2f2', 0.7, 0, 0.75);
        glass(px + 10, py + 7, 12, 16);
        paint(px + 7, py + 25, 18, 3, '#e8e8e8', 0.7, 0, 0.85);
      } else {
        // Storefront bay (one cell = one shop front): sign band, big lit window, door
        const hue = (rng() * 360) | 0;
        paint(px, py, cs, 9, `hsl(${hue}, 45%, 18%)`, 0.6, 0, 0.7);
        ce.fillStyle = `hsl(${hue}, 90%, 60%)`;
        ce.fillRect(px + 4, py + 3, cs - 8, 3);
        ca.fillStyle = `hsl(${hue}, 90%, 60%)`;
        ca.fillRect(px + 4, py + 3, cs - 8, 3);
        glass(px + 2, py + 11, cs - 4, 19, 0.35);
        paint(px + 21, py + 13, 7, 17, '#222', 0.5, 0.3, 0.3);
      }
    }
  }

  // ---- Weathering (colour map only): soot streaks under sills, stains, speckle
  if (style !== 'store') {
    for (const [x, y, w] of sills) {
      if (rng() < 0.55) {
        const len = 4 + rng() * 14;
        const g = ca.createLinearGradient(0, y, 0, y + len);
        g.addColorStop(0, `rgba(25,20,15,${0.12 + rng() * 0.18})`);
        g.addColorStop(1, 'rgba(25,20,15,0)');
        ca.fillStyle = g;
        ca.fillRect(x + rng() * 3, y, w - rng() * 6, len);
      }
    }
    for (let i = 0; i < 90; i++) {
      // rain streaks
      ca.fillStyle = `rgba(30,25,20,${0.04 + rng() * 0.06})`;
      ca.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 20 + rng() * 70);
    }
    for (let i = 0; i < 30; i++) {
      // large dirt patches
      const x = rng() * S, y = rng() * S, r = 20 + rng() * 50;
      const g = ca.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(40,32,22,${0.08 + rng() * 0.1})`);
      g.addColorStop(1, 'rgba(40,32,22,0)');
      ca.fillStyle = g;
      ca.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 6000; i++) {
    ca.fillStyle = rng() < 0.6 ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)';
    ca.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1 + rng() * 2);
  }

  return {
    map: tex(a), emissive: tex(e), orm: tex(o, { srgb: false }),
    normal: tex(heightToNormal(hc, style === 'brick' ? 3 : 4), { srgb: false }),
  };
}

// Draw a random-walk crack on any number of 2D contexts.
function crack(ctxs, x, y, len, step, width) {
  let a = Math.random() * Math.PI * 2;
  const pts = [[x, y]];
  for (let i = 0; i < len; i++) {
    a += (Math.random() - 0.5) * 0.9;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    pts.push([x, y]);
  }
  for (const [g, style] of ctxs) {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
  }
}

// One repeat of the Manhattan street grid: 140 m (avenue to avenue) x 70 m (street to street),
// with the intersection at the tile corners. Returns colour, normal and roughness maps:
// aggregate grain, tyre-worn lanes, cracks, patches, manholes, storm drains, glossy puddles.
export function roadTexture() {
  const W = 2048, H = 1024, kx = W / 140, kz = H / 70;
  const c = canvas(W, H), g = c.getContext('2d');
  const hc = canvas(W, H), hg = hc.getContext('2d'); // height
  const rc = canvas(W, H), rg = rc.getContext('2d'); // roughness (green channel)
  g.fillStyle = '#34363b';
  g.fillRect(0, 0, W, H);
  hg.fillStyle = 'rgb(128,128,128)';
  hg.fillRect(0, 0, W, H);
  rg.fillStyle = 'rgb(0,230,0)';
  rg.fillRect(0, 0, W, H);
  // Aggregate grain (colour + bumps)
  for (let i = 0; i < 60000; i++) {
    const x = Math.random() * W, y = Math.random() * H, s = 1 + Math.random() * 2.5, v = Math.random();
    g.fillStyle = v < 0.5 ? 'rgba(0,0,0,.1)' : v < 0.85 ? 'rgba(255,255,255,.05)' : 'rgba(120,110,95,.12)';
    g.fillRect(x, y, s, s);
    hg.fillStyle = v < 0.5 ? 'rgba(90,90,90,.5)' : 'rgba(170,170,170,.5)';
    hg.fillRect(x, y, s, s);
  }
  const R = (ctx, x0, z0, x1, z1, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(x0 * kx, z0 * kz, (x1 - x0) * kx, (z1 - z0) * kz);
  };
  // Tyre-polished wheel tracks down every lane (darker, smoother)
  const track = (vertical, at, from, to) => {
    for (const off of [-0.8, 0.8]) {
      if (vertical) {
        R(g, at + off - 0.3, from, at + off + 0.3, to, 'rgba(15,15,18,.16)');
        R(rg, at + off - 0.3, from, at + off + 0.3, to, 'rgb(0,175,0)');
      } else {
        R(g, from, at + off - 0.3, to, at + off + 0.3, 'rgba(15,15,18,.16)');
        R(rg, from, at + off - 0.3, to, at + off + 0.3, 'rgb(0,175,0)');
      }
    }
  };
  for (const lx of [2.2, 6.6, 133.4, 137.8]) track(true, lx, 0, 70);
  for (const lz of [3, 67]) track(false, lz, 0, 140);
  // Utility-cut patches: different asphalt with a raised seam
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * 136, z = Math.random() * 66, w = 2 + Math.random() * 8, h = 1 + Math.random() * 3;
    R(g, x, z, x + w, z + h, Math.random() < 0.5 ? '#2a2c31' : '#3d3f44');
    hg.strokeStyle = 'rgb(160,160,160)';
    hg.lineWidth = 3;
    hg.strokeRect(x * kx, z * kz, w * kx, h * kz);
  }
  // Cracks
  for (let i = 0; i < 70; i++) {
    crack([[g, 'rgba(10,10,12,.55)'], [hg, 'rgb(70,70,70)']], Math.random() * W, Math.random() * H, 8 + Math.random() * 30, 4 + Math.random() * 6, 1.5);
  }
  // Oil stains in the middle of lanes
  const oil = (x, z) => {
    const r = 10 + Math.random() * 16, gr = g.createRadialGradient(x * kx, z * kz, 0, x * kx, z * kz, r);
    gr.addColorStop(0, 'rgba(8,8,10,.4)');
    gr.addColorStop(1, 'rgba(8,8,10,0)');
    g.fillStyle = gr;
    g.fillRect(x * kx - r, z * kz - r, r * 2, r * 2);
  };
  for (const lx of [2.2, 6.6, 133.4, 137.8]) for (let z = 8; z < 64; z += 4 + Math.random() * 7) oil(lx, z);
  for (const lz of [3, 67]) for (let x = 14; x < 126; x += 5 + Math.random() * 9) oil(x, lz);
  // Puddles along the gutters: dark, glossy, flat
  const puddle = (x, z) => {
    const rx = (1 + Math.random() * 2.5) * kx, rz = (0.4 + Math.random() * 1) * kz;
    for (const [ctx, col] of [[g, 'rgba(20,24,30,.55)'], [rg, 'rgb(0,18,0)'], [hg, 'rgb(128,128,128)']]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(x * kx, z * kz, rx, rz, Math.random() * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  for (let i = 0; i < 8; i++) puddle(15 + Math.random() * 110, Math.random() < 0.5 ? 5 : 65);
  for (let i = 0; i < 6; i++) puddle(Math.random() < 0.5 ? 8.2 : 131.8, 12 + Math.random() * 46);
  // Manholes (raised rim) and storm drains along the curb near the corners
  for (const [x, z] of [[20, 2.5], [90, 67], [6, 35], [133, 22], [60, 3.4]]) {
    const r = 0.45 * kx;
    g.fillStyle = '#2b2c30';
    g.beginPath();
    g.arc(x * kx, z * kz, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#45474d';
    g.lineWidth = 2;
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.arc(x * kx, z * kz, (r * k) / 4, 0, Math.PI * 2);
      g.stroke();
    }
    hg.strokeStyle = 'rgb(175,175,175)';
    hg.lineWidth = 3;
    hg.beginPath();
    hg.arc(x * kx, z * kz, r, 0, Math.PI * 2);
    hg.stroke();
  }
  for (const [x, z, vert] of [[8.6, 14, true], [131.4, 56, true], [16, 5.6, false], [124, 64.4, false]]) {
    const w = vert ? 0.5 : 1.2, h = vert ? 1.2 : 0.5;
    R(g, x - w / 2, z - h / 2, x + w / 2, z + h / 2, '#141416');
    R(hg, x - w / 2, z - h / 2, x + w / 2, z + h / 2, 'rgb(60,60,60)');
    g.fillStyle = '#3a3b40';
    for (let k = 0; k < 6; k++) {
      if (vert) g.fillRect((x - w / 2) * kx, (z - h / 2 + (k + 0.5) * (h / 6)) * kz, w * kx, 2);
      else g.fillRect((x - w / 2 + (k + 0.5) * (w / 6)) * kx, (z - h / 2) * kz, 2, h * kz);
    }
  }
  // Markings (slightly raised paint)
  const YEL = '#d9b23a', WHT = 'rgba(235,235,235,.85)';
  const paintR = (x0, z0, x1, z1, col) => {
    R(g, x0, z0, x1, z1, col);
    R(hg, x0, z0, x1, z1, 'rgb(140,140,140)');
    R(rg, x0, z0, x1, z1, 'rgb(0,140,0)');
  };
  for (const x of [0, 140]) {
    paintR(x - 0.4, 6, x - 0.2, 64, YEL);
    paintR(x + 0.2, 6, x + 0.4, 64, YEL);
    for (const lx of [x - 4.5, x + 4.5]) for (let z = 11; z < 62; z += 9) paintR(lx - 0.1, z, lx + 0.1, z + 3, WHT);
  }
  for (const z of [0, 70]) for (let x = 13; x < 128; x += 8) paintR(x, z - 0.1, x + 3, z + 0.1, WHT);
  for (const cx of [0, 140]) {
    for (const cz of [0, 70]) {
      const dz = cz === 0 ? 1 : -1, dx = cx === 0 ? 1 : -1;
      const za = cz + dz * 6.5, zb = cz + dz * 9.5;
      for (let x = -8.5; x < 9; x += 1.2) paintR(cx + x, Math.min(za, zb), cx + x + 0.6, Math.max(za, zb), WHT);
      const xa = cx + dx * 9.5, xb = cx + dx * 12.5;
      for (let z = -5.5; z < 6; z += 1.2) paintR(Math.min(xa, xb), cz + z, Math.max(xa, xb), cz + z + 0.6, WHT);
      paintR(Math.min(cx + dx * 0.4, cx + dx * 8.5), cz + dz * 10, Math.max(cx + dx * 0.4, cx + dx * 8.5), cz + dz * 10.4, WHT);
    }
  }
  // Worn-off paint and grime over everything
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.7 ? 'rgba(52,54,59,.55)' : 'rgba(20,18,16,.12)';
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  return { map: tex(c), normal: tex(heightToNormal(hc, 2.2), { srgb: false }), rough: tex(rc, { srgb: false }) };
}

// Sidewalk concrete, one repeat = 6 x 6 m: 1.5 m slabs with joints, per-slab tint, cracks,
// chewing-gum spots, stains and grime. Mapped in world space so it lines up everywhere.
export const SIDEWALK_TILE = 6;
export function sidewalkTexture() {
  const S = 1024, slab = S / 4;
  const c = canvas(S, S), g = c.getContext('2d');
  const hc = canvas(S, S), hg = hc.getContext('2d');
  g.fillStyle = '#9a9894';
  g.fillRect(0, 0, S, S);
  hg.fillStyle = 'rgb(128,128,128)';
  hg.fillRect(0, 0, S, S);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = (Math.random() - 0.5) * 22;
      g.fillStyle = `rgb(${154 + v},${152 + v},${148 + v})`;
      g.fillRect(x * slab, y * slab, slab, slab);
    }
  }
  for (let i = 0; i < 50000; i++) {
    const x = Math.random() * S, y = Math.random() * S, s = 1 + Math.random() * 2;
    g.fillStyle = Math.random() < 0.55 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.06)';
    g.fillRect(x, y, s, s);
    hg.fillStyle = Math.random() < 0.5 ? 'rgba(100,100,100,.4)' : 'rgba(160,160,160,.4)';
    hg.fillRect(x, y, s, s);
  }
  // Large dirt blotches and stains
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 20 + Math.random() * 90;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(40,34,26,${0.12 + Math.random() * 0.15})`);
    gr.addColorStop(1, 'rgba(40,34,26,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Chewing gum spots
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${40 + Math.random() * 30},${40 + Math.random() * 25},${38 + Math.random() * 20},.75)`;
    g.beginPath();
    g.arc(Math.random() * S, Math.random() * S, 2 + Math.random() * 4, 0, Math.PI * 2);
    g.fill();
  }
  // Cracks
  for (let i = 0; i < 18; i++) crack([[g, 'rgba(30,28,26,.6)'], [hg, 'rgb(60,60,60)']], Math.random() * S, Math.random() * S, 6 + Math.random() * 18, 6 + Math.random() * 8, 1.5);
  // Expansion joints between slabs (recessed, dark with dirt)
  g.fillStyle = 'rgba(45,42,38,.85)';
  hg.fillStyle = 'rgb(40,40,40)';
  for (let k = 0; k <= 4; k++) {
    for (const ctx of [g, hg]) {
      ctx.fillRect(k * slab - 2, 0, 4, S);
      ctx.fillRect(0, k * slab - 2, S, 4);
    }
  }
  return { map: tex(c), normal: tex(heightToNormal(hc, 2.5), { srgb: false }) };
}

// Broadway strip: 16 m wide, one repeat = 32 m of road.
export function broadwayTexture() {
  const W = 256, H = 512, k = W / 16;
  const c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#33353a';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.04)';
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  g.fillStyle = '#d9b23a';
  g.fillRect(7.6 * k, 0, 0.2 * k, H);
  g.fillRect(8.2 * k, 0, 0.2 * k, H);
  g.fillStyle = 'rgba(235,235,235,.8)';
  for (const x of [3.9, 12.1]) for (let y = 0; y < H; y += H / 4) g.fillRect(x * k, y, 0.2 * k, H / 10);
  g.fillRect(0.4 * k, 0, 0.15 * k, H);
  g.fillRect(15.45 * k, 0, 0.15 * k, H);
  return tex(c);
}

const ADS = ['ZAP! COLA', 'METRO NEWS', 'HERO TV', 'SKYLINE BANK', 'BURGER BLAST', 'LIVE TONIGHT',
  'NEON NIGHTS', 'MEGA SALE', 'POWER UP', 'BROADWAY', 'JUSTICE 24/7', 'CITY LIGHTS', 'TURBO FIT', 'VOLT ENERGY'];

export function adTexture(rng) {
  const c = canvas(256, 128), g = c.getContext('2d');
  const hue = (rng() * 360) | 0;
  const grad = g.createLinearGradient(0, 0, 256, 128);
  grad.addColorStop(0, `hsl(${hue}, 90%, 45%)`);
  grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 90%, 25%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = 'rgba(255,255,255,.8)';
  g.lineWidth = 4;
  g.strokeRect(6, 6, 244, 116);
  g.fillStyle = '#fff';
  g.font = 'bold 34px Impact, Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(ADS[(rng() * ADS.length) | 0], 128, 64, 230);
  return tex(c, { repeat: false });
}

export function tickerTexture() {
  const c = canvas(1024, 48), g = c.getContext('2d');
  g.fillStyle = '#050505';
  g.fillRect(0, 0, 1024, 48);
  g.fillStyle = '#ffb000';
  g.font = 'bold 30px Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText('★ BREAKING: CRIME WAVE HITS MIDTOWN ★ HERO SPOTTED OVER TIMES SQUARE ★ ', 8, 25);
  const t = tex(c);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function glowTexture() {
  const c = canvas(64, 64), g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
