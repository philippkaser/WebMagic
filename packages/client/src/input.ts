/**
 * Keyboard + pointer-lock mouse input. Produces a movement intent in world
 * space each frame; casting/interacting are edge-triggered callbacks.
 */
export class Input {
  yaw = 0; // camera yaw, radians (0 = looking along +X)
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;

  onCast: (slot: number) => void = () => {};
  onInteract: () => void = () => {};
  onToggleInventory: () => void = () => {};
  onOpenChat: (initial?: string) => void = () => {};
  /** UI can suppress game input while typing. */
  isTyping: () => boolean = () => false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (this.isTyping()) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === 'e') this.onInteract();
      if (k === 'i' || k === 'tab') { e.preventDefault(); this.onToggleInventory(); }
      if (k === 'enter') this.onOpenChat();
      if (k === '/') { e.preventDefault(); this.onOpenChat('/'); }
      if (k >= '1' && k <= '4') this.onCast(Number(k) - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== canvas) return;
      if (e.button === 0) this.onCast(0);
      if (e.button === 2) this.onCast(1);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.0028;
    });
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /**
   * Movement direction in world space (x, y = server plane), unit length or zero.
   * Also applies classic arrow-key turning.
   */
  moveIntent(dt: number): { mx: number; my: number } {
    if (this.isTyping()) return { mx: 0, my: 0 };
    const turnSpeed = 2.6;
    if (this.keys.has('arrowleft')) this.yaw += turnSpeed * dt;
    if (this.keys.has('arrowright')) this.yaw -= turnSpeed * dt;

    let fwd = 0;
    let strafe = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('a')) strafe -= 1;
    if (this.keys.has('d')) strafe += 1;
    if (fwd === 0 && strafe === 0) return { mx: 0, my: 0 };

    // Camera yaw 0 looks along +X; server plane y == three.js z.
    const fx = Math.cos(this.yaw);
    const fy = -Math.sin(this.yaw);
    const rx = -fy;
    const ry = fx;
    let mx = fx * fwd + rx * strafe;
    let my = fy * fwd + ry * strafe;
    const len = Math.hypot(mx, my);
    if (len > 0) {
      mx /= len;
      my /= len;
    }
    return { mx, my };
  }

  /** Server-side facing angle derived from camera yaw. */
  facing(): number {
    return Math.atan2(-Math.sin(this.yaw), Math.cos(this.yaw));
  }
}
