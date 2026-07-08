import type { ClassId } from './content/classes';

/**
 * Vertical movement + stamina physics, shared verbatim by the server
 * (authoritative, replicates height to other players) and the client (predicts
 * its own jump/sprint locally for instant feel). Keeping it here — like
 * collision — guarantees the two never disagree.
 *
 * Vertical motion is intentionally decoupled from the 2D collision plane: jumps
 * are presentational until vertical terrain lands, so they never perturb the
 * sensitive horizontal prediction/reconciliation loop.
 */

export const GRAVITY = 24; // m/s²
export const JUMP_SPEED = 7.4; // takeoff velocity, m/s

export const SPRINT_MULT = 1.5;
export const STAMINA_MAX = 100;
export const SPRINT_DRAIN = 30; // stamina/sec while sprint-running
export const STAMINA_REGEN = 20; // stamina/sec while not sprinting

// Knight: hold to charge a crouch, release to leap.
export const KNIGHT_MAX_CHARGE_MS = 850;
export const KNIGHT_CHARGE_BONUS = 1.95; // takeoff multiplier at full charge
export const KNIGHT_CHARGE_SLOW = 0.4; // move-speed factor while charging

// Wizard: hold jump in the air to hover on a slow fall.
export const MAGE_HOVER_MS = 1500;
export const MAGE_HOVER_GRAVITY = 4;
export const MAGE_HOVER_FALL = -1.4; // capped gentle descent while hovering, m/s

// Warrior: one extra mid-air jump.
export const WARRIOR_AIR_JUMPS = 1;

export interface VerticalState {
  z: number; // height above ground, meters
  vz: number; // vertical velocity, m/s
  grounded: boolean;
  jumps: number; // jumps used since last touching the ground
  chargeStart: number; // knight: ms timestamp charging began (0 = not charging)
  hoverUntil: number; // wizard: ms timestamp hover expires (0 = not hovering)
}

export function newVerticalState(): VerticalState {
  return { z: 0, vz: 0, grounded: true, jumps: 0, chargeStart: 0, hoverUntil: 0 };
}

export function isCharging(v: VerticalState): boolean {
  return v.chargeStart > 0;
}

/** Jump key pressed. `now` is ms. Mutates `v`. */
export function jumpPress(v: VerticalState, cls: ClassId, now: number): void {
  if (cls === 'knight') {
    if (v.grounded) v.chargeStart = now > 0 ? now : 1; // begin charging on the ground
    return;
  }
  if (cls === 'wizard') {
    if (v.grounded) launch(v, JUMP_SPEED);
    else v.hoverUntil = now + MAGE_HOVER_MS; // catch the air and hover
    return;
  }
  // warrior — double jump
  if (v.grounded) launch(v, JUMP_SPEED);
  else if (v.jumps <= WARRIOR_AIR_JUMPS) launch(v, JUMP_SPEED * 0.92, true);
}

/** Jump key released. */
export function jumpRelease(v: VerticalState, cls: ClassId, now: number): void {
  if (cls === 'knight' && v.chargeStart > 0) {
    const charge = Math.min(now - v.chargeStart, KNIGHT_MAX_CHARGE_MS) / KNIGHT_MAX_CHARGE_MS;
    v.chargeStart = 0;
    launch(v, JUMP_SPEED * (1 + charge * (KNIGHT_CHARGE_BONUS - 1)));
  }
  if (cls === 'wizard') v.hoverUntil = 0;
}

function launch(v: VerticalState, speed: number, extra = false): void {
  v.vz = speed;
  v.grounded = false;
  v.jumps = extra ? v.jumps + 1 : 1;
}

/** Advance vertical physics by `dt` seconds. `now` is ms. */
export function stepVertical(v: VerticalState, cls: ClassId, now: number, dt: number): void {
  if (v.chargeStart > 0 || v.grounded) return; // crouched charging or already on the ground
  const hovering = cls === 'wizard' && v.hoverUntil > now && v.vz <= 0.5;
  if (hovering) {
    // Reduced gravity, but the fall is also capped so the mage floats gently
    // down no matter how fast it was dropping when hover kicked in.
    v.vz = Math.max(v.vz - MAGE_HOVER_GRAVITY * dt, MAGE_HOVER_FALL);
  } else {
    v.vz -= GRAVITY * dt;
  }
  v.z += v.vz * dt;
  if (v.z <= 0) {
    v.z = 0;
    v.vz = 0;
    v.grounded = true;
    v.jumps = 0;
    v.hoverUntil = 0;
  }
}

/** Regenerate or drain stamina for one step. */
export function stepStamina(stamina: number, sprinting: boolean, dt: number): number {
  const next = stamina + (sprinting ? -SPRINT_DRAIN : STAMINA_REGEN) * dt;
  return next < 0 ? 0 : next > STAMINA_MAX ? STAMINA_MAX : next;
}

/** Horizontal speed multiplier from sprint + knight charge state. */
export function speedMultiplier(sprinting: boolean, stamina: number, charging: boolean): number {
  if (charging) return KNIGHT_CHARGE_SLOW;
  return sprinting && stamina > 0 ? SPRINT_MULT : 1;
}
