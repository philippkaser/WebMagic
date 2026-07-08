import * as THREE from 'three';
import { TILE_SIZE, Tile, TileMap, isBlocking, isWallLike } from '@webmagic/shared';
import type { PropDef } from '@webmagic/shared';
import { hasTilePBR, spriteDef, tilePBR, tileTexture, wallPBR } from './textures';

export const WALL_HEIGHT = 3.2;
/** Dungeons are cavernous and imposing — far taller than overworld houses. */
export const DUNGEON_WALL_HEIGHT = 7.5;
/** Walls extend this far below their base to hide gaps at elevation changes. */
const WALL_SKIRT = 4;
/** Wall texture repeats per tile. >1 zooms the stonework out (smaller, denser blocks). */
const WALL_TEX_SCALE = 1.8;

/**
 * Builds the static geometry for one zone from its tile map: merged floor
 * quads, wall boxes (only faces adjacent to walkable space), optional
 * ceiling, and cross-quad trees. One draw call per material.
 */
export class LevelMesh {
  readonly group = new THREE.Group();
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh)[] = [];
  /** Water colour + normal maps, scrolled each frame for a flowing surface. */
  private waterMaps: THREE.Texture[] = [];

  build(map: TileMap, kind: 'overworld' | 'dungeon', props: PropDef[] = []): void {
    const wallHeight = kind === 'dungeon' ? DUNGEON_WALL_HEIGHT : WALL_HEIGHT;
    const floorBuckets = new Map<string, number[]>(); // texture -> positions of tile quads
    const wallBuckets = new Map<string, { pos: number[]; uv: number[]; nrm: number[] }>();
    const treePositions: { x: number; y: number }[] = [];
    const spikePositions: { x: number; y: number }[] = [];

    const floorTexOf = (t: Tile): string | null => {
      switch (t) {
        case Tile.Grass: return 'grass';
        case Tile.Road: return 'road';
        case Tile.Water: return 'water';
        case Tile.Floor: return kind === 'dungeon' ? 'dungeon-floor' : 'wood-floor';
        case Tile.Door: return kind === 'dungeon' ? 'dungeon-floor' : 'wood-floor';
        case Tile.StairsDown: return 'stairs';
        case Tile.PortalPad: return 'portal-pad';
        case Tile.Spikes: return 'spikes';
        case Tile.Tree: return 'grass';
        default: return null;
      }
    };
    const wallTexOf = (t: Tile): string =>
      t === Tile.Rock ? 'rock' : kind === 'dungeon' ? 'stone-wall' : 'house-wall';

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        const t = map.get(tx, ty);
        if (t === Tile.Tree) treePositions.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });
        if (t === Tile.Spikes) spikePositions.push({ x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE });

        const floorTex = floorTexOf(t);
        if (floorTex) {
          let arr = floorBuckets.get(floorTex);
          if (!arr) floorBuckets.set(floorTex, (arr = []));
          arr.push(tx, ty);
        }

        if (isWallLike(t)) {
          // Emit only faces that touch walkable (visible) space.
          const texName = wallTexOf(t);
          let bucket = wallBuckets.get(texName);
          if (!bucket) wallBuckets.set(texName, (bucket = { pos: [], uv: [], nrm: [] }));
          const x0 = tx * TILE_SIZE;
          const x1 = (tx + 1) * TILE_SIZE;
          const z0 = ty * TILE_SIZE;
          const z1 = (ty + 1) * TILE_SIZE;
          const neighbors: [number, number, number[], number[]][] = [
            // [dx, dy, quad corners (x,z per vertex), normal]
            [0, -1, [x1, z0, x0, z0], [0, 0, -1]], // north face
            [0, 1, [x0, z1, x1, z1], [0, 0, 1]], // south face
            [-1, 0, [x0, z0, x0, z1], [-1, 0, 0]], // west face
            [1, 0, [x1, z1, x1, z0], [1, 0, 0]], // east face
          ];
          const wallBase = map.elevationAtWorld((tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE);
          for (const [dx, dy, corners, normal] of neighbors) {
            const n = map.get(tx + dx, ty + dy);
            if (isBlocking(n) && n !== Tile.Tree && n !== Tile.Water) continue;
            pushWallQuad(bucket, corners, normal, wallBase, wallHeight);
          }
        }
      }
    }

    // --- floor meshes: PBR relief (grass tufts, plank grooves, water ripples…)
    // where available, flat colour otherwise.
    for (const [texName, tiles] of floorBuckets) {
      const geo = buildFloorGeometry(tiles, 0, map);
      let mat: THREE.Material;
      if (hasTilePBR(texName)) {
        const pbr = tilePBR(texName);
        const shiny = texName === 'water' || texName === 'portal-pad';
        if (texName === 'water') this.waterMaps = [pbr.map, pbr.normalMap];
        mat = new THREE.MeshStandardMaterial({
          map: pbr.map,
          normalMap: pbr.normalMap,
          roughnessMap: pbr.roughnessMap,
          roughness: 1,
          metalness: 0,
          normalScale: new THREE.Vector2(shiny ? 2.6 : 2, shiny ? 2.6 : 2),
          emissive: texName === 'portal-pad' ? new THREE.Color(0x2a1550) : new THREE.Color(0x000000),
          emissiveMap: texName === 'portal-pad' ? pbr.map : null,
          emissiveIntensity: texName === 'portal-pad' ? 0.4 : 1,
        });
      } else {
        mat = new THREE.MeshLambertMaterial({ map: tileTexture(texName) });
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }

    // --- wall meshes: full PBR (color + normal + roughness) stone materials
    for (const [texName, bucket] of wallBuckets) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
      const pbr = wallPBR(texName as 'stone-wall' | 'house-wall' | 'rock');
      const mat = new THREE.MeshStandardMaterial({
        map: pbr.map,
        normalMap: pbr.normalMap,
        roughnessMap: pbr.roughnessMap,
        roughness: 1,
        metalness: 0,
        normalScale: new THREE.Vector2(2.4, 2.4),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }

    // --- wall tops (seen from nowhere in first person, but cheap and safe for tall views)
    // and ceiling for dungeons
    if (kind === 'dungeon') {
      const ceilTiles: number[] = [];
      for (let ty = 0; ty < map.h; ty++) {
        for (let tx = 0; tx < map.w; tx++) {
          if (!isBlocking(map.get(tx, ty))) ceilTiles.push(tx, ty);
        }
      }
      const geo = buildFloorGeometry(ceilTiles, wallHeight, null, true);
      const mat = new THREE.MeshLambertMaterial({ map: tileTexture('ceiling') });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }

    // --- trees as merged cross-quads
    if (treePositions.length > 0) {
      const tree = spriteDef('tree');
      const pos: number[] = [];
      const uv: number[] = [];
      const nrm: number[] = [];
      for (const p of treePositions) {
        pushCrossQuads(pos, uv, nrm, p.x, p.y, tree.w, tree.h, map.elevationAtWorld(p.x, p.y));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      const mat = new THREE.MeshLambertMaterial({
        map: tree.texture,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }

    // --- decorative props: billboarded cross-quads, sitting on the terrain.
    if (props.length > 0) {
      const byKind = new Map<string, PropDef[]>();
      for (const p of props) {
        let arr = byKind.get(p.kind);
        if (!arr) byKind.set(p.kind, (arr = []));
        arr.push(p);
      }
      for (const [kind, list] of byKind) {
        const def = spriteDef(kind);
        const pos: number[] = [];
        const uv: number[] = [];
        const nrm: number[] = [];
        for (const p of list) {
          pushCrossQuads(pos, uv, nrm, p.x, p.y, def.w, def.h, map.elevationAtWorld(p.x, p.y));
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        const mat = new THREE.MeshLambertMaterial({ map: def.texture, alphaTest: 0.5, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.disposables.push(geo, mat);
      }
    }

    // --- spike traps: a cluster of sharp metal cones per trap tile.
    if (spikePositions.length > 0) {
      const cone = new THREE.ConeGeometry(0.13, 0.55, 4);
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.45, metalness: 0.6, flatShading: true });
      const offsets = [
        [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0],
      ];
      const mesh = new THREE.InstancedMesh(cone, mat, spikePositions.length * offsets.length);
      const m = new THREE.Matrix4();
      let i = 0;
      for (const p of spikePositions) {
        const e = map.elevationAtWorld(p.x, p.y);
        for (const [ox, oz] of offsets) {
          m.makeTranslation(p.x + ox, 0.27 + e, p.y + oz);
          mesh.setMatrixAt(i++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(cone, mat, mesh);
    }
  }

  /** Scroll the water maps so the surface ripples flow. `t` in seconds. */
  animate(t: number): void {
    const [map, nrm] = this.waterMaps;
    if (!map) return;
    map.offset.set((t * 0.018) % 1, (t * 0.011) % 1);
    nrm.offset.set((t * 0.03) % 1, (-t * 0.022) % 1); // ripples drift across the colour flow
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.waterMaps = [];
    this.group.clear();
  }
}

function buildFloorGeometry(tiles: number[], height: number, map: TileMap | null, flip = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const elev = (x: number, z: number) => (map ? map.elevationAtWorld(x, z) : 0);
  for (let i = 0; i < tiles.length; i += 2) {
    const tx = tiles[i];
    const ty = tiles[i + 1];
    const x0 = tx * TILE_SIZE;
    const x1 = (tx + 1) * TILE_SIZE;
    const z0 = ty * TILE_SIZE;
    const z1 = (ty + 1) * TILE_SIZE;
    const ny = flip ? -1 : 1;
    // Per-corner elevation so floors follow terrain (seamless at shared edges).
    const y00 = height + elev(x0, z0);
    const y01 = height + elev(x0, z1);
    const y11 = height + elev(x1, z1);
    const y10 = height + elev(x1, z0);
    if (!flip) {
      pos.push(x0, y00, z0, x0, y01, z1, x1, y11, z1, x0, y00, z0, x1, y11, z1, x1, y10, z0);
    } else {
      pos.push(x0, y00, z0, x1, y11, z1, x0, y01, z1, x0, y00, z0, x1, y10, z0, x1, y11, z1);
    }
    uv.push(0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1);
    for (let v = 0; v < 6; v++) nrm.push(0, ny, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return geo;
}

function pushWallQuad(
  bucket: { pos: number[]; uv: number[]; nrm: number[] },
  corners: number[], // [ax, az, bx, bz] — left edge then right edge (viewed from outside)
  normal: number[],
  baseY: number,
  wallHeight: number
): void {
  const [ax, az, bx, bz] = corners;
  const y0 = baseY - WALL_SKIRT; // extend below ground to hide elevation gaps
  const y1 = baseY + wallHeight;
  const u = WALL_TEX_SCALE; // repeats across the tile width
  const vBot = -(WALL_SKIRT / TILE_SIZE) * WALL_TEX_SCALE;
  const vTop = (wallHeight / TILE_SIZE) * WALL_TEX_SCALE; // keep texels square
  // two triangles: (a0,b0,b1) (a0,b1,a1) where 0 = ground, 1 = top
  bucket.pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
  bucket.uv.push(0, vBot, u, vBot, u, vTop, 0, vBot, u, vTop, 0, vTop);
  for (let v = 0; v < 6; v++) bucket.nrm.push(normal[0], normal[1], normal[2]);
}

function pushCrossQuads(pos: number[], uv: number[], nrm: number[], x: number, z: number, w: number, h: number, baseY = 0): void {
  const hw = w / 2;
  const y0 = baseY;
  const y1 = baseY + h;
  const planes = [
    [x - hw, z, x + hw, z, 0, 0, 1],
    [x, z - hw, x, z + hw, 1, 0, 0],
  ];
  for (const [ax, az, bx, bz, nx, ny, nz] of planes) {
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    for (let v = 0; v < 6; v++) nrm.push(nx, ny, nz);
  }
}
