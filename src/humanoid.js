import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Smooth, heroic-proportioned humanoid built from merged primitives.
// Each body segment is ONE mesh (vertex-colored), so a character is ~10 draw calls.
// Vertices remember which part they came from ("tag"), so costume colours and
// patterns can be repainted at any time without rebuilding geometry.
//
// Rig: root (feet) > spin (hip height, used for flips/knockdowns) > body (hip)
//   body > shoulder > elbow > hand marker;  body > hip > knee.
// Rotation conventions (local X): body -x leans forward, shoulder/hip +x swings
// the limb forward, elbow +x bends forward, knee -x bends backward.

export const SLOT = { MAIN: 0, TRIM: 1, SKIN: 2, HAIR: 3, DARK: 4, ALT: 5 };
const TAGS = ['pelvis', 'abs', 'chest', 'lat', 'delt', 'trap', 'neck', 'belt', 'head', 'face', 'hair', 'mask', 'helm',
  'crest', 'upperArm', 'bicep', 'forearm', 'cuff', 'glove', 'fist', 'thigh', 'shin', 'boot', 'bootCuff', 'foot', 'hat', 'gun'];
const LIMBS = new Set(['upperArm', 'bicep', 'forearm', 'thigh', 'shin']);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color();

const sph = (w = 16, h = 12) => new THREE.SphereGeometry(1, w, h);
const cap = (r, len, c = 4, rad = 12) => new THREE.CapsuleGeometry(r, len, c, rad);
const cyl = (rt, rb, h, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const P = (tag, geo, pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0]) => ({ tag, geo, pos, scale, rot });

function mergeParts(parts, colored) {
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    p.geo.dispose();
    g.deleteAttribute('uv');
    _m.compose(_p.fromArray(p.pos), _q.setFromEuler(_e.set(p.rot[0], p.rot[1], p.rot[2])), _s.fromArray(p.scale));
    g.applyMatrix4(_m);
    return g;
  });
  const merged = mergeGeometries(geos);
  if (colored) {
    const n = merged.attributes.position.count, tags = new Uint8Array(n);
    let o = 0;
    geos.forEach((g, i) => {
      const c = g.attributes.position.count;
      tags.fill(TAGS.indexOf(parts[i].tag), o, o + c);
      o += c;
    });
    merged.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    merged.userData.tags = tags;
  }
  for (const g of geos) g.dispose();
  return merged;
}

// ------------------------------------------------------------------ part lists
function torsoParts(kind) {
  const hero = kind === 'hero';
  const chest = hero ? [0.235, 0.2, 0.145] : [0.215, 0.19, 0.135];
  const delt = hero ? [0.095, 0.085, 0.09] : [0.085, 0.078, 0.082];
  const dx = hero ? 0.265 : 0.245;
  return [
    P('pelvis', sph(), [0, 0.03, 0], [0.165, 0.12, 0.115]),
    P('abs', cyl(0.135, 0.15, 0.3), [0, 0.2, 0], [1, 1, 0.78]),
    P('chest', sph(18, 14), [0, 0.48, -0.005], chest),
    P('lat', sph(12, 8), [-0.16, 0.46, 0.025], [0.1, 0.17, 0.1]),
    P('lat', sph(12, 8), [0.16, 0.46, 0.025], [0.1, 0.17, 0.1]),
    P('delt', sph(12, 10), [-dx, 0.6, 0], delt),
    P('delt', sph(12, 10), [dx, 0.6, 0], delt),
    P('trap', sph(12, 8), [0, 0.635, 0.03], [0.15, 0.06, 0.09]),
    P('neck', cyl(0.052, 0.062, 0.14, 10), [0, 0.74, 0.01]),
    P('belt', cyl(0.165, 0.165, 0.055, 16), [0, 0.1, 0], [1, 1, 0.78]),
  ];
}

