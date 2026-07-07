import { ChatChannel } from '@webmagic/shared';

/**
 * Chat log + input. Enter opens the box, Enter sends, Escape closes.
 * Messages default to global; prefix with `/l ` for local (earshot) chat.
 */
export class ChatUI {
  private el: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  onSend: (ch: ChatChannel, text: string) => void = () => {};

  constructor(overlay: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'chat';
    this.el.innerHTML = `
      <div class="chat-log"></div>
      <input class="chat-input" maxlength="240" placeholder="global — start with /l for local, Esc to close" />
    `;
    overlay.appendChild(this.el);
    this.log = this.el.querySelector('.chat-log')!;
    this.input = this.el.querySelector('.chat-input')!;

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.close();
      } else if (e.key === 'Enter') {
        const raw = this.input.value.trim();
        this.input.value = '';
        this.close();
        if (!raw) return;
        if (raw.startsWith('/l ')) this.onSend('local', raw.slice(3));
        else this.onSend('global', raw);
      }
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  open(initial = ''): void {
    this.el.classList.add('open');
    this.input.value = initial;
    // focus after the triggering keystroke finishes
    requestAnimationFrame(() => this.input.focus());
  }

  close(): void {
    this.el.classList.remove('open');
    this.input.blur();
  }

  addChat(ch: ChatChannel, from: string, text: string): void {
    const div = document.createElement('div');
    div.className = `ch-${ch}`;
    if (ch === 'system') {
      div.textContent = `✦ ${text}`;
    } else {
      const tag = ch === 'local' ? ' (local)' : '';
      div.innerHTML = `<span class="from"></span>: <span class="text"></span>`;
      div.querySelector('.from')!.textContent = `${from}${tag}`;
      div.querySelector('.text')!.textContent = text;
    }
    this.push(div);
  }

  addNotice(text: string, style = 'info'): void {
    const div = document.createElement('div');
    div.className = `notice-${style}`;
    div.textContent = text;
    this.push(div);
  }

  private push(div: HTMLDivElement): void {
    this.log.appendChild(div);
    while (this.log.children.length > 80) this.log.firstChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}
