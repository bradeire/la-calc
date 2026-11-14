export interface Migration {
  version: number;
  name: string;
  /** SQL script applied inside a transaction. */
  up: string;
  /** Reverses `up`. May be destructive; only run with explicit user consent. */
  down: string;
}
