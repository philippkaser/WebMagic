import { ClientMessage, ServerMessage, decode, encode } from '@webmagic/shared';

export type MessageHandler = (msg: ServerMessage) => void;

/**
 * Thin WebSocket wrapper. Connects to the same origin (`/ws` is proxied by
 * Vite in dev and by your reverse proxy in production); VITE_SERVER_URL
 * overrides for split deployments.
 */
export class Connection {
  private ws: WebSocket | null = null;
  onMessage: MessageHandler = () => {};
  onClose: () => void = () => {};

  connect(): Promise<void> {
    const override = import.meta.env.VITE_SERVER_URL as string | undefined;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = override ?? `${proto}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the game server.'));
      ws.onmessage = (ev) => {
        const msg = decode<ServerMessage>(ev.data as string);
        if (msg) this.onMessage(msg);
      };
      ws.onclose = () => this.onClose();
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }
}
