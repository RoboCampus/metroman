import * as THREE from 'three';

// Pocket squids: the Watcher's cleaners. Five of them patrol high up inside his pocket dimension
// (pocket.js), sweeping a scanning cone of light over the ruins, looking for anything alive to get
// rid of.
//   - Get caught in a cone (with nothing in between) and it turns its arms toward you, cups them
//     around a growing ball of energy, then fires a huge beam that follows you. The beam ignores
//     blocking and kills in about 2 seconds.
//   - The only ways out: put a building between you and it (only for a moment: the beam blasts
//     through it, and a ruin cut through comes down - see pocket.js topple), or
//     get right up close - it can't turn fast enough to track something circling its head.
//   - Lose it for a few seconds and it goes back to patrolling.
// Like the other strong enemies it lives in enemies.list (every attack hurts it) with its own
// update; the pocket swaps that list in while you're inside.

const HP = 1400;
const MOVE = { speed: 26, height: [300, 750], margin: 240, hover: 2 }; // patrol speed (m/s), waypoint heights above the floor
const SCAN = { range: 780, cone: 0.42, sweep: 1.1, speed: 0.7, pitch: 0.6 }; // cone: half-angle (rad); the cone sweeps side to side
const BEAM = {
  charge: 1.6, fire: 2.4, cooldown: 2.2, lose: 3, // seconds
  r: 4.5, dps: 170, range: 2700,
  track: [1.6, 0.55], // how fast it turns to follow you while charging / firing (rad/s, at range)
  close: 140, // closer than this its aim can't keep up: the turn rate falls off with distance
  carve: [0.8, 0.3], carveR: 6, // where the beam hits a building it blasts a hole after carve[0] s, then every carve[1] s
  // (the ruins are hollow: two holes and it's through, so cover holds for about a second)
};
const ARMS = { n: 8, segs: 10, seg: 1.6, ring: 2.2, at: -3.5 };
const TENTACLES = { segs: 14, seg: 2 };
const BALL = new THREE.Vector3(0, 0, -17); // where the energy ball forms, between the arm tips (local)
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const ZERO = new THREE.Vector3();

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0);
const coneGeo = (() => {
  const h = SCAN.range, r = Math.tan(SCAN.cone) * h;
  return new THREE.ConeGeometry(r, h, 40, 1, true).translate(0, -h / 2, 0); // apex at the origin, opening along -Y
})();

