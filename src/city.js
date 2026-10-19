import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './collision.js';
import { Traffic } from './vehicles.js';
import { TreeField } from './trees.js';
import { buildMetro, METRO_LINES } from './metro.js';
import {
  WIN_W, WIN_H, CELLS, ROOF_UV, canvas, makeFacade, roadTexture, broadwayTexture, adTexture, tickerTexture, glowTexture,
  sidewalkTexture, SIDEWALK_TILE,
} from './citytex.js';

// World axes: +X = east, -Z = north. 1 unit = 1 meter.
export const MANHATTAN = { minX: -420, maxX: 420, minZ: -1400, maxZ: 1120 };
export const PARK = { minX: -131, maxX: 131, minZ: -1324, maxZ: -776 };
const RESERVOIR = { minX: -85, maxX: 85, minZ: -1190, maxZ: -1030 };
const LANDS = [
  { minX: -440, maxX: 440, minZ: -1420, maxZ: 1140 }, // Manhattan
  { minX: 950, maxX: 1900, minZ: -1700, maxZ: 1700 }, // Brooklyn / Queens
  { minX: -1900, maxX: -950, minZ: -1700, maxZ: 1700 }, // New Jersey
  { minX: -690, maxX: -610, minZ: 1410, maxZ: 1490 }, // Liberty Island
];
const LIBERTY = { x: -650, z: 1450 };
const BRIDGE = { z: 900, x0: 440, x1: 950, deck: 22, ramp: 60 };
const AVE_SP = 140, ST_SP = 70;
// Broadway cuts diagonally across the grid (south -> Union Sq -> Times Sq -> Columbus Circle).
const BROADWAY = [[100, 1120], [140, 350], [0, -420], [-140, -776]];
const BW_HALF = 11; // half-width of the Broadway corridor (road + sidewalks)
const CHUNK = 450; // static geometry is merged per CHUNK x CHUNK tile so off-screen tiles are culled
const ALL_SIDES = { n: true, s: true, e: true, w: true };

