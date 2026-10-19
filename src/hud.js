import * as THREE from 'three';

const _p = new THREE.Vector3();

export class HUD {
  constructor(city) {
    const $ = (id) => document.getElementById(id);
    this.root = $('hud');
    this.hp = $('hp');
    this.hpText = $('hpText');
    this.pw = $('pw');
    this.sc = $('sc');
    this.score = $('score');
    this.speed = $('speed');
    this.mode = $('mode');
    this.zone = $('zone');
    this.msg = $('msg');
    this.hurtEl = $('hurt');
    this.dmgLayer = $('damageLayer');
    this.calloutEl = $('callout');
    this.comboEl = $('combo');
    this.hitsEl = $('hits');
    this.nameEl = $('heroName');
    this.map = $('minimap').getContext('2d');
    this.city = city;
    this.nums = [];
    this.slots = [];
    this.msgT = 0;
    this.hurtT = 0;
    this.zoneT = 0;
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
  }

  setAbilities(list) {
    const wrap = document.getElementById('abilities');
    wrap.innerHTML = '';
    this.slots = list.map((a) => {
      const el = document.createElement('div');
      el.className = 'slot' + (a.ult ? ' ult' : '');
      el.innerHTML = `<div class="icon">${a.icon}</div><div class="cd"></div><div class="key">${a.key}</div><div class="name">${a.name}</div>`;
      wrap.appendChild(el);
      return { a, el, cd: el.querySelector('.cd') };
    });
  }

  setMode(movement) {
    this.mode.textContent = movement === 'flight'
      ? 'FLIGHT · Space/C up/down · Shift boost · hold L-Ctrl + direction to dodge'
      : 'SUPER SPEED · Shift sprint · sprint into walls to wall-run · Space double jump · hold L-Ctrl + direction to dodge';
  }

  setScore(n) {
    this.score.textContent = `Criminals stopped: ${n}`;
  }

  message(text, dur = 1.5) {
    this.msg.textContent = text;
    this.msg.style.opacity = 1;
    this.msgT = dur;
  }

  hurt() {
    this.hurtEl.style.opacity = 1;
    this.hurtT = 0.15;
  }

  setName(name) {
    this.nameEl.textContent = name;
  }

  // Restart a CSS pop animation on an element.
  pop(el, text, cls = '') {
    el.textContent = text;
    el.className = cls;
    void el.offsetWidth;
    el.classList.add('pop');
  }

  // Big center text for counters, breakouts and knockdowns. cls: 'good' | 'bad'
  callout(text, cls) {
    this.pop(this.calloutEl, text, cls);
  }

  combo(name) {
    this.pop(this.comboEl, `COMBO · ${name}`);
  }

  // value: a damage number, or a text label (with an optional css class).
  damageNumber(pos, value, cls) {
    const el = document.createElement('div');
    el.className = 'dmg' + (cls ? ` label ${cls}` : value >= 100 ? ' big' : '');
    el.textContent = value;
    this.dmgLayer.appendChild(el);
    this.nums.push({ el, pos: pos.clone(), t: 0, dx: (Math.random() - 0.5) * 30 });
  }

  update(dt, ctx, powers) {
    const p = ctx.player;
    const hits = ctx.combat.hits;
    this.hitsEl.style.opacity = hits >= 2 ? 1 : 0;
    if (hits >= 2) this.hitsEl.innerHTML = `${hits} HITS<small>+${Math.min(hits, 25) * 6}% power regen</small>`;
    this.hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
    this.hpText.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    this.pw.style.width = `${(p.power / p.maxPower) * 100}%`;
    this.sc.style.width = `${p.super}%`;
    for (const s of this.slots) {
      const a = s.a;
      s.cd.style.setProperty('--p', a.cd ? a.timer / a.cd : 0);
      s.el.classList.toggle('off', !!a.fn && !a.ult && !powers.ready(a));
      s.el.classList.toggle('active', (!!a.hold && powers.channeling) || (a.id === 'block' && p.blocking));
      s.el.classList.toggle('ready', !!a.ult && p.super >= 100);
    }
    this.speed.textContent = `${Math.round(p.speed * 3.6)} km/h · altitude ${Math.round(p.pos.y)} m`;

    this.zoneT -= dt;
    if (this.zoneT <= 0) {
      this.zoneT = 0.3;
      this.zone.textContent = this.city.zoneName(p.pos.x, p.pos.z);
    }
    if (this.msgT > 0) {
      this.msgT -= dt;
      if (this.msgT <= 0) this.msg.style.opacity = 0;
    }
    if (this.hurtT > 0) {
      this.hurtT -= dt;
      if (this.hurtT <= 0) this.hurtEl.style.opacity = 0;
    }

    const W = innerWidth, H = innerHeight;
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.t += dt;
      if (n.t > 0.9) {
        n.el.remove();
        this.nums.splice(i, 1);
        continue;
      }
      _p.copy(n.pos);
      _p.y += n.t * 2.5;
      _p.project(ctx.camera);
      if (_p.z > 1) {
        n.el.style.opacity = 0;
        continue;
      }
      const x = ((_p.x + 1) / 2) * W + n.dx * n.t, y = ((1 - _p.y) / 2) * H;
      n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 + Math.max(0, 0.3 - n.t)})`;
      n.el.style.opacity = 1 - Math.max(0, n.t - 0.5) / 0.4;
    }

    this.drawMap(p, ctx.enemies);
  }

  drawMap(p, enemies) {
    const c = this.map, S = 200, k = 0.55; // minimap px per meter
    const info = this.city.mapInfo;
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#163049';
    c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.rotate(p.yaw); // camera forward points up
    const sc = k / info.scale;
    c.drawImage(this.city.minimap, -(p.pos.x - info.minX) * k, -(p.pos.z - info.minZ) * k, info.w * sc, info.h * sc);
    for (const e of enemies.list) {
      if (e.dead) continue;
      const s = e.type === 'brute' ? 9 : 5;
      c.fillStyle = e.type === 'drone' ? '#ff6ad5' : e.type === 'brute' ? '#c86bff' : '#ff3b30';
      c.fillRect((e.pos.x - p.pos.x) * k - s / 2, (e.pos.z - p.pos.z) * k - s / 2, s, s);
    }
    c.restore();
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(S / 2, S / 2 - 8);
    c.lineTo(S / 2 + 6, S / 2 + 6);
    c.lineTo(S / 2, S / 2 + 2);
    c.lineTo(S / 2 - 6, S / 2 + 6);
    c.closePath();
    c.fill();
  }
}
