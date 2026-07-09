import * as THREE from 'three';

/**
 * All art is generated procedurally into canvases at boot: tiling surface
 * textures and pixel-art billboard sprites. Zero binary assets keeps the
 * base lightweight; swap in real art by replacing these factories.
 */

// ---------------------------------------------------------------- helpers

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function toTexture(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  return tex;
}

/** Fill 64x64 with a base color + speckle noise + optional grid lines. */
function noisyTile(base: string, speckles: string[], seed: number, grid?: { color: string; size: number }): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(64, 64);
  const r = rand(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 380; i++) {
    ctx.fillStyle = speckles[Math.floor(r() * speckles.length)];
    ctx.fillRect(Math.floor(r() * 64), Math.floor(r() * 64), 1 + Math.floor(r() * 2), 1 + Math.floor(r() * 2));
  }
  if (grid) {
    ctx.fillStyle = grid.color;
    for (let i = 0; i < 64; i += grid.size) {
      ctx.fillRect(0, i, 64, 1);
      ctx.fillRect(i, 0, 1, 64);
    }
  }
  return c;
}

function brickTile(mortar: string, brick: string, dark: string, seed: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(64, 64);
  const r = rand(seed);
  ctx.fillStyle = mortar;
  ctx.fillRect(0, 0, 64, 64);
  const bh = 8;
  for (let row = 0; row < 64 / bh; row++) {
    const offset = row % 2 === 0 ? 0 : 8;
    for (let x = -8; x < 64; x += 16) {
      const shade = r();
      ctx.fillStyle = shade < 0.25 ? dark : brick;
      ctx.fillRect(x + offset + 1, row * bh + 1, 14, bh - 2);
      if (r() < 0.3) {
        ctx.fillStyle = dark;
        ctx.fillRect(x + offset + 2 + Math.floor(r() * 10), row * bh + 2, 2, 2);
      }
    }
  }
  return c;
}

// ------------------------------------------------------- PBR stone walls

/** Tiny tileable value noise (bilinear lattice), 0..1. */
function makeValueNoise(seed: number, period: number): (x: number, y: number) => number {
  const lattice = new Float32Array(period * period);
  const r = rand(seed);
  for (let i = 0; i < lattice.length; i++) lattice[i] = r();
  const at = (x: number, y: number) => lattice[((y % period + period) % period) * period + ((x % period + period) % period)];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

export interface PbrMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

interface StonePalette {
  /** Per-stone base colors, [r,g,b] 0..255. */
  stones: [number, number, number][];
  mortar: [number, number, number];
  /** Stone row height range in px (256px texture). */
  rowH: [number, number];
  stoneW: [number, number];
}

/**
 * Generates a tileable stone-block wall as full PBR maps (color + normal +
 * roughness), modeled after a classic mortared stone wall: irregular courses
 * of beveled blocks with deep dark joints and a speckled, worn surface.
 * Everything derives from one procedural height field so the maps agree.
 */
function generateStonePBR(seed: number, pal: StonePalette): PbrMaps {
  const S = 256;
  const height = new Float32Array(S * S);
  const stoneOf = new Int32Array(S * S).fill(-1);
  const r = rand(seed);
  const edgeNoise = makeValueNoise(seed ^ 0x1111, 64);
  const surfNoise = makeValueNoise(seed ^ 0x2222, 64);
  const fineNoise = makeValueNoise(seed ^ 0x3333, 128);

  // --- carve stone courses into the height field
  const stoneShade: number[] = [];
  const stoneTilt: [number, number][] = [];
  let id = 0;
  let y = 0;
  while (y < S) {
    let rowH = pal.rowH[0] + Math.floor(r() * (pal.rowH[1] - pal.rowH[0]));
    if (S - y - rowH < pal.rowH[0]) rowH = S - y; // last row fills to the edge (vertical tiling)
    let x = -Math.floor(r() * pal.stoneW[1]); // negative start wraps → horizontal tiling
    while (x < S) {
      let w = pal.stoneW[0] + Math.floor(r() * (pal.stoneW[1] - pal.stoneW[0]));
      const gap = 3;
      const x0 = x + gap;
      const y0 = y + gap;
      const x1 = x + w - gap;
      const y1 = y + rowH - gap;
      stoneShade[id] = 0.72 + r() * 0.38;
      stoneTilt[id] = [(r() - 0.5) * 0.25, (r() - 0.5) * 0.25];
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const wx = ((px % S) + S) % S;
          const wy = ((py % S) + S) % S;
          // distance to the stone's border, wobbled for a hand-hewn outline
          const jitter = (edgeNoise(px * 0.35, py * 0.35) - 0.5) * 4;
          const d = Math.min(px - x0, x1 - 1 - px, py - y0, y1 - 1 - py) + jitter;
          if (d < 0) continue;
          const bevel = Math.min(1, d / 4);
          const tilt = 1 + stoneTilt[id][0] * ((px - x0) / w - 0.5) + stoneTilt[id][1] * ((py - y0) / rowH - 0.5);
          const surface = 0.85 + surfNoise(px * 0.1, py * 0.1) * 0.2 + fineNoise(px * 0.5, py * 0.5) * 0.1;
          const idx = wy * S + wx;
          const h = bevel * tilt * surface;
          if (h > height[idx]) {
            height[idx] = h;
            stoneOf[idx] = id;
          }
        }
      }
      id++;
      x += w;
    }
    y += rowH;
  }

  // --- bake color / normal / roughness
  const color = new Uint8ClampedArray(S * S * 4);
  const normal = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  const speckle = rand(seed ^ 0x4444);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const i = py * S + px;
      const o = i * 4;
      const h = height[i];
      const sid = stoneOf[i];
      let cr: number, cg: number, cb: number, rg: number;
      if (sid >= 0) {
        const base = pal.stones[sid % pal.stones.length];
        const shade = stoneShade[sid] * (0.55 + 0.5 * h);
        const spk = 1 + (speckle() - 0.5) * 0.22;
        cr = base[0] * shade * spk;
        cg = base[1] * shade * spk;
        cb = base[2] * shade * spk;
        rg = 150 + surfNoise(px * 0.2, py * 0.2) * 70 + (speckle() - 0.5) * 40;
      } else {
        const m = 0.7 + surfNoise(px * 0.15, py * 0.15) * 0.5;
        cr = pal.mortar[0] * m;
        cg = pal.mortar[1] * m;
        cb = pal.mortar[2] * m;
        rg = 235;
      }
      color[o] = cr;
      color[o + 1] = cg;
      color[o + 2] = cb;
      color[o + 3] = 255;
      rough[o] = rough[o + 1] = rough[o + 2] = rg;
      rough[o + 3] = 255;

      // normal from height gradient (wrapped Sobel-lite)
      const xw = (px + 1) % S;
      const xe = (px - 1 + S) % S;
      const yn = (py + 1) % S;
      const ys = (py - 1 + S) % S;
      const strength = 1.6;
      const dx = (height[py * S + xe] - height[py * S + xw]) * strength;
      const dy = (height[ys * S + px] - height[yn * S + px]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      normal[o] = (dx * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }

  const toTex = (data: Uint8ClampedArray<ArrayBuffer>, srgb: boolean) => {
    const [c, ctx] = makeCanvas(S, S);
    ctx.putImageData(new ImageData(data, S, S), 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };

  return {
    map: toTex(color, true),
    normalMap: toTex(normal, false),
    roughnessMap: toTex(rough, false),
  };
}

const pbrCache = new Map<string, PbrMaps>();

/**
 * Build PBR maps from a photo/artwork of a wall: height is estimated from
 * luminance (bright stone faces high, dark mortar low), normals from the
 * height gradient, roughness inverted from luminance (mortar rougher than
 * stone). MirroredRepeat hides any tiling seam in the source image.
 */
function pbrFromImage(img: HTMLImageElement, tint: [number, number, number] | null): PbrMaps {
  const S = 512;
  const [c, ctx] = makeCanvas(S, S);
  ctx.drawImage(img, 0, 0, S, S);
  if (tint) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'source-over';
  }
  const src = ctx.getImageData(0, 0, S, S).data;

  // luminance → lightly blurred height field
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          sum += lum[(((y + oy) % S + S) % S) * S + (((x + ox) % S + S) % S)];
        }
      }
      height[y * S + x] = sum / 9;
    }
  }

  const normal = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const o = i * 4;
      const strength = 4.0; // deeper relief so the stonework reads under torch/lantern
      const dx = (height[y * S + (x - 1 + S) % S] - height[y * S + (x + 1) % S]) * strength;
      const dy = (height[((y + 1) % S) * S + x] - height[((y - 1 + S) % S) * S + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      normal[o] = (dx * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
      // Wider roughness spread: mortar reads matte, worn stone faces a touch glossy.
      const rg = Math.max(0.32, Math.min(1, 1.22 - lum[i] * 0.95)) * 255;
      rough[o] = rough[o + 1] = rough[o + 2] = rg;
      rough[o + 3] = 255;
    }
  }

  const dataTex = (data: Uint8ClampedArray<ArrayBuffer>) => {
    const [cc, cctx] = makeCanvas(S, S);
    cctx.putImageData(new ImageData(data, S, S), 0, 0);
    return cc;
  };
  const finish = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.MirroredRepeatWrapping;
    tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return tex;
  };

  return {
    map: finish(c, true),
    normalMap: finish(dataTex(normal), false),
    roughnessMap: finish(dataTex(rough), false),
  };
}

