import { Biome, CLASSES, ClassId, SKILLS, SkillId, Tile, worldToTile } from '@webmagic/shared';
import type { WorldState } from '../state';

/** Minimap ground/canopy colours per biome so the varied wilds read at a glance. */
const GRASS_MINIMAP: Record<Biome, string> = {
  [Biome.Meadow]: '#2a3d20',
  [Biome.Forest]: '#20301a',
  [Biome.Marsh]: '#2c3626',
  [Biome.Highland]: '#3c4234',
  [Biome.Ashland]: '#332e2c',
};
const TREE_MINIMAP: Record<Biome, string> = {
  [Biome.Meadow]: '#1c2c14',
  [Biome.Forest]: '#12210f',
  [Biome.Marsh]: '#1d2916',
  [Biome.Highland]: '#162412',
  [Biome.Ashland]: '#2a2320',
};

const SKILL_ICONS: Record<SkillId, string> = {
  slash: '⚔️',
  whirlwind: '🌪️',
  firebolt: '🔥',
  frost_nova: '❄️',
  bash: '🛡️',
  holy_light: '✨',
};

/** Health/mana orbs, XP bar, skill bar, minimap, prompts and death screen. */
export class Hud {
  private hpFill: HTMLElement;
  private hpLabel: HTMLElement;
  private mpFill: HTMLElement;
  private mpLabel: HTMLElement;
  private xpFill: HTMLElement;
  private stamFill: HTMLElement;
  private levelBadge: HTMLElement;
  private skillsEl!: HTMLElement;
  private skillEls: { root: HTMLElement; cd: HTMLElement; id: SkillId | null; label: string }[] = [];
  private zoneName: HTMLElement;
  private zoneSub: HTMLElement;
  private zoneTime!: HTMLElement;
  private prompt: HTMLElement;
  private deathScreen: HTMLElement;
  private bigNotice: HTMLElement;
  private bigNoticeTimer = 0;
  private minimap: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;
  private lastMinimapDraw = 0;
  private damageVignette!: HTMLDivElement;

  onRespawn: () => void = () => {};
  onCastSlot: (slot: number) => void = () => {};

  constructor(overlay: HTMLElement, private classId: ClassId) {
    const bottom = document.createElement('div');
    bottom.className = 'hud-bottom';
    bottom.innerHTML = `
      <div class="orb hp"><div class="fill"></div><div class="label"></div></div>
      <div class="center-hud">
        <div class="level-badge"></div>
        <div class="skills"></div>
        <div class="xpbar"><div class="fill"></div></div>
        <div class="stambar"><div class="fill"></div></div>
      </div>
      <div class="orb mp"><div class="fill"></div><div class="label"></div></div>
    `;
    overlay.appendChild(bottom);
    this.hpFill = bottom.querySelector('.hp .fill')!;
    this.hpLabel = bottom.querySelector('.hp .label')!;
    this.mpFill = bottom.querySelector('.mp .fill')!;
    this.mpLabel = bottom.querySelector('.mp .label')!;
    this.xpFill = bottom.querySelector('.xpbar .fill')!;
    this.stamFill = bottom.querySelector('.stambar .fill')!;
    this.levelBadge = bottom.querySelector('.level-badge')!;

    this.skillsEl = bottom.querySelector('.skills')!;
    // Initial loadout from the class until the first inventory message arrives.
    this.setLoadout([CLASSES[classId].primary, null, CLASSES[classId].skills[0] ?? null, CLASSES[classId].skills[1] ?? null]);

    const top = document.createElement('div');
    top.className = 'hud-top';
    top.innerHTML = `<div class="zone-name"></div><div class="zone-sub"></div><div class="zone-time"></div>`;
    overlay.appendChild(top);
    this.zoneName = top.querySelector('.zone-name')!;
    this.zoneSub = top.querySelector('.zone-sub')!;
    this.zoneTime = top.querySelector('.zone-time')!;

    this.prompt = document.createElement('div');
    this.prompt.className = 'interact-prompt';
    this.prompt.style.display = 'none';
    overlay.appendChild(this.prompt);

    const crosshair = document.createElement('div');
    crosshair.className = 'crosshair';
    crosshair.textContent = '+';
    overlay.appendChild(crosshair);

    this.damageVignette = document.createElement('div');
    this.damageVignette.className = 'damage-vignette';
    overlay.appendChild(this.damageVignette);

    this.deathScreen = document.createElement('div');
    this.deathScreen.className = 'death-screen';
    this.deathScreen.innerHTML = `
      <h1>YOU DIED</h1>
      <p>The darkness takes what it is owed.</p>
      <button>WAKE UP AT THE INN</button>
    `;
    overlay.appendChild(this.deathScreen);
    this.deathScreen.querySelector('button')!.addEventListener('click', () => this.onRespawn());

    this.bigNotice = document.createElement('div');
    this.bigNotice.className = 'big-notice';
    overlay.appendChild(this.bigNotice);

    this.minimap = document.createElement('canvas');
    this.minimap.className = 'minimap';
    this.minimap.width = 148;
    this.minimap.height = 148;
    overlay.appendChild(this.minimap);
    this.minimapCtx = this.minimap.getContext('2d')!;

    const hints = document.createElement('div');
    hints.className = 'hint-bar';
    hints.textContent = 'WASD move · Shift sprint · Space jump · mouse look · LMB/RMB + E/Q skills · F interact · I inventory · Enter chat';
    overlay.appendChild(hints);
  }

