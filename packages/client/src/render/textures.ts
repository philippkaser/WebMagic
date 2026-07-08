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

  const toTex = (data: Uint8ClampedArray, srgb: boolean) => {
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
}

const spriteCache = new Map<string, SpriteDef>();

/** Draw on a 16x24 pixel grid scaled up 4x. */
function pixelPainter(gw = 16, gh = 24): [HTMLCanvasElement, (x: number, y: number, w: number, h: number, color: string) => void] {
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

function drawHumanoid(look: HumanoidLook): HTMLCanvasElement {
  const [c, px] = pixelPainter();
  const { skin, cloth, clothDark } = look;
  // legs
  px(5, 19, 2, 5, clothDark);
  px(9, 19, 2, 5, clothDark);
  // torso
  px(4, 11, 8, 8, cloth);
  px(4, 11, 2, 8, clothDark);
  // arms
  px(3, 12, 1, 5, skin);
  px(12, 12, 1, 5, skin);
  // head
  px(5, 4, 6, 6, skin);
  px(6, 6, 1, 1, look.eyes ?? '#1a1a1a');
  px(9, 6, 1, 1, look.eyes ?? '#1a1a1a');
  if (look.hat) {
    px(4, 2, 8, 3, look.hat);
    px(5, 1, 6, 1, look.hat);
  }
  // weapon
  switch (look.weapon) {
    case 'sword':
      px(13, 8, 1, 9, '#c8c8d0');
      px(12, 15, 3, 1, '#8a6d3b');
      break;
    case 'staff':
      px(13, 5, 1, 13, '#7a5c38');
      px(12, 3, 3, 3, '#66ccff');
      break;
    case 'spear':
      px(13, 3, 1, 15, '#8a6d4b');
      px(12, 2, 3, 2, '#c8c8d0');
      break;
    case 'club':
      px(13, 9, 2, 8, '#6b4a2a');
      break;
  }
  if (look.shield) {
    px(1, 12, 3, 5, '#8a8a96');
    px(2, 13, 1, 3, '#d8b45a');
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
  const [c, px] = pixelPainter(8, 12);
  px(3, 8, 2, 3, '#6b4a2a'); // torch handle
  px(2, 4, 4, 4, '#ff8822');
  px(3, 2, 2, 3, '#ffcc44');
  px(3, 5, 2, 2, '#fff0a0');
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

export function spriteDef(variant: string): SpriteDef {
  let def = spriteCache.get(variant);
  if (def) return def;

  let canvas: HTMLCanvasElement;
  let w = 1.4;
  let h = 2.1;
  let emissive = false;

  if (variant in LOOK) {
    canvas = drawHumanoid(LOOK[variant]);
    if (variant === 'ogre') { w = 2.2; h = 3.3; }
    if (variant === 'goblin' || variant === 'imp') { w = 1.1; h = 1.65; }
  } else if (variant in RARITY_GLOW) {
    canvas = drawLootBag(RARITY_GLOW[variant]);
    w = 0.8;
    h = 0.8;
    emissive = variant !== 'common';
  } else {
    switch (variant) {
      case 'wolf':
        canvas = drawWolf();
        w = 1.8;
        h = 1.26;
        break;
      case 'caravan':
        canvas = drawCaravan();
        w = 2.6;
        h = 2.1;
        break;
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
      default:
        canvas = drawOrb('#ccccff', '#8888aa');
        w = 0.6; h = 0.6; emissive = true;
        break;
    }
  }

  const texture = toTexture(canvas, false);
  def = { texture, w, h, emissive };
  spriteCache.set(variant, def);
  return def;
}