/**
 * Load the real wall artwork (public/textures/stone-wall.jpg) and build all
 * wall materials from it. Await before the first zone renders; if it fails
 * (offline, file missing) wallPBR falls back to the procedural generator.
 */
export async function initWallTextures(): Promise<void> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('wall texture failed to load'));
      el.src = '/textures/stone-wall.jpg';
    });
    pbrCache.set('stone-wall', pbrFromImage(img, null));
    pbrCache.set('house-wall', pbrFromImage(img, [255, 208, 165])); // warm masonry
    pbrCache.set('rock', pbrFromImage(img, [148, 148, 145])); // dark raw rock
  } catch {
    console.warn('[textures] wall artwork unavailable — using procedural stone');
  }
}

/** PBR wall materials — grey dungeon stone, warm house masonry, raw rock. */
export function wallPBR(name: 'stone-wall' | 'house-wall' | 'rock'): PbrMaps {
  let maps = pbrCache.get(name);
  if (maps) return maps;
  switch (name) {
    case 'stone-wall':
      maps = generateStonePBR(101, {
        stones: [
          [138, 132, 120], [120, 114, 104], [150, 144, 132],
          [112, 108, 100], [130, 122, 108], [144, 140, 130],
        ],
        mortar: [38, 34, 30],
        rowH: [30, 46],
        stoneW: [36, 68],
      });
      break;
    case 'house-wall':
      maps = generateStonePBR(202, {
        stones: [
          [146, 112, 78], [128, 96, 66], [158, 124, 90], [120, 92, 64], [140, 108, 76],
        ],
        mortar: [52, 40, 28],
        rowH: [26, 38],
        stoneW: [40, 72],
      });
      break;
    case 'rock':
      maps = generateStonePBR(303, {
        stones: [
          [96, 92, 86], [84, 82, 78], [106, 102, 94], [76, 74, 70],
        ],
        mortar: [24, 22, 20],
        rowH: [42, 64],
        stoneW: [48, 96],
      });
      break;
  }
  pbrCache.set(name, maps);
  return maps;
}

// ------------------------------------------------------- PBR ground tiles
//
// Ground surfaces are baked from a procedural height field into full PBR maps
// (colour + normal + roughness) so floors catch torch- and sunlight with real
// relief — grass tufts, plank grooves, flagstone joints, rippling water — the
// same treatment the walls already get.

interface TileSample {
  h: number; // surface height 0..1 (drives normals + shading)
  r: number;
  g: number;
  b: number;
  rough: number; // 0 = mirror, 1 = matte
}
type TileSampler = (px: number, py: number, S: number) => TileSample;

