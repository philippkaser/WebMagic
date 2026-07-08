import * as THREE from 'three';
import { portalSwirlTexture } from './textures';

interface PortalView {
  root: THREE.Group;
  disc: THREE.Mesh;
  discMat: THREE.MeshBasicMaterial;
  rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[];
  variant: string;
}

export interface PortalTarget {
  id: number;
  x: number;
  y: number;
  variant: string;
}

/**
 * A fancy animated portal: a spinning swirl disc, a bright core, and a couple
 * of pulsing rotating rings — all additive so it glows in the dark. Replaces
 * the flat billboard sprite for portal entities.
 */
export class PortalFx {
  readonly group = new THREE.Group();
  private views = new Map<number, PortalView>();

  private build(variant: string): PortalView {
    const kind = variant === 'portal-exit' ? 'portal-exit' : 'portal';
    const ringColor = kind === 'portal-exit' ? 0x55ccff : 0xaa66ff;
    const root = new THREE.Group();

    const discMat = new THREE.MeshBasicMaterial({
      map: portalSwirlTexture(kind),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.5, 32), discMat);
    root.add(disc);

    const rings: PortalView['rings'] = [];
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.62, 40), mat);
      root.add(mesh);
      rings.push({ mesh, mat });
    }
    return { root, disc, discMat, rings, variant };
  }

  sync(portals: PortalTarget[], now: number, camX: number, camZ: number, elevation: (x: number, y: number) => number): void {
    const seen = new Set<number>();
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
      v.root.position.set(p.x, 1.9 + elevation(p.x, p.y), p.y);
      v.root.rotation.y = Math.atan2(camX - p.x, camZ - p.y); // billboard toward camera

      if (v.discMat.map) v.discMat.map.rotation = now * 0.0009; // swirl spin
      const pulse = 1 + Math.sin(now * 0.004) * 0.06;
      v.disc.scale.set(pulse, pulse, 1);
      v.discMat.opacity = 0.85 + Math.sin(now * 0.006) * 0.12;

      v.rings.forEach((r, i) => {
        const t = now * 0.001 + i * 1.7;
        const s = 1 + i * 0.28 + Math.sin(t * 1.6) * 0.1;
        r.mesh.scale.set(s, s, 1);
        r.mesh.rotation.z = t * (i % 2 ? -0.8 : 1); // counter-rotating
        r.mat.opacity = 0.45 + Math.sin(t * 2.1) * 0.3;
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
