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

interface Burst {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.PointsMaterial;
  vel: Float32Array; // 3 per particle
  drag: number;
  gravity: number;
  ttl: number;
  maxTtl: number;
}

/**
 * Transient presentation: floating combat numbers (DOM, projected) and
 * expanding nova rings (meshes). Purely cosmetic — driven by fx messages.
 */
export class FxManager {
  private texts: FloatText[] = [];
  private rings: NovaRing[] = [];
  private blasts: Blast[] = [];
  private bursts: Burst[] = [];
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

  /** Fireball detonation: an additive shockwave sphere + ground ring + embers. */
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
    this.sparks(x, z, color, Math.round(14 + radius * 6));
  }

  /**
   * A burst of `count` particles thrown outward from (x, z) at height `y`.
   * Pooled meshes disposed when they fade. Additive by default (embers/sparks);
   * pass `soft` for opaque dust.
   */
  private spawnBurst(
    x: number,
    y: number,
    z: number,
    count: number,
    color: number,
    opts: { speed: number; size: number; ttl: number; gravity: number; drag: number; soft?: boolean }
  ): void {
    if (this.bursts.length > 40) return;
    const n = Math.min(count, 60);
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // random direction, biased upward
      const a = Math.random() * Math.PI * 2;
      const up = opts.soft ? Math.random() * 0.4 + 0.1 : Math.random() * 0.9 + 0.1;
      const horiz = Math.sqrt(Math.max(0, 1 - up * up)) * (0.4 + Math.random() * 0.6);
      const spd = opts.speed * (0.5 + Math.random() * 0.7);
      vel[i * 3] = Math.cos(a) * horiz * spd;
      vel[i * 3 + 1] = up * spd;
      vel[i * 3 + 2] = Math.sin(a) * horiz * spd;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size: opts.size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: opts.soft ? THREE.NormalBlending : THREE.AdditiveBlending,
      fog: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.bursts.push({ points, geo, mat, vel, drag: opts.drag, gravity: opts.gravity, ttl: opts.ttl, maxTtl: opts.ttl });
  }

  /** Bright embers flung from an impact. */
  sparks(x: number, z: number, color: number, count = 12): void {
    this.spawnBurst(x, 0.9, z, count, color, { speed: 7, size: 0.22, ttl: 0.55, gravity: 12, drag: 2.5 });
  }

  /** Soft dust puff — a landing, a footfall. */
  dust(x: number, z: number): void {
    this.spawnBurst(x, 0.15, z, 10, 0xb9a888, { speed: 2.2, size: 0.35, ttl: 0.5, gravity: 1.5, drag: 3.5, soft: true });
  }

  /** Rising purple motes — a hovering wizard's arcane wake. */
  magicTrail(x: number, z: number): void {
    this.spawnBurst(x, 0.9, z, 3, 0xb060ff, { speed: 1.1, size: 0.3, ttl: 0.75, gravity: -0.5, drag: 1.8 });
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

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.ttl -= dt;
      if (b.ttl <= 0) {
        this.scene.remove(b.points);
        b.geo.dispose();
        b.mat.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      const attr = b.geo.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const damp = Math.max(0, 1 - b.drag * dt);
      for (let p = 0; p < arr.length; p += 3) {
        b.vel[p] *= damp;
        b.vel[p + 1] = (b.vel[p + 1] - b.gravity * dt) * damp;
        b.vel[p + 2] *= damp;
        arr[p] += b.vel[p] * dt;
        arr[p + 1] = Math.max(0.02, arr[p + 1] + b.vel[p + 1] * dt);
        arr[p + 2] += b.vel[p + 2] * dt;
      }
      attr.needsUpdate = true;
      b.mat.opacity = b.ttl / b.maxTtl;
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
    for (const b of this.bursts) {
      this.scene.remove(b.points);
      b.geo.dispose();
      b.mat.dispose();
    }
    this.bursts = [];
  }
}