const HEADS = {
  cowl: () => [P('head', sph(), [0, 0.9, 0.005], [0.105, 0.125, 0.115]), P('face', sph(12, 10), [0, 0.85, -0.028], [0.083, 0.072, 0.085])],
  helmet: () => [P('helm', sph(), [0, 0.905, 0.005], [0.12, 0.14, 0.13]), P('crest', box(0.03, 0.07, 0.22), [0, 1.03, 0])],
  masked: () => [
    P('face', sph(), [0, 0.9, 0.005], [0.1, 0.122, 0.112]),
    P('hair', sph(), [0, 0.955, 0.018], [0.108, 0.095, 0.118]),
    P('mask', box(0.205, 0.042, 0.09), [0, 0.912, -0.065]),
  ],
  thug: () => [P('face', sph(), [0, 0.9, 0.005], [0.1, 0.122, 0.112]), P('hat', sph(), [0, 0.96, 0.012], [0.108, 0.08, 0.118])],
};
const HEAD_GLOW = {
  cowl: () => [P('head', box(0.034, 0.012, 0.01), [-0.038, 0.915, -0.112]), P('head', box(0.034, 0.012, 0.01), [0.038, 0.915, -0.112])],
  helmet: () => [P('head', box(0.16, 0.032, 0.02), [0, 0.91, -0.128])],
  masked: () => [P('head', box(0.03, 0.01, 0.01), [-0.038, 0.912, -0.114]), P('head', box(0.03, 0.01, 0.01), [0.038, 0.912, -0.114])],
};

const upperArmParts = () => [P('upperArm', cap(0.062, 0.17), [0, -0.14, 0]), P('bicep', sph(), [0, -0.12, -0.022], [0.066, 0.095, 0.066])];
function forearmParts(kind, side) {
  const parts = [P('forearm', cap(0.05, 0.15), [0, -0.11, 0])];
  if (kind === 'hero') parts.push(P('cuff', cyl(0.068, 0.056, 0.08, 12), [0, -0.15, 0]), P('glove', cap(0.052, 0.07), [0, -0.2, 0]));
  parts.push(P('fist', sph(10, 8), [0, -0.285, -0.008], [0.05, 0.058, 0.055]));
  if (kind === 'thug' && side > 0) parts.push(P('gun', box(0.05, 0.24, 0.1), [0, -0.36, -0.03]));
  return parts;
}
const thighParts = () => [P('thigh', cap(0.085, 0.25), [0, -0.2, 0], [1, 1, 1.05])];
function shinParts(kind) {
  const hero = kind === 'hero';
  return [
    P('shin', cap(0.064, 0.22), [0, -0.18, 0]),
    ...(hero ? [P('bootCuff', cyl(0.082, 0.074, 0.05, 12), [0, -0.17, 0])] : []),
    P('boot', cap(0.07, hero ? 0.18 : 0.08), [0, hero ? -0.3 : -0.38, 0]),
    P('foot', cap(0.05, 0.12, 3, 8), [0, -0.485, -0.05], [1, 1, 1], [Math.PI / 2, 0, 0]),
  ];
}
// Energy lines along the limbs (hero only, optional)
const limbGlow = {
  forearm: () => [P('cuff', cyl(0.07, 0.07, 0.012, 12), [0, -0.112, 0])],
  thigh: (side) => [P('thigh', box(0.012, 0.28, 0.022), [side * 0.085, -0.2, 0])],
  shin: (side) => [P('shin', box(0.01, 0.2, 0.02), [side * 0.066, -0.12, 0])],
};

