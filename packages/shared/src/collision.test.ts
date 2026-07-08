import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TileMap, Tile, TILE_SIZE, tileCenter } from './tiles';
import { moveWithCollision, hasLineOfSight } from './collision';

/** A small open floor arena with a solid wall column at tile x=3. */
function arenaWithWallColumn(): TileMap {
  const map = new TileMap(8, 8, Tile.Floor);
  for (let ty = 0; ty < map.h; ty++) map.set(3, ty, Tile.Wall);
  return map;
}

test('open movement applies the full delta', () => {
  const map = new TileMap(8, 8, Tile.Floor);
  const start = tileCenter(1, 1);
  const res = moveWithCollision(map, start.x, start.y, 0.5, -0.25, 0.3);
  assert.ok(Math.abs(res.x - (start.x + 0.5)) < 1e-6);
  assert.ok(Math.abs(res.y - (start.y - 0.25)) < 1e-6);
});

test('moving into a wall is blocked and keeps the circle outside it', () => {
  const map = arenaWithWallColumn();
  // Stand just left of the wall column (wall spans world x in [6, 8)).
  const wallLeftEdge = 3 * TILE_SIZE; // 6
  const radius = 0.3;
  const startX = wallLeftEdge - radius - 0.05;
  const res = moveWithCollision(map, startX, tileCenter(0, 1).y, 2, 0, radius);
  assert.ok(res.x + radius <= wallLeftEdge + 1e-3, `penetrated wall: ${res.x}`);
  assert.ok(!map.blockedAtWorld(res.x, res.y), 'resolved position must be walkable');
});

test('axis separation lets you slide along a wall', () => {
  const map = arenaWithWallColumn();
  const radius = 0.3;
  const startX = 3 * TILE_SIZE - radius - 0.05;
  const startY = tileCenter(0, 1).y;
  // Push right (into wall) and down (open) at once — X is stopped, Y slides.
  const res = moveWithCollision(map, startX, startY, 2, 1, radius);
  assert.ok(res.x < startX + 2, 'x should be checked against the wall');
  assert.ok(res.y > startY + 0.5, 'y should slide freely');
});

test('hasLineOfSight is clear across open floor and blocked through a wall', () => {
  const map = arenaWithWallColumn();
  const a = tileCenter(1, 1);
  const b = tileCenter(2, 1);
  assert.ok(hasLineOfSight(map, a.x, a.y, b.x, b.y), 'adjacent open tiles see each other');

  const left = tileCenter(1, 1);
  const right = tileCenter(5, 1); // wall column at x=3 sits between them
  assert.ok(!hasLineOfSight(map, left.x, left.y, right.x, right.y), 'wall should block LOS');
});

test('TileMap.get treats out-of-bounds as Void (blocking)', () => {
  const map = new TileMap(4, 4, Tile.Floor);
  assert.equal(map.get(-1, 0), Tile.Void);
  assert.equal(map.get(0, 99), Tile.Void);
  assert.ok(map.blockedTile(-1, 0), 'out of bounds is blocked');
});
