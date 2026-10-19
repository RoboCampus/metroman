import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createHumanoid } from './humanoid.js';

// ---------------------------------------------------------------------------------------------
// Character models. Swap these for your own rigged glTF/GLB files (any Mixamo-rigged character
// works as-is; other skeletons just need the BONES names below adjusted).
//   url     – .glb file (local path like 'assets/hero.glb' or a URL)
//   height  – metres the character is scaled to
//   yaw     – rotation so the model faces -Z (Mixamo exports face +Z: use Math.PI)
//   clips   – which animation in the file to use for idle / walk / run
//   refSpeed – ground speed (m/s) at which the walk / run clips look right at 1x
//   tint    – mesh name -> costume slot ('suit' | 'trim'); textured meshes are tinted, not replaced
// Placeholders: Mixamo characters from the three.js examples, loaded from the jsDelivr CDN.
// ---------------------------------------------------------------------------------------------
const THREE_MODELS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/';
export const MODEL_CONFIG = {
  hero: {
    url: THREE_MODELS + 'Xbot.glb', height: 1.95, yaw: Math.PI,
    clips: { idle: 'idle', walk: 'walk', run: 'run' }, refSpeed: { walk: 1.6, run: 5.5 },
    tint: { Beta_Surface: 'suit', Beta_Joints: 'trim' },
  },
  thug: {
    url: THREE_MODELS + 'Soldier.glb', height: 1.85, yaw: 0,
    clips: { idle: 'Idle', walk: 'Walk', run: 'Run' }, refSpeed: { walk: 1.5, run: 5 },
    tint: { vanguard_Mesh: 'suit' },
  },
};
const BONES = {
  hips: 'Hips', spine: 'Spine2',
  arm: ['LeftArm', 'RightArm'], fore: ['LeftForeArm', 'RightForeArm'], hand: ['LeftHand', 'RightHand'],
  up: ['LeftUpLeg', 'RightUpLeg'], leg: ['LeftLeg', 'RightLeg'], foot: ['LeftFoot', 'RightFoot'],
};

const assets = {};
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

function findBone(root, key) {
  let found = null;
  root.traverse((o) => {
    if (!found && o.isBone && (o.name === key || o.name.endsWith(key))) found = o;
  });
  return found;
}

// Measure a freshly loaded model in its bind pose: hip height, total height, chest depth.
function measure(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const y = (k) => findBone(scene, k)?.getWorldPosition(_v).y;
  let foot = Infinity, top = -Infinity;
  scene.traverse((o) => {
    if (!o.isBone) return;
    const p = o.getWorldPosition(_v);
    foot = Math.min(foot, p.y);
    top = Math.max(top, p.y);
  });
  const hipY = y(BONES.hips), chestY = y(BONES.spine);
  const head = findBone(scene, 'Head').getWorldPosition(new THREE.Vector3());
  top = Math.max(top, head.y + 0.12);
  // Torso depth at chest height, from the bind-pose vertices near the centre line.
  let zMin = Infinity, zMax = -Infinity;
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      _w.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(_w.y - chestY) < 0.06 && Math.abs(_w.x) < 0.07) {
        zMin = Math.min(zMin, _w.z);
        zMax = Math.max(zMax, _w.z);
      }
    }
  });
  if (!isFinite(zMin)) zMin = -0.12, zMax = 0.12;
  return { hipY: hipY - foot, chestY: chestY - foot, height: top - foot, footY: foot, zMin, zMax };
}

