import { CLASSES, ClassId } from '@webmagic/shared';

const CLASS_ICONS: Record<ClassId, string> = {
  warrior: '⚔️',
  wizard: '🔮',
  knight: '🛡️',
};

const STORAGE_KEY = 'webmagic.lastHero';

interface RememberedHero {
  name: string;
  classId: ClassId;
  protectedName: boolean;
}

function loadRemembered(): RememberedHero | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RememberedHero;
    if (typeof v.name === 'string' && v.classId in CLASSES) return v;
  } catch {
    // ignore corrupt/unavailable storage
  }
  return null;
}

/** Remember the character so the player can log straight back in next visit. */
export function rememberHero(name: string, classId: ClassId, protectedName: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, classId, protectedName }));
  } catch {
    // storage may be disabled — logging in still works, it just won't pre-fill
  }
}

// ---------------------------------------------------------------- backdrop

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  warm: number; // 0 = deep red, 1 = bright gold
}

interface Star {
  x: number; // 0..1 of width
  y: number; // 0..1 of height (upper half)
  size: number;
  phase: number;
}

/**
 * The living splash backdrop: a night sky of twinkling stars over a torchlit
 * dark, embers rising from below, fine ash drifting down. Pure 2D canvas —
 * runs before any game asset exists, dies with the login screen.
 */
