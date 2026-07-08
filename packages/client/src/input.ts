/**
 * Keyboard + pointer-lock mouse input. Produces a movement intent in world
 * space each frame; casting/interacting are edge-triggered callbacks.
 */
const PITCH_LIMIT = 1.2; // radians up/down before the neck breaks

export class Input {
  yaw = 0; // camera yaw, radians (0 = looking along +X)
  pitch = 0; // camera pitch, radians (+ looks up)
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;

  onCast: (slot: number) => void = () => {};
  onInteract: () => void = () => {};
  onToggleInventory: () => void = () => {};
  onOpenChat: (initial?: string) => void = () => {};
  onJump: (phase: 'down' | 'up') => void = () => {};
  /** UI can suppress game input while typing. */
  isTyping: () => boolean = () => false;
  /** UI can block the canvas from grabbing the mouse while a menu is open. */
  canLock: () => boolean = () => true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (this.isTyping()) return;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        if (!e.repeat) this.onJump('down'); // ignore key-repeat while held
        this.keys.add(k);
        return;
      }
      this.keys.add(k);
      if (k === 'f') this.onInteract();
      if (k === 'e') this.onCast(2); // class skill 1
      if (k === 'q') this.onCast(3); // class skill 2
      if (k === 'i' || k === 'tab') { e.preventDefault(); this.onToggleInventory(); }
      if (k === 'enter') this.onOpenChat();
      if (k === '/') { e.preventDefault(); this.onOpenChat('/'); }
      if (k >= '1' && k <= '4') this.onCast(Number(k) - 1); // 1=LMB 2=RMB 3=E 4=Q
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === ' ') this.onJump('up');
    });
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('click', () => {
      // Don't recapture the mouse while a menu (inventory, etc.) wants it.
      if (!this.canLock()) return;
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
      this.pitch -= e.movementY * 0.0024;
      if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
      if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    });
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Sprint modifier held (shift), unless the chat box has focus. */
  get sprinting(): boolean {
    return !this.isTyping() && this.keys.has('shift');
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
