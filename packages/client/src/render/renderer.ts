import * as THREE from 'three';
import { dist, lerp } from '@webmagic/shared';
import type { WorldState } from '../state';
import type { Input } from '../input';
import { LevelMesh } from './level';
import { LightPool, LightCandidate } from './lights';
import { EntitySprites } from './sprites';
import { FxManager } from './fx';
import { spriteDef } from './textures';

/** Render at 1/N resolution and upscale — the chunky retro look. */
const PIXEL_SCALE = 3;
const EYE_HEIGHT = 1.55;

const DAY_SKY = new THREE.Color(0x7a94b8);
const DUSK_SKY = new THREE.Color(0x8a4a30);
const NIGHT_SKY = new THREE.Color(0x0a0a16);
const DUNGEON_FOG = new THREE.Color(0x060409);

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private lights: LightPool;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private moon: THREE.DirectionalLight;
  private stars: THREE.Points;
  private starsMat: THREE.PointsMaterial;
  private level: LevelMesh | null = null;
  private torchFlames: THREE.Mesh[] = [];
  readonly sprites = new EntitySprites();
  readonly fx: FxManager;
  private bobPhase = 0;
  private lastNowSec = 0;

  // --- camera juice (screen shake + springy kicks)
  private readonly baseFov = 72;
  private trauma = 0; // 0..1, decays; shake scales with trauma²
  private pitchKick = 0;
  private pitchKickV = 0;
  private landDip = 0;
  private landDipV = 0;
  private fovKick = 0;
  private fovKickV = 0;

  constructor(container: HTMLElement, overlay: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic rolloff keeps torches/lanterns from blowing out nearby surfaces.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 220);
    this.camera.rotation.order = 'YXZ';

    this.hemi = new THREE.HemisphereLight(0xbaccdd, 0x33281e, 1);
    this.scene.add(this.hemi);

    // Sun + moon travel across the sky with the world clock.
    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.moon = new THREE.DirectionalLight(0x8899cc, 0);
    this.scene.add(this.moon);
    this.scene.add(this.moon.target);

    // Night sky: a dome of stars that follows the camera.
    const starPos: number[] = [];
    for (let i = 0; i < 420; i++) {
      const az = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.48 + 0.05;
      const r = 180;
      starPos.push(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xcdd8ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    this.lights = new LightPool(this.scene);
    this.scene.add(this.sprites.group);
    this.scene.fog = new THREE.Fog(0x000000, 20, 90);
    this.fx = new FxManager(this.scene, overlay);

    const resize = () => {
      const w = Math.floor(window.innerWidth / PIXEL_SCALE);
      const h = Math.floor(window.innerHeight / PIXEL_SCALE);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
  }

  /** Rebuild static level geometry when the zone changes. */
  setZone(state: WorldState): void {
    if (this.level) {
      this.scene.remove(this.level.group);
      this.level.dispose();
      this.level = null;
    }
    for (const f of this.torchFlames) {
      this.scene.remove(f);
      f.geometry.dispose();
      (f.material as THREE.Material).dispose();
    }
    this.torchFlames = [];
    this.sprites.clear();
    this.fx.clear();
    if (!state.map || !state.zone) return;

    this.level = new LevelMesh();
    this.level.build(state.map, state.zone.kind);
    this.scene.add(this.level.group);

    const torches = state.overworld?.torches ?? state.dungeonFloor?.torches ?? [];
    this.lights.setTorches(torches);
    const flameDef = spriteDef('torch');
    for (const t of torches) {
      const geo = new THREE.PlaneGeometry(flameDef.w, flameDef.h);
      const mat = new THREE.MeshBasicMaterial({ map: flameDef.texture, transparent: true, alphaTest: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(t.x, 2.0, t.y);
      this.scene.add(mesh);
      this.torchFlames.push(mesh);
    }
  }

  render(state: WorldState, input: Input, now: number, dt: number, moving: boolean, camZ = 0): void {
    const isDungeon = state.zone?.kind === 'dungeon';

    // --- day/night atmosphere
    this.lastNowSec = now / 1000;
    let nightness: number;
    if (isDungeon) {
      nightness = 1;
      this.scene.background = DUNGEON_FOG;
      this.scene.fog = new THREE.Fog(DUNGEON_FOG, 6, 46);
      this.hemi.intensity = 0.5;
      this.hemi.color.setHex(0x6a6f88);
      this.hemi.groundColor.setHex(0x201a2c);
      this.sun.intensity = 0;
      this.moon.intensity = 0;
      this.stars.visible = false;
    } else {
      const t = state.worldTime;
      const sunAngle = (t - 0.25) * Math.PI * 2; // elevation phase: 0 at sunrise
      const daylight = Math.max(0, Math.sin(sunAngle));
      const duskiness = Math.max(0, 1 - Math.abs(daylight - 0.18) * 6);
      nightness = 1 - daylight;
      const sky = NIGHT_SKY.clone().lerp(DAY_SKY, daylight).lerp(DUSK_SKY, duskiness * 0.5);
      this.scene.background = sky;
      this.scene.fog = new THREE.Fog(sky, 24, 110);
      this.hemi.intensity = 0.14 + daylight * 0.75;
      this.hemi.color.setHex(0xbaccdd);
      this.hemi.groundColor.setHex(0x33281e);

      // travelling sun — warm and low at dawn/dusk, white at noon
      const sunDir = new THREE.Vector3(Math.cos(sunAngle), Math.sin(sunAngle), 0.35).normalize();
      this.sun.position.copy(this.camera.position).addScaledVector(sunDir, 120);
      this.sun.target.position.copy(this.camera.position);
      this.sun.intensity = daylight * 1.0;
      this.sun.color.setHex(0xfff2dd).lerp(new THREE.Color(0xffb060), duskiness);

      // faint blue moonlight so nights read as night, not as a black screen
      this.moon.position.copy(this.camera.position).addScaledVector(new THREE.Vector3(-sunDir.x, Math.max(0.35, -sunDir.y), -0.3).normalize(), 120);
      this.moon.target.position.copy(this.camera.position);
      this.moon.intensity = nightness * 0.22;

      this.stars.visible = true;
      this.stars.position.set(this.camera.position.x, 0, this.camera.position.z);
      this.starsMat.opacity = Math.max(0, nightness - 0.35) * 1.4;
    }

    // --- camera (base pose + juice: trauma shake, springy kicks, landing dip)
    this.updateCameraFx(dt);
    this.bobPhase = moving ? this.bobPhase + dt * 9 : 0;
    const bob = Math.sin(this.bobPhase) * 0.045;
    const shake = this.trauma * this.trauma;
    const st = now * 0.001;
    const shakeYaw = shake * 0.055 * Math.sin(st * 62 + 1.3);
    const shakePitch = shake * 0.05 * Math.sin(st * 71 + 4.1);
    const shakeRoll = shake * 0.09 * Math.sin(st * 55 + 2.7);
    this.camera.position.set(state.x, EYE_HEIGHT + bob + camZ + this.landDip, state.y);
    this.camera.rotation.y = input.yaw - Math.PI / 2 + shakeYaw;
    this.camera.rotation.x = input.pitch + this.pitchKick + shakePitch;
    this.camera.rotation.z = shakeRoll;
    const targetFov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }

    // --- entities + their emitted light
    this.sprites.sync(state, now, this.camera.position.x, this.camera.position.z);
    const dynamics: LightCandidate[] = [];
    for (const e of state.entities.values()) {
      const lt = e.latest.lt;
      if (!lt || e.latest.a === 'dead') continue;
      const p = state.sample(e, now);
      const isPortal = e.latest.k === 'portal';
      dynamics.push({
        x: p.x, y: p.y,
        height: isPortal ? 1.8 : 1.1,
        color: lt,
        intensity: isPortal ? 9 : e.latest.k === 'projectile' ? 7 : 3,
        range: isPortal ? 12 : 8,
        flicker: e.latest.k === 'projectile' ? 0.25 : 0.15,
        seed: e.latest.id % 100,
      });
    }
    this.lights.update(state.x, state.y, now / 1000, nightness, dynamics, {
      x: state.x,
      y: state.y,
      on: true,
    });

    // torch flames billboard + flicker scale
    for (const f of this.torchFlames) {
      f.rotation.y = Math.atan2(this.camera.position.x - f.position.x, this.camera.position.z - f.position.z);
      const s = 1 + Math.sin(now * 0.02 + f.position.x * 3) * 0.12;
      f.scale.set(s, lerp(1, s, 0.5), 1);
    }

    this.fx.update(dt, this.camera, window.innerWidth, window.innerHeight);
    this.renderer.render(this.scene, this.camera);
  }

  /** Fireball detonation: shockwave visuals + a real flash of light + a jolt. */
  explosion(x: number, y: number, color: number, radius: number): void {
    this.fx.explosion(x, y, color, radius);
    this.lights.flash(x, y, color, this.lastNowSec, {
      intensity: 22 + radius * 4,
      range: 8 + radius * 2,
      durationMs: 380,
    });
    const d = dist(x, y, this.camera.position.x, this.camera.position.z);
    this.addTrauma(Math.max(0.15, 0.7 - d * 0.03)); // closer blasts shake harder
    this.fovKickV += 20;
  }

  /** Add camera shake (0..1). Nearby impacts, hits taken, detonations. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A downward camera dip + jolt when a jump lands; scales with fall height. */
  landImpact(strength: number): void {
    this.landDipV -= strength * 2.2;
    this.fovKickV += strength * 10;
    this.addTrauma(Math.min(0.4, strength * 0.5));
  }

  /** A recoil punch — casting a skill. */
  castKick(): void {
    this.pitchKickV -= 0.9;
    this.fovKickV += 6;
  }

  /** Critically-damped springs pull the kicks back to rest each frame. */
  private updateCameraFx(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const k = 90;
    const damp = 15;
    const spring = (p: number, v: number): [number, number] => {
      const nv = v + (-k * p - damp * v) * dt;
      return [p + nv * dt, nv];
    };
    [this.pitchKick, this.pitchKickV] = spring(this.pitchKick, this.pitchKickV);
    [this.landDip, this.landDipV] = spring(this.landDip, this.landDipV);
    [this.fovKick, this.fovKickV] = spring(this.fovKick, this.fovKickV);
  }
}
