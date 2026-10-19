import * as THREE from 'three';
import { Input } from './input.js';
import { buildCity } from './city.js';
import { Player } from './player.js';
import { Enemies } from './enemies.js';
import { FX, BlobShadows } from './fx.js';
import { HUD } from './hud.js';
import { createPowerSet } from './powers.js';
import { Combat } from './combat.js';
import { loadModels } from './models.js';
import { Impacts } from './impacts.js';
import { Destruction } from './destruction.js';
import { DEFAULT_LOOK, PRESETS } from './player.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- renderer & scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#b98577', 300, 2600);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.5, 6000);
const sunDir = new THREE.Vector3(-0.75, 0.62, 0.3).normalize(); // ~35° high: streets get sun, characters cast visible shadows

function makeSky(radius) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color('#0f1a3d') },
        mid: { value: new THREE.Color('#5a4a7a') },
        horizon: { value: new THREE.Color('#f08a5d') },
        sunDir: { value: sunDir },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top, mid, horizon, sunDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0
            ? mix(mix(horizon, mid, smoothstep(0.0, 0.25, h)), top, smoothstep(0.2, 0.8, h))
            : mix(horizon, vec3(0.08, 0.08, 0.12), smoothstep(0.0, -0.2, h));
          float s = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.6, 0.3) * pow(s, 400.0) * 4.0 + vec3(1.0, 0.5, 0.25) * pow(s, 8.0) * 0.35;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
}
const sky = makeSky(4500);
scene.add(sky);
{
  // Image-based lighting from the sky so metal and glass have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(makeSky(400));
  scene.environment = pmrem.fromScene(envScene, 0.02, 1, 1000).texture;
}

scene.add(new THREE.HemisphereLight('#a8b8ff', '#5a4a48', 1.1)); // fills the street canyons that stay in building shade
const sun = new THREE.DirectionalLight('#ffb37a', 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 1, far: 600 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- post-processing & quality
// High: bloom (glowing windows, crowns, headlights, powers) + shadows. Low: neither, 1x pixels.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.55, 0.45, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const QUALITY_KEY = 'metroGuardian.quality';
let quality = 'high';
try {
  quality = localStorage.getItem(QUALITY_KEY) || 'high';
} catch {
  /* storage unavailable */
}
function applyQuality(q) {
  quality = q;
  const ratio = q === 'high' ? Math.min(devicePixelRatio, 1.5) : 1;
  renderer.setPixelRatio(ratio);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(ratio);
  composer.setSize(innerWidth, innerHeight);
  sun.castShadow = q === 'high';
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* storage unavailable */
  }
}
applyQuality(quality);

// ---------------------------------------------------------------- game objects
const input = new Input(renderer.domElement);
const city = buildCity(scene);
const fx = new FX(scene, camera);
const hud = new HUD(city);
const ctx = { scene, camera, input, city, world: city.world, fx, hud };
// Character models (models.js). If they can't load, the procedural characters are used instead.
document.getElementById('loading').textContent = 'Loading characters…';
const loaded = await loadModels();
ctx.useModels = quality === 'high'; // Low graphics keeps enemies on the cheaper procedural rig
ctx.player = new Player(ctx);
ctx.enemies = new Enemies(ctx);
ctx.combat = new Combat(ctx);
ctx.traffic = city.traffic; // cars can be pushed, damaged and blown up
city.traffic.bind(ctx);
ctx.props = city.props; // trees, benches & street furniture can be smashed
city.props.bind(ctx);
const blobs = new BlobShadows(scene);
ctx.impacts = new Impacts(ctx); // craters, scorch marks, shattered windows
ctx.destruction = new Destruction(ctx, city.destructible); // breakable buildings
const { player, enemies, combat } = ctx;
let powers = null;
ctx.getPowers = () => powers;
if (new URLSearchParams(location.search).has('debug')) window.game = ctx; // console access for testing