function bakeDataTex(data: Uint8ClampedArray<ArrayBuffer>, S: number, srgb: boolean): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(S, S);
  ctx.putImageData(new ImageData(data, S, S), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

/** Bake a sampler into tileable colour/normal/roughness maps. */
function heightFieldPBR(S: number, sampler: TileSampler, normalStrength: number): PbrMaps {
  const height = new Float32Array(S * S);
  const color = new Uint8ClampedArray(S * S * 4);
  const rough = new Uint8ClampedArray(S * S * 4);
  const normal = new Uint8ClampedArray(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const i = py * S + px;
      const o = i * 4;
      const s = sampler(px, py, S);
      height[i] = s.h;
      color[o] = s.r;
      color[o + 1] = s.g;
      color[o + 2] = s.b;
      color[o + 3] = 255;
      const rg = Math.max(0, Math.min(1, s.rough)) * 255;
      rough[o] = rough[o + 1] = rough[o + 2] = rg;
      rough[o + 3] = 255;
    }
  }
  // Normals from the wrapped height gradient (seamless because height tiles).
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const o = (py * S + px) * 4;
      const xw = (px + 1) % S;
      const xe = (px - 1 + S) % S;
      const yn = (py + 1) % S;
      const ys = (py - 1 + S) % S;
      const dx = (height[py * S + xe] - height[py * S + xw]) * normalStrength;
      const dy = (height[ys * S + px] - height[yn * S + px]) * normalStrength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      normal[o] = (dx * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return {
    map: bakeDataTex(color, S, true),
    normalMap: bakeDataTex(normal, S, false),
    roughnessMap: bakeDataTex(rough, S, false),
  };
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Procedural PBR maps for one ground tile type. Falls back to a bumpy generic. */
function generateTilePBR(name: string): PbrMaps {
  const S = 128;
  switch (name) {
    case 'grass': {
      const coarse = makeValueNoise(0x6a71, 16);
      const fine = makeValueNoise(0x6a72, 64);
      return heightFieldPBR(
        S,
        (px, py) => {
          const patch = coarse((px / S) * 16, (py / S) * 16); // slow colour drift
          const blade = fine((px / S) * 64, (py / S) * 64);
          // upright blades: brighten where a "blade" stands, darken the gaps
          const bladeMask = Math.pow(fine((px / S) * 64 + 3.1, (py / S) * 64), 1.5);
          const g = mix(74, 118, patch) + bladeMask * 26;
          const r = mix(40, 70, patch) + bladeMask * 12;
          const b = mix(24, 44, patch) + bladeMask * 8;
          return { h: blade * 0.6 + bladeMask * 0.4, r, g, b, rough: 0.9 - bladeMask * 0.08 };
        },
        2.2
      );
    }
    case 'forest-floor': {
      // Deep-woods ground: dark moss and needle litter, pale roots poking through.
      const moss = makeValueNoise(0x6f01, 16);
      const litter = makeValueNoise(0x6f02, 64);
      return heightFieldPBR(
        S,
        (px, py) => {
          const m = moss((px / S) * 16, (py / S) * 16);
          const l = litter((px / S) * 64, (py / S) * 64);
          const root = l > 0.87 ? 1 : 0;
          return {
            h: l * 0.5 + m * 0.3 + root * 0.2,
            r: mix(28, 44, m) + root * 26,
            g: mix(46, 74, m) + root * 20,
            b: mix(20, 32, m) + root * 10,
            rough: 0.95,
          };
        },
        2.2
      );
    }
    case 'marsh-floor': {
      // Sodden fen mud: sickly green-brown, glossy where water stands.
      const mud = makeValueNoise(0x3a01, 24);
      const wet = makeValueNoise(0x3a02, 12);
      return heightFieldPBR(
        S,
        (px, py) => {
          const m = mud((px / S) * 24, (py / S) * 24);
          const w = wet((px / S) * 12, (py / S) * 12);
          const puddle = w > 0.62;
          return {
            h: puddle ? 0.15 : 0.3 + m * 0.5,
            r: puddle ? 34 : mix(52, 74, m),
            g: puddle ? 48 : mix(58, 82, m),
            b: puddle ? 44 : mix(34, 46, m),
            rough: puddle ? 0.25 : 0.9,
          };
        },
        2.0
      );
    }
    case 'highland-floor': {
      // Windswept heights: thin sun-bleached grass over grey stone.
      const stone = makeValueNoise(0x4b01, 32);
      const tuft = makeValueNoise(0x4b02, 64);
      return heightFieldPBR(
        S,
        (px, py) => {
          const s = stone((px / S) * 32, (py / S) * 32);
          const t = tuft((px / S) * 64, (py / S) * 64);
          const bare = s > 0.58; // exposed rock patches
          return {
            h: bare ? 0.55 + s * 0.3 : 0.3 + t * 0.35,
            r: bare ? mix(92, 116, s) : mix(72, 96, t),
            g: bare ? mix(90, 112, s) : mix(84, 106, t),
            b: bare ? mix(86, 106, s) : mix(52, 66, t),
            rough: bare ? 0.8 : 0.92,
          };
        },
        2.4
      );
    }
    case 'ash-floor': {
      // Scorched barrens: charcoal ground, drifting grey ash, dying embers.
      const char = makeValueNoise(0x0a51, 32);
      const fleck = makeValueNoise(0x0a52, 64);
      return heightFieldPBR(
        S,
        (px, py) => {
          const c = char((px / S) * 32, (py / S) * 32);
          const f = fleck((px / S) * 64, (py / S) * 64);
          const ember = f > 0.94; // rare glowing cinders
          const shade = 0.55 + c * 0.5;
          return {
            h: c * 0.5 + f * 0.3,
            r: ember ? 190 : 44 * shade,
            g: ember ? 84 : 40 * shade,
            b: ember ? 30 : 38 * shade,
            rough: ember ? 0.4 : 0.88,
          };
        },
        2.2
      );
    }
    case 'wood-floor': {
      const grain = makeValueNoise(0x00d, 64);
      const plankShade = rand(0x0d0d);
      const shades: number[] = [];
      for (let i = 0; i < 8; i++) shades.push(0.82 + plankShade() * 0.3);
      const plankH = S / 8; // 8 planks
      return heightFieldPBR(
        S,
        (px, py) => {
          const plank = Math.floor(py / plankH);
          const withinY = py - plank * plankH;
          const groove = withinY < 1.5 || withinY > plankH - 1.5; // gap between planks
          const nail = (px % 40 < 2 && (withinY < 3 || withinY > plankH - 4)) ? 0.5 : 0;
          const g = grain((px / S) * 8, (py / S) * 64); // long horizontal grain
          const shade = shades[plank] * (0.82 + g * 0.3);
          const base = groove ? 0.4 : 1;
          return {
            h: groove ? 0.1 : 0.55 + g * 0.3 + nail,
            r: 105 * shade * base + nail * 40,
            g: 76 * shade * base + nail * 30,
            b: 46 * shade * base + nail * 16,
            rough: groove ? 0.9 : 0.55,
          };
        },
        2.4
      );
    }
    case 'dungeon-floor': {
      const cells = makeValueNoise(0xf100, 32);
      const crack = makeValueNoise(0xf101, 64);
      const cellW = S / 4; // 4x4 flagstones
      return heightFieldPBR(
        S,
        (px, py) => {
          const cx = px % cellW;
          const cy = py % cellW;
          const joint = cx < 2 || cy < 2; // mortar joints between flagstones
          const stone = cells(Math.floor(px / cellW) * 3.7, Math.floor(py / cellW) * 2.3);
          const grime = crack((px / S) * 64, (py / S) * 64);
          const crackLine = grime > 0.82 ? 0.5 : 1; // hairline cracks
          const shade = (0.7 + stone * 0.45) * crackLine;
          return {
            h: joint ? 0.05 : (0.5 + grime * 0.3) * crackLine,
            r: mix(40, 62, stone) * (joint ? 0.5 : shade),
            g: mix(37, 57, stone) * (joint ? 0.5 : shade),
            b: mix(50, 74, stone) * (joint ? 0.5 : shade),
            rough: joint ? 0.95 : 0.72,
          };
        },
        2.6
      );
    }
    case 'road': {
      const dirt = makeValueNoise(0x0aad, 64);
      const pebble = makeValueNoise(0x0aae, 32);
      return heightFieldPBR(
        S,
        (px, py) => {
          const d = dirt((px / S) * 64, (py / S) * 64);
          const p = pebble((px / S) * 32, (py / S) * 32);
          const isPebble = p > 0.74;
          const shade = 0.8 + d * 0.4;
          return {
            h: isPebble ? 0.6 + p * 0.4 : d * 0.35,
            r: (isPebble ? 150 : 110) * shade,
            g: (isPebble ? 130 : 91) * shade,
            b: (isPebble ? 104 : 64) * shade,
            rough: isPebble ? 0.6 : 0.85,
          };
        },
        2.4
      );
    }
    case 'water': {
      const ripple = makeValueNoise(0x7a7e, 32);
      return heightFieldPBR(
        S,
        (px, py) => {
          const u = (px / S) * Math.PI * 2;
          const v = (py / S) * Math.PI * 2;
          // two crossing wave trains + noise = interference ripples
          const wave = Math.sin(u * 3 + Math.sin(v * 2)) * 0.5 + Math.sin(v * 4 - u) * 0.5;
          const n = ripple((px / S) * 32, (py / S) * 32);
          const crest = clamp01(0.5 + wave * 0.35 + n * 0.15);
          return {
            h: crest,
            r: mix(24, 60, crest),
            g: mix(58, 108, crest),
            b: mix(92, 150, crest),
            rough: 0.12 + n * 0.05, // glossy — catches sun + torch highlights
          };
        },
        3.2
      );
    }
    case 'rock': {
      const n = makeValueNoise(0x50c, 64);
      const n2 = makeValueNoise(0x50d, 32);
      return heightFieldPBR(
        S,
        (px, py) => {
          const a = n((px / S) * 64, (py / S) * 64);
          const b = n2((px / S) * 32, (py / S) * 32);
          const h = a * 0.6 + b * 0.4;
          const shade = 0.7 + h * 0.5;
          return { h, r: 92 * shade, g: 89 * shade, b: 83 * shade, rough: 0.85 };
        },
        2.8
      );
    }
    case 'stairs': {
      const n = makeValueNoise(0x57a, 32);
      const stepH = S / 8;
      return heightFieldPBR(
        S,
        (px, py) => {
          const within = py % stepH;
          const step = Math.floor(py / stepH);
          const edge = within < 2; // shadowed lip of each step
          const wear = n((px / S) * 32, (py / S) * 32);
          const rise = within / stepH; // brighter toward the front of the tread
          const shade = (0.5 + rise * 0.5) * (0.8 + wear * 0.3);
          return {
            h: edge ? 0.1 : 0.4 + rise * 0.5,
            r: 46 * shade + step * 1.5,
            g: 41 * shade,
            b: 54 * shade,
            rough: edge ? 0.9 : 0.7,
          };
        },
        3.0
      );
    }
    case 'portal-pad': {
      const n = makeValueNoise(0x90a1, 32);
      return heightFieldPBR(
        S,
        (px, py) => {
          const dx = px - S / 2;
          const dy = py - S / 2;
          const rad = Math.sqrt(dx * dx + dy * dy) / (S / 2);
          const ring = Math.abs(Math.sin(rad * 10)) > 0.86 && rad < 0.95; // glowing rune rings
          const g = n((px / S) * 32, (py / S) * 32);
          const shade = 0.6 + g * 0.4;
          return {
            h: 0.4 + g * 0.2,
            r: (ring ? 150 : 58) * shade,
            g: (ring ? 100 : 44) * shade,
            b: (ring ? 220 : 92) * shade,
            rough: ring ? 0.3 : 0.55, // runes read as polished, glossy inlay
          };
        },
        1.6
      );
    }
    default: {
      const n = makeValueNoise(0x0fa11, 64);
      return heightFieldPBR(
        S,
        (px, py) => {
          const a = n((px / S) * 64, (py / S) * 64);
          const s = 0.75 + a * 0.4;
          return { h: a, r: 90 * s, g: 88 * s, b: 96 * s, rough: 0.8 };
        },
        2.2
      );
    }
  }
}

/** Ground tiles that ship full PBR relief. Others fall back to flat colour. */
const PBR_TILES = new Set([
  'grass', 'road', 'water', 'wood-floor', 'dungeon-floor', 'rock', 'stairs', 'portal-pad',
  'forest-floor', 'marsh-floor', 'highland-floor', 'ash-floor',
]);
const tilePbrCache = new Map<string, PbrMaps>();

export function hasTilePBR(name: string): boolean {
  return PBR_TILES.has(name);
}

export function tilePBR(name: string): PbrMaps {
  let maps = tilePbrCache.get(name);
  if (!maps) {
    maps = generateTilePBR(name);
    tilePbrCache.set(name, maps);
  }
  return maps;
}

// ---------------------------------------------------------------- tiles

const tileCache = new Map<string, THREE.Texture>();

export function tileTexture(name: string): THREE.Texture {
  let tex = tileCache.get(name);
  if (tex) return tex;
  let canvas: HTMLCanvasElement;
  switch (name) {
    case 'grass':
      canvas = noisyTile('#3d5a2e', ['#4a6b38', '#31491f', '#557a40', '#2c421c'], 11);
      break;
    case 'road':
      canvas = noisyTile('#6e5b40', ['#7d6a4c', '#5d4c33', '#877455', '#54452e'], 22);
      break;
    case 'dirt':
      canvas = noisyTile('#4a3b28', ['#57472f', '#3d3020', '#5d4c38'], 23);
      break;
    case 'stone-wall':
      canvas = brickTile('#1d1a22', '#4d4658', '#332e3d', 33);
      break;
    case 'house-wall':
      canvas = brickTile('#2a2118', '#6e5138', '#543c26', 44);
      break;
    case 'wood-floor': {
      canvas = noisyTile('#5d452c', ['#6b5236', '#4f3a24', '#755c3e'], 55, { color: '#3d2d1a', size: 16 });
      break;
    }
    case 'dungeon-floor':
      canvas = noisyTile('#2e2a36', ['#383342', '#25212c', '#403a4d'], 66, { color: '#1c1922', size: 32 });
      break;
    case 'ceiling':
      canvas = noisyTile('#211d28', ['#2a2533', '#181520'], 77);
      break;
    case 'rock':
      canvas = noisyTile('#4d4a45', ['#5d5a54', '#3d3a36', '#6b6860'], 88);
      break;
    case 'water':
      canvas = noisyTile('#1e3d5a', ['#2a4d6e', '#16324a', '#356087'], 99);
      break;
    case 'portal-pad':
      canvas = noisyTile('#3a2a55', ['#4d3873', '#2a1d40', '#6a4d99'], 111, { color: '#8a6dbb', size: 32 });
      break;
    case 'stairs':
      canvas = noisyTile('#2a2530', ['#38334200', '#111'], 122, { color: '#0d0b12', size: 8 });
      break;
    case 'spikes':
      // dark pitted metal plate the spikes sit on
      canvas = noisyTile('#1a1518', ['#2a2226', '#0d0a0c', '#332a2e'], 133, { color: '#0a0709', size: 16 });
      break;
    default:
      canvas = noisyTile('#ff00ff', ['#dd00dd'], 1);
  }
  tex = toTexture(canvas);
  tileCache.set(name, tex);
  return tex;
}

// ---------------------------------------------------------------- sprites

export interface SpriteDef {
  texture: THREE.Texture;
  w: number; // world size of the billboard
  h: number;
  /** Emissive sprites (portals, orbs, flames) ignore scene lighting. */
  emissive: boolean;
  /** Directional billboards: front/back/side chosen by facing vs. camera. */
  views?: { front: THREE.Texture; back: THREE.Texture; side: THREE.Texture };
}

const spriteCache = new Map<string, SpriteDef>();

/** Draw on a 16x24 pixel grid scaled up 4x. */
type PixelFn = (x: number, y: number, w: number, h: number, color: string) => void;

function pixelPainter(gw = 16, gh = 24): [HTMLCanvasElement, PixelFn] {
  const scale = 4;
  const [c, ctx] = makeCanvas(gw * scale, gh * scale);
  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
  };
  return [c, px];
}

interface HumanoidLook {
  skin: string;
  cloth: string;
  clothDark: string;
  hat?: string;
  weapon?: 'sword' | 'staff' | 'spear' | 'club' | 'none';
  shield?: boolean;
  eyes?: string;
}

type Orient = 'front' | 'back' | 'side';

/** Multiply a #rrggbb colour by per-channel factors (for shading + tinting). */
function shade(hex: string, r: number, g = r, b = r): string {
  const n = parseInt(hex.slice(1), 16);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const R = cl(((n >> 16) & 255) * r);
  const G = cl(((n >> 8) & 255) * g);
  const B = cl((n & 255) * b);
  return `#${((R << 16) | (G << 8) | B).toString(16).padStart(6, '0')}`;
}

/** A recoloured look for crowd variety (shifts clothing, keeps skin). */
function varyLook(look: HumanoidLook, index: number): HumanoidLook {
  const tints: [number, number, number][] = [
    [1, 1, 1],
    [1.18, 0.9, 0.8], // warmer
    [0.82, 0.95, 1.2], // cooler
    [0.9, 1.12, 0.86], // greener
  ];
  const [tr, tg, tb] = tints[index % tints.length];
  return {
    ...look,
    cloth: shade(look.cloth, tr, tg, tb),
    clothDark: shade(look.clothDark, tr, tg, tb),
    hat: look.hat ? shade(look.hat, tr, tg, tb) : undefined,
  };
}

const BOOTS = '#2e2016';
const BELT = '#4a3420';
const BUCKLE = '#c8a850';

// Higher-resolution humanoid: drawn on a 28x40 grid with two-tone shading.
function drawWeaponHi(px: PixelFn, weapon: HumanoidLook['weapon'], onRight: boolean): void {
  const wx = onRight ? 24 : 2; // hand x for front(right)/back(left)
  const blade = onRight ? '#d0d0d8' : '#9a9aa2';
  switch (weapon) {
    case 'sword':
      px(wx, 8, 2, 18, blade);
      px(wx - 2, 24, 6, 2, '#8a6d3b');
      px(wx, 26, 2, 4, '#6b4a2a');
      break;
    case 'staff':
      px(wx, 5, 2, 24, '#7a5c38');
      px(wx - 2, 2, 6, 5, onRight ? '#66ccff' : '#3a7a9a');
      break;
    case 'spear':
      px(wx, 3, 2, 27, '#8a6d4b');
      px(wx - 2, 1, 6, 4, '#c8c8d0');
      break;
    case 'club':
      px(wx - 1, 14, 5, 15, '#6b4a2a');
      px(wx - 1, 14, 5, 5, '#5a3d22');
      break;
  }
}

function drawHumanoid(look: HumanoidLook, orient: Orient = 'front'): HTMLCanvasElement {
  const [c, px] = pixelPainter(28, 40);
  const { skin, cloth, clothDark } = look;
  const skinD = shade(skin, 0.8);
  const skinL = shade(skin, 1.1);
  const clothL = shade(cloth, 1.2);
  const hair = look.hat ?? '#3a2a1a';

  if (orient === 'side') {
    // Profile facing right (mirrored for the opposite direction).
    px(12, 30, 4, 8, clothDark); // near leg
    px(12, 38, 4, 2, BOOTS);
    px(9, 16, 9, 14, cloth); // torso
    px(9, 16, 3, 14, clothDark);
    px(7, 28, 11, 2, BELT);
    px(13, 18, 3, 10, cloth); // forward arm
    px(13, 28, 3, 2, skin); // hand
    px(10, 5, 9, 11, skin); // head
    px(10, 5, 3, 11, skinD);
    px(19, 9, 1, 3, skin); // nose
    px(16, 10, 2, 2, look.eyes ?? '#241a12'); // eye
    px(11, 13, 4, 1, skinD); // mouth
    px(9, 4, 9, 4, hair); // hair crown + back
    px(9, 4, 2, 8, hair);
    if (look.hat) px(9, 2, 9, 3, look.hat);
    if (look.weapon && look.weapon !== 'none') {
      px(20, 5, 2, 22, look.weapon === 'staff' ? '#7a5c38' : '#c8c8d0'); // held forward
      if (look.weapon === 'staff') px(18, 2, 5, 5, '#66ccff');
    }
    return c;
  }

  const back = orient === 'back';
  // legs + boots
  px(9, 30, 4, 8, clothDark);
  px(15, 30, 4, 8, clothDark);
  px(9, 38, 4, 2, BOOTS);
  px(15, 38, 4, 2, BOOTS);
  // torso with shaded/lit sides
  px(7, 16, 14, 14, cloth);
  px(7, 16, 4, 14, clothDark); // shadow side
  px(19, 17, 2, 12, clothL); // highlight edge
  // belt
  px(7, 28, 14, 2, BELT);
  if (!back) px(13, 28, 2, 2, BUCKLE);
  // arms + hands
  px(4, 17, 3, 10, cloth);
  px(4, 17, 2, 10, clothDark);
  px(4, 27, 3, 3, skin);
  px(21, 17, 3, 10, cloth);
  px(21, 27, 3, 3, skin);
  // neck
  px(12, 14, 4, 2, skinD);
  // head
  px(9, 5, 10, 11, back ? hair : skin);
  if (!back) {
    px(9, 5, 3, 11, skinD); // face shadow
    px(17, 6, 2, 8, skinL); // face highlight
    px(11, 10, 2, 2, look.eyes ?? '#241a12');
    px(15, 10, 2, 2, look.eyes ?? '#241a12');
    px(12, 13, 4, 1, skinD); // mouth
  }
  // hair
  px(8, 4, 12, back ? 6 : 4, hair);
  px(8, 4, 2, 8, hair);
  px(18, 4, 2, 8, hair);
  if (look.hat) {
    px(8, 2, 12, 4, look.hat);
    px(9, 1, 10, 1, look.hat);
  }
  // weapon + shield swap sides when seen from behind
  drawWeaponHi(px, look.weapon, !back);
  if (look.shield) {
    const sx = back ? 22 : 2;
    px(sx, 17, 4, 9, '#8a8a96');
    px(sx + 1, 19, 2, 4, '#d8b45a');
  }
  return c;
}

function drawWolf(): HTMLCanvasElement {
  const [c, px] = pixelPainter(20, 14);
  const fur = '#5d5a60';
  const dark = '#43404a';
  px(3, 5, 13, 5, fur); // body
  px(1, 3, 5, 4, fur); // head
  px(2, 4, 1, 1, '#e05545'); // eye
  px(0, 2, 2, 2, dark); // ears
  px(4, 10, 2, 4, dark);
  px(8, 10, 2, 4, dark);
  px(13, 10, 2, 4, dark);
  px(15, 4, 4, 2, dark); // tail
  return c;
}

function drawSlime(body: string, dark: string, light: string): HTMLCanvasElement {
  const [c, px] = pixelPainter(16, 14);
  // gooey dome
  px(3, 8, 10, 5, body);
  px(2, 9, 12, 3, body);
  px(4, 5, 8, 4, body);
  px(5, 3, 6, 3, body);
  px(4, 11, 10, 2, dark); // shadowed base
  px(5, 4, 3, 2, light); // highlight
  px(6, 7, 1, 1, '#1a1a1a'); // eyes
  px(9, 7, 1, 1, '#1a1a1a');
  px(6, 9, 4, 1, dark); // mouth
  return c;
}

function drawSpider(): HTMLCanvasElement {
  const [c, px] = pixelPainter(18, 12);
  const body = '#2a2230';
  const dark = '#181320';
  // legs
  for (const lx of [1, 2, 14, 15]) px(lx, 5, 3, 1, dark);
  px(2, 3, 2, 2, dark);
  px(14, 3, 2, 2, dark);
  px(2, 8, 2, 2, dark);
  px(14, 8, 2, 2, dark);
  // body
  px(6, 4, 6, 5, body);
  px(7, 3, 4, 2, body);
  px(7, 5, 1, 1, '#e0403a'); // eyes
  px(10, 5, 1, 1, '#e0403a');
  return c;
}

function drawLootBag(glow: string): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 12);
  px(3, 4, 6, 6, '#8a6d3b');
  px(4, 3, 4, 2, '#6b532c');
  px(5, 2, 2, 2, '#d8b45a');
  px(2, 5, 1, 4, glow);
  px(9, 5, 1, 4, glow);
  px(3, 10, 6, 1, glow);
  return c;
}