// Geometry is built once per kind and cloned per character.
const protoCache = new Map();
function proto(kind) {
  if (protoCache.has(kind)) return protoCache.get(kind);
  const k = kind;
  const pr = {
    torso: mergeParts(torsoParts(k), true),
    heads: {},
    upperArm: mergeParts(upperArmParts(), true),
    forearm: [-1, 1].map((s) => mergeParts(forearmParts(k, s), true)),
    thigh: mergeParts(thighParts(), true),
    shin: mergeParts(shinParts(k), true),
    glow: null,
  };
  if (k === 'hero') {
    for (const h of ['cowl', 'helmet', 'masked']) pr.heads[h] = mergeParts(HEADS[h](), true);
    pr.glow = {
      buckle: mergeParts([P('belt', box(0.07, 0.045, 0.02), [0, 0.1, -0.132])], false),
      heads: Object.fromEntries(['cowl', 'helmet', 'masked'].map((h) => [h, mergeParts(HEAD_GLOW[h](), false)])),
      forearm: mergeParts(limbGlow.forearm(), false),
      thigh: [-1, 1].map((s) => mergeParts(limbGlow.thigh(s), false)),
      shin: [-1, 1].map((s) => mergeParts(limbGlow.shin(s), false)),
    };
  } else pr.heads.thug = mergeParts(HEADS.thug(), true);
  protoCache.set(kind, pr);
  return pr;
}

// Which palette slot a vertex gets, given its part tag, position (segment space) and limb side.
function slotOf(kind, tag, x, y, z, side, look) {
  if (kind === 'hero') {
    switch (tag) {
      case 'face': return SLOT.SKIN;
      case 'hair': return SLOT.HAIR;
      case 'belt': case 'cuff': case 'glove': case 'fist': case 'boot': case 'bootCuff': case 'foot':
      case 'mask': case 'helm': case 'head': return SLOT.TRIM;
      case 'pelvis': return look.pattern === 'classic' || look.pattern === 'split' ? SLOT.TRIM : SLOT.MAIN;
    }
    const p = look.pattern;
    if (p === 'panels') {
      if ((tag === 'chest' || tag === 'abs' || tag === 'lat') && Math.abs(x) > 0.13) return SLOT.TRIM;
      if (LIMBS.has(tag) && x * side > 0.03) return SLOT.TRIM;
    }
    if (p === 'chevron' && (tag === 'chest' || tag === 'delt' || tag === 'trap' || tag === 'lat') && y > 0.47 + Math.abs(x) * 0.55) return SLOT.TRIM;
    if (p === 'split' && (tag === 'thigh' || tag === 'shin')) return SLOT.TRIM;
    return SLOT.MAIN;
  }
  // Thugs: MAIN jacket, TRIM pants, SKIN, HAIR hat, DARK shoes/gun, ALT shirt
  const brute = kind === 'brute';
  switch (tag) {
    case 'face': case 'neck': case 'fist': return SLOT.SKIN;
    case 'hat': return brute ? SLOT.SKIN : SLOT.HAIR;
    case 'gun': case 'boot': case 'foot': case 'belt': return SLOT.DARK;
    case 'pelvis': case 'thigh': case 'shin': return SLOT.TRIM;
    case 'upperArm': case 'bicep': case 'forearm': case 'delt': return brute ? SLOT.SKIN : SLOT.MAIN;
    case 'chest': case 'abs':
      if (brute) return SLOT.ALT;
      return z < -0.06 && Math.abs(x) < 0.05 ? SLOT.ALT : SLOT.MAIN;
  }
  return brute ? SLOT.ALT : SLOT.MAIN;
}

