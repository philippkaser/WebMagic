import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ClientMessage, decode } from '@webmagic/shared';
import { CONFIG } from './config';
import { GameServer } from './game/game';
import { Session } from './net/session';
import { staticHandler } from './net/static';
import { JsonFileStore } from './persist/store';

async function main() {
  const store = new JsonFileStore(CONFIG.dataDir);
  await store.init();

  const game = new GameServer(store);
  game.start();

  // One port for everything: the built client over HTTP + the game WebSocket.
  const httpServer = createServer(staticHandler(CONFIG.clientDist));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES') {
      console.error(
        `[net] no permission to bind port ${CONFIG.port}. Run privileged, ` +
          `grant the capability (sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"), ` +
          `or pick another port with PORT=8080.`
      );
    } else if (err.code === 'EADDRINUSE') {
      console.error(`[net] port ${CONFIG.port} is already in use — set PORT to something free.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  httpServer.listen(CONFIG.port, () => {
    console.log(
      `[net] WebMagic serving http://0.0.0.0:${CONFIG.port}/ ` +
        `(game socket at /ws, seed ${CONFIG.worldSeed})`
    );
  });

  const shutdown = async () => {
    console.log('[net] shutting down…');
    wss.close();
    httpServer.close();
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