function drawPortal(color1: string, color2: string): HTMLCanvasElement {
  const [c] = pixelPainter(16, 22);
  const ctx = c.getContext('2d')!;
  const cx = 32;
  const cy = 44;
  for (let i = 8; i > 0; i--) {
    ctx.fillStyle = i % 2 === 0 ? color1 : color2;
    ctx.globalAlpha = 0.55 + (8 - i) * 0.05;
    ctx.beginPath();
    ctx.ellipse(cx, cy, i * 3.4, i * 4.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - 3, cy - 8, 6, 16);
  return c;
}

/** Parse "#rrggbb" to [r,g,b]. */
function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PORTAL_W = 30;
const PORTAL_H = 46;

/**
 * A chunky-pixel "tear in the fabric of space": a jagged vertical rift with a
 * glowing torn edge, a dark void interior lit by crackling energy filaments and
 * sparks of starlight. Drawn on a tiny grid with NearestFilter to match the
 * game's pixel-art look; `phase` animates the crackle.
 */
function drawPortalRift(inner: string, outer: string, phase: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(PORTAL_W, PORTAL_H);
  const cx = (PORTAL_W - 1) / 2;
  const [ir, ig, ib] = rgbOf(inner);
  const [or_, og, ob] = rgbOf(outer);
  const voidR = 12, voidG = 4, voidB = 22; // near-black void
  const img = ctx.createImageData(PORTAL_W, PORTAL_H);
  const maxHW = PORTAL_W / 2 - 1;
  for (let y = 0; y < PORTAL_H; y++) {
    const ny = y / (PORTAL_H - 1);
    // lens profile (fat middle, pinched ends) + jagged, crackling edge
    const lens = Math.pow(Math.sin(Math.PI * ny), 0.62);
    const jag = Math.sin(y * 0.8 + phase * 6) * 1.8 + Math.sin(y * 2.1 - phase * 3.7) * 1.1;
    const edge = lens * maxHW + jag;
    for (let x = 0; x < PORTAL_W; x++) {
      const o = (y * PORTAL_W + x) * 4;
      const dx = x - cx;
      if (edge < 0.6 || Math.abs(dx) > edge) {
        img.data[o + 3] = 0;
        continue;
      }
      const rim = edge - Math.abs(dx); // distance in from the torn edge
      let r: number, g: number, b: number;
      if (rim < 1.6) {
        // the rip itself glows white-hot toward the inner colour
        r = Math.round((255 + ir) / 2);
        g = Math.round((255 + ig) / 2);
        b = Math.round((255 + ib) / 2);
      } else {
        const en = Math.sin(dx * 0.7 + y * 0.35 - phase * 7) * Math.cos(y * 0.5 + phase * 5);
        const star = (x * 7 + y * 13 + Math.floor(phase * 4) * 29) % 41 < 2;
        if (star) {
          r = g = b = 255;
        } else {
          const t = Math.pow(Math.max(0, en), 2); // energy filaments
          r = Math.round(voidR + (ir - voidR) * t);
          g = Math.round(voidG + (ig - voidG) * t);
          b = Math.round(voidB + (ib - voidB) * t);
          // hint of the edge colour bleeding inward
          const eb = Math.max(0, 1 - rim / 5) * 0.5;
          r = Math.round(r + (or_ - r) * eb);
          g = Math.round(g + (og - g) * eb);
          b = Math.round(b + (ob - b) * eb);
        }
      }
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

interface PortalRiftTex {
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  inner: string;
  outer: string;
}
const portalRiftCache = new Map<string, PortalRiftTex>();

/** Cached pixelated rift texture; call redrawPortalRift() to animate it. */
export function portalRiftTexture(kind: 'portal' | 'portal-exit'): PortalRiftTex {
  let entry = portalRiftCache.get(kind);
  if (entry) return entry;
  const [inner, outer] = kind === 'portal-exit' ? ['#a8f0ff', '#2b6fd8'] : ['#e0b0ff', '#7a2bd8'];
  const canvas = drawPortalRift(inner, outer, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; // chunky pixels, like the rest of the game
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  entry = { texture, canvas, inner, outer };
  portalRiftCache.set(kind, entry);
  return entry;
}

/** Aspect ratio (w/h) of the rift plane so the tear isn't stretched. */
export const PORTAL_RIFT_ASPECT = PORTAL_W / PORTAL_H;

let portalGlowTex: THREE.CanvasTexture | null = null;
/** Soft radial glow used as a halo behind a portal rift. */
export function portalGlowTexture(): THREE.CanvasTexture {
  if (portalGlowTex) return portalGlowTex;
  const S = 64;
  const [c, ctx] = makeCanvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  portalGlowTex = new THREE.CanvasTexture(c);
  portalGlowTex.colorSpace = THREE.SRGBColorSpace;
  return portalGlowTex;
}

/** Re-render the rift at a new phase (crackling edge + shifting energy). */
export function redrawPortalRift(entry: PortalRiftTex, phase: number): void {
  const next = drawPortalRift(entry.inner, entry.outer, phase);
  const ctx = entry.canvas.getContext('2d')!;
  ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
  ctx.drawImage(next, 0, 0);
  entry.texture.needsUpdate = true;
}

function drawOrb(inner: string, outer: string): HTMLCanvasElement {
  const [c] = pixelPainter(8, 8);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 2, 16, 16, 15);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, inner);
  g.addColorStop(1, outer + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return c;
}

function drawFlame(): HTMLCanvasElement {
  // Higher-res flame: layered from a deep-orange base up to a white-hot core.
  const [c, px] = pixelPainter(10, 16);
  px(4, 12, 2, 4, '#5a3a1e'); // handle
  px(3, 13, 4, 1, '#3a2412'); // bracket
  px(3, 8, 4, 4, '#e0530f'); // outer flame
  px(3, 6, 4, 3, '#ff7a1c');
  px(4, 4, 2, 4, '#ff9a2a');
  px(4, 8, 2, 3, '#ffb84a');
  px(4, 6, 2, 3, '#ffd86a');
  px(4, 7, 2, 2, '#fff2b8'); // white-hot center
  px(4, 2, 2, 2, '#ffcc55'); // rising tip
  px(5, 1, 1, 1, '#ffe89a');
  return c;
}

function drawTree(): HTMLCanvasElement {
  const [c, px] = pixelPainter(16, 24);
  px(7, 16, 2, 8, '#4a3520');
  px(3, 8, 10, 8, '#2c4a1e');
  px(4, 4, 8, 6, '#375c26');
  px(6, 2, 4, 4, '#427030');
  return c;
}

/** Deep-forest pine: tall, dark, stacked boughs. */
function drawPine(): HTMLCanvasElement {
  const [c, px] = pixelPainter(16, 30);
  px(7, 22, 2, 8, '#3a2a18'); // trunk
  px(2, 16, 12, 6, '#14281a'); // wide bottom boughs
  px(3, 11, 10, 6, '#1a3320');
  px(4, 7, 8, 5, '#204026');
  px(5, 4, 6, 4, '#284c2d');
  px(7, 1, 2, 4, '#2f5834'); // crown spike
  return c;
}

/** Bare dead snag for the ashlands. */
function drawDeadTree(): HTMLCanvasElement {
  const [c, px] = pixelPainter(16, 26);
  px(7, 8, 2, 18, '#3d332c'); // trunk
  px(4, 6, 4, 2, '#463b32'); // reaching limbs
  px(9, 4, 5, 2, '#463b32');
  px(3, 4, 2, 3, '#3d332c');
  px(12, 2, 2, 3, '#3d332c');
  px(6, 2, 2, 7, '#463b32');
  px(9, 10, 3, 1, '#352c26'); // stub
  return c;
}

/** Gnarled fen tree: squat trunk, droopy canopy, hanging moss. */
function drawSwampTree(): HTMLCanvasElement {
  const [c, px] = pixelPainter(18, 22);
  px(8, 14, 3, 8, '#2e2a20'); // squat trunk
  px(6, 17, 2, 4, '#2e2a20'); // root flare
  px(11, 17, 2, 4, '#2e2a20');
  px(3, 6, 12, 7, '#2c3d26'); // droopy canopy
  px(5, 4, 8, 4, '#33472c');
  px(2, 9, 3, 5, '#26351f'); // moss curtains
  px(13, 8, 3, 6, '#26351f');
  px(7, 12, 2, 3, '#26351f');
  return c;
}

function drawSignpost(): HTMLCanvasElement {
  const [c, px] = pixelPainter(14, 18);
  px(6, 6, 2, 12, '#6b4a2a'); // post
  px(6, 6, 1, 12, '#5a3d22');
  px(2, 2, 10, 5, '#9a6a3a'); // board
  px(2, 2, 10, 1, '#b98a52');
  px(2, 2, 1, 5, '#7a5228');
  px(4, 4, 6, 1, '#4a3018'); // engraving lines
  px(4, 6, 5, 1, '#4a3018');
  return c;
}

function drawCampfire(): HTMLCanvasElement {
  const [c, px] = pixelPainter(14, 12);
  px(2, 9, 10, 2, '#5a3d22'); // logs
  px(3, 8, 8, 2, '#6b4a2a');
  px(2, 10, 3, 1, '#3a2412');
  px(9, 10, 3, 1, '#3a2412');
  // flames
  px(5, 4, 4, 5, '#e0530f');
  px(6, 2, 2, 4, '#ff9a2a');
  px(6, 5, 2, 2, '#ffd86a');
  px(6, 3, 1, 1, '#fff2b8');
  px(4, 6, 1, 2, '#ff7a1c');
  px(9, 6, 1, 2, '#ff7a1c');
  return c;
}

function drawShrine(): HTMLCanvasElement {
  const [c, px] = pixelPainter(16, 22);
  // stone base + pedestal
  px(2, 18, 12, 3, '#6f6a63');
  px(2, 18, 12, 1, '#8a857c');
  px(4, 13, 8, 5, '#7d7870');
  px(4, 13, 2, 5, '#5f5a53');
  px(4, 13, 8, 1, '#98938a');
  // carved arch
  px(5, 4, 6, 9, '#877f74');
  px(5, 4, 2, 9, '#6b6459');
  px(6, 2, 4, 3, '#948b7e');
  // glowing crystal in the niche
  px(6, 6, 4, 5, '#66ffcc');
  px(7, 5, 2, 2, '#b8fff0');
  px(7, 7, 2, 2, '#9affe0');
  px(6, 10, 4, 1, '#33ddaa');
  return c;
}

function drawObelisk(): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 24);
  // stepped base
  px(2, 21, 8, 3, '#4a4642');
  px(3, 19, 6, 2, '#565049');
  // tapering shaft
  px(4, 3, 4, 16, '#6b6459');
  px(4, 3, 1, 16, '#544e45'); // shaded side
  px(7, 3, 1, 16, '#7d7568'); // lit side
  px(4, 3, 4, 1, '#8a8072');
  // pyramidion tip
  px(5, 1, 2, 2, '#948b7e');
  // glowing runes down the face
  px(5, 6, 2, 1, '#8a6bff');
  px(5, 9, 2, 1, '#a48bff');
  px(5, 12, 2, 1, '#8a6bff');
  px(5, 15, 2, 1, '#a48bff');
  return c;
}

function drawChicken(): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 10);
  px(3, 4, 6, 4, '#f2f2f2'); // body
  px(3, 4, 2, 4, '#dcdcdc'); // shadow
  px(2, 2, 3, 3, '#f8f8f8'); // head/neck
  px(2, 1, 2, 1, '#e04040'); // comb
  px(1, 3, 1, 1, '#f0a020'); // beak
  px(3, 3, 1, 1, '#222222'); // eye
  px(8, 3, 2, 3, '#e8e8e8'); // tail
  px(4, 8, 1, 2, '#f0a020'); // legs
  px(6, 8, 1, 2, '#f0a020');
  return c;
}

