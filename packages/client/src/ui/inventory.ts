import { AFFIX_LABELS, Attributes, Item, Slot } from '@webmagic/shared';

const SLOTS: Slot[] = ['weapon', 'helm', 'armor', 'boots', 'trinket'];

/**
 * Inventory + equipment + character sheet panel (toggled with I/Tab).
 * Click an item to equip it, shift-click to drop it, click a filled
 * equipment slot to unequip.
 */
export class InventoryPanel {
  private el: HTMLDivElement;
  private items: Item[] = [];
  private equipment: Partial<Record<Slot, Item>> = {};
  private attrs: Attributes = { str: 0, int: 0, vit: 0, armor: 0 };

  onEquip: (itemId: string) => void = () => {};
  onUnequip: (slot: Slot) => void = () => {};
  onDrop: (itemId: string) => void = () => {};

  constructor(overlay: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panel';
    overlay.appendChild(this.el);
    this.render();
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }

  toggle(): void {
    this.el.classList.toggle('open');
  }

  close(): void {
    this.el.classList.remove('open');
  }

  setData(items: Item[], equipment: Partial<Record<Slot, Item>>, attrs: Attributes): void {
    this.items = items;
    this.equipment = equipment;
    this.attrs = attrs;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = `
      <h2>CHARACTER</h2>
      <div class="stats-block">
        <b>STR</b> ${fmt(this.attrs.str)} · <b>INT</b> ${fmt(this.attrs.int)} ·
        <b>VIT</b> ${fmt(this.attrs.vit)} · <b>ARMOR</b> ${fmt(this.attrs.armor)}
      </div>
      <div class="equip-row"></div>
      <h2>INVENTORY (${this.items.length}/24)</h2>
      <div class="hint">click = equip · shift+click = drop · items marked ◆ are unclaimed dungeon loot</div>
      <div class="inv-grid"></div>
    `;

    const equipRow = this.el.querySelector('.equip-row')!;
    for (const slot of SLOTS) {
      const item = this.equipment[slot];
      const div = document.createElement('div');
      div.className = 'equip-slot' + (item ? ` rarity-${item.rarity}` : '');
      div.innerHTML = `<div class="slot-name">${slot}</div>` + (item ? itemBody(item) : '<div style="color:#554">empty</div>');
      if (item) div.addEventListener('click', () => this.onUnequip(slot));
      equipRow.appendChild(div);
    }

    const grid = this.el.querySelector('.inv-grid')!;
    for (const item of this.items) {
      const div = document.createElement('div');
      div.className = `inv-item rarity-${item.rarity}`;
      div.innerHTML = itemBody(item);
      div.addEventListener('click', (e) => {
        if ((e as MouseEvent).shiftKey) this.onDrop(item.id);
        else this.onEquip(item.id);
      });
      grid.appendChild(div);
    }
  }
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function itemBody(item: Item): string {
  const affixes = item.affixes
    .map((a) => `<div class="affix">+${fmt(a.value)} ${AFFIX_LABELS[a.stat]}</div>`)
    .join('');
  const tag = item.dungeonLoot ? '<div class="item-tag">◆ unclaimed dungeon loot</div>' : '';
  return `
    <div class="item-name">${escapeHtml(item.name)}</div>
    <div style="color:#9a8f7a">${item.slot} · ilvl ${item.ilvl} · ${item.rarity}</div>
    ${affixes}${tag}
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
