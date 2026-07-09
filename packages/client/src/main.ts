import './style.css';
import {
  CLASSES,
  ClassId,
  PASSIVES,
  PROTOCOL_VERSION,
  STAMINA_MAX,
  ServerMessage,
  SkillId,
  isCharging,
  isHovering,
  jumpPress,
  jumpRelease,
  newVerticalState,
  speedMultiplier,
  stepStamina,
  stepVertical,
} from '@webmagic/shared';
import { Connection } from './net';
import { Input } from './input';
import { initWallTextures } from './render/textures';
import { WorldState } from './state';
import { GameRenderer } from './render/renderer';
import { LoginScreen, rememberHero } from './ui/login';
import { ChatUI } from './ui/chat';
import { Hud } from './ui/hud';
import { InventoryPanel } from './ui/inventory';

const root = document.getElementById('app')!;

async function boot() {
  const login = new LoginScreen(root);
  const texturesReady = initWallTextures(); // fetch wall artwork while the player picks a class
  const conn = new Connection();
  try {
    await conn.connect();
  } catch (err) {
    login.showError((err as Error).message);
    return;
  }

  const accepted = new Promise<Extract<ServerMessage, { t: 'welcome' }>>((resolve) => {
    conn.onMessage = (msg) => {
      if (msg.t === 'welcome') resolve(msg);
      else if (msg.t === 'reject') login.showError(msg.reason);
    };
  });

  // Re-arm the submit handler until the server lets us in.
  let done = false;
  let passphrase = '';
  void (async () => {
    while (!done) {
      const res = await login.waitForSubmit();
      passphrase = res.pass;
      conn.send({ t: 'hello', v: PROTOCOL_VERSION, name: res.name, classId: res.classId, pass: res.pass });
    }
  })();

  const welcome = await accepted;
  done = true;
  // Remember this hero so next visit pre-fills the login (and prompts for the
  // passphrase if one was set). The server's class wins for existing characters.
  rememberHero(welcome.name, welcome.classId, passphrase.length > 0);
  await texturesReady; // wall materials must exist before the first zone builds
  login.hide();
  startGame(conn, welcome.classId, welcome.playerId, welcome.name, passphrase);
}

