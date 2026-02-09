import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function getCacheDir(appName: string): string {
  const platform = process.platform;
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA
      ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : undefined)
      ?? os.tmpdir();
    return path.join(base, appName);
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", appName);
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, appName);
}

export interface CheckpointStore {
  save(id: string, data: { elements: any[] }): Promise<void>;
  load(id: string): Promise<{ elements: any[] } | null>;
}

export class FileCheckpointStore implements CheckpointStore {
  private dir: string;
  constructor() {
    this.dir = path.join(getCacheDir("excalichat"), "checkpoints");
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async save(id: string, data: { elements: any[] }): Promise<void> {
    await fs.promises.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(data));
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    try {
      const raw = await fs.promises.readFile(path.join(this.dir, `${id}.json`), "utf-8");
      return JSON.parse(raw);
    } catch { return null; }
  }
}

const memoryStore = new Map<string, string>();
export class MemoryCheckpointStore implements CheckpointStore {
  async save(id: string, data: { elements: any[] }): Promise<void> {
    memoryStore.set(id, JSON.stringify(data));
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    const raw = memoryStore.get(id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;
export class RedisCheckpointStore implements CheckpointStore {
  private redis: any = null;
  private async getRedis() {
    if (!this.redis) {
      const { Redis } = await import("@upstash/redis");
      const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) throw new Error("Missing Redis env vars (KV_REST_API_* or UPSTASH_REDIS_REST_*)");
      this.redis = new Redis({ url, token });
    }
    return this.redis;
  }
  async save(id: string, data: { elements: any[] }): Promise<void> {
    const redis = await this.getRedis();
    await redis.set(`cp:${id}`, JSON.stringify(data), { ex: REDIS_TTL_SECONDS });
  }
  async load(id: string): Promise<{ elements: any[] } | null> {
    const redis = await this.getRedis();
    const raw = await redis.get(`cp:${id}`);
    if (!raw) return null;
    try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  }
}

export function createVercelStore(): CheckpointStore {
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    return new RedisCheckpointStore();
  }
  return new MemoryCheckpointStore();
}