const aim = { origin: new THREE.Vector3(), dir: new THREE.Vector3(), point: new THREE.Vector3(), target: null };
const _tmp = new THREE.Vector3();
// Crosshair ray with light aim assist. Returns a shared object.
ctx.getAim = (range = 160, assistDeg = 6) => {
  camera.getWorldPosition(aim.origin);
  camera.getWorldDirection(aim.dir);
  const reach = range + player.curDist;
  const t = city.world.raycastHit(aim.origin, aim.dir, reach);
  aim.normal = t < reach ? city.world.hitNormal : null; // surface under the crosshair
  aim.point.copy(aim.origin).addScaledVector(aim.dir, t);
  aim.target = enemies.findTarget(aim.origin, aim.dir, reach, Math.cos(THREE.MathUtils.degToRad(assistDeg)));
  if (aim.target) {
    const c = enemies.center(aim.target, _tmp);
    if (c.distanceTo(aim.origin) <= t + 3) {
      aim.point.copy(c);
      aim.normal = null;
    } else aim.target = null;
  }
  return aim;
};

function setPower(type) {
  if (powers) powers.dispose();
  powers = createPowerSet(ctx, type);
  player.setTheme(type);
  const [melee, ranged, block] = combat.slots;
  Object.assign(ranged, powers.rangedInfo);
  hud.setAbilities([melee, ranged, block, ...powers.abilities]);
}

function setMovement(m) {
  player.setMovement(m);
  hud.setMode(m);
}

// ---------------------------------------------------------------- menu: powers & character creator
const LOOK_KEY = 'metroGuardian.look';
function loadLook() {
  try {
    return { ...DEFAULT_LOOK, ...JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_LOOK };
  }
}
function saveLook() {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    /* storage unavailable: look just won't persist */
  }
}
const look = loadLook();
let customColors = !!look.customColors;

function renderLook() {
  player.applyLook(look);
  hud.setName(look.name || 'Guardian');
  for (const chips of document.querySelectorAll('.chips[data-look]')) {
    for (const b of chips.children) b.classList.toggle('sel', b.dataset.value === String(look[chips.dataset.look]));
  }
  for (const input of document.querySelectorAll('[data-color]')) input.value = look[input.dataset.color];
  saveLook();
}

const choice = { movement: 'flight', power: 'fire' };
for (const group of document.querySelectorAll('.cards')) {
  group.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    for (const c of group.children) c.classList.toggle('sel', c === card);
    choice[group.dataset.group] = card.dataset.value;
    // Picking a power applies its color preset unless the player chose their own colors.
    if (group.dataset.group === 'power' && !customColors) {
      Object.assign(look, PRESETS[card.dataset.value]);
      renderLook();
    }
  });
}
for (const chips of document.querySelectorAll('.chips[data-look]')) {
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = chips.dataset.look;
    look[key] = b.dataset.value === 'true' ? true : b.dataset.value === 'false' ? false : b.dataset.value;
    renderLook();
  });
}
const qualityChips = document.querySelector('.chips[data-setting="quality"]');
const renderQuality = () => { for (const b of qualityChips.children) b.classList.toggle('sel', b.dataset.value === quality); };
qualityChips.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  applyQuality(b.dataset.value);
  ctx.useModels = quality === 'high';
  renderQuality();
});
renderQuality();
for (const input of document.querySelectorAll('[data-color]')) {
  input.addEventListener('input', () => {
    look[input.dataset.color] = input.value;
    look.customColors = customColors = true;
    renderLook();
  });
}
const nameInput = document.getElementById('lookName');
nameInput.value = look.name;
nameInput.addEventListener('input', () => {
  look.name = nameInput.value.trim() || 'Guardian';
  renderLook();
});
renderLook();
document.getElementById('play').disabled = false;
document.getElementById('loading').textContent = loaded.hero ? 'Ready.' : 'Ready (character models unavailable, using built-in characters).';

