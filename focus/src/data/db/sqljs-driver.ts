import type { Database, SqlJsStatic, Statement } from 'sql.js';
import type { DatabaseDriver, Row, SqlParams } from './driver';

const PRAGMAS = 'PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF;';

export class SqlJsDriver implements DatabaseDriver {
  private db: Database;
  private depth = 0;
  private dirty = false;
  private listeners = new Set<() => void>();
  private cache = new Map<string, Statement>();
  version = 0;

  constructor(sql: SqlJsStatic, bytes?: Uint8Array | null) {
    this.db = bytes ? new sql.Database(bytes) : new sql.Database();
    this.db.exec(PRAGMAS);
  }

  private stmt(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.cache.size > 300) {
        // Bounded cache; free the oldest entry.
        const [k, old] = this.cache.entries().next().value as [string, Statement];
        old.free();
        this.cache.delete(k);
      }
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, params?: SqlParams): void {
    const s = this.stmt(sql);
    try {
      s.run(params as never);
    } finally {
      s.reset();
    }
    this.markWrite();
  }

  all<T = Row>(sql: string, params?: SqlParams): T[] {
    const s = this.stmt(sql);
    const out: T[] = [];
    try {
      if (params) s.bind(params as never);
      while (s.step()) out.push(s.getAsObject() as T);
    } finally {
      s.reset();
    }
    return out;
  }

  get<T = Row>(sql: string, params?: SqlParams): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.markWrite();
  }

  transaction<T>(fn: () => T): T {
    const level = this.depth;
    const sp = `sp_${level}`;
    this.db.exec(level === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
    this.depth++;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.depth--;
      try {
        this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch (rollbackErr) {
        // Surface both errors: the original cause is the important one.
        console.error('Rollback failed', rollbackErr);
      }
      if (level === 0) this.dirty = false;
      throw err;
    }
    this.depth--;
    this.db.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    if (level === 0) this.flushNotifications();
    return result;
  }

  private markWrite() {
    this.dirty = true;
    if (this.depth === 0) this.flushNotifications();
  }

  private flushNotifications() {
    if (!this.dirty) return;
    this.dirty = false;
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  export(): Uint8Array {
    const bytes = this.db.export();
    // sql.js re-opens the database during export, resetting pragmas.
    this.db.exec(PRAGMAS);
    return bytes;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const s of this.cache.values()) s.free();
    this.cache.clear();
    this.db.close();
  }
}
