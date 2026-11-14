export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;
export type Row = Record<string, SqlValue>;

/**
 * Synchronous SQLite access (ADR-003). Only repositories use this interface;
 * UI code never sees SQL.
 */
export interface DatabaseDriver {
  run(sql: string, params?: SqlParams): void;
  all<T = Row>(sql: string, params?: SqlParams): T[];
  get<T = Row>(sql: string, params?: SqlParams): T | undefined;
  /** Execute a multi-statement script (migrations). */
  exec(sql: string): void;
  /**
   * Run `fn` atomically. Nested calls use savepoints. Any thrown error rolls
   * back to the start of that level and is re-thrown — never swallowed.
   */
  transaction<T>(fn: () => T): T;
  /** Serialise the database file. */
  export(): Uint8Array;
  /** Monotonic counter, bumped after every committed write. */
  readonly version: number;
  /** Called after each committed write (outside any transaction). */
  subscribe(listener: () => void): () => void;
  close(): void;
}