let started = false, paused = true;
document.getElementById('play').addEventListener('click', () => {
  setPower(choice.power);
  setMovement(choice.movement);
  document.getElementById('menu').classList.add('hidden');
  hud.show(true);
  started = true;
  paused = false;
  input.active = true;
  input.enterFullscreen();
  input.lock();
  hud.message('PROTECT NEW YORK', 2.5);
});
const pauseEl = document.getElementById('pause');
pauseEl.addEventListener('click', () => {
  input.enterFullscreen();
  input.lock();
});
// Outside fullscreen Ctrl+W can't be blocked; at least ask before the tab closes.
addEventListener('beforeunload', (e) => {
  if (started) e.preventDefault();
});
document.addEventListener('pointerlockchange', () => {
  if (!started) return;
  paused = !input.locked;
  pauseEl.classList.toggle('hidden', !paused);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let elapsed = 0;

const _look = new THREE.Vector3(), _right = new THREE.Vector3();

function frame() {
  requestAnimationFrame(frame);
  const realDt = Math.min(clock.getDelta(), 0.05);
  // Hit-stop: a few frames of near-freeze on heavy impacts
  const dt = combat.hitstopT > 0 ? realDt * 0.08 : realDt;
  combat.hitstopT -= realDt;
  if (!started) {
    // Menu: slow orbit around the hero, framed to the right of the creator panel
    elapsed += dt;
    const a = Math.PI + Math.sin(elapsed * 0.3) * 0.6;
    camera.position.set(player.pos.x + Math.sin(a) * 4.2, player.pos.y + 1.7, player.pos.z + Math.cos(a) * 4.2);
    _look.set(player.pos.x, player.pos.y + 1.1, player.pos.z);
    _right.subVectors(_look, camera.position).cross(THREE.Object3D.DEFAULT_UP).normalize();
    if (innerWidth > 900) _look.addScaledVector(_right, -1.6);
    camera.lookAt(_look);
    player.facing = 0;
    player.animate(dt);
    sun.position.copy(player.pos).addScaledVector(sunDir, 300);
    sun.target.position.copy(player.pos);
    city.update(dt, elapsed, player.pos);
    fx.update(dt, renderer.domElement.height);
  } else if (!paused) tick(dt);
  sky.position.copy(camera.position);
  if (quality === 'high') composer.render();
  else renderer.render(scene, camera);
  input.endFrame();
}

// Soft contact shadows under the hero and every enemy, on whatever surface is below them.
function updateBlobShadows() {
  const w = city.world;
  blobs.begin();
  if (!player.dead) {
    const gy = w.groundY(player.pos.x, player.pos.z, player.pos.y + 0.5);
    blobs.add(player.pos.x, gy, player.pos.z, 0.7, player.pos.y - gy);
  }
  for (const e of enemies.list) {
    if (e.dead && e.deathT < 0.5) continue;
    const drone = e.type === 'drone', top = e.pos.y + (drone ? -0.3 : 0.5);
    const gy = w.groundY(e.pos.x, e.pos.z, top);
    blobs.add(e.pos.x, gy, e.pos.z, drone ? 0.9 : 0.68 * (e.stats.scale || 1), e.pos.y - gy - (drone ? 0.6 : 0), drone ? 0.5 : 0.75);
  }
  blobs.end();
}

function tick(dt) {
  elapsed += dt;
  if (input.hit('KeyT')) {
    setMovement(player.movement === 'flight' ? 'speed' : 'flight');
    hud.message(player.movement === 'flight' ? 'FLIGHT' : 'SUPER SPEED', 1);
  }
  if (input.hit('KeyG')) {
    setPower(player.theme === 'fire' ? 'electric' : 'fire');
    hud.message(player.theme === 'fire' ? 'FIRE' : 'ELECTRICITY', 1);
  }
  combat.update(dt);
  player.update(dt);
  powers.update(dt);
  enemies.update(dt);
  city.update(dt, elapsed, player.pos);
  ctx.impacts.update(dt);
  ctx.destruction.update(dt);
  updateBlobShadows();
  fx.update(dt, renderer.domElement.height);
  sun.position.copy(player.pos).addScaledVector(sunDir, 300);
  sun.target.position.copy(player.pos);
  hud.update(dt, ctx, powers);
}
frame();
// Debug: advance the simulation n fixed frames without rendering (works in throttled tabs).
ctx.step = (n = 1, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) {
    tick(dt);
    input.endFrame();
  }
};
