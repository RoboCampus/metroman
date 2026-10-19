# Metro Guardian

Browser superhero game set in New York. Three.js loaded from a CDN, no build step.

```
npm start        # http://localhost:5173
```

Open `http://localhost:5173/?debug` to expose `window.game` (and `game.step(n)` to advance frames) for testing.

## Combat (modeled on DCUO's action combat)
- LMB tap/hold = strike / lunging Interrupt · RMB tap/hold = blast / Block Breaker · hold L-Ctrl = Block (+ direction = dodge)
- Counter triangle: Block Breaker beats Block, Interrupt beats Block Breaker, Block beats Interrupt
- Enemy tells: red glow = lunge (block it), orange glow = breaker (interrupt it), blue shield = blocking (break it)
- Combos: tap×3, tap-tap-hold, ranged tap-tap-hold, tap-tap-ranged hold · hit counter boosts power regen
- Power interactions: fire attacks set Burning (Meteor/Supernova +60%), electric attacks set Charged (Thunderclap/Wrath +60%)

## Character models
Characters are rigged glTF/GLB models configured in `MODEL_CONFIG` at the top of `src/models.js`.
Walk/run/idle come from the model's animation clips; combat poses (punches, flight, blocking,
aiming, knockdowns) are layered on top by aiming the arm and leg bones, so any model works with
the existing combat.

To use your own character:
1. Get a rigged model with a Mixamo skeleton (e.g. upload your model to mixamo.com to auto-rig it,
   then download it with its Idle / Walk / Run animations) and convert/export it as `.glb`.
2. Put it in `assets/` and point `url` at it (e.g. `'assets/hero.glb'`).
3. Set `clips` to the animation names in the file, `yaw` so it faces -Z (Mixamo exports need `Math.PI`),
   and `tint` to map mesh names to the `suit` / `trim` colour slots used by the character creator.

If a model fails to load, the built-in procedural characters (`src/humanoid.js`) are used instead.
The placeholders (X Bot, Soldier) are Mixamo characters from the three.js examples. Get your own
from Mixamo or use CC0 models before publishing the game.

## Layout
- `src/city.js` – procedural NYC: Manhattan grid, Central Park, Times Square, Empire State, Chrysler, One WTC, Statue of Liberty, Brooklyn Bridge, Brooklyn/Jersey City, traffic, minimap
- `src/models.js` – glTF character loading, model rig (animation clips + procedural pose layering), fallback
- `src/citytex.js` – procedural textures: weathered facades with normal maps, streets, Broadway, signs
- `src/trees.js` – detailed tree variants, instanced per map tile
- `src/metro.js` – elevated subway lines, stations and moving trains
- `src/impacts.js` – craters, scorch marks, shattered windows and falling glass (pooled, fading decals)
- `src/humanoid.js` – shared character builder (heroic proportions, one mesh per body segment, repaintable colour patterns) used by the hero and enemies
- `src/vehicles.js` – instanced low-poly cars (sedan, taxi, SUV) with glowing lights; traffic recycles around the player
- `src/combat.js` – tap/hold input, combos, melee, hit counter, hit-stop
- `src/player.js` – hero model & customizable look, flight & super-speed movement (wall-running, double jump, dodge), block/knockdown/breakout, third-person camera
- `src/powers.js` – Fire and Electricity power sets (basic, channel, 2 abilities, supercharge)
- `src/enemies.js` – street thugs and drones: spawning, AI, bullets, damage API
- `src/collision.js` – AABB hash-grid world: cylinder collision, raycasts
- `src/fx.js` – particles, lightning ribbons, shockwave rings, light flashes
- `src/hud.js`, `src/input.js`, `src/main.js`
