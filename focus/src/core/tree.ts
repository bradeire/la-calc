import type { Task } from './domain/types';

export interface TaskNode {
  task: Task;
  depth: number;
  children: TaskNode[];
}

/**
 * Build a forest from a flat list. Tasks whose parent is not in the list are
 * treated as roots, so filtered views still show nested matches.
 */
export function buildTree(tasks: readonly Task[]): TaskNode[] {
  const byId = new Map<string, TaskNode>();
  for (const t of tasks) byId.set(t.id, { task: t, depth: 0, children: [] });
  const roots: TaskNode[] = [];
  for (const t of tasks) {
    const node = byId.get(t.id)!;
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (nodes: TaskNode[], depth: number, seen: Set<string>) => {
    for (const n of nodes) {
      if (seen.has(n.task.id)) continue;
      seen.add(n.task.id);
      n.depth = depth;
      n.children.sort((a, b) => a.task.sortOrder - b.task.sortOrder);
      setDepth(n.children, depth + 1, seen);
    }
  };
  setDepth(roots, 0, new Set());
  return roots;
}

/** Depth-first flatten, skipping children of collapsed nodes. */
export function flattenTree(nodes: readonly TaskNode[], isCollapsed: (t: Task) => boolean = (t) => t.collapsed): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (list: readonly TaskNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length && !isCollapsed(n.task)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
