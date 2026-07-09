import * as THREE from 'three';
import { Tile, angleDiff, worldToTile } from '@webmagic/shared';
import type { WorldState } from '../state';
import { spriteDef, type SpriteDef } from './textures';

interface SpriteInstance {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
  variant: string;
  h: number;
  flashUntil: number;
  /** Attack telegraph: amber tint + a swelling pulse while winding up. */
  telegraphUntil: number;
  views?: SpriteDef['views'];
  curView?: string;
  /** Floating name + level plate. */
  plate?: THREE.Mesh;
  plateKey?: string;
}

// ---------------------------------------------------------------- nameplates

/** Fixtures never get nameplates even though they carry names. */
const PLATELESS = new Set(['signpost', 'campfire', 'shrine', 'obelisk']);

/** Name colour by what you're looking at: white heroes, green folk, red threats. */
function plateColor(kind: string): string {
  if (kind === 'player') return '#ffffff';
  if (kind === 'monster') return '#ff7a66';
  return '#7ec87e';
}

const plateCache = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();
const PLATE_GEO = new THREE.PlaneGeometry(1, 1);

function plateTexture(name: string, lvl: number | undefined, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const key = `${name}|${lvl ?? ''}|${color}`;
  let entry = plateCache.get(key);
  if (entry) return entry;

  const font = 'bold 26px "Courier New", monospace';
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const lvlText = lvl !== undefined ? ` ${lvl}` : '';
  const nameW = ctx.measureText(name).width;
  const lvlW = lvlText ? ctx.measureText(lvlText).width : 0;
  c.width = Math.ceil(nameW + lvlW) + 16;
  c.height = 40;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#10101a';
  ctx.strokeText(name, 8, 22);
  ctx.fillStyle = color;
  ctx.fillText(name, 8, 22);
  if (lvlText) {
    ctx.strokeText(lvlText, 8 + nameW, 22);
    ctx.fillStyle = '#d8b45a'; // level always reads gold
    ctx.fillText(lvlText, 8 + nameW, 22);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  entry = { texture, aspect: c.width / c.height };
  plateCache.set(key, entry);
  return entry;
}

/**
 * Doom-style billboard sprites for every replicated entity. Lambert materials
 * mean sprites react to torch light and spells; emissive things (portals,
 * bolts, glowing loot) use basic materials so they shine in the dark.
 */
/** NPC/monster types that get per-entity palette variants for crowd variety. */
const VARIED = new Set(['villager', 'guard', 'caravan-guard', 'goblin', 'orc', 'skeleton', 'imp', 'ogre']);

/** Stable sprite key: adds a palette-variant suffix for varied crowd types. */
function spriteKey(variant: string, id: number): string {
  return VARIED.has(variant) ? `${variant}#${id % 4}` : variant;
}

export class EntitySprites {
  readonly group = new THREE.Group();
  private instances = new Map<number, SpriteInstance>();

  sync(state: WorldState, now: number, camX: number, camZ: number): void {
    const seen = new Set<number>();

    for (const [id, e] of state.entities) {
      if (e.latest.k === 'portal') continue; // portals are drawn by PortalFx
      seen.add(id);
      const key = spriteKey(e.latest.v, id);
      let inst = this.instances.get(id);
      if (inst && inst.variant !== key) {
        this.removeInstance(id);
        inst = undefined;
      }
      if (!inst) {
        const def = spriteDef(key);
        const geo = new THREE.PlaneGeometry(def.w, def.h);
        const mat = def.emissive
          ? new THREE.MeshBasicMaterial({ map: def.texture, transparent: true, alphaTest: 0.05, depthWrite: false })
          : new THREE.MeshLambertMaterial({ map: def.texture, alphaTest: 0.5, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        this.group.add(mesh);
        inst = { mesh, mat, variant: key, h: def.h, flashUntil: 0, telegraphUntil: 0, views: def.views };
        this.instances.set(id, inst);
      }

      const p = state.sample(e, now);
      const dead = e.latest.a === 'dead';

      // Directional billboards: pick front/back/side from facing vs. the camera.
      if (inst.views && !dead) {
        const camAngle = Math.atan2(camZ - p.y, camX - p.x);
        const rel = angleDiff(p.f, camAngle);
        const a = Math.abs(rel);
        let view: 'front' | 'back' | 'side';
        let mirror = false;
        if (a <= Math.PI / 4) view = 'front';
        else if (a >= (3 * Math.PI) / 4) view = 'back';
        else { view = 'side'; mirror = rel < 0; }
        if (inst.curView !== view) {
          inst.mat.map = inst.views[view];
          inst.mat.needsUpdate = true;
          inst.curView = view;
        }
        inst.mesh.scale.x = mirror ? -1 : 1;
      }
      let yBase = inst.h / 2;
      if (e.latest.k === 'loot') {
        yBase = inst.h / 2 + 0.15 + Math.sin(now * 0.003 + id) * 0.08; // hovering loot
      } else if (e.latest.a === 'move' && !dead) {
        yBase += Math.abs(Math.sin(now * 0.012 + id)) * 0.09; // walk bob
      }

      const ground = state.map ? state.map.elevationAtWorld(p.x, p.y) : 0;
      // Creatures wading through water sink hip-deep.
      let sink = 0;
      if (!dead && state.map && (e.latest.k === 'player' || e.latest.k === 'monster' || e.latest.k === 'npc')) {
        if (state.map.get(worldToTile(p.x), worldToTile(p.y)) === Tile.Water) sink = 0.42;
      }
      inst.mesh.position.set(p.x, ground + (dead ? 0.25 : yBase + p.z) - sink, p.y);
      // billboard toward camera (yaw only)
      inst.mesh.rotation.y = Math.atan2(camX - p.x, camZ - p.y);

      // --- nameplate: name + level floating above the head
      this.syncPlate(inst, e.latest.n, e.latest.lvl, e.latest.k, dead);
      if (inst.plate) {
        const dx = camX - p.x;
        const dz = camZ - p.y;
        inst.plate.visible = !dead && dx * dx + dz * dz < 30 * 30; // declutter far crowds
        inst.plate.position.set(p.x, ground + inst.h + p.z - sink + 0.32, p.y);
        inst.plate.rotation.y = inst.mesh.rotation.y;
      }
      if (dead) {
        inst.mesh.rotation.x = -Math.PI / 2.2;
        setTint(inst, 0x555555);
        inst.mesh.scale.y = 1;
      } else {
        inst.mesh.rotation.x = 0;
        if (inst.flashUntil > now) {
          setTint(inst, 0xff6655);
        } else if (inst.telegraphUntil > now) {
          // wind-up telegraph: amber flare + a rearing pulse you can react to
          setTint(inst, 0xffa030);
        } else if (e.latest.a === 'attack') {
          setTint(inst, 0xffddaa);
        } else {
          setTint(inst, 0xffffff);
        }
        inst.mesh.scale.y = inst.telegraphUntil > now ? 1 + Math.sin(now * 0.03) * 0.05 + 0.05 : 1;
      }
    }

    for (const id of [...this.instances.keys()]) {
      if (!seen.has(id)) this.removeInstance(id);
    }
  }

  /** Create/replace/remove the floating name+level plate as needed. */
  private syncPlate(inst: SpriteInstance, name: string | undefined, lvl: number | undefined, kind: string, dead: boolean): void {
    const wants = !dead && !!name && (kind === 'player' || kind === 'monster' || kind === 'npc') && !PLATELESS.has(inst.variant.split('#')[0]);
    const key = wants ? `${name}|${lvl ?? ''}|${kind}` : undefined;
    if (inst.plateKey === key) return;
    if (inst.plate) {
      this.group.remove(inst.plate);
      (inst.plate.material as THREE.Material).dispose(); // texture stays cached
      inst.plate = undefined;
    }
    inst.plateKey = key;
    if (!wants || !name) return;
    const { texture, aspect } = plateTexture(name, lvl, plateColor(kind));
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // names read through the world, MMO-style
      depthWrite: false,
    });
    const plate = new THREE.Mesh(PLATE_GEO, mat);
    plate.renderOrder = 10;
    const h = 0.32;
    plate.scale.set(h * aspect, h, 1);
    this.group.add(plate);
    inst.plate = plate;
  }

  /** Brief red flash when an entity takes a hit. */
  flash(id: number, now: number): void {
    const inst = this.instances.get(id);
    if (inst) inst.flashUntil = now + 130;
  }

  /** Amber wind-up telegraph for the given duration (an incoming attack). */
  telegraph(id: number, now: number, durMs: number): void {
    const inst = this.instances.get(id);
    if (inst) inst.telegraphUntil = now + durMs;
  }

  private removeInstance(id: number): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.group.remove(inst.mesh);
    inst.mesh.geometry.dispose();
    inst.mat.dispose();
    if (inst.plate) {
      this.group.remove(inst.plate);
      (inst.plate.material as THREE.Material).dispose();
    }
    this.instances.delete(id);
  }

  clear(): void {
    for (const id of [...this.instances.keys()]) this.removeInstance(id);
  }
}

function setTint(inst: SpriteInstance, hex: number): void {
  inst.mat.color.setHex(hex);
}
