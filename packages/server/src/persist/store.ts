import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlayerRecord } from '../game/player';

/**
 * Persistence seam. The base ships a JSON file store; production swaps in a
 * database implementation without touching game code.
 */
export interface PlayerStore {
  init(): Promise<void>;
  load(name: string): Promise<PlayerRecord | null>;
  save(record: PlayerRecord): Promise<void>;
  flush(): Promise<void>;
}

export class JsonFileStore implements PlayerStore {
  private readonly dir: string;
  private records = new Map<string, PlayerRecord>();
  private dirty = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get file(): string {
    return join(this.dir, 'players.json');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const arr = JSON.parse(raw) as PlayerRecord[];
      for (const r of arr) this.records.set(r.name.toLowerCase(), r);
      console.log(`[store] loaded ${this.records.size} characters`);
    } catch {
      // first boot — no data yet
    }
  }

  async load(name: string): Promise<PlayerRecord | null> {
    return this.records.get(name.toLowerCase()) ?? null;
  }

  async save(record: PlayerRecord): Promise<void> {
    this.records.set(record.name.toLowerCase(), record);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const arr = [...this.records.values()];
    await writeFile(this.file, JSON.stringify(arr, null, 2), 'utf8');
  }
}