function startGame(
  initialConn: Connection,
  classId: ClassId,
  initialSelfId: number,
  playerName: string,
  passphrase: string
) {
  let conn = initialConn;
  let selfEntityId = initialSelfId;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const state = new WorldState();
  const renderer = new GameRenderer(root, overlay);
  root.appendChild(overlay);

  const input = new Input(renderer.canvas);
  const chat = new ChatUI(overlay);
  const hud = new Hud(overlay, classId);
  const inventory = new InventoryPanel(overlay);

  // ---- local movement gamefeel: predict own jump + stamina for instant feel;
  // the server runs the identical shared physics to replicate height to others.
  const vert = newVerticalState();
  let localStam = STAMINA_MAX;
  let wasGrounded = true;
  let peakAir = 0; // track fall height so only real landings kick up dust
  let hoverFxAt = 0; // throttle for hover particles

  // ---- input wiring
  input.isTyping = () => chat.isOpen;
  // Menus need the cursor, so free the mouse while any is open and don't let
  // the canvas recapture it until they're all closed.
  input.canLock = () => !inventory.isOpen && !chat.isOpen;
  const releaseMouseForMenu = () => {
    if (document.pointerLockElement) document.exitPointerLock();
  };
  input.onJump = (phase) => {
    const now = performance.now();
    if (phase === 'down') jumpPress(vert, classId, now);
    else jumpRelease(vert, classId, now);
    conn.send({ t: 'jump', phase });
  };
  input.onOpenChat = (initial) => {
    chat.open(initial ?? '');
    releaseMouseForMenu();
  };
  input.onToggleInventory = () => {
    inventory.toggle();
    if (inventory.isOpen) releaseMouseForMenu();
  };
  input.onInteract = () => {
    const target = state.nearestInteractable();
    if (target) conn.send({ t: 'interact', id: target.latest.id });
  };
  // Active skill loadout [LMB, RMB, E, Q], kept in sync from inventory messages.
  let loadout: (SkillId | null)[] = [CLASSES[classId].primary, null, CLASSES[classId].skills[0] ?? null, CLASSES[classId].skills[1] ?? null];
  const castSlot = (slot: number) => {
    const skillId = loadout[slot];
    if (!skillId || state.self?.dead) return;
    conn.send({ t: 'cast', skillId, aim: input.facing() });
    renderer.castKick(); // recoil punch for weight
  };
  input.onCast = castSlot;
  hud.onCastSlot = castSlot;
  hud.onRespawn = () => conn.send({ t: 'respawn' });
  chat.onSend = (ch, text) => conn.send({ t: 'chat', ch, text });
  inventory.onEquip = (itemId) => conn.send({ t: 'equip', itemId });
  inventory.onUnequip = (slot) => conn.send({ t: 'unequip', slot });
  inventory.onDrop = (itemId) => conn.send({ t: 'drop', itemId });

  // ---- server messages
  const handleServerMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'zone': {
        state.setZone(msg);
        renderer.setZone(state);
        if (msg.kind === 'overworld') {
          hud.setZone('THE WILDS', 'stay near the lanterns after dark');
        } else {
          hud.setZone(
            (msg.dungeonName ?? 'DUNGEON').toUpperCase(),
            `floor ${msg.floor} — complete ${msg.keepFloors} floors to keep your loot`
          );
          hud.showBigNotice(`${msg.dungeonName} — Floor ${msg.floor}`);
        }
        break;
      }
      case 'snap':
        state.applySnapshot(msg, performance.now());
        break;
      case 'inv': {
        inventory.setData(msg.items, msg.equipment, msg.attrs);
        loadout = msg.loadout;
        hud.setLoadout(msg.loadout);
        // Drive weapon-passive visuals from equipped gear.
        const passives = new Set(Object.values(msg.equipment).map((it) => it?.passive).filter(Boolean));
        const followColor = passives.has('following_light') ? PASSIVES.following_light.color : 0;
        renderer.setPassives(followColor, passives.has('spinning_fireballs'));
        break;
      }
      case 'chat':
        chat.addChat(msg.ch, msg.from, msg.text);
        break;
      case 'notice':
        chat.addNotice(msg.text, msg.style ?? 'info');
        if (msg.style === 'loot') hud.showBigNotice(msg.text);
        break;
      case 'fx':
        handleFx(msg);
        break;
      case 'reject':
        chat.addNotice(msg.reason, 'warn');
        break;
    }
  };
  // ---- automatic reconnection: log back in as the same character
  const wire = (c: Connection) => {
    c.onMessage = handleServerMessage;
    c.onClose = () => void reconnect();
  };

  let reconnecting = false;
  async function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    hud.setZone('RECONNECTING…', 'the connection was lost — retrying');
    chat.addNotice('Connection lost — reconnecting…', 'warn');
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const c = new Connection();
        await c.connect();
        const buffered: ServerMessage[] = [];
        const ok = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 5000);
          c.onMessage = (m) => {
            if (m.t === 'welcome') {
              clearTimeout(timeout);
              selfEntityId = m.playerId;
              resolve(true);
            } else if (m.t === 'reject') {
              clearTimeout(timeout);
              resolve(false);
            } else {
              buffered.push(m); // zone/inv can arrive right behind welcome
            }
          };
          c.onClose = () => {
            clearTimeout(timeout);
            resolve(false);
          };
          c.send({ t: 'hello', v: PROTOCOL_VERSION, name: playerName, classId, pass: passphrase });
        });
        if (!ok) continue; // name may still be held by the dying session — retry
        conn = c;
        wire(c);
        for (const m of buffered) handleServerMessage(m);
        chat.addNotice('Reconnected.', 'info');
        reconnecting = false;
        return;
      } catch {
        // server still down — keep trying
      }
    }
  }
  wire(conn);

  function handleFx(msg: Extract<ServerMessage, { t: 'fx' }>) {
    const now = performance.now();
    switch (msg.kind) {
      case 'hit':
      case 'crit': {
        if (msg.entId) renderer.sprites.flash(msg.entId, now);
        const isSelf = msg.entId !== undefined && state.self && msg.entId === selfEntityId;
        renderer.fx.damageNumber(msg.x, msg.y, String(msg.amount ?? ''), isSelf ? '#ff5544' : '#ffd866');
        renderer.fx.sparks(msg.x, msg.y, isSelf ? 0xff5544 : 0xffd866, msg.kind === 'crit' ? 12 : 6);
        // Juice: taking a hit shakes the camera and flashes red; landing a crit gives a small jolt.
        if (isSelf) {
          renderer.addTrauma(msg.kind === 'crit' ? 0.5 : 0.32);
          hud.flashDamage();
        } else if (msg.kind === 'crit') {
          renderer.addTrauma(0.14);
        }
        break;
      }
      case 'heal':
        renderer.fx.damageNumber(msg.x, msg.y, `+${msg.amount}`, '#7ec87e');
        break;
      case 'death':
        renderer.fx.damageNumber(msg.x, msg.y, '✝', '#99999a', 20);
        break;
      case 'levelup':
        renderer.fx.nova(msg.x, msg.y, 0xffd866, 3);
        if (msg.entId === selfEntityId) hud.showBigNotice('LEVEL UP!');
        break;
      case 'nova':
        renderer.fx.nova(msg.x, msg.y, msg.color ?? 0xffffff, msg.amount ?? 3);
        break;
      case 'explosion':
        renderer.explosion(msg.x, msg.y, msg.color ?? 0xff7722, msg.amount ?? 2);
        break;
      case 'pickup':
        renderer.fx.damageNumber(msg.x, msg.y, '+', '#d8b45a');
        break;
      case 'feathers':
        renderer.fx.feathers(msg.x, msg.y, msg.color);
        break;
      case 'windup':
        // an attack being wound up nearby — amber flare on the attacker
        if (msg.entId) renderer.sprites.telegraph(msg.entId, now, msg.amount ?? 400);
        break;
      case 'swing': {
        renderer.fx.swingArc(msg.x, msg.y, msg.dir ?? 0, msg.amount ?? 2, msg.color ?? 0xffe6b0);
        // your own swing carries a little kick
        if (msg.entId === selfEntityId) renderer.addTrauma(0.06);
        break;
      }
    }
  }

  // Dev console access: window.__wm.state / .input
  (window as unknown as Record<string, unknown>).__wm = { state, input, renderer };

  // ---- main loop
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    const { mx, my } = input.moveIntent(dt);
    const moving = mx !== 0 || my !== 0;

    // Local jump + stamina prediction (mirrors the server exactly).
    stepVertical(vert, classId, now, dt);
    // Kick up dust on landing after a real jump.
    peakAir = Math.max(peakAir, vert.z);
    if (vert.grounded && !wasGrounded && peakAir > 0.6) {
      renderer.fx.dust(state.x, state.y);
      renderer.landImpact(Math.min(1, peakAir * 0.4)); // bigger falls hit harder
    }
    if (vert.grounded) peakAir = 0;
    wasGrounded = vert.grounded;
    const hovering = isHovering(vert, classId, now);
    const sprinting = input.sprinting && moving && localStam > 0 && !isCharging(vert) && !hovering;
    localStam = stepStamina(localStam, sprinting, dt);
    const spdMul = speedMultiplier(sprinting, localStam, isCharging(vert), hovering);
    // Arcane wake: purple motes stream off a hovering wizard.
    if (hovering && now - hoverFxAt > 55) {
      hoverFxAt = now;
      renderer.fx.magicTrail(state.x, state.y);
    }

    const chunk = state.move(mx, my, dt, spdMul);
    if (chunk) {
      conn.send({ t: 'input', seq: chunk.seq, mx: chunk.mx, my: chunk.my, f: input.facing(), dt: chunk.dt, sprint: chunk.sprint });
    }

    // interact prompt
    const target = state.nearestInteractable();
    if (target) {
      const l = target.latest;
      let label = 'F — interact';
      if (l.k === 'portal') label = `F — ${l.v === 'portal-exit' ? 'Leave through' : 'Enter'} ${l.n ?? 'portal'}`;
      else if (l.k === 'loot') label = `F — pick up ${l.n ?? 'loot'}`;
      else if (l.v === 'signpost') label = 'F — read the sign';
      else if (l.v === 'campfire') label = 'F — rest at the fire';
      else if (l.v === 'chicken') label = 'F — pet the chicken';
      else if (l.k === 'npc') label = `F — talk to ${l.n ?? 'villager'}`;
      hud.setPrompt(label);
    } else {
      hud.setPrompt(null);
    }

    hud.update(state, now, localStam);
    renderer.render(state, input, now, dt, moving, vert.z, hovering);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void boot();