const inRect = (x, z, r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
export const isLand = (x, z) => LANDS.some((r) => inRect(x, z, r));

export function zoneName(x, z) {
  if (x > 440 && x < 950 && Math.abs(z - BRIDGE.z) < 16) return 'BROOKLYN BRIDGE';
  if (x > 950) return 'BROOKLYN';
  if (x < -950) return 'JERSEY CITY';
  if (Math.hypot(x - LIBERTY.x, z - LIBERTY.z) < 90) return 'LIBERTY ISLAND';
  if (z > 1140) return 'UPPER BAY';
  if (x > 440) return 'EAST RIVER';
  if (x < -440) return 'HUDSON RIVER';
  if (inRect(x, z, PARK)) return 'CENTRAL PARK';
  if (z < -1330) return 'HARLEM';
  if (z < -770) return x < 0 ? 'UPPER WEST SIDE' : 'UPPER EAST SIDE';
  if (Math.abs(x) < 140 && Math.abs(z + 420) < 75) return 'TIMES SQUARE';
  if (distToBroadway(x, z) < BW_HALF) return 'BROADWAY';
  if (z < -100) return 'MIDTOWN';
  if (z < 350) return 'CHELSEA';
  if (z < 800) return 'GREENWICH VILLAGE';
  return 'FINANCIAL DISTRICT';
}

function distToBroadway(x, z) {
  let best = Infinity;
  for (let i = 1; i < BROADWAY.length; i++) {
    const [ax, az] = BROADWAY[i - 1], [bx, bz] = BROADWAY[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}
// Points every 3 m along Broadway, for rectangle overlap tests.
const BW_PTS = [];
for (let i = 1; i < BROADWAY.length; i++) {
  const [ax, az] = BROADWAY[i - 1], [bx, bz] = BROADWAY[i];
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 3);
  for (let k = 0; k <= n; k++) BW_PTS.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
}
function hitsBroadway(x0, z0, x1, z1) {
  if (x1 < -160 || x0 > 160 || z1 < -790) return false;
  for (const [px, pz] of BW_PTS) {
    const dx = Math.max(x0 - px, 0, px - x1), dz = Math.max(z0 - pz, 0, pz - z1);
    if (dx * dx + dz * dz < BW_HALF * BW_HALF) return true;
  }
  return false;
}

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCity(scene) {
  const rng = makeRng(20261018);
  const world = new World(32);
  world.floorAt = (x, z) => (isLand(x, z) ? 0 : -0.3);

  // Geometry buckets: Map<chunkKey, geometry[]>. Facades are split per style (one material each).
  const STYLES = ['glass', 'deco', 'office', 'brick', 'store'];
  const bGeos = Object.fromEntries(STYLES.map((s) => [s, new Map()])); // facades with window UVs
  const dGeos = new Map(); // props (no UVs)
  const mGeos = new Map(); // polished metal: deco crowns, spires, rails
  const lGeos = new Map(); // unlit HDR lights: crown floodlights, signs, aviation lights
  const gGeos = new Map(); // ground slabs (no UVs)
  const sGeos = new Map(); // sidewalks & plazas (world-space UVs on the concrete texture)
  // Destructible buildings: while a building is being generated, curGroup collects everything
  // it adds, so it can later be swapped for a fractured version (see destruction.js).
  let curGroup = null;
  const groups = [];
  const add = (bucket, geo, x, z) => {
    if (curGroup && bucket !== gGeos && bucket !== sGeos) geo.userData.group = curGroup; // pavement stays
    const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
    let list = bucket.get(k);
    if (!list) bucket.set(k, (list = []));
    list.push(geo);
  };
  const footprints = [];
  const beacons = [];
  const lotRecs = new Map(); // Manhattan block "i,j" -> buildings (for skybridges)
  const trees = new TreeField(rng);
  const tmpColor = new THREE.Color();
  const pick = (arr) => arr[(rng() * arr.length) | 0];

  function colorize(g, hex) {
    tmpColor.set(hex);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = tmpColor.r;
      arr[i * 3 + 1] = tmpColor.g;
      arr[i * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }

  // Darken toward the bottom of a wall (street grime); grime = brightness factor at the base.
  function weather(g, y0, h, grime) {
    if (grime >= 1) return;
    const pos = g.attributes.position, col = g.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, (pos.getY(i) - y0) / Math.max(1, Math.min(h, 60)));
      const f = grime + (1 - grime) * t;
      col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f);
    }
  }

  // cell = metres covered by one texture cell [width, height]
  function wallBox(cx, y0, cz, w, h, d, color, style = 'deco', cell = [WIN_W, WIN_H], collide = true, grime = 1) {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv;
    const ou = Math.floor(rng() * CELLS) / CELLS, ov = style === 'store' ? 0 : Math.floor(rng() * CELLS) / CELLS;
    const dims = [[d, h], [d, h], null, null, [w, h], [w, h]]; // +x -x +y -y +z -z
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        if (!dims[f]) {
          uv.setXY(i, ROOF_UV, ROOF_UV);
          continue;
        }
        uv.setXY(i, ou + (uv.getX(i) * dims[f][0]) / (cell[0] * CELLS), ov + (uv.getY(i) * dims[f][1]) / (cell[1] * CELLS));
      }
    }
    g.translate(cx, y0 + h / 2, cz);
    colorize(g, color);
    weather(g, y0, h, grime);
    if (curGroup) {
      // Everything needed to rebuild this wall as breakable panels with identical texturing
      const wall = { cx, y0, cz, w, h, d, color, style, cell, ou, ov, grime };
      g.userData.wall = wall;
      curGroup.walls.push(wall);
    }
    add(bGeos[style], g, cx, cz);
    if (collide) {
      const b = world.addBox(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2);
      b.group = curGroup;
      if (g.userData.wall) g.userData.wall.box = b; // disabled while the wall is fractured
    }
  }

  // Cylindrical facade (rounded towers). Collision uses the inscribed square.
  function cylWall(cx, y0, cz, r, h, color, style, cell = [WIN_W, WIN_H], collide = true, grime = 1, open = false) {
    if (curGroup) curGroup.round = true; // rounded towers aren't fractured
    const g = new THREE.CylinderGeometry(r, r, h, 24, 1, open);
    const uv = g.attributes.uv, nrm = g.attributes.normal, circ = 2 * Math.PI * r;
    const ou = Math.floor(rng() * CELLS) / CELLS, ov = style === 'store' ? 0 : Math.floor(rng() * CELLS) / CELLS;
    for (let i = 0; i < uv.count; i++) {
      if (Math.abs(nrm.getY(i)) > 0.9) uv.setXY(i, ROOF_UV, ROOF_UV);
      else uv.setXY(i, ou + (uv.getX(i) * circ) / (cell[0] * CELLS), ov + (uv.getY(i) * h) / (cell[1] * CELLS));
    }
    g.translate(cx, y0 + h / 2, cz);
    colorize(g, color);
    weather(g, y0, h, grime);
    add(bGeos[style], g, cx, cz);
    if (collide) world.addBox(cx - r * 0.7, y0, cz - r * 0.7, cx + r * 0.7, y0 + h, cz + r * 0.7);
  }

  function detailBox(cx, y0, cz, w, h, d, color, collide = false, list = dGeos) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, y0 + h / 2, cz);
    add(list, colorize(g, color), cx, cz);
    if (collide) world.addBox(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2);
  }

  function detailCyl(cx, y0, cz, rt, rb, h, color, seg = 8, list = dGeos) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    g.translate(cx, y0 + h / 2, cz);
    add(list, colorize(g, color), cx, cz);
  }

  // Unlit geometry with an HDR colour (values above 1 glow through the bloom pass).
  function hdr(geo, [r, g, b], x, z) {
    colorize(geo, '#000');
    const a = geo.attributes.color.array;
    for (let i = 0; i < a.length; i += 3) a.set([r, g, b], i);
    add(lGeos, geo, x, z);
  }
  const lightBox = (cx, y0, cz, w, h, d, rgb) => hdr(new THREE.BoxGeometry(w, h, d).translate(cx, y0 + h / 2, cz), rgb, cx, cz);
  const lightCyl = (cx, y0, cz, r, h, rgb) => hdr(new THREE.CylinderGeometry(r, r, h, 24, 1, true).translate(cx, y0 + h / 2, cz), rgb, cx, cz);

  function groundBox(x0, z0, x1, z1, y0, y1, color, collide = false) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    add(gGeos, colorize(g, color), (x0 + x1) / 2, (z0 + z1) / 2);
    if (collide) world.addBox(x0, y0, z0, x1, y1, z1);
  }

  // Concrete slab with world-space UVs (tops tile in x/z, sides in (x+z)/y) so joints line up
  // across blocks. tint multiplies the concrete texture (plazas use a warmer stone).
  function sidewalkBox(x0, z0, x1, z1, y0, y1, tint = '#ffffff', collide = true) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, x / SIDEWALK_TILE, z / SIDEWALK_TILE);
      else uv.setXY(i, (x + z) / SIDEWALK_TILE, y / SIDEWALK_TILE);
    }
    add(sGeos, colorize(g, tint), (x0 + x1) / 2, (z0 + z1) / 2);
    if (collide) world.addBox(x0, y0, z0, x1, y1, z1);
  }

  // Block sidewalk plus a slightly raised granite curb around the edge
  function sidewalk(x0, z0, x1, z1, tint) {
    sidewalkBox(x0, z0, x1, z1, 0, 0.15, tint);
    const c = 0.3, curb = '#d2d0cc';
    sidewalkBox(x0, z0, x1, z0 + c, 0.15, 0.17, curb, false);
    sidewalkBox(x0, z1 - c, x1, z1, 0.15, 0.17, curb, false);
    sidewalkBox(x0, z0 + c, x0 + c, z1 - c, 0.15, 0.17, curb, false);
    sidewalkBox(x1 - c, z0 + c, x1, z1 - c, 0.15, 0.17, curb, false);
  }

  const PALETTES = {
    glass: ['#5f7a95', '#4c667e', '#7d93a8', '#40566c', '#8ea4b5', '#6a8f9c'],
    deco: ['#e3d6b8', '#d6c49c', '#c9b38a', '#ece3cf', '#bfae8f', '#b9b2a6'],
    office: ['#aaa49a', '#8f8b85', '#bdb5a7', '#7a766f', '#9c9488'],
    brick: ['#8c4c3a', '#7a4031', '#a05e45', '#6f4a3b', '#94654c', '#8a6a52'],
    store: ['#9a9a9a', '#b5a58a', '#7d7d86'],
  };
  const GOLD = [2.4, 1.7, 0.75], COOL = [1.7, 1.9, 2.3], RED_LIGHT = [3, 0.15, 0.1];
  const NEON = [[2.6, 0.4, 1.6], [0.4, 2.2, 2.6], [2.6, 1.6, 0.3], [0.6, 2.6, 0.8], [2.6, 0.5, 0.4]];
  const AWNING = ['#8c1d1d', '#1d5c2e', '#1d3c8c', '#2b2b2b', '#a35a12', '#5a1d5c', '#0f4c4c'];
  const IRON = '#25272b', ROOF = '#3b3936';

  function chooseStyle(h) {
    const r = rng();
    if (h > 120) return r < 0.45 ? 'deco' : r < 0.9 ? 'glass' : 'office';
    if (h > 50) return r < 0.35 ? 'deco' : r < 0.7 ? 'office' : r < 0.85 ? 'glass' : 'brick';
    return r < 0.6 ? 'brick' : r < 0.85 ? 'office' : 'deco';
  }

  function darker(hex, k = 0.75) {
    return '#' + tmpColor.set(hex).multiplyScalar(k).getHexString();
  }

  function waterTower(x, y, z) {
    for (const [dx, dz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
      detailBox(x + dx, y, z + dz, 0.25, 3, 0.25, '#3a3a3a');
    }
    detailCyl(x, y + 3, z, 2.2, 2.2, 4.2, '#6b4a33', 12);
    add(dGeos, colorize(new THREE.ConeGeometry(2.45, 1.6, 12).translate(x, y + 8, z), '#4a3424'), x, z);
  }

  function aviationLights(cx, top, cz, tw, td) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) lightBox(cx + sx * (tw / 2 - 0.4), top, cz + sz * (td / 2 - 0.4), 0.5, 0.5, 0.5, RED_LIGHT);
  }

  // Exterior faces of a lot: [axis, face coord, outward sign, span start, span end]
  function faces(x0, z0, x1, z1, ext) {
    const out = [];
    if (ext.s) out.push(['z', z1, 1, x0, x1]);
    if (ext.n) out.push(['z', z0, -1, x0, x1]);
    if (ext.e) out.push(['x', x1, 1, z0, z1]);
    if (ext.w) out.push(['x', x0, -1, z0, z1]);
    return out;
  }

  // Shop awnings sloping down toward the street
  function awnings(x0, z0, x1, z1, ext) {
    const color = pick(AWNING);
    for (const [axis, f, n, a, b] of faces(x0, z0, x1, z1, ext)) {
      if (rng() < 0.4) continue;
      for (let t = a + 1; t < b - 4; t += 6) {
        if (rng() < 0.45) continue;
        const w = 3.5 + rng() * 1.5, mid = t + w / 2;
        const g = axis === 'z'
          ? new THREE.BoxGeometry(w, 0.08, 1.4).rotateX(n * 0.35).translate(mid, 3.3, f + n * 0.75)
          : new THREE.BoxGeometry(1.4, 0.08, w).rotateZ(-n * 0.35).translate(f + n * 0.75, 3.3, mid);
        add(dGeos, colorize(g, color), axis === 'z' ? mid : f, axis === 'z' ? f : mid);
      }
    }
  }

  // Vertical neon blade sign sticking out over the sidewalk
  function bladeSign(x0, z0, x1, z1, ext) {
    const fs = faces(x0, z0, x1, z1, ext);
    if (!fs.length) return;
    const [axis, f, n, a, b] = pick(fs);
    const t = a + 2 + rng() * Math.max(0, b - a - 4), y = 5.2 + rng() * 2, col = pick(NEON);
    if (axis === 'z') {
      lightBox(t, y, f + n * 0.75, 0.25, 3, 1.2, col);
      detailBox(t, y - 0.15, f + n * 0.75, 0.32, 3.3, 1.3, IRON);
    } else {
      lightBox(f + n * 0.75, y, t, 1.2, 3, 0.25, col);
      detailBox(f + n * 0.75, y - 0.15, t, 1.3, 3.3, 0.32, IRON);
    }
  }

  // Iron fire escape zig-zagging up one street-facing wall
  function fireEscape(x0, z0, x1, z1, h, ext) {
    const fs = faces(x0, z0, x1, z1, ext);
    if (!fs.length) return;
    const [axis, f, n, a, b] = pick(fs);
    if (b - a < 9) return;
    const fw = Math.min(7, b - a - 3), c = a + 1.5 + rng() * (b - a - 3 - fw) + fw / 2;
    const top = Math.min(h - 2.5, 7.2 + WIN_H * 10);
    const slope = Math.atan2(WIN_H, fw * 0.7), run = Math.hypot(fw * 0.7, WIN_H);
    let flip = 1;
    for (let y = 7.2; y <= top; y += WIN_H) {
      const out = f + n * 0.65, rail = f + n * 1.28;
      if (axis === 'z') {
        detailBox(c, y, out, fw, 0.1, 1.3, IRON);
        detailBox(c, y + 1.0, rail, fw, 0.06, 0.06, IRON);
        add(dGeos, colorize(new THREE.BoxGeometry(run, 0.08, 0.7).rotateZ(flip * slope).translate(c, y - WIN_H / 2, out), IRON), c, f);
      } else {
        detailBox(out, y, c, 1.3, 0.1, fw, IRON);
        detailBox(rail, y + 1.0, c, 0.06, 0.06, fw, IRON);
        add(dGeos, colorize(new THREE.BoxGeometry(0.7, 0.08, run).rotateX(flip * slope).translate(out, y - WIN_H / 2, c), IRON), f, c);
      }
      flip = -flip;
    }
  }

  // Flat roof: tar surface, parapet wall, stair bulkhead
  function flatRoof(cx, top, cz, w, d, color) {
    if (w < 4 || d < 4) return;
    detailBox(cx, top, cz, w - 0.6, 0.06, d - 0.6, ROOF);
    const c = darker(color, 0.8), t = 0.3;
    detailBox(cx, top, cz - d / 2 + t / 2, w, 1.0, t, c);
    detailBox(cx, top, cz + d / 2 - t / 2, w, 1.0, t, c);
    detailBox(cx - w / 2 + t / 2, top, cz, t, 1.0, d - 2 * t, c);
    detailBox(cx + w / 2 - t / 2, top, cz, t, 1.0, d - 2 * t, c);
    if (w > 10 && d > 10 && rng() < 0.7) detailBox(cx + (rng() - 0.5) * (w - 8), top, cz + (rng() - 0.5) * (d - 8), 3.5, 3, 4, '#8a8580', true);
  }

  // String courses: a ledge above the shops and every few floors
  function ledges(cx, cz, w, d, h, color) {
    detailBox(cx, 4.55, cz, w + 0.5, 0.35, d + 0.5, darker(color, 0.8));
    const every = (4 + ((rng() * 5) | 0)) * WIN_H;
    for (let y = 4.6 + every; y < h - 3; y += every) detailBox(cx, y, cz, w + 0.35, 0.3, d + 0.35, darker(color, 0.85));
  }

  // plain: keep a simple box on the lot (no plaza setback or round tower), e.g. for billboard walls
  function building(x0, z0, x1, z1, h, ext = ALL_SIDES, plain = false) {
    curGroup = plain ? null : { walls: [], parts: [], round: false };
    const rec = buildingImpl(x0, z0, x1, z1, h, ext, plain);
    if (curGroup && !curGroup.round && curGroup.walls.length) groups.push(curGroup);
    curGroup = null;
    return rec;
  }

  function buildingImpl(x0, z0, x1, z1, h, ext, plain) {
    const style = chooseStyle(h), color = pick(PALETTES[style]);
    const grime = style === 'glass' ? 0.85 : 0.58 + rng() * 0.22;
    // Modern towers sometimes sit back from the street behind a small plaza with trees.
    if (!plain && style === 'glass' && h > 80 && x1 - x0 > 26 && z1 - z0 > 26 && rng() < 0.4) {
      const inset = 3 + rng() * 3, ox0 = x0, oz0 = z0, ox1 = x1, oz1 = z1;
      if (ext.w) x0 += inset;
      if (ext.e) x1 -= inset;
      if (ext.n) z0 += inset;
      if (ext.s) z1 -= inset;
      sidewalkBox(ox0, oz0, ox1, oz1, 0.15, 0.2, '#e8d8c0');
      for (const [px, pz] of [[ox0 + 1.8, oz0 + 1.8], [ox1 - 1.8, oz0 + 1.8], [ox0 + 1.8, oz1 - 1.8], [ox1 - 1.8, oz1 - 1.8]]) {
        if (rng() < 0.7) trees.add(px, 0.2, pz, 'street');
      }
    }
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (!plain && (style === 'glass' || style === 'deco') && h > 90 && Math.min(w, d) > 26 && rng() < 0.25) {
      return roundTower(cx, cz, Math.min(w, d) / 2 - 1, h, color, style, grime);
    }
    wallBox(cx, 0, cz, w, h, d, color, style, undefined, true, grime);
    const shops = h > 9 && w > 6 && d > 6;
    if (shops) {
      wallBox(cx, 0, cz, w + 0.3, 4.6, d + 0.3, pick(PALETTES.store), 'store', [6, 4.6], false, 0.8);
      awnings(x0 - 0.15, z0 - 0.15, x1 + 0.15, z1 + 0.15, ext);
      if (rng() < 0.15) bladeSign(x0 - 0.15, z0 - 0.15, x1 + 0.15, z1 + 0.15, ext);
    }
    if (style !== 'glass') ledges(cx, cz, w, d, h, color);
    if (style === 'brick' && h < 70 && rng() < 0.65) fireEscape(x0, z0, x1, z1, h, ext);

    let top = h, tw = w, td = d, flat = style !== 'glass';
    if (style === 'deco' && h > 70 && w > 14 && d > 14) {
      // Art deco "wedding cake": stepped setbacks with cornices, floodlit crown, metal pyramid and spire
      const tiers = 2 + ((rng() * 2) | 0);
      for (let t = 0; t < tiers; t++) {
        detailBox(cx, top - 0.6, cz, tw + 0.8, 1.0, td + 0.8, darker(color));
        tw *= 0.72;
        td *= 0.72;
        const th = h * (0.1 + rng() * 0.08);
        wallBox(cx, top, cz, tw, th, td, color, 'deco', undefined, true, 0.9);
        top += th;
      }
      lightBox(cx, top - 1.6, cz, tw + 0.3, 1.0, td + 0.3, GOLD);
      const r = Math.min(tw, td) * 0.7, ph = Math.min(tw, td) * (0.8 + rng() * 0.6);
      add(mGeos, colorize(new THREE.ConeGeometry(r, ph, 4).rotateY(Math.PI / 4).translate(cx, top + ph / 2, cz), rng() < 0.6 ? '#c9a24a' : '#c8ccd4'), cx, cz);
      world.addBox(cx - r * 0.5, top, cz - r * 0.5, cx + r * 0.5, top + ph * 0.5, cz + r * 0.5);
      detailCyl(cx, top + ph * 0.8, cz, 0.15, 0.5, 14 + rng() * 16, '#d0d0d0', 6, mGeos);
      top += ph;
      flat = false;
    } else if (h > 70 && w > 14 && d > 14 && rng() < 0.55) {
      const s = 0.55 + rng() * 0.25, h2 = h * (0.1 + rng() * 0.22);
      if (flat) flatRoof(cx, h, cz, w, d, color);
      tw = w * s;
      td = d * s;
      wallBox(cx, top, cz, tw, h2, td, color, style, undefined, true, 0.92);
      top += h2;
      if (rng() < 0.4) {
        const h3 = h2 * 0.6;
        tw *= 0.65;
        td *= 0.65;
        wallBox(cx, top, cz, tw, h3, td, color, style, undefined, true, 0.95);
        top += h3;
      }
    }
    if (flat) flatRoof(cx, top, cz, tw, td, color);
    if (style === 'glass' && top > 110) {
      lightBox(cx, top - 1.2, cz, tw + 0.25, 0.8, td + 0.25, rng() < 0.5 ? COOL : GOLD);
      aviationLights(cx, top, cz, tw, td);
    }
    if (h < 45 && flat && rng() < 0.06) {
      // Rooftop neon sign on a frame
      const sw = Math.min(tw - 2, 10);
      if (sw > 4) {
        detailBox(cx, top, cz, sw, 3.2, 0.3, IRON);
        lightBox(cx, top + 1.0, cz - 0.25, sw - 0.6, 1.6, 0.12, pick(NEON));
      }
    }
    footprints.push({ x0, z0, x1, z1, h: top });
    if (style !== 'deco' && top > 140 && rng() < 0.55) detailCyl(cx, top, cz, 0.25, 0.6, 12 + rng() * 30, '#9a9a9a', 6, mGeos);
    else if (h < 70 && w > 9 && d > 9 && rng() < 0.4) waterTower(x0 + 4 + rng() * (w - 8), h, z0 + 4 + rng() * (d - 8));
    if (flat && tw > 8 && td > 8) {
      const n = (rng() * 3) | 0;
      for (let i = 0; i < n; i++) {
        const bw = 2 + rng() * 3, bd = 2 + rng() * 3;
        detailBox(cx + (rng() - 0.5) * (tw - bw - 1), top, cz + (rng() - 0.5) * (td - bd - 1), bw, 1.2 + rng() * 1.5, bd, '#707070');
      }
    }
    return { x0, z0, x1, z1, h };
  }

  // Rounded Metropolis-style tower with stepped crown
  function roundTower(cx, cz, r, h, color, style, grime) {
    cylWall(cx, 0, cz, r, h, color, style, undefined, true, grime);
    cylWall(cx, 0, cz, r + 0.15, 4.6, pick(PALETTES.store), 'store', [6, 4.6], false, 0.8, true);
    let top = h, tr = r;
    if (style === 'deco') {
      for (let t = 0; t < 2; t++) {
        tr *= 0.75;
        const th = h * 0.07;
        cylWall(cx, top, cz, tr, th, color, 'deco', undefined, true, 0.95);
        top += th;
      }
      lightCyl(cx, top - 1.4, cz, tr + 0.2, 1.0, GOLD);
      const ph = tr * 1.4;
      add(mGeos, colorize(new THREE.ConeGeometry(tr * 0.9, ph, 16).translate(cx, top + ph / 2, cz), '#c9a24a'), cx, cz);
      detailCyl(cx, top + ph * 0.85, cz, 0.15, 0.5, 20, '#d0d0d0', 6, mGeos);
      top += ph;
    } else {
      lightCyl(cx, top - 1.2, cz, r + 0.2, 0.8, COOL);
      detailCyl(cx, top, cz, 0.3, 0.7, 25 + rng() * 20, '#9a9a9a', 6, mGeos);
    }
    footprints.push({ x0: cx - r, z0: cz - r, x1: cx + r, z1: cz + r, h: top });
    return { x0: cx - r, z0: cz - r, x1: cx + r, z1: cz + r, h };
  }

  // Instanced park bench; rotY = direction it faces (0 = +Z)
  const bench = (x, y, z, rotY) => trees.addBench(x, y, z, rotY);

  // Trash cans at the corners, a hydrant by the curb, newspaper boxes near a corner.
  function streetFurniture(x0, z0, x1, z1) {
    const corners = [[x0 + 1, z0 + 1, Math.PI], [x1 - 1, z0 + 1, Math.PI], [x0 + 1, z1 - 1, 0], [x1 - 1, z1 - 1, 0]];
    for (const [x, z, r] of corners) if (rng() < 0.55) trees.addProp('trash', x, 0.15, z, r);
    if (rng() < 0.85) {
      const north = rng() < 0.5;
      trees.addProp('hydrant', x0 + 5 + rng() * (x1 - x0 - 10), 0.15, north ? z0 + 0.65 : z1 - 0.65, north ? Math.PI : 0);
    }
    if (rng() < 0.35) {
      const west = rng() < 0.5, x = west ? x0 + 0.7 : x1 - 0.7, n = 1 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) trees.addProp('newsbox', x, 0.15, z0 + 4 + i * 0.55, west ? -Math.PI / 2 : Math.PI / 2);
    }
  }

  // Small fenced park in place of a building
  function pocketPark(x0, z0, x1, z1) {
    groundBox(x0 + 0.5, z0 + 0.5, x1 - 0.5, z1 - 0.5, 0.15, 0.3, '#3f6b34', true);
    const fc = '#1f2a22';
    detailBox((x0 + x1) / 2, 0.3, z0 + 0.55, x1 - x0 - 1, 0.9, 0.06, fc);
    detailBox((x0 + x1) / 2, 0.3, z1 - 0.55, x1 - x0 - 1, 0.9, 0.06, fc);
    detailBox(x0 + 0.55, 0.3, (z0 + z1) / 2, 0.06, 0.9, z1 - z0 - 1, fc);
    const n = 2 + ((rng() * 5) | 0);
    for (let i = 0; i < n; i++) trees.add(x0 + 2.5 + rng() * (x1 - x0 - 5), 0.3, z0 + 2.5 + rng() * (z1 - z0 - 5), 'garden', 0.75);
    bench((x0 + x1) / 2 - 1.5, 0.3, z1 - 2, Math.PI);
    if (x1 - x0 > 16) bench((x0 + x1) / 2 + 1.5, 0.3, z1 - 2, Math.PI);
  }

  // Paved plaza where Broadway cut a lot away
  function plaza(x0, z0, x1, z1) {
    sidewalkBox(x0, z0, x1, z1, 0.15, 0.17, '#e8d8c0');
    for (let i = 0; i < 4; i++) {
      const x = x0 + 2 + rng() * (x1 - x0 - 4), z = z0 + 2 + rng() * (z1 - z0 - 4);
      const dist = distToBroadway(x, z);
      if (dist < BW_HALF + 1.5) continue;
      if (rng() < 0.6) trees.add(x, 0.17, z, 'street');
      else bench(x, 0.17, z, ((rng() * 4) | 0) * (Math.PI / 2));
    }
  }

  function splits(a, b, n) {
    const w = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const v = 0.6 + rng() * 0.8;
      w.push(v);
      s += v;
    }
    const out = [a];
    let acc = a;
    for (let i = 0; i < n - 1; i++) {
      acc += (w[i] / s) * (b - a);
      out.push(acc);
    }
    out.push(b);
    return out;
  }

  function fillBlock(x0, z0, x1, z1, hf, maxLots = 4, key = null) {
    const recs = [];
    if (key) lotRecs.set(key, recs);
    const base = hf((x0 + x1) / 2, (z0 + z1) / 2);
    if (base > 110 && rng() < 0.25 && !hitsBroadway(x0, z0, x1, z1)) {
      recs.push(building(x0, z0, x1, z1, base * (1 + rng() * 0.35)));
      return;
    }
    const nx = 2 + ((rng() * (maxLots - 1)) | 0);
    const nz = maxLots > 3 && rng() < 0.55 ? 2 : 1;
    const xs = splits(x0, x1, nx), zs = splits(z0, z1, nz);
    for (let a = 0; a < nx; a++) {
      for (let b = 0; b < nz; b++) {
        const lx0 = xs[a], lz0 = zs[b], lz1 = zs[b + 1];
        let lx1 = xs[a + 1];
        if (a < nx - 1 && rng() < 0.18) lx1 -= 2.5 + rng() * 1.5; // alley
        if (key && hitsBroadway(lx0, lz0, lx1, lz1)) {
          plaza(lx0, lz0, lx1, lz1);
          continue;
        }
        const r = rng();
        if (r < 0.05 && lx1 - lx0 > 10 && lz1 - lz0 > 10) {
          pocketPark(lx0, lz0, lx1, lz1);
          continue;
        }
        if (r < 0.07) continue; // empty lot
        const ext = { w: a === 0, e: a === nx - 1, n: b === 0, s: b === nz - 1 };
        recs.push(building(lx0, lz0, lx1, lz1, Math.max(8, base * (0.55 + rng() * 0.75)), ext));
      }
    }
  }

  // ---------------------------------------------------------------- land
  groundBox(LANDS[0].minX, LANDS[0].minZ, LANDS[0].maxX, LANDS[0].maxZ, -6, -0.03, '#2a2c31'); // painted road plane sits on top
  groundBox(LANDS[1].minX, LANDS[1].minZ, LANDS[1].maxX, LANDS[1].maxZ, -6, 0, '#2a2c31');
  groundBox(LANDS[2].minX, LANDS[2].minZ, LANDS[2].maxX, LANDS[2].maxZ, -6, 0, '#2a2c31');

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(12000, 12000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#173650', roughness: 0.12, metalness: 0.6 }),
  );
  water.position.y = -0.3;
  water.receiveShadow = true;
  scene.add(water);

  // Only half of the would-be tall buildings stay tall; the rest become mid-rises. Uses a hash of
  // the lot position instead of rng() so the rest of the city layout doesn't change.
  const TALL = 80;
  const hash = (x, z, k) => {
    const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
    return v - Math.floor(v);
  };
  const fewerTall = (hf) => (x, z) => {
    const h = hf(x, z);
    return h > TALL && hash(x, z, 1) < 0.5 ? 40 + hash(x, z, 2) * 35 : h;
  };

  // ---------------------------------------------------------------- Manhattan
  const manhattanH = fewerTall((x, z) => {
    const mid = Math.exp(-(((z + 330) / 360) ** 2));
    const down = Math.exp(-(((z - 990) / 190) ** 2));
    const parkEdge = z < -760 && z > -1340 && Math.abs(x) < 290 ? 0.45 : 0;
    const t = Math.max(mid, down * 1.1, parkEdge);
    let h = 14 + rng() * 22 + t * (35 + rng() * 140);
    if (rng() < 0.06 * t) h += 90 + rng() * 120;
    return h;
  });
  // Blocks handled by landmarks: Times Square (4), Empire State, Chrysler, One WTC.
  const reserved = new Set(['2,13', '3,13', '2,14', '3,14', '2,17', '3,15', '1,34']);
  const cols = (MANHATTAN.maxX - MANHATTAN.minX) / AVE_SP;
  const rows = (MANHATTAN.maxZ - MANHATTAN.minZ) / ST_SP;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const ax = MANHATTAN.minX + i * AVE_SP, zj = MANHATTAN.minZ + j * ST_SP;
      const bx0 = ax + 9, bx1 = ax + AVE_SP - 9, bz0 = zj + 6, bz1 = zj + ST_SP - 6;
      if (inRect((bx0 + bx1) / 2, (bz0 + bz1) / 2, PARK)) continue;
      // Sidewalk tint varies a little block to block
      const sv = 225 + ((rng() * 30) | 0);
      sidewalk(bx0, bz0, bx1, bz1, `rgb(${sv},${sv},${sv})`);
      streetFurniture(bx0, bz0, bx1, bz1);
      if (reserved.has(i + ',' + j)) continue;
      fillBlock(bx0 + 2.5, bz0 + 2.5, bx1 - 2.5, bz1 - 2.5, manhattanH, 4, i + ',' + j);
    }
  }
  // Painted street surface: one texture tile per grid cell, intersections at the tile corners.
  {
    const w = MANHATTAN.maxX - MANHATTAN.minX, d = MANHATTAN.maxZ - MANHATTAN.minZ;
    const rt = roadTexture();
    for (const t of [rt.map, rt.normal, rt.rough]) t.repeat.set(w / AVE_SP, d / ST_SP);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: rt.map, normalMap: rt.normal, roughnessMap: rt.rough, roughness: 1, metalness: 0.05 }));
    road.position.set((MANHATTAN.minX + MANHATTAN.maxX) / 2, 0, (MANHATTAN.minZ + MANHATTAN.maxZ) / 2);
    road.receiveShadow = true;
    scene.add(road);
  }
  // Broadway road surface laid diagonally over the grid
  {
    const tex = broadwayTexture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    for (let i = 1; i < BROADWAY.length; i++) {
      const [ax, az] = BROADWAY[i - 1], [bx, bz] = BROADWAY[i];
      const len = Math.hypot(bx - ax, bz - az);
      const t = tex.clone();
      t.repeat.set(1, len / 32);
      t.needsUpdate = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16, len).rotateX(-Math.PI / 2).rotateY(Math.atan2(-(bx - ax), -(bz - az))), mat.clone());
      m.material.map = t;
      m.position.set((ax + bx) / 2, 0.18, (az + bz) / 2);
      m.receiveShadow = true;
      scene.add(m);
    }
  }

  // Glass skybridges between tall buildings facing each other across a street
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const zs = MANHATTAN.minZ + (j + 1) * ST_SP;
      if (METRO_LINES.some((L) => L.axis === 'x' && Math.abs(L.c - zs) < 1)) continue;
      const A = lotRecs.get(i + ',' + j), Bl = lotRecs.get(i + ',' + (j + 1));
      if (!A || !Bl) continue;
      for (const a of A) {
        if (a.h < 45 || Math.abs(a.z1 - (zs - 8.5)) > 0.6) continue;
        for (const b of Bl) {
          if (b.h < 45 || Math.abs(b.z0 - (zs + 8.5)) > 0.6) continue;
          const ox0 = Math.max(a.x0, b.x0), ox1 = Math.min(a.x1, b.x1);
          if (ox1 - ox0 < 12 || rng() > 0.12) continue;
          const x = (ox0 + ox1) / 2, y = Math.max(20, Math.min(a.h, b.h) * (0.35 + rng() * 0.35));
          const len = b.z0 - a.z1 + 0.4;
          wallBox(x, y, zs, 7, 4.5, len, pick(PALETTES.glass), 'glass');
          detailBox(x, y - 0.4, zs, 7.6, 0.5, len, IRON, false, mGeos);
          detailBox(x, y + 4.5, zs, 7.6, 0.4, len, IRON, false, mGeos);
          lightBox(x, y - 0.5, zs, 5, 0.1, len - 1, COOL);
        }
      }
    }
  }

  // ---------------------------------------------------------------- trees
  // Street trees in tree pits along the sidewalks (denser in residential areas than in Midtown)
  const density = (z) => (z < -770 ? 0.8 : z < -100 ? 0.25 : z < 800 ? 0.6 : 0.35);
  const nearAvenue = (x) => {
    const ax = Math.round((x - MANHATTAN.minX) / AVE_SP) * AVE_SP + MANHATTAN.minX;
    return Math.abs(x - ax);
  };
  for (let j = 0; j <= rows; j++) {
    const zs = MANHATTAN.minZ + j * ST_SP;
    for (const side of [-1, 1]) {
      const z = zs + side * 7.3;
      if (z < MANHATTAN.minZ || z > MANHATTAN.maxZ) continue;
      for (let x = MANHATTAN.minX + 15; x < MANHATTAN.maxX - 15; x += 9 + rng() * 5) {
        if (nearAvenue(x) < 15 || inRect(x, z, PARK)) continue;
        if (world.pointInside(x, 1, z) || distToBroadway(x, z) < BW_HALF) continue;
        const r = rng();
        if (r < density(z)) {
          trees.add(x, 0.15, z, 'street');
          trees.addProp('pit', x, 0.15, z);
        }
        // Bench against the building line, facing the street, in gaps between tree pits
        else if (r < density(z) + 0.12 && !world.pointInside(x, 1, z + side * 0.7)) bench(x, 0.15, z + side * 0.5, side > 0 ? Math.PI : 0);
      }
    }
  }
  for (let i = 0; i <= cols; i++) {
    const ax = MANHATTAN.minX + i * AVE_SP;
    for (const side of [-1, 1]) {
      if ((i === 0 && side < 0) || (i === cols && side > 0)) continue;
      const x = ax + side * 10.2;
      for (let z = MANHATTAN.minZ + 20; z < MANHATTAN.maxZ; z += 12 + rng() * 8) {
        const lamp = (z - MANHATTAN.minZ - 5) % 35;
        if (lamp < 3 || lamp > 32 || inRect(x, z, PARK) || rng() > density(z) * 0.45) continue;
        const sz = (z - MANHATTAN.minZ) % ST_SP;
        if (sz < 14 || sz > ST_SP - 14 || world.pointInside(x, 1, z) || distToBroadway(x, z) < BW_HALF) continue;
        trees.add(x, 0.15, z, 'street');
      }
    }
  }

  // ---------------------------------------------------------------- Central Park
  groundBox(PARK.minX, PARK.minZ, PARK.maxX, PARK.maxZ, 0, 0.25, '#3c6a32', true);
  groundBox(-3, PARK.minZ, 3, PARK.maxZ, 0.25, 0.28, '#a59a7c');
  for (const z of [-1250, -900]) groundBox(PARK.minX, z - 2.5, PARK.maxX, z + 2.5, 0.25, 0.28, '#a59a7c');
  const reservoir = new THREE.Mesh(
    new THREE.PlaneGeometry(RESERVOIR.maxX - RESERVOIR.minX, RESERVOIR.maxZ - RESERVOIR.minZ).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#1d3d55', roughness: 0.08, metalness: 0.5 }),
  );
  reservoir.position.set((RESERVOIR.minX + RESERVOIR.maxX) / 2, 0.3, (RESERVOIR.minZ + RESERVOIR.maxZ) / 2);
  scene.add(reservoir);
  {
    const res = { minX: RESERVOIR.minX - 5, maxX: RESERVOIR.maxX + 5, minZ: RESERVOIR.minZ - 5, maxZ: RESERVOIR.maxZ + 5 };
    // Fewer, much bigger trees (12-16 m) so their branches and the lawns between them show.
    res.minX -= 4; res.maxX += 4; res.minZ -= 4; res.maxZ += 4;
    let n = 0;
    while (n < 650) {
      const x = PARK.minX + 6 + rng() * (PARK.maxX - PARK.minX - 12);
      const z = PARK.minZ + 6 + rng() * (PARK.maxZ - PARK.minZ - 12);
      if (inRect(x, z, res) || Math.abs(x) < 9 || Math.abs(z + 1250) < 8 || Math.abs(z + 900) < 8) continue;
      trees.add(x, 0.25, z, 'park', 0.9 + rng() * 0.35);
      n++;
    }
    // Benches lining the paths, facing the path, and around the reservoir facing the water
    for (let z = PARK.minZ + 12; z < PARK.maxZ - 8; z += 16) {
      if (Math.abs(z + 1250) < 6 || Math.abs(z + 900) < 6) continue;
      bench(-4.2, 0.28, z, Math.PI / 2);
      bench(4.2, 0.28, z + 8, -Math.PI / 2);
    }
    for (const pz of [-1250, -900]) {
      for (let x = PARK.minX + 10; x < PARK.maxX - 8; x += 16) {
        if (Math.abs(x) < 7) continue;
        bench(x, 0.28, pz - 3.8, 0);
        bench(x + 8, 0.28, pz + 3.8, Math.PI);
      }
    }
    for (let x = RESERVOIR.minX + 6; x < RESERVOIR.maxX - 4; x += 20) {
      bench(x, 0.25, RESERVOIR.minZ - 2.5, 0);
      bench(x + 10, 0.25, RESERVOIR.maxZ + 2.5, Math.PI);
    }
    for (let z = RESERVOIR.minZ + 8; z < RESERVOIR.maxZ - 4; z += 22) {
      bench(RESERVOIR.minX - 2.5, 0.25, z, Math.PI / 2);
      bench(RESERVOIR.maxX + 2.5, 0.25, z + 11, -Math.PI / 2);
    }
  }

  // ---------------------------------------------------------------- Times Square
  const tickerTex = tickerTexture();
  const tickerMat = new THREE.MeshBasicMaterial({ map: tickerTex, toneMapped: false });
  function billboard(x, y, z, w, h, rotY, mat) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat || new THREE.MeshBasicMaterial({ map: adTexture(rng), toneMapped: false }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    scene.add(m);
    return m;
  }
  for (const [i, j] of [[2, 13], [3, 13], [2, 14], [3, 14]]) {
    const ax = MANHATTAN.minX + i * AVE_SP, zj = MANHATTAN.minZ + j * ST_SP;
    const x0 = ax + 11.5, x1 = ax + AVE_SP - 11.5, z0 = zj + 8.5, z1 = zj + ST_SP - 8.5;
    building(x0, z0, x1, z1, 70 + rng() * 60, ALL_SIDES, true);
    // Corner nearest the (x=0, z=-420) intersection and the outward normals of its two faces.
    const fx = i === 2 ? x1 : x0, nx = i === 2 ? 1 : -1;
    const fz = j === 13 ? z1 : z0, nz = j === 13 ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const w = 16 + rng() * 6, h = 9 + rng() * 3, y = 15 + k * 13;
      billboard(fx + nx * 0.3, y, fz - nz * (w / 2 + 1), w, h, nx > 0 ? Math.PI / 2 : -Math.PI / 2);
      billboard(fx - nx * (w / 2 + 1), y, fz + nz * 0.3, w, h, nz > 0 ? 0 : Math.PI);
    }
    billboard(fx + nx * 0.3, 7, fz - nz * 26, 50, 2.4, nx > 0 ? Math.PI / 2 : -Math.PI / 2, tickerMat);
    billboard(fx - nx * 26, 7, fz + nz * 0.3, 50, 2.4, nz > 0 ? 0 : Math.PI, tickerMat);
  }

  // ---------------------------------------------------------------- Empire State Building
  function beacon(x, y, z, color) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    m.position.set(x, y, z);
    scene.add(m);
    beacons.push(m);
  }
  {
    const cx = -70, cz = -175, col = '#c8bea6';
    let y = 0;
    for (const [w, d, h] of [[108, 50, 24], [64, 42, 178], [48, 34, 30], [32, 26, 24], [18, 16, 14]]) {
      wallBox(cx, y, cz, w, h, d, col, 'deco', undefined, true, y === 0 ? 0.7 : 0.9);
      if (w <= 48) lightBox(cx, y + h - 1.4, cz, w + 0.4, 1.0, d + 0.4, GOLD); // floodlit upper tiers
      y += h;
    }
    footprints.push({ x0: cx - 54, z0: cz - 25, x1: cx + 54, z1: cz + 25, h: y });
    detailCyl(cx, y, cz, 1.6, 4.5, 26, '#bdb7a8', 8);
    world.addBox(cx - 3, y, cz - 3, cx + 3, y + 26, cz + 3);
    y += 26;
    detailCyl(cx, y, cz, 0.25, 0.6, 30, '#999999', 6);
    beacon(cx, y + 30, cz, '#ff2a2a');
  }

  // ---------------------------------------------------------------- Chrysler Building
  {
    const cx = 70, cz = -315, col = '#b9b4ab';
    let y = 0;
    for (const [w, d, h] of [[100, 50, 22], [42, 42, 150], [34, 34, 22], [28, 28, 10]]) {
      wallBox(cx, y, cz, w, h, d, col, 'deco', undefined, true, y === 0 ? 0.7 : 0.9);
      y += h;
    }
    footprints.push({ x0: cx - 50, z0: cz - 25, x1: cx + 50, z1: cz + 25, h: y });
    lightBox(cx, y - 1.2, cz, 28.4, 1.0, 28.4, COOL);
    const crown = [];
    let cy = y;
    for (const [rb, rt, h] of [[13, 10.5, 10], [10.5, 8, 9], [8, 5.5, 8], [5.5, 0.4, 13]]) {
      crown.push(new THREE.CylinderGeometry(rt, rb, h, 8).translate(cx, cy + h / 2, cz).toNonIndexed());
      cy += h;
    }
    crown.push(new THREE.CylinderGeometry(0.15, 0.4, 28, 6).translate(cx, cy + 14, cz).toNonIndexed());
    const crownMesh = new THREE.Mesh(
      mergeGeometries(crown),
      new THREE.MeshStandardMaterial({ color: '#dfe2ea', metalness: 0.85, roughness: 0.22, emissive: '#3a3f55', emissiveIntensity: 0.6 }),
    );
    crownMesh.castShadow = true;
    scene.add(crownMesh);
    world.addBox(cx - 10, y, cz - 10, cx + 10, y + 27, cz + 10);
  }

  // ---------------------------------------------------------------- Brooklyn Bridge
  {
    const { z: bz, x0, x1, deck, ramp } = BRIDGE;
    const deckCol = '#5b524a', stone = '#9b8b73';
    detailBox((x0 + x1) / 2, deck - 1.5, bz, x1 - x0 - 2 * ramp, 1.5, 24, deckCol, true);
    const L = Math.hypot(ramp, deck), th = Math.atan2(deck, ramp);
    for (const [cx, rot] of [[x0 + ramp / 2, th], [x1 - ramp / 2, -th]]) {
      add(dGeos, colorize(new THREE.BoxGeometry(L, 1.5, 24).rotateZ(rot).translate(cx, deck / 2 - 0.75, bz), deckCol), cx, bz);
    }
    // Stair-step colliders under the ramps (each step is within the step-up height).
    const steps = 15;
    for (let k = 0; k < steps; k++) {
      const top = ((k + 1) * deck) / steps, len = ramp / steps;
      world.addBox(x0 + k * len, top - 1.5, bz - 12, x0 + (k + 1) * len, top, bz + 12);
      world.addBox(x1 - (k + 1) * len, top - 1.5, bz - 12, x1 - k * len, top, bz + 12);
    }
    const towers = [575, 815];
    for (const tx of towers) {
      detailBox(tx, -0.3, bz - 10, 9, 82, 7, stone, true);
      detailBox(tx, -0.3, bz + 10, 9, 82, 7, stone, true);
      detailBox(tx, 66, bz, 9, 16, 27, stone, true);
      detailBox(tx, 8, bz, 9, 6, 27, stone, true);
    }
    const cableY = (x) => {
      if (x < towers[0]) return deck + ((x - (x0 + ramp)) / (towers[0] - (x0 + ramp))) * (80 - deck);
      if (x > towers[1]) return 80 - ((x - towers[1]) / (x1 - ramp - towers[1])) * (80 - deck);
      const m = (towers[0] + towers[1]) / 2, half = (towers[1] - towers[0]) / 2;
      return deck + 4 + (80 - deck - 4) * ((x - m) / half) ** 2;
    };
    const pts = [];
    for (const zs of [bz - 11.5, bz + 11.5]) {
      for (let x = x0 + ramp; x < x1 - ramp; x += 5) {
        pts.push(x, cableY(x), zs, x + 5, cableY(x + 5), zs);
        if (Math.round(x) % 10 === 0) pts.push(x, cableY(x), zs, x, deck, zs);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: '#d8cfba' })));
  }

  // ---------------------------------------------------------------- elevated subway
  const trains = buildMetro({
    box: (cx, y0, cz, w, h, d, color, collide, metal) => detailBox(cx, y0, cz, w, h, d, color, collide, metal ? mGeos : dGeos),
    light: lightBox,
  }, scene);

  // ---------------------------------------------------------------- Brooklyn & Jersey City
  function district(x0, x1, z0, z1, aveSp, stSp, hf) {
    for (let x = x0 + 20; x + aveSp <= x1; x += aveSp) {
      for (let z = z0 + 20; z + stSp <= z1; z += stSp) {
        const bx0 = x + 7, bx1 = x + aveSp - 7, bz0 = z + 6, bz1 = z + stSp - 6;
        sidewalk(bx0, bz0, bx1, bz1, '#c8c8c8');
        fillBlock(bx0 + 2, bz0 + 2, bx1 - 2, bz1 - 2, hf, 3);
        for (let tx = bx0 + 4; tx < bx1 - 4; tx += 10) if (rng() < 0.12) trees.add(tx, 0.15, bz0 + 1, 'street');
      }
    }
  }
  district(950, 1560, -1300, 1500, 110, 70, fewerTall((x, z) =>
    8 + rng() * 16 + (x < 1150 && z > 600 && z < 1200 ? 20 + rng() * 70 : 0)));
  district(-1560, -950, -1300, 1500, 110, 70, fewerTall((x, z) =>
    8 + rng() * 20 + (x > -1170 && z > 300 && z < 1100 ? 30 + rng() * 140 : 0)));

  // ---------------------------------------------------------------- Street lamps
  const lampPts = [];
  for (let i = 0; i <= cols; i++) {
    const ax = MANHATTAN.minX + i * AVE_SP;
    for (const side of [-1, 1]) {
      if ((i === 0 && side < 0) || (i === cols && side > 0)) continue;
      const lx = ax + side * 10.5;
      for (let z = MANHATTAN.minZ + 5; z < MANHATTAN.maxZ; z += 35) {
        if (Math.abs(lx) < 135 && z > PARK.minZ && z < PARK.maxZ) continue;
        detailBox(lx, 0, z, 0.22, 7.2, 0.22, '#2b2b2e');
        lampPts.push(lx - side * 0.6, 7.3, z);
      }
    }
  }
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lampPts, 3));
    const lamps = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.6, map: glowTexture(), color: '#ffd59a', transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    scene.add(lamps);
  }

  // ---------------------------------------------------------------- materials & merge
  const facades = Object.fromEntries(STYLES.map((s) => [s, makeFacade(s, rng)]));
  const facadeMaterial = (s, extra = {}) => new THREE.MeshStandardMaterial({
    map: facades[s].map, emissiveMap: facades[s].emissive, emissive: 0xffffff, emissiveIntensity: s === 'store' ? 1.4 : 1.1,
    roughnessMap: facades[s].orm, metalnessMap: facades[s].orm, roughness: 1, metalness: 1,
    normalMap: facades[s].normal, normalScale: new THREE.Vector2(0.9, 0.9), vertexColors: true, ...extra,
  });
  function mergeList(list, keepUV) {
    const prepared = list.map((g) => {
      const ng = g.index ? g.toNonIndexed() : g;
      if (!keepUV) ng.deleteAttribute('uv');
      return ng;
    });
    const merged = mergeGeometries(prepared, false);
    // Where each building piece ended up inside the merged buffer
    const entries = [];
    let off = 0;
    prepared.forEach((g, i) => {
      const c = g.attributes.position.count;
      if (list[i].userData.group) entries.push({ src: list[i], start: off, count: c });
      off += c;
    });
    for (const g of prepared) g.dispose();
    for (const g of list) g.dispose();
    return { geo: merged, entries };
  }
  // One mesh per (bucket, chunk) so the renderer can skip tiles outside the camera / shadow frustum.
  function emit(bucket, material, keepUV, cast = true, receive = true) {
    for (const list of bucket.values()) {
      if (!list.length) continue;
      const { geo, entries } = mergeList(list, keepUV);
      const m = new THREE.Mesh(geo, material);
      m.castShadow = cast;
      m.receiveShadow = receive;
      scene.add(m);
      const p = geo.attributes.position.array;
      for (const e of entries) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let v = e.start * 3; v < (e.start + e.count) * 3; v += 3) {
          x0 = Math.min(x0, p[v]); x1 = Math.max(x1, p[v]);
          y0 = Math.min(y0, p[v + 1]); y1 = Math.max(y1, p[v + 1]);
          z0 = Math.min(z0, p[v + 2]); z1 = Math.max(z1, p[v + 2]);
        }
        const part = { mesh: m, start: e.start, count: e.count, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, hidden: false };
        const ud = e.src.userData;
        if (ud.wall) ud.wall.part = part;
        else ud.group.parts.push(part);
      }
    }
  }

  // One World Trade Center: square base, 45°-rotated square top (custom mesh, uses facade atlas).
  {
    const cx = -210, cz = 1015, s = 25, H = 330;
    const B = [[-s, -s], [s, -s], [s, s], [-s, s]];
    const T = [[0, -s], [s, 0], [0, s], [-s, 0]];
    const tris = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      tris.push([B[i], 0], [B[j], 0], [T[i], H]);
      tris.push([T[i], H], [B[j], 0], [T[j], H]);
    }
    tris.push([T[0], H], [T[1], H], [T[2], H], [T[0], H], [T[2], H], [T[3], H]);
    const pos = [], uv = [];
    for (let t = 0; t < tris.length; t += 3) {
      const p = tris.slice(t, t + 3).map(([[x, z], y]) => new THREE.Vector3(cx + x, y, cz + z));
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      for (const v of p) {
        pos.push(v.x, v.y, v.z);
        const horiz = Math.abs(n.x) > Math.abs(n.z) ? v.z : v.x;
        if (Math.abs(n.y) > 0.99 * n.length()) uv.push(ROOF_UV, ROOF_UV);
        else uv.push(horiz / (WIN_W * CELLS), v.y / (WIN_H * CELLS));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const wtc = new THREE.Mesh(g, facadeMaterial('glass', { vertexColors: false, color: '#a9c2da', side: THREE.DoubleSide }));
    wtc.castShadow = wtc.receiveShadow = true;
    scene.add(wtc);
    for (let k = 0; k < 6; k++) {
      const half = s * (1 - (0.5 * (k + 0.5)) / 6) * 0.97;
      world.addBox(cx - half, (k * H) / 6, cz - half, cx + half, ((k + 1) * H) / 6, cz + half);
    }
    footprints.push({ x0: cx - s, z0: cz - s, x1: cx + s, z1: cz + s, h: H });
    detailCyl(cx, H, cz, 0.5, 1.6, 110, '#d0d0d0', 8);
    beacon(cx, H + 110, cz, '#ffffff');
  }

  // Statue of Liberty
  {
    const { x: lx, z: lz } = LIBERTY;
    groundBox(lx - 40, lz - 40, lx + 40, lz + 40, -6, 1, '#4f6b45', true);
    detailBox(lx, 1, lz, 20, 5, 20, '#8f8571', true);
    detailBox(lx, 6, lz, 12, 22, 12, '#a69c86', true);
    detailBox(lx, 28, lz, 9, 3, 9, '#958b76', true);
    footprints.push({ x0: lx - 10, z0: lz - 10, x1: lx + 10, z1: lz + 10, h: 57 });
    const copper = new THREE.MeshStandardMaterial({ color: '#6fa593', roughness: 0.6, metalness: 0.3 });
    const grp = new THREE.Group();
    grp.position.set(lx, 31, lz);
    const UP = new THREE.Vector3(0, 1, 0);
    const addPart = (geo, x, y, z, dir, mat = copper) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (dir) m.quaternion.setFromUnitVectors(UP, dir);
      m.castShadow = true;
      grp.add(m);
      return m;
    };
    addPart(new THREE.CylinderGeometry(1.8, 3.1, 19, 14), 0, 9.5, 0);
    addPart(new THREE.CylinderGeometry(1.5, 1.8, 4, 12), 0, 21, 0);
    addPart(new THREE.SphereGeometry(1.35, 14, 10), 0, 24.4, 0);
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + (k - 3) * 0.33;
      const dir = new THREE.Vector3(Math.cos(a), 0.7, Math.sin(a)).normalize();
      addPart(new THREE.ConeGeometry(0.22, 2.2, 5), dir.x * 1.6, 25.2 + dir.y * 1.2, dir.z * 1.6, dir);
    }
    const arm = new THREE.Vector3(0.25, 1, 0).normalize();
    const sh = new THREE.Vector3(1.5, 22, 0);
    addPart(new THREE.CylinderGeometry(0.45, 0.6, 8, 8), sh.x + arm.x * 4, sh.y + arm.y * 4, sh.z, arm);
    addPart(new THREE.CylinderGeometry(0.6, 0.35, 1.3, 8), sh.x + arm.x * 8.5, sh.y + arm.y * 8.5, sh.z, arm);
    addPart(new THREE.SphereGeometry(0.75, 10, 8), sh.x + arm.x * 9.6, sh.y + arm.y * 9.6, sh.z, null,
      new THREE.MeshBasicMaterial({ color: '#ffcf55', toneMapped: false }));
    addPart(new THREE.BoxGeometry(1.3, 2.8, 0.5), -1.9, 18.5, -0.9);
    scene.add(grp);
    world.addBox(lx - 3.5, 31, lz - 3.5, lx + 3.5, 57, lz + 3.5);
  }

  const styleMats = Object.fromEntries(STYLES.map((s) => [s, facadeMaterial(s)]));
  for (const s of STYLES) emit(bGeos[s], styleMats[s], true);
  emit(mGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.9, emissive: '#2a2418', emissiveIntensity: 0.5 }), false);
  emit(lGeos, new THREE.MeshBasicMaterial({ vertexColors: true }), false, false, false);
  emit(dGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 }), false);
  emit(gGeos, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), false, false, true);
  const sw = sidewalkTexture();
  emit(sGeos, new THREE.MeshStandardMaterial({ map: sw.map, normalMap: sw.normal, vertexColors: true, roughness: 0.92 }), true, false, true);
  const treeCount = trees.build(scene);

  // ---------------------------------------------------------------- traffic (US: drive on the right)
  const lanes = [];
  for (let i = 0; i <= cols; i++) {
    const ax = MANHATTAN.minX + i * AVE_SP;
    const a = ax === 0 ? PARK.maxZ + 6 : MANHATTAN.minZ;
    lanes.push({ axis: 'z', c: ax - 4, a, b: MANHATTAN.maxZ, dir: 1 });
    lanes.push({ axis: 'z', c: ax + 4, a, b: MANHATTAN.maxZ, dir: -1 });
  }
  for (let j = 0; j <= rows; j++) {
    const z = MANHATTAN.minZ + j * ST_SP;
    if (z > PARK.minZ - 10 && z < PARK.maxZ + 10) continue;
    lanes.push({ axis: 'x', c: z + 3, a: MANHATTAN.minX, b: MANHATTAN.maxX, dir: 1 });
    lanes.push({ axis: 'x', c: z - 3, a: MANHATTAN.minX, b: MANHATTAN.maxX, dir: -1 });
  }
  const traffic = new Traffic(scene, lanes, rng);

  // ---------------------------------------------------------------- minimap image
  const MAPW = 1024;
  const mapInfo = { minX: -1600, minZ: -1600, w: MAPW, h: MAPW, scale: MAPW / 3200 };
  const minimap = canvas(MAPW, MAPW);
  {
    const m = minimap.getContext('2d'), s = mapInfo.scale;
    const R = (x0, z0, x1, z1, col) => {
      m.fillStyle = col;
      m.fillRect((x0 - mapInfo.minX) * s, (z0 - mapInfo.minZ) * s, (x1 - x0) * s, (z1 - z0) * s);
    };
    const P = (x, z) => [(x - mapInfo.minX) * s, (z - mapInfo.minZ) * s];
    m.fillStyle = '#163049';
    m.fillRect(0, 0, MAPW, MAPW);
    for (const l of LANDS) R(l.minX, l.minZ, l.maxX, l.maxZ, '#3a3d44');
    R(PARK.minX, PARK.minZ, PARK.maxX, PARK.maxZ, '#2e5a2b');
    R(RESERVOIR.minX, RESERVOIR.minZ, RESERVOIR.maxX, RESERVOIR.maxZ, '#1d3d55');
    R(BRIDGE.x0, BRIDGE.z - 12, BRIDGE.x1, BRIDGE.z + 12, '#7a6e62');
    for (const f of footprints) R(f.x0, f.z0, f.x1, f.z1, `hsl(215, 12%, ${30 + (Math.min(f.h, 300) / 300) * 45}%)`);
    m.strokeStyle = '#55585f';
    m.lineWidth = 16 * s;
    m.beginPath();
    BROADWAY.forEach(([x, z], i) => (i ? m.lineTo(...P(x, z)) : m.moveTo(...P(x, z))));
    m.stroke();
    m.strokeStyle = '#c0832a';
    m.lineWidth = 3;
    for (const L of METRO_LINES) {
      m.beginPath();
      if (L.axis === 'z') {
        m.moveTo(...P(L.c, L.a));
        m.lineTo(...P(L.c, L.b));
      } else {
        m.moveTo(...P(L.a, L.c));
        m.lineTo(...P(L.b, L.c));
      }
      m.stroke();
    }
  }

  function update(dt, t, focus) {
    traffic.update(dt, focus);
    if (trees.ctx) trees.update(dt);
    trains.update(dt);
    tickerTex.offset.x = (t * 0.08) % 1;
    const on = Math.floor(t * 1.2) % 2 === 0;
    for (const b of beacons) b.visible = on;
  }

  // A point on a Manhattan street between minD and maxD from (px, pz), not inside a building.
  function randomStreetPoint(px, pz, minD, maxD) {
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2, d = minD + Math.random() * (maxD - minD);
      let x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
      if (x < MANHATTAN.minX || x > MANHATTAN.maxX || z < MANHATTAN.minZ || z > MANHATTAN.maxZ) continue;
      const ax = Math.round((x - MANHATTAN.minX) / AVE_SP) * AVE_SP + MANHATTAN.minX;
      const sz = Math.round((z - MANHATTAN.minZ) / ST_SP) * ST_SP + MANHATTAN.minZ;
      if (Math.abs(x - ax) < Math.abs(z - sz)) x = ax + (Math.random() - 0.5) * 12;
      else z = sz + (Math.random() - 0.5) * 8;
      if (world.pointInside(x, 1, z)) continue;
      return { x, z };
    }
    return null;
  }

  return {
    world, minimap, mapInfo, update, randomStreetPoint, zoneName, isLand, treeCount, traffic, props: trees,
    destructible: { groups, styleMats },
    spawn: new THREE.Vector3(0, 0, -380),
  };
}
