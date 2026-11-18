import type { Migration } from './types';

/**
 * Index for "next sort position among siblings" (project_id, parent_id).
 * Without it, every task insert scanned all top-level tasks (O(n)); measured
 * at ~1.6 ms per insert with 20,000 tasks. See tests/performance.test.ts.
 */
export const migration002: Migration = {
  version: 2,
  name: 'task sibling order index',
  up: 'CREATE INDEX IF NOT EXISTS idx_tasks_siblings ON tasks(project_id, parent_id, sort_order);',
  down: 'DROP INDEX IF EXISTS idx_tasks_siblings;',
};
