import * as THREE from 'three';

interface FloatText {
  el: HTMLDivElement;
  x: number;
  y: number; // world height
  z: number;
  vy: number;
  ttl: number;
}

interface NovaRing {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  ttl: number;
  maxTtl: number;
  targetRadius: number;
}

interface Blast {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  ttl: number;
  maxTtl: number;
  targetRadius: number;
}

/**
 * Transient presentation: floating combat numbers (DOM, projected) and
 * expanding nova rings (meshes). Purely cosmetic — driven by fx messages.
 */
export class FxManager {
  private texts: FloatText[] = [];
  private rings: NovaRing[] = [];
  private blasts: Blast[] = [];
  private readonly overlay: HTMLElement;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene, overlay: HTMLElement) {
    this.scene = scene;
    this.overlay = overlay;
  }

  damageNumber(x: number, z: number, text: string, color: string, size = 15): void {
    if (this.texts.length > 60) return;
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = `${size}px`;
    this.overlay.appendChild(el);
    this.texts.push({ el, x, y: 1.9 + Math.random() * 0.4, z, vy: 1.4, ttl: 1.1 });
  }

  nova(x: number, z: number, color: number, radius: number): void {
    const geo = new THREE.RingGeometry(0.3, 0.55, 32);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.1, z);
    this.scene.add(mesh);
    this.rings.push({ mesh, mat, ttl: 0.45, maxTtl: 0.45, targetRadius: radius });
  }

  /** Fireball detonation: an additive shockwave sphere + ground ring. */
  explosion(x: number, z: number, color: number, radius: number): void {
    const geo = new THREE.SphereGeometry(0.5, 12, 8);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 1.0, z);
    this.scene.add(mesh);
    this.blasts.push({ mesh, mat, ttl: 0.38, maxTtl: 0.38, targetRadius: radius });
    this.nova(x, z, color, radius * 0.8);
  }

  update(dt: number, camera: THREE.Camera, width: number, height: number): void {
    const v = new THREE.Vector3();
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.ttl -= dt;
      t.y += t.vy * dt;
      if (t.ttl <= 0) {
        t.el.remove();
        this.texts.splice(i, 1);
        continue;
      }
      v.set(t.x, t.y, t.z).project(camera);
      if (v.z > 1 || v.z < -1) {
        t.el.style.display = 'none';
        continue;
      }
      t.el.style.display = 'block';
      t.el.style.left = `${((v.x + 1) / 2) * width}px`;
      t.el.style.top = `${((1 - v.y) / 2) * height}px`;
      t.el.style.opacity = String(Math.min(1, t.ttl * 2));
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.ttl -= dt;
      if (b.ttl <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mat.dispose();
        this.blasts.splice(i, 1);
        continue;
      }
      const progress = 1 - b.ttl / b.maxTtl;
      // fast expansion with ease-out, whitening core then fading
      const s = 0.4 + Math.sqrt(progress) * b.targetRadius * 2;
      b.mesh.scale.set(s, s, s);
      b.mat.opacity = 0.95 * (1 - progress) * (1 - progress);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.ttl -= dt;
      if (r.ttl <= 0) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mat.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const progress = 1 - r.ttl / r.maxTtl;
      const s = 1 + progress * r.targetRadius * 2;
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = 0.9 * (1 - progress);
    }
  }

  clear(): void {
    for (const t of this.texts) t.el.remove();
    this.texts = [];
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      r.mesh.geometry.dispose();
      r.mat.dispose();
    }
    this.rings = [];
    for (const b of this.blasts) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.blasts = [];
  }
}
