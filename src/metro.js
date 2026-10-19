import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Elevated subway ("the El"): steel viaducts running above the streets between buildings,
// with stations and moving trains. Lines are axis-aligned and sit over road centre lines.
//   axis 'z': runs north-south along an avenue at x = c;  axis 'x': east-west along a street at z = c
//   y: top of deck. halfRoad: half the road width (columns stand at the curb).
export const METRO_LINES = [
  { axis: 'z', c: -280, a: -1320, b: 1060, y: 9, halfRoad: 9, stations: [-560, 420] },
  { axis: 'x', c: 140, a: -415, b: 415, y: 15, halfRoad: 6, stations: [70] },
];
const STEEL = '#3e4147', STEEL2 = '#4a4e56', RAIL = '#8a8a8a', DECK = '#2c2a28';
const WARM = [2.2, 1.6, 0.9];

// B: city builder helpers { box(cx,y0,cz,w,h,d,color,collide,metal), light(cx,y0,cz,w,h,d,rgb) }
export function buildMetro(B, scene) {
  for (const L of METRO_LINES) {
    const len = L.b - L.a, mid = (L.a + L.b) / 2;
    // Place a box given "along" and "across" coordinates for this line.
    const put = (along, y0, across, l, h, w, color, collide = false, metal = false) =>
      L.axis === 'z'
        ? B.box(L.c + across, y0, along, w, h, l, color, collide, metal)
        : B.box(along, y0, L.c + across, l, h, w, color, collide, metal);
    const glow = (along, y0, across, l, h, w) =>
      L.axis === 'z' ? B.light(L.c + across, y0, along, w, h, l, WARM) : B.light(along, y0, L.c + across, l, h, w, WARM);
    const other = METRO_LINES.find((o) => o !== L);
    const nearOther = (along) => Math.abs(along - other.c) < other.halfRoad + 2;

    put(mid, L.y - 1, 0, len, 1.0, 9.6, DECK, true);
    for (const s of [-1, 1]) {
      put(mid, L.y - 2.2, s * 4.65, len, 2.8, 0.35, STEEL2, true);
      for (let t = L.a + 2; t < L.b; t += 4) put(t, L.y - 2.3, s * 4.88, 0.25, 3.0, 0.12, STEEL);
      for (const r of [-0.72, 0.72]) put(mid, L.y, s * 2.2 + r, len, 0.18, 0.12, RAIL, false, true);
    }
    for (let t = L.a + 10; t < L.b; t += 26) {
      if (nearOther(t)) continue;
      const cx = L.halfRoad - 1.2;
      put(t, 0, -cx, 0.7, L.y - 1.6, 0.7, STEEL, true);
      put(t, 0, cx, 0.7, L.y - 1.6, 0.7, STEEL, true);
      put(t, L.y - 2.6, 0, 0.9, 1.0, cx * 2 + 0.7, STEEL);
      glow(t + 13, L.y - 1.15, 0, 1.2, 0.15, 0.6);
    }
    // Stations: side platforms with a canopy and lighting
    for (const st of L.stations) {
      const pw = L.halfRoad < 8 ? 1.6 : 2.6, off = 4.85 + pw / 2;
      for (const s of [-1, 1]) {
        put(st, L.y - 1, s * off, 50, 1.0, pw, '#77736c', true);
        put(st, L.y + 3.4, s * (off - 0.4), 52, 0.3, pw + 1.2, STEEL2);
        for (let t = st - 24; t <= st + 24; t += 8) put(t, L.y, s * (off + pw / 2 - 0.2), 0.2, 3.4, 0.2, STEEL);
        glow(st, L.y + 3.25, s * (off - 0.4), 46, 0.12, 0.4);
        put(st, L.y, s * (off + pw / 2 - 0.05), 50, 1.1, 0.06, STEEL); // railing
      }
    }
  }
  return new Trains(scene);
}

