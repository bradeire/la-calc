import { z } from 'zod';
import { labelInputSchema, labelPatchSchema, PALETTE, type Label, type LabelInput } from '@/core/domain/types';
import type { Repositories } from '@/data';
import { nowIso } from '@/data/repositories/base';
import { NotFoundError, ValidationError, type UndoAction } from './events';
import { toValidationError } from './task-service';

export class LabelService {
  constructor(private r: Repositories) {}

  create(input: LabelInput, opts: { isSample?: boolean } = {}): Label {
    let data: z.output<typeof labelInputSchema>;
    try {
      data = labelInputSchema.parse(input);
    } catch (e) {
      toValidationError(e);
    }
    return this.r.db.transaction(() => {
      if (this.r.labels.findByName(data.name)) throw new ValidationError(`A label called “${data.name}” already exists`, 'name');
      const id = this.r.labels.insert({ ...data, isSample: opts.isSample });
      this.r.activity.log('label', id, 'created', { name: data.name });
      return this.r.labels.get(id)!;
    });
  }

  update(id: string, patch: Partial<LabelInput>): Label {
    let data: z.output<typeof labelPatchSchema>;
    try {
      data = labelPatchSchema.parse(patch);
    } catch (e) {
      toValidationError(e);
    }
    return this.r.db.transaction(() => {
      const existing = this.r.labels.get(id);
      if (!existing) throw new NotFoundError('That label');
      if (data.name) {
        const clash = this.r.labels.findByName(data.name);
        if (clash && clash.id !== id) throw new ValidationError(`A label called “${data.name}” already exists`, 'name');
      }
      this.r.labels.update(id, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return this.r.labels.get(id)!;
    });
  }

  /** Find labels by name, creating any that do not exist (Quick Add). */
  ensure(names: readonly string[]): string[] {
    return this.r.db.transaction(() =>
      names.map((name, i) => {
        const found = this.r.labels.findByName(name);
        if (found) return found.id;
        const color = PALETTE[(this.r.labels.list().length + i) % PALETTE.length]!.value;
        return this.create({ name, color }).id;
      }),
    );
  }

  /** Soft delete. Task associations are kept so restoring the label restores them. */
  remove(id: string): UndoAction {
    const l = this.r.labels.get(id);
    if (!l) throw new NotFoundError('That label');
    this.r.labels.update(id, { deletedAt: nowIso() });
    return { label: `Deleted label “${l.name}”`, undo: () => this.restore(id) };
  }

  restore(id: string): void {
    const l = this.r.labels.get(id);
    if (!l) throw new NotFoundError('That label');
    if (this.r.labels.findByName(l.name)) throw new ValidationError(`A label called “${l.name}” already exists — rename it first`);
    this.r.labels.update(id, { deletedAt: null });
  }
}