  /** Rebuild the skill bar for a new loadout [LMB, RMB, E, Q]. */
  setLoadout(loadout: (SkillId | null)[]): void {
    const labels = ['LMB', 'RMB', 'E', 'Q'];
    this.skillsEl.innerHTML = '';
    this.skillEls = [];
    loadout.forEach((id, i) => {
      const s = document.createElement('div');
      s.className = 'skill' + (id ? '' : ' empty');
      s.innerHTML = `<span class="key">${labels[i]}</span>${id ? SKILL_ICONS[id] : ''}<div class="cd" style="display:none"></div>`;
      if (id) s.title = `${SKILLS[id].name} — ${SKILLS[id].desc}`;
      s.addEventListener('click', () => this.onCastSlot(i));
      this.skillsEl.appendChild(s);
      this.skillEls.push({ root: s, cd: s.querySelector('.cd')!, id, label: labels[i] });
    });
  }

  setZone(name: string, sub: string): void {
    this.zoneName.textContent = name;
    this.zoneSub.textContent = sub;
  }

  setPrompt(text: string | null): void {
    if (text) {
      this.prompt.textContent = text;
      this.prompt.style.display = 'block';
    } else {
      this.prompt.style.display = 'none';
    }
  }

  /** Red vignette pulse when the player takes a hit. */
  flashDamage(): void {
    this.damageVignette.classList.remove('hit');
    void this.damageVignette.offsetWidth; // restart the CSS transition
    this.damageVignette.classList.add('hit');
  }

  showBigNotice(text: string): void {
    this.bigNotice.textContent = text;
    this.bigNotice.style.opacity = '1';
    clearTimeout(this.bigNoticeTimer);
    this.bigNoticeTimer = window.setTimeout(() => (this.bigNotice.style.opacity = '0'), 2600);
  }