function paintMesh(mesh, kind, palette, look) {
  const g = mesh.geometry, tags = g.userData.tags, pos = g.attributes.position, col = g.attributes.color;
  const side = mesh.userData.side || 0;
  for (let i = 0; i < tags.length; i++) {
    const c = palette[slotOf(kind, TAGS[tags[i]], pos.getX(i), pos.getY(i), pos.getZ(i), side, look)];
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

export function createHumanoid(kind) {
  const pr = proto(kind);
  const hero = kind === 'hero';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: hero ? 0.38 : 0.75, metalness: hero ? 0.2 : 0.05, emissive: 0xffffff, emissiveIntensity: 0,
  });
  const glowMat = hero ? new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.5 }) : null;
  const rig = { kind, material, glowMat, meshes: [], lines: [], heads: {}, arms: [], legs: [] };
  const add = (geo, parent, side = 0, mat = material) => {
    const m = new THREE.Mesh(mat === material ? geo.clone() : geo, mat);
    m.castShadow = true;
    m.userData.side = side;
    parent.add(m);
    if (mat === material) rig.meshes.push(m);
    return m;
  };

  rig.root = new THREE.Group();
  rig.spin = new THREE.Group();
  rig.spin.position.y = 1.0;
  rig.root.add(rig.spin);
  rig.body = new THREE.Group();
  rig.spin.add(rig.body);
  add(pr.torso, rig.body);
  if (hero) add(pr.glow.buckle, rig.body, 0, glowMat);
  for (const [name, geo] of Object.entries(pr.heads)) {
    const g = new THREE.Group();
    add(geo, g);
    if (hero) add(pr.glow.heads[name], g, 0, glowMat);
    rig.body.add(g);
    rig.heads[name] = g;
  }
  [-1, 1].forEach((side, i) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (hero ? 0.3 : 0.28), 0.6, 0);
    rig.body.add(shoulder);
    add(pr.upperArm, shoulder, side);
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    add(pr.forearm[i], elbow, side);
    const hand = new THREE.Object3D();
    hand.position.y = -0.3;
    elbow.add(hand);
    rig.arms.push({ shoulder, elbow, hand });

    const hip = new THREE.Group();
    hip.position.set(side * 0.1, -0.02, 0);
    rig.body.add(hip);
    add(pr.thigh, hip, side);
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    add(pr.shin, knee, side);
    rig.legs.push({ hip, knee });
    if (hero) {
      rig.lines.push(add(pr.glow.forearm, elbow, side, glowMat), add(pr.glow.thigh[i], hip, side, glowMat), add(pr.glow.shin[i], knee, side, glowMat));
    }
  });

  rig.paint = (colors, look = {}) => {
    const palette = colors.map((c) => new THREE.Color(c));
    for (const m of rig.meshes) paintMesh(m, kind, palette, look);
  };
  // Same interface as the glTF ModelRig (models.js); the procedural rig has no clips, so the
  // locomotion argument is ignored and callers include stride poses themselves.
  rig.hipY = 1.0;
  rig.chest = { y: 0.5, z: -0.154 };
  rig.capeAnchor = { y: 0.67, z: 0.15 };
  rig.procedural = true;
  rig.pose = (p, k) => applyPose(rig, p, k);
  return rig;
}

// Smoothly drive the rig toward a pose. Missing fields default to a relaxed stance.
export function applyPose(rig, p, k) {
  const L = (o, prop, v) => (o[prop] += (v - o[prop]) * k);
  L(rig.body.rotation, 'x', p.tilt ?? 0);
  const [al, ar] = rig.arms, [ll, lr] = rig.legs;
  L(al.shoulder.rotation, 'x', p.sL ?? 0);
  L(ar.shoulder.rotation, 'x', p.sR ?? 0);
  L(al.elbow.rotation, 'x', p.eL ?? 0.15);
  L(ar.elbow.rotation, 'x', p.eR ?? 0.15);
  L(ll.hip.rotation, 'x', p.hL ?? 0);
  L(lr.hip.rotation, 'x', p.hR ?? 0);
  L(ll.knee.rotation, 'x', p.kL ?? -0.05);
  L(lr.knee.rotation, 'x', p.kR ?? -0.05);
  const spread = p.spread ?? 0.12;
  L(al.shoulder.rotation, 'z', -spread);
  L(ar.shoulder.rotation, 'z', spread);
}

// Shared walk/run cycle for any rig: returns pose fields for a stride phase.
export function stride(phase, amp, armBend = 0.5) {
  const sw = Math.sin(phase);
  return {
    hL: sw * amp,
    hR: -sw * amp,
    kL: -(0.1 + Math.max(0, -sw) * amp * 1.3),
    kR: -(0.1 + Math.max(0, sw) * amp * 1.3),
    sL: -sw * amp * 0.8,
    sR: sw * amp * 0.8,
    eL: armBend,
    eR: armBend,
  };
}
