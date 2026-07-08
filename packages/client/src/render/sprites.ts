import * as THREE from 'three';
import { angleDiff } from '@webmagic/shared';
import type { WorldState } from '../state';
import { spriteDef, type SpriteDef } from './textures';

interface SpriteInstance {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;
  variant: string;
  h: number;
  flashUntil: number;
  views?: SpriteDef['views'];
  curView?: string;
}

/**
 * Doom-style billboard sprites for every replicated entity. Lambert materials
 * mean sprites react to torch light and spells; emissive things (portals,
 * bolts, glowing loot) use basic materials so they shine in the dark.
 */
export class EntitySprites {
  readonly group = new THREE.Group();
  private instances = new Map<number, SpriteInstance>();

  sync(state: WorldState, now: number, camX: number, camZ: number): void {
    const seen = new Set<number>();

    for (const [id, e] of state.entities) {
      seen.add(id);
      let inst = this.instances.get(id);
      if (inst && inst.variant !== e.latest.v) {
        this.removeInstance(id);
        inst = undefined;
      }
      if (!inst) {
        const def = spriteDef(e.latest.v);
        const geo = new THREE.PlaneGeometry(def.w, def.h);
        const mat = def.emissive
          ? new THREE.MeshBasicMaterial({ map: def.texture, transparent: true, alphaTest: 0.05, depthWrite: false })
          : new THREE.MeshLambertMaterial({ map: def.texture, alphaTest: 0.5, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        this.group.add(mesh);
        inst = { mesh, mat, variant: e.latest.v, h: def.h, flashUntil: 0, views: def.views };
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

      inst.mesh.position.set(p.x, dead ? 0.25 : yBase + p.z, p.y);
      // billboard toward camera (yaw only)
      inst.mesh.rotation.y = Math.atan2(camX - p.x, camZ - p.y);
      if (dead) {
        inst.mesh.rotation.x = -Math.PI / 2.2;
        setTint(inst, 0x555555);
      } else {
        inst.mesh.rotation.x = 0;
        if (inst.flashUntil > now) {
          setTint(inst, 0xff6655);
        } else if (e.latest.a === 'attack') {
          setTint(inst, 0xffddaa);
        } else {
          setTint(inst, 0xffffff);
        }
      }
      // portals slowly pulse
      if (e.latest.k === 'portal') {
        const s = 1 + Math.sin(now * 0.002 + id) * 0.06;
        inst.mesh.scale.set(s, s, 1);
      }
    }

    for (const id of [...this.instances.keys()]) {
      if (!seen.has(id)) this.removeInstance(id);
    }
  }

  /** Brief red flash when an entity takes a hit. */
  flash(id: number, now: number): void {
    const inst = this.instances.get(id);
    if (inst) inst.flashUntil = now + 130;
  }

  private removeInstance(id: number): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.group.remove(inst.mesh);
    inst.mesh.geometry.dispose();
    inst.mat.dispose();
    this.instances.delete(id);
  }

  clear(): void {
    for (const id of [...this.instances.keys()]) this.removeInstance(id);
  }
}

function setTint(inst: SpriteInstance, hex: number): void {
  inst.mat.color.setHex(hex);
}
