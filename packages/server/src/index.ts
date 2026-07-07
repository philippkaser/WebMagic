import { WebSocketServer } from 'ws';
import { ClientMessage, decode } from '@webmagic/shared';
import { CONFIG } from './config';
import { GameServer } from './game/game';
import { Session } from './net/session';
import { JsonFileStore } from './persist/store';

async function main() {
  const store = new JsonFileStore(CONFIG.dataDir);
  await store.init();

  const game = new GameServer(store);
  game.start();

  const wss = new WebSocketServer({ port: CONFIG.port, path: '/ws' });

  wss.on('connection', (ws) => {
    if (game.sessions.size >= CONFIG.maxConnections) {
      ws.close(1013, 'Server full');
      return;
    }
    const session = new Session(ws, CONFIG.messageRateLimit);
    game.addSession(session);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!session.takeToken()) return; // silently drop flooders
      const msg = decode<ClientMessage>(data.toString());
      if (!msg || typeof msg.t !== 'string') return;
      try {
        game.handleMessage(session, msg);
      } catch (err) {
        console.error('[net] message handling error', err);
      }
    });

    ws.on('close', () => void game.removeSession(session));
    ws.on('error', () => ws.close());
  });

  console.log(`[net] WebMagic server listening on ws://0.0.0.0:${CONFIG.port}/ws (seed ${CONFIG.worldSeed})`);

  const shutdown = async () => {
    console.log('[net] shutting down…');
    wss.close();
    await game.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
