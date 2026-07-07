import * as THREE from 'three';
import { Vec2 } from '@webmagic/shared';

const MAX_LIGHTS = 14;
const TORCH_COLOR = 0xff9440;

interface Candidate {
  x: number;
  y: number; // world plane y == three z
  height: number;
  color: number;
  intensity: number;
  range: number;
  flicker: number; // 0..1 amount
  seed: number;
}

/**
 * Reactive lighting on a budget: a fixed pool of point lights is reassigned
 * every frame to the nearest/strongest light sources — static torches, the
 * player's lantern, glowing projectiles, portals and rare loot.
 */
export class LightPool {
  private lights: THREE.PointLight[] = [];
  private torches: Vec2[] = [];

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.8);
      scene.add(l);
      this.lights.push(l);
    }
  }

  setTorches(torches: Vec2[]): void {
    this.torches = torches;
  }

  /**
   * @param dynamics lights from entities (projectiles, portals, loot glow)
   * @param lantern the player's own light (position + strength scale)
   */
  update(
    camX: number,
    camY: number,
    time: number,
    nightness: number,
    dynamics: Candidate[],
    lantern: { x: number; y: number; on: boolean }
  ): void {
    const candidates: Candidate[] = [];

    // Torches matter more at night / in dungeons.
    const torchIntensity = 8 + nightness * 8;
    for (const t of this.torches) {
      const dx = t.x - camX;
      const dy = t.y - camY;
      const d2 = dx * dx + dy * dy;
      if (d2 > 55 * 55) continue;
      candidates.push({
        x: t.x, y: t.y, height: 2.0,
        color: TORCH_COLOR, intensity: torchIntensity, range: 11,
        flicker: 0.35, seed: (t.x * 13 + t.y * 7) % 100,
      });
    }
    candidates.push(...dynamics);
    if (lantern.on) {
      candidates.push({
        x: lantern.x, y: lantern.y, height: 1.8,
        color: 0xffc890, intensity: 3 + nightness * 6, range: 13,
        flicker: 0.12, seed: 3,
      });
    }

    candidates.sort((a, b) => {
      const da = (a.x - camX) ** 2 + (a.y - camY) ** 2;
      const db = (b.x - camX) ** 2 + (b.y - camY) ** 2;
      return da - db;
    });

    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const c = candidates[i];
      if (!c) {
        l.intensity = 0;
        continue;
      }
      l.position.set(c.x, c.height, c.y);
      l.color.setHex(c.color);
      l.distance = c.range;
      const fl = c.flicker > 0
        ? 1 - c.flicker / 2 + c.flicker * (Math.sin(time * 9 + c.seed * 17) * 0.5 + Math.sin(time * 23 + c.seed * 5) * 0.5) * 0.5
        : 1;
      l.intensity = c.intensity * fl;
    }
  }
}

export type LightCandidate = Candidate;
