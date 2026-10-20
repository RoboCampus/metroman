import * as THREE from 'three';

// Boss battle: the kaiju vs Impregno Man. While both are alive they target each other (each boss's
// `rival`) instead of the hero; when one goes down the winner is announced and goes back to
// hunting the hero. A battle starts a few seconds into the game, and B starts a new one
// (summoning whichever boss is missing) near the hero.
const FIRST = 8;

export class BossFight {
  constructor(ctx, kaiju, impregno) {
    this.ctx = ctx;
    this.kaiju = kaiju; // spawners
    this.impregno = impregno;
    this.timer = FIRST;
    this.fighting = null; // [kaiju, impregno] while a battle is on
  }

  start() {
    const { player } = this.ctx;
    if (!this.kaiju.current) this.kaiju.summon(player.pos.x, player.pos.z, 260, 380);
    const k = this.kaiju.current;
    if (!this.impregno.current && k) {
      // Impregno Man flies in from the far side of the kaiju
      const dx = k.e.pos.x - player.pos.x, dz = k.e.pos.z - player.pos.z, d = Math.hypot(dx, dz) || 1;
      this.impregno.summon(new THREE.Vector3(k.e.pos.x + (dx / d) * 220, 120, k.e.pos.z + (dz / d) * 220));
    }
    this.ctx.hud.message('BOSS BATTLE: KAIJU vs IMPREGNO MAN', 3.5);
  }

  update(dt, input) {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) this.start();
    }
    if (input?.hit('KeyB')) this.start();
    const k = this.kaiju.current, m = this.impregno.current;
    const alive = (b) => b && !b.e.dead;
    if (alive(k) && alive(m)) {
      k.rival = m;
      m.rival = k;
      this.fighting = [k, m];
      return;
    }
    if (this.fighting) {
      const [fk, fm] = this.fighting;
      this.fighting = null;
      fk.rival = fm.rival = null;
      if (alive(fk)) this.ctx.hud.message('THE KAIJU WINS!', 4);
      else if (alive(fm)) this.ctx.hud.message('IMPREGNO MAN WINS!', 4);
      else this.ctx.hud.message("IT'S A DRAW!", 4);
    }
  }
}
