import { SKILLS, SkillId, angleDiff } from '@webmagic/shared';
import { Entity, Faction, allocEntityId } from './entities';
import { Zone, ZoneHost } from './zone';
import type { Player } from './player';

export function spawnProjectile(
  zone: Zone,
  owner: Entity,
  angle: number,
  opts: { speed: number; damage: number; range: number; light?: number; slowMs?: number; variant?: string }
): Entity {
  const e: Entity = {
    id: allocEntityId(),
    kind: 'projectile',
    variant: opts.variant ?? 'bolt',
    x: owner.x + Math.cos(angle) * (owner.radius + 0.4),
    y: owner.y + Math.sin(angle) * (owner.radius + 0.4),
    facing: angle,
    radius: 0.3,
    speed: opts.speed,
    hp: 1,
    maxHp: 1,
    anim: 'move',
    faction: owner.faction,
    dead: false,
    vx: Math.cos(angle) * opts.speed,
    vy: Math.sin(angle) * opts.speed,
    ttl: opts.range / opts.speed,
    damage: opts.damage,
    ownerId: owner.id,
    light: opts.light,
    slowMs: opts.slowMs,
  };
  zone.addEntity(e);
  return e;
}

function hostileTo(faction: Faction, e: Entity): boolean {
  return !e.dead && e.faction !== 'none' && e.faction !== faction &&
    (e.kind === 'player' || e.kind === 'monster' || e.kind === 'npc');
}

/**
 * Execute a skill cast for a player. Returns an error string for the client,
 * or null on success.
 */
export function castSkill(
  host: ZoneHost,
  zone: Zone,
  player: Player,
  skillId: SkillId,
  aim: number,
  now: number
): string | null {
  const def = SKILLS[skillId];
  if (!def) return 'Unknown skill.';
  const ent = player.entity;
  if (ent.dead) return null;
  if (!player.unlockedSkills().includes(skillId)) return 'Skill not unlocked yet.';
  if (player.cooldownRemaining(skillId, now) > 0) return null;
  if (player.mp < def.mpCost) return 'Not enough mana.';

  player.mp -= def.mpCost;
  player.cooldowns.set(skillId, now + def.cooldownMs);
  ent.facing = aim;
  ent.anim = def.kind === 'melee' ? 'attack' : 'cast';

  const scaleStat = def.scale === 'melee' ? player.stats.meleePower : player.stats.spellPower;
  let power = def.power * (1 + scaleStat * 0.02);
  // 10% crits keep combat spicy
  const crit = Math.random() < 0.1;
  if (crit) power *= 1.5;

  switch (def.kind) {
    case 'melee': {
      const targets = zone.grid
        .query(ent.x, ent.y, def.range + 0.5)
        .filter((e) => hostileTo(ent.faction, e))
        .filter((e) => Math.abs(angleDiff(aim, Math.atan2(e.y - ent.y, e.x - ent.x))) < Math.PI / 3);
      for (const t of targets) {
        zone.applyDamage(host, t, power, ent, now);
        if (def.stunMs && !t.dead) t.stunUntil = now + def.stunMs;
      }
      break;
    }
    case 'projectile': {
      spawnProjectile(zone, ent, aim, {
        speed: def.speed ?? 14,
        damage: Math.round(power),
        range: def.range,
        light: def.lightColor,
        variant: skillId,
      });
      break;
    }
    case 'nova': {
      const radius = def.radius ?? 3;
      host.broadcastFx(zone, { t: 'fx', kind: 'nova', x: ent.x, y: ent.y, color: def.lightColor, amount: radius });
      const targets = zone.grid.query(ent.x, ent.y, radius).filter((e) => hostileTo(ent.faction, e));
      for (const t of targets) {
        zone.applyDamage(host, t, power, ent, now);
        if (def.slowMs && !t.dead) t.slowUntil = now + def.slowMs;
      }
      break;
    }
    case 'heal': {
      const radius = def.radius ?? 4;
      host.broadcastFx(zone, { t: 'fx', kind: 'nova', x: ent.x, y: ent.y, color: def.lightColor, amount: radius });
      const allies = zone.grid
        .query(ent.x, ent.y, radius)
        .filter((e) => !e.dead && e.faction === ent.faction);
      for (const a of allies) zone.heal(host, a, power);
      break;
    }
  }
  return null;
}