export class Squid {
  constructor(ctx, pocket, at) {
    this.ctx = ctx;
    this.pocket = pocket;
    this.bodyMat = new THREE.MeshStandardMaterial({ color: '#5b3f7a', roughness: 0.45, metalness: 0.15, emissive: '#ffffff', emissiveIntensity: 0 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 2.4), toneMapped: false });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2, 3), toneMapped: false });
    const root = this.build();
    const e = ctx.enemies.base('squid', root, at.clone(), this.bodyMat);
    e.boss = this;
    e.noBar = true;
    e.mapColor = '#c070ff';
    e.scoreValue = 20;
    this.e = e;
    this.root = root;
    pocket.group.add(root); // (hidden with the rest of the pocket while you're away)
    // Scanning cone, energy ball, beam
    const add = (o) => (pocket.group.add(o), o);
    this.cone = add(new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.5, 1, 1.6), transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    })));
    this.ball = add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 3, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })));
    this.beam = add(new THREE.Group());
    this.beamCore = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.8, 2.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beamGlow = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.8, 2), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beam.add(this.beamCore, this.beamGlow);
    this.ball.visible = this.beam.visible = false;

    this.vel = new THREE.Vector3();
    this.aim = new THREE.Vector3(0, 0, -1); // where the arms point while attacking
    this.face = new THREE.Vector3(0, 0, 1); // where the mantle points
    this.scanDir = new THREE.Vector3(0, -1, 0);
    this.lastSeen = new THREE.Vector3();
    this.waypoint = new THREE.Vector3();
    this.pickWaypoint();
    this.state = 'patrol';
    this.stateT = 0;
    this.t = Math.random() * 100;
    this.lostT = 0;
    this.carveT = 0;
    this.pose = { spread: 0.12, curl: 0, wave: 0.12 }; // arm pose, eased toward the state's
  }

  // ---------------------------------------------------------------- model (metres; arms along -Z)
  build() {
    const root = new THREE.Group(), mat = this.bodyMat;
    const add = (geo, m, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.castShadow = m === mat;
      root.add(o);
      return o;
    };
    // Mantle: a long tapering cone behind the head, glowing bands, two fins at the tip
    const profile = [[0.01, 26], [1.6, 24], [3.2, 19], [4.2, 13], [4.4, 8], [4, 3], [3.4, 0]].map(([r, y]) => new THREE.Vector2(r, y));
    add(new THREE.LatheGeometry(profile, 24).rotateX(Math.PI / 2), mat);
    for (const [z, r] of [[6, 4.45], [12, 4.3], [18, 3.15]]) add(new THREE.TorusGeometry(r, 0.25, 6, 32), this.glowMat, 0, 0, z);
    for (const sx of [-1, 1]) {
      const s = new THREE.Shape([[3.5, -16.5], [10.5, -21], [4, -26.5], [0.5, -26]].map(([x, y]) => new THREE.Vector2(sx * x, y)));
      const fin = add(new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#4a3266', roughness: 0.5, side: THREE.DoubleSide }));
      fin.castShadow = true;
    }
    // Head, eyes, and the searchlight organ underneath
    add(new THREE.SphereGeometry(3.7, 20, 14), mat, 0, 0, -1).scale.set(1, 0.9, 1.1);
    for (const sx of [-1, 1]) add(new THREE.SphereGeometry(1.1, 14, 10), this.eyeMat, sx * 3.3, 0.6, -1.6);
    this.lamp = add(new THREE.SphereGeometry(1, 14, 10), this.eyeMat, 0, -3, -2);
    // Arms (and two long tentacles): chains of tapering segments, each bending on its parent
    const chain = (a, segs, len, r0, r1, ring) => {
      const base = new THREE.Group();
      base.position.set(Math.cos(a) * ring, Math.sin(a) * ring, ARMS.at);
      base.rotation.z = a; // local +X points out from the middle
      root.add(base);
      const list = [];
      let parent = base;
      for (let s = 0; s < segs; s++) {
        const seg = new THREE.Group();
        seg.position.z = s ? -len : 0;
        parent.add(seg);
        const ra = r0 + (r1 - r0) * (s / segs), rb = r0 + (r1 - r0) * ((s + 1) / segs);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rb, ra, len + 0.3, 8).rotateX(Math.PI / 2).translate(0, 0, -len / 2), mat);
        m.castShadow = true;
        const joint = new THREE.Mesh(new THREE.SphereGeometry(ra, 8, 6), mat); // (rounds off the bend)
        seg.add(m, joint);
        list.push(seg);
        parent = seg;
      }
      return list;
    };
    this.arms = [];
    for (let k = 0; k < ARMS.n; k++) this.arms.push(chain(((k + 0.5) / ARMS.n) * Math.PI * 2, ARMS.segs, ARMS.seg, 0.95, 0.15, ARMS.ring));
    this.tentacles = [0, Math.PI].map((a) => chain(a, TENTACLES.segs, TENTACLES.seg, 0.6, 0.12, ARMS.ring * 0.6));
    for (const t of this.tentacles) {
      const club = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mat);
      club.scale.set(0.8, 0.5, 2);
      club.position.z = -TENTACLES.seg - 1;
      t[t.length - 1].add(club);
    }
    return root;
  }

  // Arms: spread out at the base, curl in toward the middle along their length, wave.
  animateArms(dt, want) {
    const P = this.pose, k = 1 - Math.exp(-4 * dt), t = this.t;
    for (const key in want) P[key] += (want[key] - P[key]) * k;
    this.arms.forEach((segs, a) => {
      segs.forEach((seg, s) => {
        seg.rotation.y = (s === 0 ? -P.spread : 0) + (P.curl / segs.length) + Math.sin(t * 2.6 - s * 0.7 + a * 1.7) * P.wave * 0.35;
        seg.rotation.x = Math.sin(t * 2.1 - s * 0.6 + a * 2.3) * P.wave * 0.3;
      });
    });
    this.tentacles.forEach((segs, a) => {
      segs.forEach((seg, s) => {
        seg.rotation.y = (s === 0 ? -P.spread * 1.4 : 0) + Math.sin(t * 1.8 - s * 0.5 + a * 3) * 0.12;
        seg.rotation.x = Math.sin(t * 1.4 - s * 0.45 + a) * 0.1;
      });
    });
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    const { player } = this.ctx, e = this.e, P = this.pocket;
    this.t += dt;
    this.stateT += dt;
    e.flash = Math.max(0, e.flash - dt * 5);
    this.bodyMat.emissiveIntensity = e.flash * 0.8;
    const pc = _u.copy(player.pos).setY(player.pos.y + 1); // the hero's middle
    const calm = P.calm(); // (just arrived or respawned, or the blue man is here)
    const alert = this.state !== 'patrol';
    this.eyeMat.color.setRGB(alert ? 3 : 0.6, alert ? 0.4 : 2, alert ? 0.3 : 3);
    this.glowMat.color.setRGB(alert ? 2.4 : 0.4, alert ? 0.5 : 1.6, alert ? 0.6 : 2.4);
    let face; // where the mantle should point (+Z)

    if (this.state === 'patrol') {
      // Swim mantle-first from waypoint to waypoint, sweeping the cone over the ruins
      _v.subVectors(this.waypoint, e.pos);
      if (_v.length() < 40) this.pickWaypoint();
      this.vel.lerp(_v.normalize().multiplyScalar(MOVE.speed), 1 - Math.exp(-0.6 * dt));
      face = this.face.copy(this.vel).normalize();
      const yaw = Math.atan2(this.vel.x, this.vel.z) + Math.sin(this.t * SCAN.speed) * SCAN.sweep;
      const pitch = -(SCAN.pitch + Math.sin(this.t * 0.45) * 0.3);
      this.scanDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      this.animateArms(dt, { spread: 0.12, curl: 0, wave: 0.14 });
      if (!calm && this.sees(pc, true)) this.spot(pc);
    } else {
      // Hunting: hang in place, arms toward the hero
      this.vel.multiplyScalar(Math.exp(-MOVE.hover * dt));
      const sees = !calm && this.sees(pc, false);
      if (sees) {
        this.lastSeen.copy(pc);
        this.lostT = 0;
      } else this.lostT += dt;
      const firing = this.state === 'fire';
      const d = e.pos.distanceTo(this.state === 'cooldown' && !sees ? this.lastSeen : pc);
      const rate = BEAM.track[firing ? 1 : 0] * Math.min(1, Math.max(0.15, d / BEAM.close)); // up close it can't keep up
      this.turnAim(_v.subVectors(sees ? pc : this.lastSeen, this.ballPos(_w)).normalize(), rate * dt);
      face = this.face.copy(this.aim).negate();
      if (this.state === 'charge') this.updateCharge(dt);
      else if (firing) this.updateFire(dt);
      else {
        this.animateArms(dt, { spread: 0.35, curl: 0.4, wave: 0.2 });
        if (this.stateT > BEAM.cooldown) {
          if (sees) this.begin('charge');
          else if (this.lostT > BEAM.lose) this.begin('patrol');
        }
      }
      if (this.state === 'charge' && this.lostT > BEAM.lose) this.begin('patrol');
    }
    if (player.dead && this.state !== 'patrol') this.begin('patrol');

    // Move, stay inside the dome
    e.pos.addScaledVector(this.vel, dt);
    _v.subVectors(e.pos, P.O);
    if (_v.length() > P.R - 60) e.pos.copy(P.O).addScaledVector(_v.normalize(), P.R - 60);
    e.pos.y = Math.max(e.pos.y, P.O.y + 60);
    this.root.position.copy(e.pos);
    this.root.position.y += Math.sin(this.t * 0.8) * 1.5;
    // Turn: +Z toward `face`
    _m.lookAt(face, ZERO, Math.abs(face.y) > 0.95 ? _v.set(1, 0, 0) : UP);
    _q.setFromRotationMatrix(_m);
    this.root.quaternion.slerp(_q, 1 - Math.exp(-(alert ? 4 : 1.5) * dt));
    this.root.updateMatrixWorld();

    // The scanning cone shows while it patrols
    this.cone.visible = this.state === 'patrol';
    if (this.cone.visible) {
      this.lamp.getWorldPosition(this.cone.position);
      this.cone.quaternion.setFromUnitVectors(_v.set(0, -1, 0), this.scanDir);
      this.cone.material.opacity = 0.045 + 0.02 * Math.sin(this.t * 7);
    }
  }

  ballPos(out) {
    return this.root.localToWorld(out.copy(BALL));
  }

  turnAim(want, maxAngle) {
    const ang = this.aim.angleTo(want);
    if (ang <= maxAngle || ang < 1e-4) this.aim.copy(want);
    else {
      _q.setFromUnitVectors(this.aim, want);
      const q = new THREE.Quaternion().slerp(_q, maxAngle / ang);
      this.aim.applyQuaternion(q).normalize();
    }
  }

  // Can it see the hero? While patrolling only inside its scanning cone.
  sees(pc, cone) {
    const { player, world } = this.ctx;
    if (player.dead) return false;
    const from = this.lamp.getWorldPosition(_v);
    const to = _w.subVectors(pc, from), d = to.length();
    if (d > SCAN.range * (cone ? 1 : 1.6)) return false;
    to.multiplyScalar(1 / d);
    if (cone && to.dot(this.scanDir) < Math.cos(SCAN.cone)) return false;
    return world.raycastHit(from, to, d) >= d - 3;
  }

  spot(pc) {
    this.lastSeen.copy(pc);
    this.aim.subVectors(pc, this.e.pos).normalize();
    this.lostT = 0;
    this.begin('charge');
    this.pocket.squidAlarm();
  }

  begin(state) {
    this.state = state;
    this.stateT = 0;
    this.ball.visible = state === 'charge' || state === 'fire';
    this.beam.visible = state === 'fire';
    if (state === 'fire') this.carveT = BEAM.carve[0];
  }

  // Arms cup forward around a ball of light that swells, everything around it sucked in.
  updateCharge(dt) {
    const k = Math.min(1, this.stateT / BEAM.charge), fx = this.ctx.fx;
    this.animateArms(dt, { spread: 0.75, curl: 1.7, wave: 0.05 });
    const b = this.ballPos(this.ball.position);
    this.ball.scale.setScalar(0.5 + 5.5 * k * k + Math.sin(this.t * 40) * 0.3 * k);
    this.ball.material.opacity = 0.6 + 0.4 * k;
    for (let i = 0; i < 6; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(18 + Math.random() * 14);
      fx.spawn(b.x + _v.x, b.y + _v.y, b.z + _v.z, -_v.x / 0.45, -_v.y / 0.45, -_v.z / 0.45, 0.45, 1.1, 0.2, [0.6, 0.85, 1], [1, 1, 1], 0, 0);
    }
    if (Math.random() < dt * 10) fx.flash(b, 0x9fd0ff, 4000 * k, 120, 0.1);
    if (k >= 1) {
      this.begin('fire');
      fx.flash(b, 0xffffff, 30000, 600, 0.3);
      this.ctx.player.shake(0.6, 0.4);
    }
  }

  // The beam: out along the aim until it hits a building, the floor or the dome. It follows the
  // hero (slowly), burns them while they're in it, and digs into whatever it hits.
  updateFire(dt) {
    const { player, world, fx } = this.ctx, P = this.pocket;
    this.animateArms(dt, { spread: 0.95, curl: 0.7, wave: 0.08 });
    const o = this.ballPos(this.ball.position), d = this.aim;
    this.ball.scale.setScalar(6 + Math.sin(this.t * 50) * 0.6);
    // Length: the first solid thing, or the dome
    _v.subVectors(o, P.O);
    const bq = _v.dot(d), cq = _v.lengthSq() - P.R * P.R;
    const toDome = -bq + Math.sqrt(Math.max(0, bq * bq - cq));
    const hitT = world.raycastHit(o, d, Math.min(BEAM.range, toDome));
    const len = Math.max(1, hitT);
    const flick = 1 + Math.sin(this.t * 60) * 0.08;
    this.beam.position.copy(o);
    this.beam.quaternion.setFromUnitVectors(UP, d);
    this.beamCore.scale.set(BEAM.r * 0.45 * flick, len, BEAM.r * 0.45 * flick);
    this.beamGlow.scale.set(BEAM.r * 1.1 * flick, len, BEAM.r * 1.1 * flick);
    const end = _w.copy(o).addScaledVector(d, len);
    // Where it lands: an explosion that keeps going, and the building gives way
    if (Math.random() < dt * 30) fx.burst(end, 8, { speed: 30, life: 0.5, size: 2.5, c0: [0.9, 0.95, 1], c1: [0.3, 0.5, 1], drag: 2 });
    if (Math.random() < dt * 12) fx.flash(end, 0xbfe0ff, 20000, 200, 0.1);
    this.carveT -= dt;
    if (this.carveT <= 0 && hitT < Math.min(BEAM.range, toDome) - 0.5) {
      this.carveT = BEAM.carve[1];
      if (P.damage(end.clone(), BEAM.carveR, d.clone())) {
        fx.burst(end, 40, { speed: 40, life: 0.7, size: 4, size1: 7, c0: [0.95, 0.97, 1], c1: [0.3, 0.5, 1], drag: 2 });
        fx.ring(end, 0x9fd0ff, 22, 0.4);
        fx.flash(end, 0xdff0ff, 40000, 260, 0.2);
        if (player.pos.distanceTo(end) < 250) player.shake(0.4, 0.3);
      }
    }
    // The hero: inside the beam?
    const pc = _u.copy(player.pos).setY(player.pos.y + 1).sub(o), along = pc.dot(d);
    if (!player.dead && !player.invulnerable && along > 0 && along < len && pc.addScaledVector(d, -along).length() < BEAM.r + 1) {
      player.hurt(BEAM.dps * dt); // (no blocking this)
      player.vel.addScaledVector(d, 40 * dt);
      player.shake(1, 0.3);
      if (Math.random() < dt * 20) {
        _v.copy(player.pos).setY(player.pos.y + 1);
        fx.burst(_v, 10, { speed: 14, life: 0.3, size: 1, c0: [1, 1, 1], c1: [0.4, 0.6, 1] });
      }
    }
    if (this.stateT >= BEAM.fire) this.begin('cooldown');
  }

  pickWaypoint() {
    const P = this.pocket, d = (P.R - MOVE.margin) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    this.waypoint.set(P.O.x + Math.cos(a) * d, P.O.y + MOVE.height[0] + Math.random() * (MOVE.height[1] - MOVE.height[0]), P.O.z + Math.sin(a) * d);
  }

  // Dead: the glow goes out and it drops, then bursts when it hits the ground.
  updateDead(dt) {
    const e = this.e, P = this.pocket, fx = this.ctx.fx;
    if (!this.fell) {
      this.fell = true;
      this.cone.visible = this.ball.visible = this.beam.visible = false;
      this.glowMat.color.setRGB(0.05, 0.05, 0.08);
      this.eyeMat.color.setRGB(0.05, 0.05, 0.05);
      this.vel.set(0, 0, 0);
      this.ctx.hud.callout('SQUID DESTROYED', 'good');
    }
    this.vel.y -= 30 * dt;
    e.pos.addScaledVector(this.vel, dt);
    this.root.position.copy(e.pos);
    this.root.rotateX(dt * 0.8);
    this.animateArms(dt, { spread: 0.6, curl: 0, wave: 0.6 });
    if (Math.random() < dt * 15) fx.smoke(e.pos.x, e.pos.y, e.pos.z, 0, 2, 0, 1.5, 3, 6);
    if (e.pos.y > P.O.y + 4) return false;
    fx.burst(e.pos, 120, { speed: 40, life: 1, size: 3, c0: [0.8, 0.6, 1], c1: [0.3, 0.1, 0.5], drag: 2 });
    fx.flash(e.pos, 0xc080ff, 30000, 300, 0.5);
    P.damage(e.pos.clone().setY(P.O.y + 5), 14, null);
    this.dispose();
    return true;
  }

  dispose() {
    const P = this.pocket;
    P.group.remove(this.root, this.cone, this.ball, this.beam);
    this.root.traverse((o) => o.isMesh && o.geometry.dispose());
    for (const m of [this.glowMat, this.eyeMat, this.cone.material, this.ball.material, this.beamCore.material, this.beamGlow.material]) m.dispose();
    this.ball.geometry.dispose();
  }
}

export const SQUID_STATS = { hp: HP, r: 10, cy: 0, mass: 0, scale: 10 };
