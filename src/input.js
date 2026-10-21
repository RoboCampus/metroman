export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.pressed = new Set();
    // left/right: currently held. *Down/*Up: pressed/released this frame.
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftDown: false, rightDown: false, leftUp: false, rightUp: false };
    this.wheel = 0;
    this.locked = false;
    this.active = false; // set once the game has started

    addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      // Ctrl is the dodge modifier: block browser shortcuts like Ctrl+S / Ctrl+D while playing.
      if (e.ctrlKey && this.active) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouse.left = this.mouse.leftDown = true;
      if (e.button === 2) this.mouse.right = this.mouse.rightDown = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.mouse.left) {
        this.mouse.left = false;
        this.mouse.leftUp = true;
      }
      if (e.button === 2 && this.mouse.right) {
        this.mouse.right = false;
        this.mouse.rightUp = true;
      }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => { if (this.locked) this.wheel += e.deltaY; }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.mouse.left = this.mouse.right = false;
    });
  }

  lock() {
    const r = this.el.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  }

  // Fullscreen + Keyboard Lock is the only way a page can receive Ctrl+W/T/N
  // instead of the browser closing or opening tabs. then() runs once fullscreen is on (or failed).
  enterFullscreen(then) {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return then?.();
    document.documentElement
      .requestFullscreen()
      .then(() => navigator.keyboard?.lock?.(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyT', 'KeyN', 'KeyR', 'KeyG']))
      .catch(() => {})
      .finally(() => then?.());
  }

  // Capture the mouse (and enter fullscreen). The browser can refuse the mouse capture while it's
  // switching to fullscreen, so ask again once that's done.
  capture() {
    this.lock();
    this.enterFullscreen(() => {
      if (!this.locked) this.lock();
    });
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  get shift() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = this.mouse.dy = 0;
    this.mouse.leftDown = this.mouse.rightDown = this.mouse.leftUp = this.mouse.rightUp = false;
    this.wheel = 0;
  }
}