  update(state: WorldState, now: number, stamina?: number): void {
    const s = state.self;
    if (!s) return;
    this.hpFill.style.height = `${Math.max(0, (s.hp / s.maxHp) * 100)}%`;
    this.hpLabel.textContent = `${s.hp}/${s.maxHp}`;
    this.mpFill.style.height = `${Math.max(0, (s.mp / s.maxMp) * 100)}%`;
    this.mpLabel.textContent = `${s.mp}/${s.maxMp}`;
    this.xpFill.style.width = `${Math.min(100, (s.xp / s.xpNext) * 100)}%`;
    this.levelBadge.textContent = `Level ${s.level}`;

    // Sprint stamina — client-predicted value (falls back to the server's).
    const stam = stamina ?? s.stam;
    const stamPct = Math.max(0, Math.min(100, (stam / s.maxStam) * 100));
    this.stamFill.style.width = `${stamPct}%`;
    this.stamFill.classList.toggle('low', stamPct < 25);

    for (const sk of this.skillEls) {
      if (!sk.id) continue;
      // Only class slots (E/Q) are level-gated; weapon skills (LMB/RMB) are not.
      const classSlot = sk.label === 'E' || sk.label === 'Q';
      const locked = classSlot && SKILLS[sk.id].unlockLevel > s.level;
      sk.root.classList.toggle('locked', locked);
      const rem = s.cds[sk.id];
      if (locked) {
        sk.cd.style.display = 'flex';
        sk.cd.textContent = `L${SKILLS[sk.id].unlockLevel}`;
      } else if (rem && rem > 80) {
        sk.cd.style.display = 'flex';
        sk.cd.textContent = (rem / 1000).toFixed(1);
      } else {
        sk.cd.style.display = 'none';
      }
    }

    this.deathScreen.classList.toggle('open', s.dead);

    // world clock (overworld only — dungeons are timeless dark)
    if (state.zone?.kind === 'overworld') {
      const t = state.worldTime;
      const hours = Math.floor(t * 24);
      const mins = Math.floor((t * 24 - hours) * 60);
      const icon = t > 0.28 && t < 0.72 ? '☀️' : t < 0.22 || t > 0.8 ? '🌙' : t <= 0.28 ? '🌅' : '🌆';
      this.zoneTime.textContent = `${icon} ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    } else {
      this.zoneTime.textContent = '';
    }

    if (now - this.lastMinimapDraw > 180) {
      this.lastMinimapDraw = now;
      this.drawMinimap(state);
    }
  }

  private drawMinimap(state: WorldState): void {
    const ctx = this.minimapCtx;
    const size = this.minimap.width;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    const map = state.map;
    if (!map) return;
    const viewTiles = 46; // tiles across
    const px = size / viewTiles;
    const ctx0 = worldToTile(state.x) - viewTiles / 2;
    const cty0 = worldToTile(state.y) - viewTiles / 2;

    for (let vy = 0; vy < viewTiles; vy++) {
      for (let vx = 0; vx < viewTiles; vx++) {
        const t = map.get(ctx0 + vx, cty0 + vy);
        let color: string | null = null;
        switch (t) {
          case Tile.Grass: color = GRASS_MINIMAP[map.biomeAt(ctx0 + vx, cty0 + vy)] ?? '#2a3d20'; break;
          case Tile.Road: color = '#584a33'; break;
          case Tile.Tree: color = TREE_MINIMAP[map.biomeAt(ctx0 + vx, cty0 + vy)] ?? '#1c2c14'; break;
          case Tile.Water: color = '#16324a'; break;
          case Tile.Rock: color = '#3d3a36'; break;
          case Tile.Floor: color = '#4a4152'; break;
          case Tile.Wall: color = '#191521'; break;
          case Tile.Door: color = '#6b532c'; break;
          case Tile.StairsDown: color = '#d8b45a'; break;
          case Tile.PortalPad: color = '#8a5dd8'; break;
          case Tile.Spikes: color = '#7a2a2a'; break;
        }
        if (color) {
          ctx.fillStyle = color;
          ctx.fillRect(vx * px, vy * px, Math.ceil(px), Math.ceil(px));
        }
      }
    }

    // entities
    for (const e of state.entities.values()) {
      const l = e.latest;
      if (l.a === 'dead') continue;
      let color: string | null = null;
      if (l.k === 'monster') color = '#e05545';
      else if (l.k === 'player') color = '#ffffff';
      else if (l.k === 'npc') color = '#7ec87e';
      else if (l.k === 'portal') color = '#bb77ff';
      else if (l.k === 'loot') color = '#d8b45a';
      if (!color) continue;
      const ex = (worldToTile(l.x) - ctx0) * px;
      const ey = (worldToTile(l.y) - cty0) * px;
      if (ex < 0 || ey < 0 || ex > size || ey > size) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
    }

    // self
    ctx.fillStyle = '#ffe08a';
    ctx.fillRect(size / 2 - 2, size / 2 - 2, 4, 4);
  }
}
