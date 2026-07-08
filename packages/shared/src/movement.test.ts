import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newVerticalState,
  jumpPress,
  jumpRelease,
  stepVertical,
  stepStamina,
  speedMultiplier,
  isCharging,
  JUMP_SPEED,
  STAMINA_MAX,
  SPRINT_MULT,
  KNIGHT_CHARGE_SLOW,
  KNIGHT_MAX_CHARGE_MS,
} from './movement';

/** Simulate to the ground and return peak height reached. */
function apex(v: ReturnType<typeof newVerticalState>, cls: 'warrior' | 'wizard' | 'knight', t0 = 0): number {
  let peak = 0;
  let now = t0;
  for (let i = 0; i < 600; i++) {
    stepVertical(v, cls, now, 1 / 60);
    now += 1000 / 60;
    peak = Math.max(peak, v.z);
    if (v.grounded && i > 0) break;
  }
  return peak;
}

test('a jump leaves the ground, rises, and lands back at zero', () => {
  const v = newVerticalState();
  jumpPress(v, 'warrior', 0);
  assert.ok(!v.grounded, 'should be airborne right after takeoff');
  assert.equal(v.vz, JUMP_SPEED);
  const peak = apex(v, 'warrior');
  assert.ok(peak > 1, `should reach a meaningful height, got ${peak}`);
  assert.ok(v.grounded, 'should return to the ground');
  assert.equal(v.z, 0);
});

test('warrior can double jump but not triple jump', () => {
  const v = newVerticalState();
  jumpPress(v, 'warrior', 0); // 1st
  stepVertical(v, 'warrior', 16, 0.05);
  const before2 = v.vz;
  jumpPress(v, 'warrior', 20); // 2nd (air) — refreshes upward velocity
  assert.ok(v.vz > before2, 'second jump should add upward velocity');
  const after2 = v.jumps;
  jumpPress(v, 'warrior', 40); // 3rd — ignored
  assert.equal(v.jumps, after2, 'third jump must be ignored');
});

test('wizard hover slows the fall (stays airborne longer than a warrior)', () => {
  const w = newVerticalState();
  let now = 0;
  jumpPress(w, 'wizard', now); // takeoff
  // Catch the air shortly after leaving the ground (still rising) — hover then
  // engages automatically near the apex and floats the mage gently down.
  for (let i = 0; i < 4; i++) { stepVertical(w, 'wizard', now, 1 / 60); now += 1000 / 60; }
  jumpPress(w, 'wizard', now); // hold to hover
  let wizAir = 4;
  for (let i = 0; i < 900 && !w.grounded; i++) { stepVertical(w, 'wizard', now, 1 / 60); now += 1000 / 60; wizAir++; }

  const wr = newVerticalState();
  jumpPress(wr, 'warrior', 0);
  let warAir = 0;
  let n2 = 0;
  for (let i = 0; i < 900 && !wr.grounded; i++) { stepVertical(wr, 'warrior', n2, 1 / 60); n2 += 1000 / 60; warAir++; }

  assert.ok(wizAir > warAir * 1.5, `hover should clearly extend air time (wizard ${wizAir} vs warrior ${warAir})`);
});

test('knight charge: longer hold launches higher, and charging slows movement', () => {
  const quick = newVerticalState();
  jumpPress(quick, 'knight', 0);
  assert.ok(isCharging(quick), 'holding jump on the ground charges');
  assert.equal(speedMultiplier(false, STAMINA_MAX, isCharging(quick)), KNIGHT_CHARGE_SLOW);
  jumpRelease(quick, 'knight', 50); // barely charged
  const quickPeak = apex(quick, 'knight');

  const full = newVerticalState();
  jumpPress(full, 'knight', 0);
  jumpRelease(full, 'knight', KNIGHT_MAX_CHARGE_MS + 200); // over-charged, clamps to max
  const fullPeak = apex(full, 'knight');

  assert.ok(fullPeak > quickPeak * 1.5, `full charge (${fullPeak}) should clear a quick tap (${quickPeak})`);
});

test('stamina drains while sprinting and regenerates otherwise', () => {
  let s = STAMINA_MAX;
  s = stepStamina(s, true, 1);
  assert.ok(s < STAMINA_MAX, 'sprinting drains');
  const drained = s;
  s = stepStamina(s, false, 1);
  assert.ok(s > drained, 'resting regenerates');
  // Never below zero.
  let z = 5;
  for (let i = 0; i < 100; i++) z = stepStamina(z, true, 1);
  assert.equal(z, 0);
});

test('sprint multiplier only applies with stamina left', () => {
  assert.equal(speedMultiplier(true, 50, false), SPRINT_MULT);
  assert.equal(speedMultiplier(true, 0, false), 1, 'no stamina = no sprint');
  assert.equal(speedMultiplier(false, 100, false), 1);
});
