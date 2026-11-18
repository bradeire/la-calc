import { addDays, todayISO } from '@/core/dates';
import { parseQuickAdd } from '@/core/nlp/parser';
import type { LabelService } from '@/services/label-service';
import type { ProjectService } from '@/services/project-service';
import type { TaskService } from '@/services/task-service';

/**
 * Demonstration data. Every row is tagged is_sample = 1 so it can be removed
 * cleanly later (DataService.removeSampleData). Dates are relative to today.
 */
export function loadSampleData(
  svc: { tasks: TaskService; projects: ProjectService; labels: LabelService },
  now: Date = new Date(),
) {
  const today = todayISO(now);
  const d = (n: number) => addDays(today, n);
  const sample = { isSample: true };

  const labels = {
    calls: svc.labels.create({ name: 'calls', color: '#0284c7' }, sample).id,
    errands: svc.labels.create({ name: 'errands', color: '#d97706' }, sample).id,
    quick: svc.labels.create({ name: 'quick-win', color: '#16a34a' }, sample).id,
    waiting: svc.labels.create({ name: 'waiting-on', color: '#7c3aed' }, sample).id,
  };

  const home = svc.projects.create({ name: 'Home', color: '#16a34a', icon: 'house', description: 'House, garden and admin' }, sample);
  const diy = svc.projects.create({ name: 'Kitchen refit', color: '#ea580c', icon: 'hammer', parentId: home.id, layout: 'board' }, sample);
  const work = svc.projects.create({ name: 'Work', color: '#2563eb', icon: 'briefcase', description: 'Quarterly priorities' }, sample);
  const holiday = svc.projects.create({ name: 'Lake District trip', color: '#0d9488', icon: 'map', layout: 'list' }, sample);

  const s = (projectId: string, name: string) => svc.projects.addSection(projectId, name);
  const diyPlan = s(diy.id, 'Planning');
  const diyDoing = s(diy.id, 'In progress');
  s(diy.id, 'Done');
  const workReport = s(work.id, 'Q4 report');
  const workAdmin = s(work.id, 'Admin');

  const t = svc.tasks;
  t.create({ title: 'Buy batteries for smoke alarms', projectId: home.id, scheduledDate: d(0), priority: 2, labelIds: [labels.errands, labels.quick], durationMinutes: 15 }, sample);
  t.create({ title: 'Phone the dentist to rebook check-up', scheduledDate: d(-1), scheduledTime: '10:00', labelIds: [labels.calls], durationMinutes: 10 }, sample);
  t.create({ title: 'Renew car insurance', projectId: home.id, deadline: d(6), scheduledDate: d(3), priority: 1, description: 'Compare at least three quotes before renewing.' }, sample);
  const meter = parseQuickAdd('Submit meter reading every month on the 1st', { now });
  t.create({ title: meter.title, projectId: home.id, scheduledDate: meter.scheduledDate, recurrence: meter.recurrence, recurrenceText: meter.recurrenceText, durationMinutes: 5 }, sample);
  const bins = parseQuickAdd('Put the bins out every tuesday', { now });
  t.create({ title: bins.title, projectId: home.id, scheduledDate: bins.scheduledDate, scheduledTime: '19:00', recurrence: bins.recurrence, recurrenceText: bins.recurrenceText }, sample);

  t.create({ title: 'Measure the worktop run', projectId: diy.id, sectionId: diyPlan, priority: 2, durationMinutes: 30 }, sample);
  const quotes = t.create({ title: 'Get fitter quotes', projectId: diy.id, sectionId: diyPlan, deadline: d(14), priority: 2 }, sample);
  t.create({ title: 'Email Hughes & Sons', parentId: quotes.id, labelIds: [labels.waiting] }, sample);
  t.create({ title: 'Ask neighbours for recommendations', parentId: quotes.id }, sample);
  const done = t.create({ title: 'Collect brochure', parentId: quotes.id }, sample);
  t.complete(done.id);
  t.create({ title: 'Replace kitchen tap', projectId: diy.id, sectionId: diyDoing, priority: 2, scheduledDate: d(2), durationMinutes: 90 }, sample);

  const report = t.create({ title: 'Draft Q4 report', projectId: work.id, sectionId: workReport, priority: 1, deadline: d(9), scheduledDate: d(1), durationMinutes: 120 }, sample);
  const gather = t.create({ title: 'Gather figures from finance', parentId: report.id, priority: 2, scheduledDate: d(0) }, sample);
  t.create({ title: 'Chase missing October numbers', parentId: gather.id, labelIds: [labels.waiting, labels.calls] }, sample);
  t.create({ title: 'Write executive summary', parentId: report.id, durationMinutes: 45 }, sample);
  t.create({ title: 'Book 1:1 with line manager', projectId: work.id, sectionId: workAdmin, scheduledDate: d(4), labelIds: [labels.quick] }, sample);
  t.create({ title: 'Submit expenses', projectId: work.id, sectionId: workAdmin, deadline: d(-2), priority: 3, labelIds: [labels.quick], status: 'waiting' }, sample);

  t.create({ title: 'Research walking routes', projectId: holiday.id, durationMinutes: 60, scheduledDate: d(5) }, sample);
  t.create({ title: 'Book accommodation', projectId: holiday.id, priority: 1, deadline: d(10) }, sample);
  t.create({ title: 'Check travel documents', projectId: holiday.id, priority: 3 }, sample);
  t.create({ title: 'Read through the inbox and file tasks', pinnedToday: true, labelIds: [labels.quick] }, sample);
  t.create({ title: 'Look into a better note-taking routine' }, sample);
}
