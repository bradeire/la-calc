/**
 * Domain event bus. Services emit after a successful commit. The Phase 3
 * automation engine subscribes here; the UI does not need to change.
 */
export type DomainEvent =
  | { type: 'task.created'; taskId: string }
  | { type: 'task.updated'; taskId: string; changes: string[] }
  | { type: 'task.completed'; taskId: string; nextId: string | null }
  | { type: 'task.reopened'; taskId: string }
  | { type: 'task.deleted'; taskIds: string[] }
  | { type: 'task.moved'; taskIds: string[]; projectId: string | null }
  | { type: 'task.priorityChanged'; taskId: string; from: number; to: number }
  | { type: 'task.labelAdded'; taskId: string; labelId: string }
  | { type: 'project.created'; projectId: string }
  | { type: 'project.completed'; projectId: string };

type Listener = (e: DomainEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private queue: DomainEvent[] = [];
  private depth = 0;

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Events emitted inside `batch` are delivered after it completes successfully. */
  batch<T>(fn: () => T): T {
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      if (this.depth === 0) this.drain();
      return r;
    } catch (e) {
      this.depth--;
      if (this.depth === 0) this.queue = [];
      throw e;
    }
  }

  emit(e: DomainEvent) {
    this.queue.push(e);
    if (this.depth === 0) this.drain();
  }

  private drain() {
    const q = this.queue;
    this.queue = [];
    for (const e of q) {
      for (const l of this.listeners) {
        try {
          l(e);
        } catch (err) {
          // A failing subscriber must not break the user's action, but must be visible.
          console.error(`Event listener failed for ${e.type}`, err);
        }
      }
    }
  }
}

export interface UndoAction {
  label: string;
  undo: () => void;
}

export class ValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} could not be found. It may have been deleted.`);
    this.name = 'NotFoundError';
  }
}

/**
 * The action is allowed but probably unintended (e.g. completing a blocked task).
 * The UI asks the user and, if they agree, repeats the action with `force`.
 */
export class ConfirmationRequired extends Error {
  constructor(
    message: string,
    public readonly confirmLabel: string,
  ) {
    super(message);
    this.name = 'ConfirmationRequired';
  }
}