function drawDeer(): HTMLCanvasElement {
  const [c, px] = pixelPainter(18, 16);
  // body
  px(4, 6, 9, 4, '#9a6a3a');
  px(4, 6, 9, 1, '#b3824a'); // sunlit back
  px(4, 9, 9, 1, '#7a5228'); // belly shadow
  // haunch + chest shading
  px(11, 6, 2, 4, '#8a5e30');
  // neck + head
  px(12, 3, 3, 3, '#9a6a3a');
  px(14, 2, 3, 3, '#a5723e'); // head
  px(16, 3, 1, 1, '#5a3d22'); // nose
  px(15, 3, 1, 1, '#221a12'); // eye
  // antlers
  px(14, 0, 1, 2, '#d8c8a8');
  px(13, 0, 1, 1, '#d8c8a8');
  px(16, 0, 1, 2, '#d8c8a8');
  // white tail
  px(3, 6, 1, 2, '#f0ece0');
  // legs
  px(5, 10, 1, 4, '#6b4a28');
  px(7, 10, 1, 4, '#7a5228');
  px(10, 10, 1, 4, '#6b4a28');
  px(12, 10, 1, 4, '#7a5228');
  return c;
}

function drawBarrel(): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 16);
  px(3, 3, 6, 12, '#8a5a2e'); // staves
  px(3, 3, 2, 12, '#6b4522'); // shadow
  px(2, 4, 8, 2, '#5a3a1e'); // hoops
  px(2, 8, 8, 2, '#5a3a1e');
  px(2, 12, 8, 2, '#5a3a1e');
  px(3, 2, 6, 1, '#9a6a3a');
  return c;
}

