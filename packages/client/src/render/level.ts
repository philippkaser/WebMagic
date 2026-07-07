import * as THREE from 'three';
import { TILE_SIZE, Tile, TileMap, isBlocking, isWallLike } from '@webmagic/shared';
import { spriteDef, tileTexture } from './textures';

export const WALL_HEIGHT = 3.2;

/**
 * Builds the static geometry for one zone from its tile map: merged floor
 * quads, wall boxes (only faces adjacent to walkable space), optional
 * ceiling, and cross-quad trees. One draw call per material.
 */
export class LevelMesh {
  readonly group = new THREE.Group();
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  build(map: TileMap, kind: 'overworld' | 'dungeon'): void {
    const floorBuckets = new Map<string, number[]>(); // texture -> positions of tile quads
    const wallBuckets = new Map<string, { pos: number[]; uv: number[]; nrm: number[] }>();
    const treePositions: { x: number; y: number }[] = [];

    const floorTexOf = (t: Tile): string | null => {
      switch (t) {
        case Tile.Grass: return 'grass';
        case Tile.Road: return 'road';
        case Tile.Water: return 'water';
        case Tile.Floor: return kind === 'dungeon' ? 'dungeon-floor' : 'wood-floor';
        case Tile.Door: return kind === 'dungeon' ? 'dungeon-floor' : 'wood-floor';
        case Tile.StairsDown: return 'stairs';
        case Tile.PortalPad: return 'portal-pad';
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
          for (const [dx, dy, corners, normal] of neighbors) {
            const n = map.get(tx + dx, ty + dy);
            if (isBlocking(n) && n !== Tile.Tree && n !== Tile.Water) continue;
            pushWallQuad(bucket, corners, normal);
          }
        }
      }
    }

    // --- floor meshes
    for (const [texName, tiles] of floorBuckets) {
      const geo = buildFloorGeometry(tiles, 0);
      const mat = new THREE.MeshLambertMaterial({ map: tileTexture(texName) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }

    // --- wall meshes
    for (const [texName, bucket] of wallBuckets) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
      const mat = new THREE.MeshLambertMaterial({ map: tileTexture(texName) });
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
      const geo = buildFloorGeometry(ceilTiles, WALL_HEIGHT, true);
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
        pushCrossQuads(pos, uv, nrm, p.x, p.y, tree.w, tree.h);
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
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }
}

function buildFloorGeometry(tiles: number[], height: number, flip = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    const tx = tiles[i];
    const ty = tiles[i + 1];
    const x0 = tx * TILE_SIZE;
    const x1 = (tx + 1) * TILE_SIZE;
    const z0 = ty * TILE_SIZE;
    const z1 = (ty + 1) * TILE_SIZE;
    const ny = flip ? -1 : 1;
    if (!flip) {
      pos.push(x0, height, z0, x0, height, z1, x1, height, z1, x0, height, z0, x1, height, z1, x1, height, z0);
    } else {
      pos.push(x0, height, z0, x1, height, z1, x0, height, z1, x0, height, z0, x1, height, z0, x1, height, z1);
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
  normal: number[]
): void {
  const [ax, az, bx, bz] = corners;
  const h = WALL_HEIGHT;
  // two triangles: (a0,b0,b1) (a0,b1,a1) where 0 = ground, 1 = top
  bucket.pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, 0, az, bx, h, bz, ax, h, az);
  bucket.uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  for (let v = 0; v < 6; v++) bucket.nrm.push(normal[0], normal[1], normal[2]);
}

function pushCrossQuads(pos: number[], uv: number[], nrm: number[], x: number, z: number, w: number, h: number): void {
  const hw = w / 2;
  const planes = [
    [x - hw, z, x + hw, z, 0, 0, 1],
    [x, z - hw, x, z + hw, 1, 0, 0],
  ];
  for (const [ax, az, bx, bz, nx, ny, nz] of planes) {
    pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, 0, az, bx, h, bz, ax, h, az);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    for (let v = 0; v < 6; v++) nrm.push(nx, ny, nz);
  }
}
