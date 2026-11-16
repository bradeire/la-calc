# Changelog

## 0.4.0 — 2026-11-16 (Phase 3: intelligence and automation)

### Added
- Automations: trigger → conditions (filter builder) → actions, with examples, history, test mode, hourly limits,
  duplicate and loop prevention.
- Webhooks with HMAC-SHA256 signing; Home Assistant guide (INTEGRATIONS.md).
- Capture tasks from pasted emails, meeting notes and text files; Android share target.
- Optional AI assistant (Ollama or OpenAI-compatible) with consent, payload preview and confirm-before-apply:
  subtasks, task suggestions, project summary, filter from words, template drafts, plan review, AI capture.
- Voice dictation in Quick Add with clear online/on-device disclosure.
- Native: OS keychain for secrets and Rust-side HTTP for integrations.
- First Android build: signed arm64 release APK (Tauri Android project in `src-tauri/gen/android`).

### Fixed
- Edits could be lost when the page was reloaded or closed immediately after a change.

## 0.3.0 — 2026-11-16 (Phase 2: advanced planning)

### Added
- Calendar day, 3-day, week (time grid with drag-to-move, drag-to-resize, click-to-add), month and agenda views,
  with project/label filters, deadlines, projected repeats, working-hours shading and a current-time line.
- Task dependencies with cycle prevention, blocked badges and "Complete anyway" / "Schedule anyway" confirmations.
- Filters: visual builder and query language kept in sync; saved and pinned filters; quick-start presets.
- Workload bars, conflict detection and suggested rescheduling with accept/reject (Upcoming → Review plan).
- Reminders delivered in-app with Complete/Snooze/Dismiss, plus optional system notifications (web and desktop).
- Project templates: save any project as a template; built-in "Holiday planning".
- Settings: notifications, default estimate.

### Fixed
- Weekend tasks counted as overload; blocked-task lookup slow on large lists; several collapsed-section controls.

## 0.2.0 — 2026-11-16 (Phase 1 completion)

### Added
- Native desktop/mobile shell (Tauri 2): SQLite stored as a real file with atomic saves, rotation and snapshots;
  single-instance guard; flush before window close; per-user Windows installer configuration; app icons.
- Project notes and attachments.
- Virtualised task lists for large views.
- Automated accessibility audit, offline test, performance tests.

### Changed
- Higher-contrast secondary text, accessible accent palette, readable label colours, calendar ARIA structure.
- Database migration 002 (sibling-order index).

### Fixed
- Quick Add menus appeared behind the dialog.
- Installed web app failed to load offline.
- "Add file" did nothing while the attachments section was collapsed.
- New databases weren't saved until the first edit.
- Upcoming showed "Today" for timed tasks on other days.

## 0.1.0 — 2026-11-14 (Phase 1, first session)

### Added
- Architecture decision records, architecture, database and roadmap documentation.
- Local SQLite database (sql.js) persisted to IndexedDB with rotating snapshots, integrity check on start-up,
  corruption recovery, pre-migration snapshots, versioned reversible migrations and a single-tab lock.
- Full Phase 1 schema including tables for later phases.
- Tasks with every specified field and status; nested subtasks; duplicate, move, promote, soft delete, Trash, undo.
- Deterministic offline Quick Add parser (UK defaults) with highlighted tokens, tap-to-unrecognise and ambiguity choices.
- Recurrence engine with scheduled- or completion-based repeats; one next occurrence per completion.
- Projects (nested, sections, colours, icons, notes, archive, favourites) with List, Board, Table and month Calendar layouts.
- Labels, Inbox, Today, Upcoming, Calendar, Search (FTS), Focus mode with timer, Trash, Settings, onboarding.
- Comments, local attachments, reminders (stored), activity history, time tracking.
- JSON and SQLite backup with verification; restore with safety snapshot; demo data with safe removal.
- Responsive layout (bottom navigation + FAB on phones, sidebar + resizable detail panel on desktop), dark mode,
  accent colours, keyboard shortcuts, swipe actions, drag and drop, PWA with offline service worker.
- 138 Vitest tests and 22 Playwright tests (desktop + Pixel 7 emulation).
