import { extractCandidates, type Candidate, type CaptureSource } from '@/core/capture';
import { parseQuickAdd } from '@/core/nlp/parser';
import type { Task } from '@/core/domain/types';
import type { Repositories } from '@/data';
import type { AiService } from './ai-service';
import { ValidationError } from './events';
import type { QuickAddService } from './quick-add-service';

/** Email / notes / document capture (spec 5.6). Produces suggestions; `commit` creates only what the user ticked. */
export class CaptureService {
  constructor(private r: Repositories, private quickAdd: QuickAddService, private ai: AiService, private now: () => Date = () => new Date()) {}

  private ctx() {
    const s = this.r.settings.getAll();
    return {
      now: this.now(),
      prefs: { dateOrder: s.dateOrder, hour12: s.hour12, weekStartsOn: s.weekStartsOn },
      projects: this.r.projects.list().map((p) => ({ id: p.id, name: p.name })),
      labels: this.r.labels.list().map((l) => ({ id: l.id, name: l.name })),
    };
  }

  /** Deterministic, offline extraction. */
  analyse(text: string): { source: CaptureSource; candidates: Candidate[] } {
    if (!text.trim()) throw new ValidationError('Paste some text or choose a file first');
    if (text.length > 200_000) throw new ValidationError('That text is too long (200,000 characters max)');
    return extractCandidates(text, this.ctx());
  }

  /** AI extraction (only when configured and consented); results go through the same parser. */
  async analyseWithAi(text: string): Promise<{ source: CaptureSource; candidates: Candidate[] }> {
    const { source } = this.analyse(text);
    const items = await this.ai.extract(source.body || text);
    const ctx = this.ctx();
    const candidates = items.map((i) => {
      const t = `${i.title}${i.due ? ` by ${i.due}` : ''}`;
      return { text: t, parsed: parseQuickAdd(t, ctx), sourceLine: i.title, confidence: 'medium' as const, why: 'Suggested by the AI assistant' };
    });
    return { source, candidates: candidates.filter((c) => c.parsed.title.trim()) };
  }

  /** Create the chosen suggestions; the source is recorded in each description. */
  commit(chosen: { text: string; sourceLine: string }[], source: CaptureSource, projectId: string | null): Task[] {
    const ctx = this.ctx();
    const origin = source.kind === 'email' ? `From email “${source.subject ?? '(no subject)'}”${source.from ? ` — ${source.from}` : ''}` : 'Captured from notes';
    return this.r.db.transaction(() =>
      chosen.map((c) =>
        this.quickAdd.commit(parseQuickAdd(c.text, ctx), { projectId }, { description: `${origin}\n> ${c.sourceLine.slice(0, 500)}` }),
      ),
    );
  }
}