// ------------------------------------------------------------------ trains
const CAR_L = 15, CAR_GAP = 0.6, CARS = 4;
function colorize(g, rgb) {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  const a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set(rgb, i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const hex = (h) => new THREE.Color(h).toArray();

// One train along local -Z (front at -Z), bottom at y = 0. Returns { body, lights } geometries.
function trainGeometry() {
  const body = [], lights = [];
  const total = CARS * CAR_L + (CARS - 1) * CAR_GAP;
  for (let c = 0; c < CARS; c++) {
    const z = -total / 2 + c * (CAR_L + CAR_GAP) + CAR_L / 2;
    body.push(colorize(new THREE.BoxGeometry(2.9, 2.9, CAR_L).translate(0, 2.25, z), hex('#b8bcc2')));
    body.push(colorize(new THREE.BoxGeometry(2.6, 0.25, CAR_L - 0.4).translate(0, 3.8, z), hex('#8e9298')));
    body.push(colorize(new THREE.BoxGeometry(2.95, 0.22, CAR_L).translate(0, 1.6, z), hex('#7a1d1d'))); // stripe
    for (const bz of [-5.2, 5.2]) body.push(colorize(new THREE.BoxGeometry(2.2, 0.7, 2.6).translate(0, 0.45, z + bz), hex('#1c1c1e')));
    for (const s of [-1, 1]) {
      for (let w = 0; w < 6; w++) {
        const wz = z - CAR_L / 2 + 1.4 + w * 2.45;
        if (w === 1 || w === 4) {
          body.push(colorize(new THREE.BoxGeometry(0.06, 2.0, 1.3).translate(s * 1.47, 2.3, wz + 0.6), hex('#55595f'))); // door
        } else {
          lights.push(colorize(new THREE.BoxGeometry(0.06, 0.9, 1.6).translate(s * 1.47, 2.75, wz + 0.6), [1.25, 1.1, 0.8]));
        }
      }
    }
  }
  // Head/tail lights and destination signs at both ends
  for (const end of [-1, 1]) {
    const z = end * (total / 2 + 0.02);
    lights.push(colorize(new THREE.BoxGeometry(1.6, 0.28, 0.06).translate(0, 3.35, z), [1.6, 1.1, 0.3]));
    for (const s of [-1, 1]) lights.push(colorize(new THREE.BoxGeometry(0.3, 0.2, 0.06).translate(s * 1.0, 1.1, z), end < 0 ? [1.8, 1.75, 1.5] : [1.8, 0.1, 0.1]));
  }
  return { body: mergeGeometries(body), lights: mergeGeometries(lights), length: total };
}

class Trains {
  constructor(scene) {
    const geo = trainGeometry();
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.75 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.trains = [];
    for (const L of METRO_LINES) {
      const lo = L.a + geo.length / 2 + 5, hi = L.b - geo.length / 2 - 5;
      for (const [track, dir] of [[-2.2, 1], [2.2, -1]]) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(geo.body, bodyMat);
        body.castShadow = true;
        g.add(body, new THREE.Mesh(geo.lights, lightMat));
        scene.add(g);
        this.trains.push({ L, g, track, dir, lo, hi, s: lo + Math.random() * (hi - lo), speed: 15 + Math.random() * 4 });
      }
    }
  }

  update(dt) {
    for (const t of this.trains) {
      t.s += t.dir * t.speed * dt;
      if (t.s > t.hi || t.s < t.lo) {
        t.s = Math.min(t.hi, Math.max(t.lo, t.s));
        t.dir = -t.dir; // the line terminates: head back the other way
      }
      const { L, g } = t;
      // Front is -Z locally: face the travel direction.
      if (L.axis === 'z') {
        g.position.set(L.c + t.track, L.y + 0.05, t.s);
        g.rotation.y = t.dir > 0 ? Math.PI : 0;
      } else {
        g.position.set(t.s, L.y + 0.05, L.c + t.track);
        g.rotation.y = t.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
    }
  }
}