class SplashBackdrop {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private embers: Ember[] = [];
  private stars: Star[] = [];
  private raf = 0;
  private last = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 90; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random() * 0.55,
        size: Math.random() < 0.15 ? 2 : 1,
        phase: Math.random() * Math.PI * 2,
      });
    }
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.draw(now / 1000, dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private draw(t: number, dt: number): void {
    const c = this.canvas;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
      c.width = c.clientWidth;
      c.height = c.clientHeight;
    }
    const { width: w, height: h } = c;
    const ctx = this.ctx;

    // night gradient, warmed from below as if by a great unseen hearth
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#050308');
    sky.addColorStop(0.55, '#0d0a14');
    sky.addColorStop(1, '#1c1016');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // pulsing hearth-glow along the bottom edge
    const pulse = 0.75 + Math.sin(t * 1.7) * 0.12 + Math.sin(t * 4.3) * 0.06;
    const glow = ctx.createRadialGradient(w / 2, h * 1.15, 0, w / 2, h * 1.15, h * 0.75);
    glow.addColorStop(0, `rgba(214, 110, 34, ${0.34 * pulse})`);
    glow.addColorStop(0.5, `rgba(150, 60, 20, ${0.16 * pulse})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // stars, twinkling
    ctx.fillStyle = '#cdd8ff';
    for (const s of this.stars) {
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.7 + s.phase));
      ctx.globalAlpha = tw * 0.8;
      ctx.fillRect(s.x * w, s.y * h, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    // embers rise
    if (this.embers.length < 110 && Math.random() < 0.5) {
      this.embers.push({
        x: Math.random() * w,
        y: h + 6,
        vx: (Math.random() - 0.5) * 14,
        vy: -(22 + Math.random() * 42),
        life: 0,
        maxLife: 5 + Math.random() * 5,
        size: 1 + Math.random() * 2.2,
        warm: Math.random(),
      });
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life += dt;
      if (e.life >= e.maxLife || e.y < -8) {
        this.embers.splice(i, 1);
        continue;
      }
      e.x += (e.vx + Math.sin(t * 2 + e.y * 0.02) * 9) * dt;
      e.y += e.vy * dt;
      const fade = 1 - e.life / e.maxLife;
      const r = Math.round(200 + e.warm * 55);
      const g = Math.round(90 + e.warm * 90);
      ctx.globalAlpha = fade * 0.85;
      ctx.fillStyle = `rgb(${r},${g},30)`;
      ctx.fillRect(e.x, e.y, e.size, e.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ screen

/**
 * Splash + login. First a title splash over the living backdrop — press any
 * key to approach — then the hero form (name, passphrase, class) slides in.
 */
export class LoginScreen {
  private el: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private backdrop: SplashBackdrop;
  private resolve: ((v: { name: string; classId: ClassId; pass: string }) => void) | null = null;
  private selected: ClassId = 'warrior';
  private atForm = false;

  constructor(root: HTMLElement) {
    const remembered = loadRemembered();
    if (remembered) this.selected = remembered.classId;

    this.el = document.createElement('div');
    this.el.className = 'login';
    this.el.innerHTML = `
      <canvas class="login-bg"></canvas>
      <div class="login-content">
        <h1>WEBMAGIC</h1>
        <div class="tagline">a world beneath the lantern light</div>
        <div class="splash-hint">— press any key to approach —</div>
        <div class="login-form">
          <input type="text" maxlength="16" placeholder="Hero name" id="login-name" autocomplete="off" />
          <input type="password" maxlength="64" placeholder="Passphrase (optional)" id="login-pass" autocomplete="current-password" />
          <div class="hint">Set a passphrase to protect your hero, so only you can log in as them.</div>
          <div class="classes"></div>
          <button id="login-play">ENTER THE WORLD</button>
        </div>
        <div class="error"></div>
      </div>
    `;
    root.appendChild(this.el);
    this.errorEl = this.el.querySelector('.error')!;
    this.backdrop = new SplashBackdrop(this.el.querySelector('.login-bg')!);

    const nameInput = this.el.querySelector('#login-name') as HTMLInputElement;
    if (remembered) {
      nameInput.value = remembered.name;
      if (remembered.protectedName) {
        this.showError(`Welcome back, ${remembered.name} — enter your passphrase to continue.`);
      }
    }

    const cards = this.el.querySelector('.classes')!;
    for (const cls of Object.values(CLASSES)) {
      const card = document.createElement('div');
      card.className = 'class-card' + (cls.id === this.selected ? ' selected' : '');
      card.innerHTML = `
        <div class="icon">${CLASS_ICONS[cls.id]}</div>
        <h3>${cls.name}</h3>
        <p>${cls.desc}</p>
        <p style="margin-top:6px">${cls.passive.name}: ${cls.passive.desc}</p>
      `;
      card.addEventListener('click', () => {
        this.selected = cls.id;
        cards.querySelectorAll('.class-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      cards.appendChild(card);
    }

    const submit = () => {
      const name = nameInput.value.trim();
      const pass = (this.el.querySelector('#login-pass') as HTMLInputElement).value;
      if (name.length < 2) {
        this.showError('Pick a name (2-16 letters/digits).');
        return;
      }
      if (pass && (pass.length < 4 || pass.length > 64)) {
        this.showError('Passphrase must be 4-64 characters (or leave it blank).');
        return;
      }
      this.resolve?.({ name, classId: this.selected, pass });
    };
    this.el.querySelector('#login-play')!.addEventListener('click', submit);
    this.el.addEventListener('keydown', (e) => {
      if (!this.atForm) return;
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });

    // Splash stage: any key or click steps up to the hero form.
    const approach = () => {
      if (this.atForm) return;
      this.atForm = true;
      this.el.classList.add('at-form');
      const focusTarget = remembered?.protectedName
        ? (this.el.querySelector('#login-pass') as HTMLInputElement)
        : nameInput;
      // wait a beat for the reveal transition before grabbing focus
      setTimeout(() => focusTarget.focus(), 220);
      window.removeEventListener('keydown', approach);
    };
    window.addEventListener('keydown', approach);
    this.el.addEventListener('mousedown', approach);
  }

  waitForSubmit(): Promise<{ name: string; classId: ClassId; pass: string }> {
    return new Promise((resolve) => (this.resolve = resolve));
  }

  showError(text: string): void {
    this.errorEl.textContent = text;
  }

  hide(): void {
    this.backdrop.stop();
    this.el.remove();
  }
}