function drawCrate(): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 12);
  px(2, 2, 8, 8, '#9a713e');
  px(2, 2, 8, 8, '#9a713e');
  px(2, 2, 2, 8, '#7a5630');
  px(2, 2, 8, 1, '#b98a52');
  px(2, 5, 8, 2, '#6b4a28'); // planks
  px(5, 2, 2, 8, '#6b4a28');
  return c;
}

function drawFlowers(): HTMLCanvasElement {
  const [c, px] = pixelPainter(12, 10);
  px(2, 6, 1, 4, '#3a6b28'); // stems
  px(5, 5, 1, 5, '#3a6b28');
  px(8, 7, 1, 3, '#3a6b28');
  px(1, 4, 3, 2, '#e05a6a'); // red
  px(4, 3, 3, 2, '#ffd23a'); // yellow
  px(7, 5, 3, 2, '#8a6dff'); // violet
  px(2, 4, 1, 1, '#fff0a0');
  px(5, 3, 1, 1, '#fff0a0');
  return c;
}

function drawHaybale(): HTMLCanvasElement {
  const [c, px] = pixelPainter(14, 10);
  px(2, 3, 10, 7, '#c8a83a');
  px(2, 3, 10, 2, '#dcbe52');
  px(2, 5, 10, 1, '#a88a2a'); // binding lines
  px(2, 8, 10, 1, '#a88a2a');
  px(2, 3, 2, 7, '#a88a2a');
  return c;
}

