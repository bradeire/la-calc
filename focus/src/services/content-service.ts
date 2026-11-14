import type { Repositories } from '@/data';
import type { FileStore } from '@/platform/types';
import { newId } from '@/data/repositories/base';
import { NotFoundError, ValidationError, type UndoAction } from './events';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Executable or script types are refused; everything is stored as inert bytes and only ever downloaded. */
const BLOCKED_EXTENSIONS = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|apk|app|dmg|sh)$/i;

export class ContentService {
  constructor(private r: Repositories, private files: FileStore) {}

  addComment(taskId: string, body: string): string {
    const text = body.trim();
    if (!text) throw new ValidationError('A comment cannot be empty');
    if (text.length > 20000) throw new ValidationError('Comments are limited to 20,000 characters');
    return this.r.db.transaction(() => {
      if (!this.r.tasks.get(taskId)) throw new NotFoundError('That task');
      const id = this.r.comments.insert({ taskId, body: text });
      this.r.activity.log('task', taskId, 'comment.added');
      return id;
    });
  }

  editComment(id: string, body: string): void {
    const text = body.trim();
    if (!text) throw new ValidationError('A comment cannot be empty');
    this.r.comments.update(id, text);
  }

  removeComment(id: string): UndoAction {
    this.r.comments.softDelete(id);
    return { label: 'Comment deleted', undo: () => this.r.comments.softDelete(id, null) };
  }

  async addAttachment(target: { taskId?: string; projectId?: string }, file: File | Blob, fileName: string): Promise<string> {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new ValidationError('Attachments are limited to 50 MB each');
    if (BLOCKED_EXTENSIONS.test(fileName)) throw new ValidationError('Executable and script files cannot be attached');
    // Strip path separators and control characters from user-supplied file names.
    // eslint-disable-next-line no-control-regex
    const safeName = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'attachment';
    const key = `att_${newId()}`;
    await this.files.put(key, file);
    try {
      return this.r.db.transaction(() => {
        const id = this.r.attachments.insert({
          taskId: target.taskId ?? null,
          projectId: target.projectId ?? null,
          fileName: safeName,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          storageKey: key,
        });
        if (target.taskId) this.r.activity.log('task', target.taskId, 'attachment.added', { fileName: safeName });
        return id;
      });
    } catch (err) {
      // Do not leave orphaned bytes behind if the metadata could not be saved.
      await this.files.delete(key);
      throw err;
    }
  }

  async getAttachmentBlob(id: string): Promise<{ blob: Blob; fileName: string }> {
    const a = this.r.attachments.get(id);
    if (!a) throw new NotFoundError('That attachment');
    const blob = await this.files.get(a.storageKey);
    if (!blob) throw new NotFoundError(`The file for “${a.fileName}”`);
    return { blob: new Blob([blob], { type: a.mimeType }), fileName: a.fileName };
  }

  /** Soft delete; the stored bytes are kept until Trash is emptied, so undo works. */
  removeAttachment(id: string): UndoAction {
    this.r.attachments.softDelete(id);
    return { label: 'Attachment removed', undo: () => this.r.attachments.softDelete(id, null) };
  }

  addReminder(taskId: string, r: { kind: 'absolute'; remindAt: string } | { kind: 'relative'; offsetMinutes: number }): string {
    const t = this.r.tasks.get(taskId);
    if (!t) throw new NotFoundError('That task');
    if (r.kind === 'absolute') {
      if (Number.isNaN(Date.parse(r.remindAt))) throw new ValidationError('Choose a valid reminder time');
      return this.r.reminders.insert({ taskId, kind: 'absolute', remindAt: new Date(r.remindAt).toISOString() });
    }
    if (!t.scheduledDate && !t.deadline) throw new ValidationError('Relative reminders need a scheduled date or deadline');
    if (!Number.isInteger(r.offsetMinutes) || r.offsetMinutes < 0 || r.offsetMinutes > 60 * 24 * 60) {
      throw new ValidationError('Choose a reminder offset between 0 minutes and 60 days');
    }
    return this.r.reminders.insert({ taskId, kind: 'relative', offsetMinutes: r.offsetMinutes });
  }

  removeReminder(id: string): void {
    this.r.reminders.delete(id);
  }
}
