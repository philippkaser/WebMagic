import type { WebSocket } from 'ws';
import { ServerMessage, encode } from '@webmagic/shared';
import type { Player } from '../game/player';
import type { ServerStats } from '../stats';

let nextSessionId = 1;

/**
 * One connected socket. Knows nothing about game rules — it carries the
 * player reference, replication bookkeeping and rate limiting.
 */
export class Session {
  readonly id = nextSessionId++;
  readonly ws: WebSocket;
  player: Player | null = null;
  /** Entity ids this client currently knows about (for AOI enter/leave diffs). */
  known = new Set<number>();
  /** Force a zone (re)send on next snapshot. */
  needsZoneSync = true;

  // token-bucket rate limiting
  private tokens: number;
  private lastRefill = Date.now();
  private readonly ratePerSec: number;

  // chat gets its own, tighter bucket
  private chatTokens = 3;
  private lastChatRefill = Date.now();

  private readonly stats?: ServerStats;

  constructor(ws: WebSocket, ratePerSec: number, stats?: ServerStats) {
    this.ws = ws;
    this.ratePerSec = ratePerSec;
    this.tokens = ratePerSec;
    this.stats = stats;
  }

  /** @returns false if the client is over its message budget. */
  takeToken(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.ratePerSec, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  takeChatToken(): boolean {
    const now = Date.now();
    this.chatTokens = Math.min(3, this.chatTokens + (now - this.lastChatRefill) / 1500);
    this.lastChatRefill = now;
    if (this.chatTokens < 1) return false;
    this.chatTokens -= 1;
    return true;
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      const data = encode(msg);
      if (this.stats) this.stats.bytesOut += data.length;
      this.ws.send(data);
    }
  }
}