function drawStall(): HTMLCanvasElement {
  const [c, px] = pixelPainter(20, 18);
  px(2, 10, 16, 5, '#8a6d4b'); // counter
  px(2, 14, 2, 4, '#5a4530'); // legs
  px(16, 14, 2, 4, '#5a4530');
  px(3, 2, 14, 3, '#b8452e'); // canopy
  px(3, 5, 14, 2, '#d8d0b8'); // stripe
  for (let i = 3; i < 17; i += 2) px(i, 5, 1, 2, '#b8452e'); // striped canopy
  px(2, 5, 1, 6, '#6b5030'); // poles
  px(17, 5, 1, 6, '#6b5030');
  px(5, 11, 2, 2, '#e05a6a'); // goods on counter
  px(9, 11, 2, 2, '#ffd23a');
  px(13, 11, 2, 2, '#5a9a3a');
  return c;
}

function drawCaravan(): HTMLCanvasElement {
  const [c, px] = pixelPainter(20, 16);
  px(2, 4, 14, 7, '#8a6d4b'); // wagon body
  px(3, 2, 12, 3, '#c8b89a'); // canvas top
  px(3, 11, 3, 3, '#3d3226'); // wheels
  px(12, 11, 3, 3, '#3d3226');
  px(16, 6, 3, 5, '#6b5a48'); // mule
  px(17, 4, 2, 3, '#5d4c3a');
  return c;
}