// Load every configured model. Resolves to { hero: bool, thug: bool }; failures fall back to
// the procedural characters, so the game still runs offline.
export async function loadModels(timeoutMs = 20000) {
  const loader = new GLTFLoader();
  const result = {};
  await Promise.all(Object.entries(MODEL_CONFIG).map(async ([kind, cfg]) => {
    try {
      const gltf = await Promise.race([
        loader.loadAsync(cfg.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      assets[kind] = { gltf, info: measure(gltf) };
      result[kind] = true;
    } catch (err) {
      console.warn(`Model "${kind}" failed to load, using procedural character:`, err.message);
      result[kind] = false;
    }
  }));
  return result;
}

export const hasModel = (kind) => !!assets[kind];

// A rig for either kind of character. Both expose the same interface:
//   root, spin, body, hipY, arms[i].hand, chest {y,z}, capeAnchor {y,z},
//   pose(p, k, dt, loco), paint(colors, look), material (emissive flash), heads, lines
export function createRig(kind, { preferModel = true } = {}) {
  const modelKind = kind === 'brute' ? 'thug' : kind;
  if (preferModel && assets[modelKind]) return new ModelRig(assets[modelKind], MODEL_CONFIG[modelKind]);
  return createHumanoid(kind);
}

const POSE_DEFAULTS = { tilt: 0, sL: 0, sR: 0, eL: 0.15, eR: 0.15, hL: 0, hR: 0, kL: -0.05, kR: -0.05, spread: 0.12 };
const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1), DOWN = new THREE.Vector3(0, -1, 0);
const IDENTITY = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _from = new THREE.Vector3(), _to = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _dir = new THREE.Vector3(); // aim() target; kept separate from aim()'s scratch vectors
const _bodyQ = new THREE.Quaternion(), _qx = new THREE.Quaternion(), _qz = new THREE.Quaternion();

// Skinned glTF character. Animation clips drive locomotion; the game's procedural poses
// (attacks, blocking, flight, aiming, knockdowns) are layered on top by aiming limb bones.
class ModelRig {
  constructor(asset, cfg) {
    const { gltf, info } = asset;
    const model = SkeletonUtils.clone(gltf.scene);
    const s = cfg.height / info.height;
    this.hipY = info.hipY * s;
    this.root = new THREE.Group();
    this.spin = new THREE.Group();
    this.spin.position.y = this.hipY;
    this.root.add(this.spin);
    this.body = new THREE.Group();
    this.spin.add(this.body);
    model.scale.setScalar(s);
    model.rotation.y = cfg.yaw;
    model.position.y = -(info.footY * s) - this.hipY;
    this.body.add(model);
    // After the yaw the chest front is toward -Z; express torso depth in body space.
    const flip = Math.abs(cfg.yaw) > 1;
    const front = (flip ? info.zMax : -info.zMin) * s, back = (flip ? -info.zMin : info.zMax) * s;
    this.chest = { y: (info.chestY - info.hipY) * s, z: -front - 0.04 };
    this.capeAnchor = { y: (info.chestY - info.hipY) * s + 0.14, z: back + 0.02 };

    this.mats = [];
    this.tinted = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow animation
      this.mats.push(o.material);
      const slot = cfg.tint[o.name];
      if (slot) this.tinted.push({ mat: o.material, slot, textured: !!o.material.map });
    });
    // Same surface as a plain material, so enemy hit-flash code works unchanged.
    const mats = this.mats;
    this.material = {
      emissive: { setHex: (h) => mats.forEach((m) => m.emissive.setHex(h)) },
      set emissiveIntensity(v) { mats.forEach((m) => (m.emissiveIntensity = v)); },
      get emissiveIntensity() { return mats[0].emissiveIntensity; },
      dispose: () => mats.forEach((m) => m.dispose()),
    };

    const b = (k) => findBone(model, k);
    this.bones = {
      arm: BONES.arm.map(b), fore: BONES.fore.map(b), hand: BONES.hand.map(b),
      up: BONES.up.map(b), leg: BONES.leg.map(b), foot: BONES.foot.map(b),
    };
    this.arms = this.bones.hand.map((hand) => ({ hand }));
    this.heads = {};
    this.lines = [];

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    this.refSpeed = cfg.refSpeed;
    for (const [key, name] of Object.entries(cfg.clips)) {
      const clip = gltf.animations.find((a) => a.name === name);
      if (clip) this.actions[key] = this.mixer.clipAction(clip);
    }
    this.current = null;
    this.play('idle', 1);
    this.ps = { ...POSE_DEFAULTS };
    this.w = { armL: 0, armR: 0, legs: 0 };
  }

  play(key, timeScale) {
    const a = this.actions[key] || this.actions.idle;
    if (!a) return;
    if (this.current !== a) {
      a.reset().fadeIn(0.2).play();
      if (this.current) this.current.fadeOut(0.2);
      this.current = a;
    }
    a.timeScale = timeScale;
  }

  // colors: [main/suit, trim, skin, hair, dark, alt]. look.glow / look.lines light up the trim.
  paint(colors, look = {}) {
    for (const t of this.tinted) {
      const c = new THREE.Color(t.slot === 'trim' ? colors[1] : colors[0]);
      // Keep texture detail visible: tint toward the colour instead of replacing it.
      t.mat.color.copy(t.textured ? new THREE.Color(1, 1, 1).lerp(c, 0.65) : c);
      t.mat.roughness = 0.35;
      t.mat.metalness = 0.25;
      if (t.slot === 'trim' && look.glow) {
        t.mat.emissive.set(look.glow);
        t.mat.emissiveIntensity = look.lines === false ? 0 : 0.6;
      }
    }
  }

  // loco: { clip: 'idle'|'walk'|'run', speed, mask } → animation clip drives the body;
  //   mask 'armR' / 'arms' still lets the pose control those limbs (e.g. aiming while running).
  // loco null → the procedural pose drives all limbs over the idle clip.
  pose(p, k, dt, loco) {
    const ps = this.ps;
    for (const key in POSE_DEFAULTS) ps[key] += ((p[key] ?? POSE_DEFAULTS[key]) - ps[key]) * k;
    const mask = loco ? loco.mask : 'all';
    const kw = 1 - Math.exp(-12 * dt);
    const target = {
      armL: mask === 'all' || mask === 'arms' ? 1 : 0,
      armR: mask === 'all' || mask === 'arms' || mask === 'armR' ? 1 : 0,
      legs: mask === 'all' ? 1 : 0,
    };
    for (const c in target) this.w[c] += (target[c] - this.w[c]) * (dt > 0 ? kw : 1);
    this.body.rotation.x = ps.tilt;

    if (loco && loco.clip !== 'idle') {
      const ref = this.refSpeed[loco.clip] || 1;
      this.play(loco.clip, THREE.MathUtils.clamp(loco.speed / ref, 0.5, 3));
    } else this.play('idle', 1);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    this.body.getWorldQuaternion(_bodyQ);

    const B = this.bones;
    [this.w.armL, this.w.armR].forEach((w, i) => {
      if (w < 0.01 || !B.arm[i]) return;
      const side = i === 0 ? -1 : 1;
      const s = i === 0 ? ps.sL : ps.sR, e = i === 0 ? ps.eL : ps.eR;
      _qx.setFromAxisAngle(X, s);
      _qz.setFromAxisAngle(Z, side * ps.spread);
      _q2.multiplyQuaternions(_qx, _qz);
      this.aim(B.arm[i], B.fore[i], _dir.copy(DOWN).applyQuaternion(_q2), w);
      _q2.multiply(_qx.setFromAxisAngle(X, e));
      this.aim(B.fore[i], B.hand[i], _dir.copy(DOWN).applyQuaternion(_q2), w);
    });
    if (this.w.legs > 0.01) {
      for (let i = 0; i < 2; i++) {
        if (!B.up[i]) continue;
        const h = i === 0 ? ps.hL : ps.hR, kn = i === 0 ? ps.kL : ps.kR;
        this.aim(B.up[i], B.leg[i], _dir.copy(DOWN).applyAxisAngle(X, h), this.w.legs);
        this.aim(B.leg[i], B.foot[i], _dir.copy(DOWN).applyAxisAngle(X, h + kn), this.w.legs);
      }
    }
  }

  // Rotate `bone` so the bone->child direction points along dirBody (body space), blended by w.
  aim(bone, child, dirBody, w) {
    bone.getWorldPosition(_a);
    child.getWorldPosition(_b);
    _from.subVectors(_b, _a).normalize();
    _to.copy(dirBody).applyQuaternion(_bodyQ).normalize();
    _q.setFromUnitVectors(_from, _to);
    if (w < 1) _q.slerp(IDENTITY, 1 - w);
    bone.getWorldQuaternion(_wq).premultiply(_q);
    bone.parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq.multiply(_wq));
    bone.updateMatrixWorld(true);
  }
}
