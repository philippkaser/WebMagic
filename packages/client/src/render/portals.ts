import * as THREE from 'three';
import { PORTAL_RIFT_ASPECT, portalGlowTexture, portalRiftTexture, redrawPortalRift } from './textures';

interface PortalView {
  root: THREE.Group;
  rift: THREE.Mesh;
  riftMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  tex: ReturnType<typeof portalRiftTexture>;
  kind: 'portal' | 'portal-exit';
  variant: string;
}

export interface PortalTarget {
  id: number;
  x: number;
  y: number;
  variant: string;
}

const RIFT_H = 3.8;
const RIFT_W = RIFT_H * PORTAL_RIFT_ASPECT;

/**
 * A "tear in the fabric of space": a tall jagged pixel rift with a glowing torn
 * edge and crackling void energy, over a soft additive glow. Drawn instead of
 * the flat billboard sprite for portal entities.
 */
export class PortalFx {
  readonly group = new THREE.Group();
  private views = new Map<number, PortalView>();

  private build(variant: string): PortalView {
    const kind: PortalView['kind'] = variant === 'portal-exit' ? 'portal-exit' : 'portal';
    const glowColor = kind === 'portal-exit' ? 0x2b8fd8 : 0x8a3bd8;
    const root = new THREE.Group();

    // Soft halo behind the tear.
    const glowMat = new THREE.MeshBasicMaterial({
      color: glowColor,
      map: portalGlowTexture(),
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(RIFT_W * 3, RIFT_H * 1.5), glowMat);
    glow.position.z = -0.05;
    root.add(glow);

    const tex = portalRiftTexture(kind);
    const riftMat = new THREE.MeshBasicMaterial({
      map: tex.texture,
      transparent: true,
      alphaTest: 0.02,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const rift = new THREE.Mesh(new THREE.PlaneGeometry(RIFT_W, RIFT_H), riftMat);
    root.add(rift);

    return { root, rift, riftMat, glowMat, tex, kind, variant };
  }

  sync(portals: PortalTarget[], now: number, camX: number, camZ: number, elevation: (x: number, y: number) => number): void {
    const seen = new Set<number>();
    const redrawn = new Set<string>();
    for (const p of portals) {
      seen.add(p.id);
      let v = this.views.get(p.id);
      if (v && v.variant !== p.variant) {
        this.remove(p.id);
        v = undefined;
      }
      if (!v) {
        v = this.build(p.variant);
        this.group.add(v.root);
        this.views.set(p.id, v);
      }

      // Animate the pixel rift once per kind (textures are shared).
      if (!redrawn.has(v.kind)) {
        redrawPortalRift(v.tex, now * 0.0009);
        redrawn.add(v.kind);
      }

      v.root.position.set(p.x, RIFT_H / 2 + 0.2 + elevation(p.x, p.y), p.y);
      v.root.rotation.y = Math.atan2(camX - p.x, camZ - p.y); // billboard toward camera
      v.glowMat.opacity = 0.22 + Math.sin(now * 0.005) * 0.08;
      v.riftMat.opacity = 0.9 + Math.sin(now * 0.013) * 0.1; // subtle flicker
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.remove(id);
  }

  private remove(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.rift.geometry.dispose();
    v.riftMat.dispose();
    v.glowMat.dispose();
    this.views.delete(id);
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }
}