const LOOK: Record<string, HumanoidLook> = {
  warrior: { skin: '#d8a578', cloth: '#8a3226', clothDark: '#5d221a', weapon: 'sword' },
  wizard: { skin: '#d8a578', cloth: '#2b4a8a', clothDark: '#1c3260', hat: '#2b4a8a', weapon: 'staff' },
  knight: { skin: '#d8a578', cloth: '#8a8a96', clothDark: '#5d5d68', hat: '#8a8a96', weapon: 'sword', shield: true },
  villager: { skin: '#d8a578', cloth: '#7a6648', clothDark: '#584a33', weapon: 'none' },
  guard: { skin: '#d8a578', cloth: '#6b6b78', clothDark: '#474752', hat: '#6b6b78', weapon: 'spear' },
  'caravan-guard': { skin: '#d8a578', cloth: '#6b5b40', clothDark: '#4a3f2c', hat: '#6b6b78', weapon: 'spear' },
  goblin: { skin: '#5d8a3a', cloth: '#4a3a26', clothDark: '#332818', weapon: 'club', eyes: '#e0d040' },
  orc: { skin: '#3d6b2e', cloth: '#4a3226', clothDark: '#2e1f18', weapon: 'club', eyes: '#e05545' },
  skeleton: { skin: '#d8d8cc', cloth: '#a8a89a', clothDark: '#78786d', weapon: 'sword', eyes: '#111111' },
  imp: { skin: '#a03226', cloth: '#701d16', clothDark: '#4a120e', eyes: '#ffd040', weapon: 'none' },
  ogre: { skin: '#7a6b3a', cloth: '#4a3a26', clothDark: '#332818', weapon: 'club', eyes: '#e05545' },
};

const RARITY_GLOW: Record<string, string> = {
  common: '#9a9a9a',
  magic: '#5599ff',
  rare: '#ffdd44',
  epic: '#bb55ff',
  legendary: '#ff8833',
};

/**
 * Add a chunky dark outline around a sprite's silhouette — the classic
 * pixel-art technique that makes characters pop against any background.
 * `thickness` is in device pixels (one grid cell = the painter's scale).
 */
function addOutline(canvas: HTMLCanvasElement, thickness = 4, color = '#141020'): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const src = ctx.getImageData(0, 0, W, H);
  const a = src.data;
  const out = new Uint8ClampedArray(a);
  const [cr, cg, cb] = rgbOf(color);
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && a[(y * W + x) * 4 + 3] > 16;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (a[o + 3] > 16) continue; // keep existing opaque pixels
      let edge = false;
      for (let d = 1; d <= thickness && !edge; d++) {
        if (opaque(x - d, y) || opaque(x + d, y) || opaque(x, y - d) || opaque(x, y + d)) edge = true;
      }
      if (edge) {
        out[o] = cr;
        out[o + 1] = cg;
        out[o + 2] = cb;
        out[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(new ImageData(out, W, H), 0, 0);
}

export function spriteDef(variant: string): SpriteDef {
  let def = spriteCache.get(variant);
  if (def) return def;

  // Palette variants come in as "base#index" (crowd variety); split them.
  const hash = variant.indexOf('#');
  const base = hash >= 0 ? variant.slice(0, hash) : variant;
  const variantIndex = hash >= 0 ? Number(variant.slice(hash + 1)) || 0 : 0;

  let canvas: HTMLCanvasElement;
  let w = 1.4;
  let h = 2.1;
  let emissive = false;
  let views: SpriteDef['views'];
  let outline = false;

  if (base in LOOK) {
    // Directional: front/back/side billboards picked by facing vs. camera.
    const look = varyLook(LOOK[base], variantIndex);
    const view = (o: Orient) => {
      const cv = drawHumanoid(look, o);
      addOutline(cv); // dark pixel-art outline so the figure reads
      return toTexture(cv, false);
    };
    canvas = drawHumanoid(look, 'front');
    addOutline(canvas);
    views = { front: toTexture(canvas, false), back: view('back'), side: view('side') };
    if (base === 'ogre') { w = 2.2; h = 3.3; }
    if (base === 'goblin' || base === 'imp') { w = 1.1; h = 1.65; }
  } else if (base in RARITY_GLOW) {
    canvas = drawLootBag(RARITY_GLOW[base]);
    w = 0.8;
    h = 0.8;
    emissive = base !== 'common';
  } else {
    switch (base) {
      case 'wolf':
        canvas = drawWolf();
        w = 1.8;
        h = 1.26;
        break;
      case 'chicken':
        canvas = drawChicken();
        w = 0.6;
        h = 0.5;
        break;
      case 'deer':
        canvas = drawDeer();
        w = 1.5;
        h = 1.3;
        break;
      case 'signpost':
        canvas = drawSignpost();
        w = 1.1;
        h = 1.4;
        break;
      case 'shrine':
        canvas = drawShrine();
        w = 1.6;
        h = 2.2;
        break;
      case 'obelisk':
        canvas = drawObelisk();
        w = 1.2;
        h = 2.6;
        break;
      case 'campfire':
        canvas = drawCampfire();
        w = 1.2;
        h = 1.0;
        emissive = true;
        break;
      case 'slime':
        canvas = drawSlime('#5bb84a', '#2f7a2c', '#9fe08a');
        w = 1.5;
        h = 1.3;
        break;
      case 'slimelet':
        canvas = drawSlime('#6cc85a', '#3a8a34', '#b0f098');
        w = 0.85;
        h = 0.75;
        break;
      case 'spider':
        canvas = drawSpider();
        w = 1.5;
        h = 1.0;
        break;
      case 'caravan':
        canvas = drawCaravan();
        w = 2.6;
        h = 2.1;
        break;
      // NOTE: portals are drawn by PortalFx (render/portals.ts), not as sprites.
      case 'portal':
        canvas = drawPortal('#9944ff', '#5522aa');
        w = 2.6;
        h = 3.6;
        emissive = true;
        break;
      case 'portal-exit':
        canvas = drawPortal('#44ddff', '#2288aa');
        w = 2.6;
        h = 3.6;
        emissive = true;
        break;
      case 'firebolt':
        canvas = drawOrb('#ff7722', '#aa3300');
        w = 0.6; h = 0.6; emissive = true;
        break;
      case 'monster-bolt':
        canvas = drawOrb('#ff4422', '#881100');
        w = 0.6; h = 0.6; emissive = true;
        break;
      case 'torch':
        canvas = drawFlame();
        w = 0.5; h = 0.75; emissive = true;
        break;
      case 'tree':
        canvas = drawTree();
        w = 2.8; h = 4.2;
        break;
      case 'pine':
        canvas = drawPine();
        w = 2.6; h = 5.2;
        break;
      case 'dead-tree':
        canvas = drawDeadTree();
        w = 2.1; h = 3.6;
        break;
      case 'swamp-tree':
        canvas = drawSwampTree();
        w = 2.8; h = 3.3;
        break;
      case 'barrel':
        canvas = drawBarrel();
        w = 0.9; h = 1.2;
        break;
      case 'crate':
        canvas = drawCrate();
        w = 1.0; h = 1.0;
        break;
      case 'flowers':
        canvas = drawFlowers();
        w = 0.9; h = 0.75;
        break;
      case 'haybale':
        canvas = drawHaybale();
        w = 1.3; h = 0.95;
        break;
      case 'stall':
        canvas = drawStall();
        w = 2.6; h = 2.3;
        break;
      default:
        canvas = drawOrb('#ccccff', '#8888aa');
        w = 0.6; h = 0.6; emissive = true;
        break;
    }
    // Outline every solid sprite (creatures, props, trees) — but not the
    // glowing emissive ones (portals, bolts, torches, loot orbs).
    outline = !emissive;
  }

  if (outline) addOutline(canvas);
  const texture = views ? views.front : toTexture(canvas, false);
  def = { texture, w, h, emissive, views };
  spriteCache.set(variant, def);
  return def;
}
