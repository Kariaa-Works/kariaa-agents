/**
 * The jobs seen in recent searches, so `get` works for sources that cannot
 * look a listing up by id, and so a later CLI process still knows an id.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobSchema, type Job } from "./types.js";

export type JobCacheOptions = {
  /** Entries kept. Default 500. */
  max?: number;
  /** Default 7 days. */
  ttlMs?: number;
  /** JSON file to persist to; null for memory only. */
  file?: string | null;
};

type Entry = { at: number; job: Job };

export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.WORK_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "work-protocol");
  return path.join(dir, "jobs.json");
}

export class JobCache {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly file: string | null;
  private dirty = false;

  constructor(options: JobCacheOptions = {}) {
    this.max = options.max ?? 500;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.file = options.file ?? null;
    if (this.file) this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string): Job | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(id);
      this.dirty = true;
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.job;
  }

  set(job: Job): void {
    this.entries.delete(job.id);
    this.entries.set(job.id, { at: Date.now(), job });
    this.trim();
    this.dirty = true;
  }

  setMany(jobs: Iterable<Job>): void {
    for (const job of jobs) this.set(job);
  }

  private trim(): void {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as { version?: number; entries?: unknown[] };
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return;
      const now = Date.now();
      for (const raw of parsed.entries) {
        const entry = raw as Partial<Entry>;
        if (!entry || typeof entry.at !== "number" || now - entry.at > this.ttlMs) continue;
        const job = JobSchema.safeParse(entry.job);
        if (!job.success) continue;
        this.entries.set(job.data.id, { at: entry.at, job: job.data });
      }
      this.trim();
    } catch {
      // No cache yet, or an unreadable one: start empty.
    }
  }

  /** Writes the cache when something changed. Never throws: a cache is a convenience. */
  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // Read-only home, full disk: carry on without persistence.
    }
  }
}
