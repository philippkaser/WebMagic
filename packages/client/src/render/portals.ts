import * as THREE from 'three';
import { portalWaveTexture, redrawPortalWaves } from './textures';

interface PortalView {
  root: THREE.Group;
  disc: THREE.Mesh;
  discMat: THREE.MeshBasicMaterial;
  waveTex: ReturnType<typeof portalWaveTexture>;
  rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[];
  kind: 'portal' | 'portal-exit';
  variant: string;
}

export interface PortalTarget {
  id: number;
  x: number;
  y: number;
  variant: string;
}

/**
 * A pixelated wave portal: a chunky-pixel face of concentric waves rippling out
 * from a bright core, plus a few thin rings that expand outward like ripples.
 * Additive so it glows in the dark. Drawn instead of the flat billboard sprite.
 */
export class PortalFx {
  readonly group = new THREE.Group();
  private views = new Map<number, PortalView>();

  private build(variant: string): PortalView {
    const kind: PortalView['kind'] = variant === 'portal-exit' ? 'portal-exit' : 'portal';
    const ringColor = kind === 'portal-exit' ? 0x66ddff : 0xc07bff;
    const root = new THREE.Group();

    const waveTex = portalWaveTexture(kind);
    const discMat = new THREE.MeshBasicMaterial({
      map: waveTex.texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.5, 40), discMat);
    root.add(disc);

    // Thin rings that expand outward as ripples.
    const rings: PortalView['rings'] = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 28), mat);
      root.add(mesh);
      rings.push({ mesh, mat });
    }
    return { root, disc, discMat, waveTex, rings, kind, variant };
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

      // Animate the pixelated wave face once per kind (textures are shared).
      if (!redrawn.has(v.kind)) {
        redrawPortalWaves(v.waveTex, now * 0.0007);
        redrawn.add(v.kind);
      }

      v.root.position.set(p.x, 1.9 + elevation(p.x, p.y), p.y);
      v.root.rotation.y = Math.atan2(camX - p.x, camZ - p.y); // billboard toward camera
      const pulse = 1 + Math.sin(now * 0.004) * 0.05;
      v.disc.scale.set(pulse, pulse, 1);
      v.discMat.opacity = 0.85 + Math.sin(now * 0.006) * 0.12;

      // Expanding ripple rings, staggered so waves emanate continuously.
      v.rings.forEach((r, i) => {
        const phase = ((now * 0.0006 + i / v.rings.length) % 1 + 1) % 1;
        const radius = 0.45 + phase * 1.9;
        r.mesh.scale.set(radius, radius, 1);
        r.mat.opacity = (1 - phase) * 0.55;
      });
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.remove(id);
  }

  private remove(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.disc.geometry.dispose();
    v.discMat.dispose();
    for (const r of v.rings) {
      r.mesh.geometry.dispose();
      r.mat.dispose();
    }
    this.views.delete(id);
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }
}
