import { CLASSES, ClassId } from '@webmagic/shared';

const CLASS_ICONS: Record<ClassId, string> = {
  warrior: '⚔️',
  wizard: '🔮',
  knight: '🛡️',
};

export class LoginScreen {
  private el: HTMLDivElement;
  private errorEl: HTMLDivElement;
  private resolve: ((v: { name: string; classId: ClassId }) => void) | null = null;
  private selected: ClassId = 'warrior';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'login';
    this.el.innerHTML = `
      <h1>WEBMAGIC</h1>
      <div class="tagline">a world beneath the lantern light</div>
      <input type="text" maxlength="16" placeholder="Hero name" id="login-name" autocomplete="off" />
      <div class="classes"></div>
      <button id="login-play">ENTER</button>
      <div class="error"></div>
    `;
    root.appendChild(this.el);
    this.errorEl = this.el.querySelector('.error')!;

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
      const name = (this.el.querySelector('#login-name') as HTMLInputElement).value.trim();
      if (name.length < 2) {
        this.showError('Pick a name (2-16 letters/digits).');
        return;
      }
      this.resolve?.({ name, classId: this.selected });
    };
    this.el.querySelector('#login-play')!.addEventListener('click', submit);
    this.el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });
  }

  waitForSubmit(): Promise<{ name: string; classId: ClassId }> {
    return new Promise((resolve) => (this.resolve = resolve));
  }

  showError(text: string): void {
    this.errorEl.textContent = text;
  }

  hide(): void {
    this.el.remove();
  }
}
