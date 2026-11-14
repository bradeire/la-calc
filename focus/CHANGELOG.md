# Changelog

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
