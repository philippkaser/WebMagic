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

export class LoginScreen {
  private el: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private resolve: ((v: { name: string; classId: ClassId; pass: string }) => void) | null = null;
  private selected: ClassId = 'warrior';

  constructor(root: HTMLElement) {
    const remembered = loadRemembered();
    if (remembered) this.selected = remembered.classId;

    this.el = document.createElement('div');
    this.el.className = 'login';
    this.el.innerHTML = `
      <h1>WEBMAGIC</h1>
      <div class="tagline">a world beneath the lantern light</div>
      <input type="text" maxlength="16" placeholder="Hero name" id="login-name" autocomplete="off" />
      <input type="password" maxlength="64" placeholder="Passphrase (optional)" id="login-pass" autocomplete="current-password" />
      <div class="hint">Set a passphrase to protect your hero, so only you can log in as them.</div>
      <div class="classes"></div>
      <button id="login-play">ENTER</button>
      <div class="error"></div>
    `;
    root.appendChild(this.el);
    this.errorEl = this.el.querySelector('.error')!;

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
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });

    // Returning heroes usually just need their passphrase — focus it for them.
    (remembered?.protectedName ? (this.el.querySelector('#login-pass') as HTMLInputElement) : nameInput).focus();
  }

  waitForSubmit(): Promise<{ name: string; classId: ClassId; pass: string }> {
    return new Promise((resolve) => (this.resolve = resolve));
  }

  showError(text: string): void {
    this.errorEl.textContent = text;
  }

  hide(): void {
    this.el.remove();
  }
}
